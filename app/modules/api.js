import { xxHash32 } from 'js-xxhash'
import uploadContent from './uploadContent.js'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { LRUCache } from 'lru-cache'
import crypto from 'crypto'
import AWS from 'aws-sdk'
import pLimit from 'p-limit'
import { EventEmitter } from 'events'
import https from 'https'

import User from '../models/User.js'
import Item from '../models/Item.js'

// ===== CONSTANTS AND CONFIGURATION =====
const MAX_CONCURRENT_GENERATIONS = 3
const MAX_CONCURRENT_REQUESTS = 3
const GENERATION_TIMEOUT = 30000
const RETRY_ATTEMPTS = 3
const RETRY_DELAY = 1000
const MAX_IMAGE_LOAD_CONCURRENT = 10

// Sharp configuration for optimal memory usage
sharp.cache({ memory: 128, files: 10 })
sharp.concurrency(1)
sharp.simd(true)

// ===== DIRECTORY SETUP =====
const AVATARS_DIR = path.join(process.cwd(), 'avatars')
const CACHE_DIR = path.join(process.cwd(), 'cache')

const initializeDirectories = async () => {
    try {
        await Promise.all([
            fs.mkdir(AVATARS_DIR, { recursive: true }),
            fs.mkdir(CACHE_DIR, { recursive: true })
        ])
    } catch (error) {
        console.error('Failed to initialize directories:', error)
        throw error
    }
}

// Initialize directories on startup
initializeDirectories().catch(console.error)

// ===== AWS S3 CONFIGURATION =====
const spacesEndpoint = new AWS.Endpoint(process.env.DO_ENDPOINT)
const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: process.env.DO_SPACE_ID,
    secretAccessKey: process.env.DO_SPACE_KEY,
    httpOptions: {
        timeout: 10000,
        agent: new https.Agent({ keepAlive: true })
    }
})

// ===== CACHE CONFIGURATION =====
const avatarCache = new LRUCache({
    max: 20,
    ttl: 1000 * 60 * 60, // 1 hour
    updateAgeOnGet: true,
    sizeCalculation: (value) => value.length,
    maxSize: 50 * 1024 * 1024, // 50MB max
    dispose: (value, key) => {
        console.log(`Disposing avatar cache entry: ${key}`)
    }
})

const memoryCache = new LRUCache({
    max: 50,
    ttl: 1000 * 60 * 30, // 30 minutes
    sizeCalculation: (value) => value.length || 1024,
    maxSize: 50 * 1024 * 1024 // 50MB max
})

// ===== REQUEST MANAGEMENT =====
const generationLocks = new Map()
const generationEvents = new EventEmitter()
const imageLoadLimit = pLimit(MAX_IMAGE_LOAD_CONCURRENT)
const requestQueue = []
const activeRequests = new Set()

// ===== CIRCUIT BREAKER =====
class CircuitBreaker {
    constructor(threshold = 5, timeout = 60000) {
        this.failures = 0
        this.threshold = threshold
        this.timeout = timeout
        this.state = 'CLOSED'
        this.nextAttempt = Date.now()
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error('Circuit breaker is OPEN')
            }
            this.state = 'HALF_OPEN'
        }

        try {
            const result = await fn()
            this.onSuccess()
            return result
        } catch (error) {
            this.onFailure()
            throw error
        }
    }

    onSuccess() {
        this.failures = 0
        this.state = 'CLOSED'
    }

    onFailure() {
        this.failures++
        if (this.failures >= this.threshold) {
            this.state = 'OPEN'
            this.nextAttempt = Date.now() + this.timeout
        }
    }
}

const s3CircuitBreaker = new CircuitBreaker()
const imageLoadCircuitBreaker = new CircuitBreaker()

// ===== UTILITY FUNCTIONS =====
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const retryWithBackoff = async (fn, attempts = RETRY_ATTEMPTS, delay = RETRY_DELAY) => {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn()
        } catch (error) {
            if (i === attempts - 1) throw error
            const backoffDelay = delay * Math.pow(2, i)
            console.warn(`Retry attempt ${i + 1}/${attempts} after ${backoffDelay}ms`, error.message)
            await sleep(backoffDelay)
        }
    }
}

const sanitizeUsername = (username) => {
    if (!username || typeof username !== 'string') {
        throw new Error('Invalid username')
    }
    return username.replace(/[^a-zA-Z0-9_-]/g, '')
}

const getParams = (username) => {
    return {
        Bucket: process.env.DO_SPACE_NAME,
        Key: `user-clothing/${username}.webp`,
        Expires: 3600
    }
}

// ===== MEMORY MONITORING =====
const checkMemoryUsage = () => {
    const usage = process.memoryUsage()
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024)
    const rssMB = Math.round(usage.rss / 1024 / 1024)
    
    console.log(`Memory Usage - Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`)
    
    // Force garbage collection if available and memory usage is high
    if (heapUsedMB > 500 && global.gc) {
        console.log('Forcing garbage collection...')
        global.gc()
    }
    
    // Clear caches if memory is critically high
    if (rssMB > 800) {
        console.warn('Critical memory usage detected, clearing caches...')
        avatarCache.clear()
        memoryCache.clear()
        sharp.cache(false)
        sharp.cache({ memory: 64, files: 5 })
    }
}

// Run memory check every 30 seconds
setInterval(checkMemoryUsage, 30000)

// ===== IMAGE LOADING =====
const getImage = async (item) => {
    if (!item) return null

    const itemId = item.toString()
    const cacheKey = itemId.toLowerCase()

    // Check memory cache
    const memCached = memoryCache.get(cacheKey)
    if (memCached) return memCached

    return imageLoadLimit(async () => {
        try {
            // Check disk cache
            const diskCacheKey = crypto.createHash('md5').update(cacheKey).digest('hex')
            const diskCachePath = path.join(CACHE_DIR, `${diskCacheKey}.png`)
            
            try {
                const diskData = await fs.readFile(diskCachePath)
                // Only cache small images in memory
                if (diskData.length < 1024 * 1024) {
                    memoryCache.set(cacheKey, diskData)
                }
                return diskData
            } catch (error) {
                // Disk cache miss, continue to fetch
            }

            // Fetch from remote
            const data = await imageLoadCircuitBreaker.execute(() =>
                retryWithBackoff(async () => {
                    const response = await axios.get(
                        `https://${process.env.DO_SPACE_ENDPOINT}item-sprite/${itemId}.webp`,
                        {
                            responseType: 'arraybuffer',
                            timeout: 10000,
                            maxContentLength: 10 * 1024 * 1024
                        }
                    )
                    return response.data
                })
            )

            // Convert to PNG
            const pngBuffer = await sharp(data).png().toBuffer()

            // Cache small images only
            if (pngBuffer.length < 1024 * 1024) {
                memoryCache.set(cacheKey, pngBuffer)
            }
            
            // Write to disk cache asynchronously
            fs.writeFile(diskCachePath, pngBuffer).catch(error => {
                console.warn('Failed to write disk cache:', error.message)
            })

            return pngBuffer
        } catch (error) {
            console.error(`Failed to load image for ${itemId}:`, error.message)
            return null
        }
    })
}

// ===== AVATAR GENERATION =====
const generateDirectionalAvatar = async (direction, layers, shoesBehindPants, hairInfrontTop, width = 425, height = 850) => {
    const sourceX = direction * width
    
    const getFacingOrder = (direction) => {
        // Forward-facing (0)
        if (direction === 0) {
            return [
                "base",
                "tattoos",
                "makeup", "eyes", "eyebrows", "head", "nose", "mouth", "beard",
                "wings", "glasses",
                "hair_behind",
                "socks",
                "shoes_before",
                "gloves", "bottom", "belt",
                "shoes_after",
                "bracelets", "handheld",
                "top",
                "necklace", "coat", "neckwear", "hair_infront", "piercings", "earPiece", "hat", "horns",
                "bag"
            ]
        }
        // Side views (1, 4)
        else if ([1, 4].includes(direction)) {
            return [
                "base",
                "tattoos",
                "makeup", "eyes", "eyebrows", "head", "nose", "mouth", "beard",
                "glasses",
                "hair_behind",
                "socks",
                "shoes_before",
                "gloves", "bottom", "belt",
                "shoes_after",
                "bracelets", "handheld",
                "top",
                "necklace", "coat", "neckwear", "hair_infront", "piercings", "earPiece", "hat", "horns",
                "wings", "bag"
            ]
        }
        // Three-quarter views (2, 5)
        else if ([2, 5].includes(direction)) {
            return [
                "base",
                "tattoos",
                "makeup", "eyes", "eyebrows", "head", "nose", "mouth", "beard",
                "wings", "glasses",
                "socks",
                "shoes_before",
                "gloves", "bottom", "belt",
                "shoes_after",
                "bracelets", "handheld",
                "top", "necklace",
                "coat", "hair_behind", "piercings", "earPiece", "neckwear", "hair_infront", "hat", "horns",
                "bag"
            ]
        }
        // Back view (3)
        else {
            return [
                "base",
                "tattoos",
                "makeup", "eyes", "eyebrows", "head", "nose", "mouth", "beard",
                "socks",
                "shoes_before",
                "gloves", "bottom", "belt",
                "shoes_after",
                "bracelets", "handheld",
                "piercings", "earPiece", "glasses",
                "horns",
                "top", "necklace", "coat", "hair_infront",
                "hair_behind", "hat", "neckwear",
                "wings", "bag"
            ]
        }
    }

    const layerOrder = getFacingOrder(direction)
    const compositeInputs = []
    
    for (const layerName of layerOrder) {
        let layerBuffer = null
        
        // Handle special layer mappings
        if (layerName === 'shoes_before' && !shoesBehindPants) {
            layerBuffer = layers["shoes"]
        } else if (layerName === 'shoes_after' && shoesBehindPants) {
            layerBuffer = layers["shoes"]
        } else if (layerName === 'hair_behind' && !hairInfrontTop) {
            layerBuffer = layers["hair"]
        } else if (layerName === 'hair_infront' && hairInfrontTop) {
            layerBuffer = layers["hair"]
        } else {
            layerBuffer = layers[layerName]
        }
        
        if (!layerBuffer) continue

        try {
            // Check if this is a sprite sheet or single image
            const metadata = await sharp(layerBuffer).metadata()
            
            if (metadata.width === 2550 && metadata.height === 850) {
                // This is a sprite sheet, extract the correct frame
                const extractedLayer = await sharp(layerBuffer)
                    .extract({
                        left: sourceX,
                        top: 0,
                        width: width,
                        height: height
                    })
                    .toBuffer()

                compositeInputs.push({
                    input: extractedLayer,
                    top: 0,
                    left: 0
                })
            } else if (metadata.width === width && metadata.height === height) {
                // This is already a single frame
                compositeInputs.push({
                    input: layerBuffer,
                    top: 0,
                    left: 0
                })
            } else {
                console.warn(`Unexpected dimensions for layer ${layerName}: ${metadata.width}x${metadata.height}`)
            }
        } catch (error) {
            console.warn(`Failed to process layer ${layerName}:`, error.message)
        }
    }
    
    // Create the final composite
    const result = await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
    })
    .composite(compositeInputs)
    .toBuffer()
    
    return result
}

const generateFullSpriteSheet = async (allLayers, shoesBehindPants, hairInfrontTop) => {
    const spriteWidth = 2550
    const spriteHeight = 850
    const frameWidth = 425
    const frameHeight = 850
    
    try {
        // Combine all tattoos into a single sprite sheet
        let tattooSpriteSheet = null
        const tattooLayers = Object.entries(allLayers)
            .filter(([key, value]) => key.startsWith('tattoo_') && value)
        
        if (tattooLayers.length > 0) {
            let tattooComposite = sharp({
                create: {
                    width: spriteWidth,
                    height: spriteHeight,
                    channels: 4,
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                }
            })

            const tattooInputs = []
            for (const [key, buffer] of tattooLayers) {
                if (buffer) {
                    tattooInputs.push({
                        input: buffer,
                        top: 0,
                        left: 0
                    })
                }
            }
            
            if (tattooInputs.length > 0) {
                tattooSpriteSheet = await tattooComposite.composite(tattooInputs).toBuffer()
            }
        }

        // Create layers object with combined tattoos
        const layers = {
            ...allLayers,
            ...(tattooSpriteSheet && { tattoos: tattooSpriteSheet })
        }

        // Remove individual tattoo layers
        Object.keys(layers).forEach(key => {
            if (key.startsWith('tattoo_')) {
                delete layers[key]
            }
        })

        // Generate each direction
        const compositeInputs = []
        
        for (let direction = 0; direction < 6; direction++) {
            try {
                const directionBuffer = await generateDirectionalAvatar(
                    direction,
                    layers,
                    shoesBehindPants,
                    hairInfrontTop,
                    frameWidth,
                    frameHeight
                )
                
                compositeInputs.push({
                    input: directionBuffer,
                    left: direction * frameWidth,
                    top: 0
                })
            } catch (error) {
                console.error(`Failed to generate direction ${direction}:`, error)
                // Create a blank frame for failed directions
                const blankFrame = await sharp({
                    create: {
                        width: frameWidth,
                        height: frameHeight,
                        channels: 4,
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    }
                }).toBuffer()
                
                compositeInputs.push({
                    input: blankFrame,
                    left: direction * frameWidth,
                    top: 0
                })
            }
        }

        const result = sharp({
            create: {
                width: spriteWidth,
                height: spriteHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        })

        return result.composite(compositeInputs).toBuffer()
    } catch (error) {
        console.error('Sprite sheet generation failed:', error)
        throw error
    }
}

const createAvatarThumbnail = async (user, hash, type, res) => {
    try {
        // Validate customization data
        if (!user.customization || typeof user.customization !== 'object') {
            throw new Error('Invalid user customization data')
        }

        // Load base image
        const skinTone = user.customization.skinTone ?? 0
        const baseFileName = user.customization.isMale ? `male_${skinTone}.png` : `female_${skinTone}.png`
        const baseDir = path.join(process.cwd(), '_bases', baseFileName)
        
        const baseBuffer = await fs.readFile(baseDir).catch(error => {
            throw new Error(`Base image not found: ${baseFileName}`)
        })

        // Load all images in parallel
        const imagePromises = {
            base: baseBuffer,
            makeup: getImage(user.customization.makeup),
            hair: getImage(user.customization.hair),
            beard: getImage(user.customization.beard),
            eyes: getImage(user.customization.eyes),
            eyebrows: getImage(user.customization.eyebrows),
            head: getImage(user.customization.head),
            nose: getImage(user.customization.nose),
            mouth: getImage(user.customization.mouth),
            hat: getImage(user.customization.hat),
            piercings: getImage(user.customization.piercings),
            earPiece: getImage(user.customization.earPiece),
            glasses: getImage(user.customization.glasses),
            horns: getImage(user.customization.horns),
            top: getImage(user.customization.top),
            necklace: getImage(user.customization.necklace),
            neckwear: getImage(user.customization.neckwear),
            coat: getImage(user.customization.coat),
            belt: getImage(user.customization.belt),
            bottom: getImage(user.customization.bottom),
            socks: getImage(user.customization.socks),
            shoes: getImage(user.customization.shoes),
            bracelets: getImage(user.customization.bracelets),
            wings: getImage(user.customization.wings),
            bag: getImage(user.customization.bag),
            gloves: getImage(user.customization.gloves),
            handheld: getImage(user.customization.handheld),
            // Tattoos
            tattoo_head: getImage(user.customization.tattoos?.head),
            tattoo_neck: getImage(user.customization.tattoos?.neck),
            tattoo_chest: getImage(user.customization.tattoos?.chest),
            tattoo_stomach: getImage(user.customization.tattoos?.stomach),
            tattoo_backUpper: getImage(user.customization.tattoos?.backUpper),
            tattoo_backLower: getImage(user.customization.tattoos?.backLower),
            tattoo_armRight: getImage(user.customization.tattoos?.armRight),
            tattoo_armLeft: getImage(user.customization.tattoos?.armLeft),
            tattoo_legRight: getImage(user.customization.tattoos?.legRight),
            tattoo_legLeft: getImage(user.customization.tattoos?.legLeft)
        }

        // Wait for all images to load
        const loadedImages = {}
        const entries = await Promise.all(
            Object.entries(imagePromises).map(async ([key, promise]) => {
                try {
                    const value = await promise
                    return [key, value]
                } catch (error) {
                    console.warn(`Failed to load ${key}:`, error.message)
                    return [key, null]
                }
            })
        )
        
        entries.forEach(([key, value]) => {
            loadedImages[key] = value
        })

        // Get item metadata
        let shoesBehindPants = false
        let hairInfrontTop = false

        if (user.customization.bottom) {
            try {
                const pants = await Item.findById(
                    user.customization.bottom,
                    'description',
                    { lean: true, timeout: 2000 }
                )
                shoesBehindPants = pants?.description?.includes('!x') || false
            } catch (error) {
                console.warn('Failed to load pants metadata:', error.message)
            }
        }

        if (user.customization.hair) {
            try {
                const hair = await Item.findById(
                    user.customization.hair,
                    'description',
                    { lean: true, timeout: 2000 }
                )
                hairInfrontTop = hair?.description?.includes('!s') || false
            } catch (error) {
                console.warn('Failed to load hair metadata:', error.message)
            }
        }

        // Generate sprite sheet
        const spriteSheet = await generateFullSpriteSheet(
            loadedImages,
            shoesBehindPants,
            hairInfrontTop
        )

        // Generate front-facing avatar
        const frontFacingBuffer = await sharp(spriteSheet)
            .extract({ left: 0, top: 0, width: 425, height: 850 })
            .webp({ quality: 95, effort: 4 })
            .toBuffer()

        // Save to disk
        const filePath = path.join(AVATARS_DIR, `${hash}.webp`)
        await fs.writeFile(filePath, frontFacingBuffer).catch(error => {
            console.warn('Failed to save avatar to disk:', error.message)
        })

        // Update cache
        avatarCache.set(hash, frontFacingBuffer)

        // For non-sprite requests, return immediately
        if (type !== 'sprite') {
            return frontFacingBuffer
        }

        // Generate thumbnail
        const thumbnailBuffer = await sharp(spriteSheet)
            .extract({ left: 103, top: 42, width: 218, height: 218 })
            .toBuffer()

        // Upload generated images
        try {
            const [clothingUrl, thumbnailUrl, avatarUrl] = await Promise.all([
                retryWithBackoff(() =>
                    uploadContent(user.clothing, { data: spriteSheet }, 'user-clothing', 5, "DONT", undefined, user.username)
                ),
                retryWithBackoff(() =>
                    uploadContent(user.thumbnail, { data: thumbnailBuffer }, 'user-thumbnail', 5, undefined, undefined, user.username)
                ),
                retryWithBackoff(() =>
                    uploadContent(user.avatar, { data: frontFacingBuffer }, 'user-avatar', 5, "N", undefined, user.username)
                )
            ])

            // Update user record
            const newHash = xxHash32(JSON.stringify({
                username: user.username,
                customization: user.customization
            }), 0).toString()

            await User.updateOne(
                { username: user.username },
                {
                    customizationHash: newHash,
                    clothing: clothingUrl,
                    thumbnail: thumbnailUrl,
                    avatar: avatarUrl
                },
                { timestamps: false }
            ).catch(error => {
                console.error('Failed to update user record:', error)
            })

            if (type === 'sprite') {
                const signedUrl = await s3.getSignedUrlPromise('getObject', getParams(user.username))
                return res.status(307).redirect(signedUrl)
            }

            return frontFacingBuffer
        } catch (uploadError) {
            console.error('Upload failed:', uploadError)
            return frontFacingBuffer
        }
    } catch (error) {
        console.error('Avatar generation failed:', error)
        throw error
    }
}

// ===== MAIN AVATAR ENDPOINT =====
const getAvatar = async (req, res) => {
    const startTime = Date.now()
    let lockKey = null
    
    try {
        // Validate inputs
        const rawType = req.params.type
        const username = sanitizeUsername(req.params.username)
        
        // Map short forms to full types
        const typeMap = {
            'a': 'avatar',
            's': 'sprite', 
            't': 'thumbnail',
            'avatar': 'avatar',
            'sprite': 'sprite',
            'thumbnail': 'thumbnail'
        }

        const type = typeMap[rawType]

        if (!type) {
            return res.status(400).json({ error: 'Invalid avatar type' })
        }

        // Find user
        const user = await User.findOne(
            { username },
            'username customization customizationHash clothing thumbnail avatar',
            { lean: true, timeout: 5000 }
        ).catch(error => {
            console.error('Database error:', error)
            throw new Error('Database unavailable')
        })
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }

        // Calculate hash
        const hash = xxHash32(JSON.stringify({
            username: user.username,
            customization: user.customization
        }), 0).toString()

        // Check if sprite is already generated
        if (type === 'sprite' && user.customizationHash === hash) {
            try {
                const signedUrl = await s3CircuitBreaker.execute(() =>
                    s3.getSignedUrlPromise('getObject', getParams(username))
                )
                return res.status(307).redirect(signedUrl)
            } catch (error) {
                console.error('S3 error:', error)
                return res.status(503).json({ error: 'Storage service unavailable' })
            }
        }

        // Check memory cache for non-sprite types
        if (type !== 'sprite') {
            const cachedAvatar = avatarCache.get(hash)
            if (cachedAvatar) {
                res.set('Content-Type', 'image/webp')
                res.set('X-Cache', 'HIT')
                return res.status(200).send(cachedAvatar)
            }
        }

        // Check disk cache
        if (user.customizationHash === hash && type !== 'sprite') {
            try {
                const avatarPath = path.join(AVATARS_DIR, `${hash}.webp`)
                const buffer = await fs.readFile(avatarPath)
                avatarCache.set(hash, buffer)
                res.set('Content-Type', 'image/webp')
                res.set('X-Cache', 'DISK')
                return res.status(200).send(buffer)
            } catch (error) {
                // File doesn't exist, continue to generation
            }
        }

        // Check if generation is already in progress
        lockKey = `${username}-${hash}`
        if (generationLocks.has(lockKey)) {
            // Wait for existing generation
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Generation timeout'))
                }, GENERATION_TIMEOUT)

                generationEvents.once(lockKey, (error, result) => {
                    clearTimeout(timeout)
                    if (error) {
                        reject(error)
                    } else if (type === 'sprite') {
                        s3.getSignedUrlPromise('getObject', getParams(username))
                            .then(url => res.status(307).redirect(url))
                            .catch(reject)
                    } else {
                        res.set('Content-Type', 'image/webp')
                        res.status(200).send(result)
                        resolve()
                    }
                })
            })
        }

        // Acquire generation lock
        generationLocks.set(lockKey, true)

        // Generate avatar with timeout
        const generatedAvatar = await Promise.race([
            createAvatarThumbnail(user, hash, type, res),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Generation timeout')), GENERATION_TIMEOUT)
            )
        ])

        // Emit success event
        generationEvents.emit(lockKey, null, generatedAvatar)

        if (type !== 'sprite') {
            res.set('Content-Type', 'image/webp')
            res.set('X-Cache', 'MISS')
            res.set('X-Generation-Time', `${Date.now() - startTime}ms`)
            return res.status(200).send(generatedAvatar)
        }
    } catch (error) {
        console.error('Avatar generation error:', error)
        
        // Emit error event if lock was acquired
        if (lockKey && generationLocks.has(lockKey)) {
            generationEvents.emit(lockKey, error)
        }

        // Send appropriate error response
        if (error.message === 'Generation timeout') {
            res.status(504).json({ error: 'Request timeout' })
        } else if (error.message === 'Database unavailable') {
            res.status(503).json({ error: 'Service temporarily unavailable' })
        } else {
            res.status(500).json({ error: 'Error generating avatar' })
        }
    } finally {
        // Clean up lock
        if (lockKey) {
            generationLocks.delete(lockKey)
        }
    }
}

// ===== REQUEST QUEUE MANAGEMENT =====
const processRequestQueue = async () => {
    while (requestQueue.length > 0 && activeRequests.size < MAX_CONCURRENT_REQUESTS) {
        const { req, res, handler } = requestQueue.shift()
        const requestId = `${req.params.username}-${Date.now()}`
        
        activeRequests.add(requestId)
        
        handler(req, res)
            .catch(error => {
                console.error('Request handler error:', error)
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' })
                }
            })
            .finally(() => {
                activeRequests.delete(requestId)
                processRequestQueue()
            })
    }
}

const queuedGetAvatar = (req, res) => {
    if (activeRequests.size >= MAX_CONCURRENT_REQUESTS) {
        requestQueue.push({ req, res, handler: getAvatar })
        processRequestQueue()
    } else {
        const requestId = `${req.params.username}-${Date.now()}`
        activeRequests.add(requestId)
        
        getAvatar(req, res)
            .catch(error => {
                console.error('Avatar generation error:', error)
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' })
                }
            })
            .finally(() => {
                activeRequests.delete(requestId)
                processRequestQueue()
            })
    }
}

// ===== CLEANUP FUNCTIONS =====
const cleanupOldAvatars = async () => {
    try {
        const files = await fs.readdir(AVATARS_DIR)
        const now = Date.now()
        const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days
        
        const cleanupPromises = files.map(async (file) => {
            try {
                const filePath = path.join(AVATARS_DIR, file)
                const stats = await fs.stat(filePath)
                
                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filePath)
                    console.log(`Cleaned up old avatar: ${file}`)
                }
            } catch (error) {
                console.error(`Error cleaning up file ${file}:`, error.message)
            }
        })

        await Promise.all(cleanupPromises)
        console.log('Avatar cleanup completed')
    } catch (error) {
        console.error('Avatar cleanup failed:', error)
    }
}

// Run cleanup periodically
const cleanupInterval = setInterval(() => {
    cleanupOldAvatars().catch(console.error)
}, 24 * 60 * 60 * 1000) // Once per day

// ===== CACHE MANAGEMENT =====
const clearAllCaches = async () => {
    const results = {
        memoryCachesCleared: false,
        diskCacheCleared: false,
        avatarsCleaned: false,
        errors: []
    }

    // Clear memory caches
    try {
        avatarCache.clear()
        memoryCache.clear()
        results.memoryCachesCleared = true
    } catch (error) {
        results.errors.push({
            type: 'memory_cache',
            error: error.message
        })
    }

    // Clear disk cache
    try {
        const files = await fs.readdir(CACHE_DIR)
        
        await Promise.allSettled(files.map(async (file) => {
            const filePath = path.join(CACHE_DIR, file)
            await fs.unlink(filePath)
        }))

        results.diskCacheCleared = true
    } catch (error) {
        if (error.code !== 'ENOENT') {
            results.errors.push({
                type: 'disk_cache',
                error: error.message
            })
        }
    }

    // Clean old avatars
    try {
        await cleanupOldAvatars()
        results.avatarsCleaned = true
    } catch (error) {
        results.errors.push({
            type: 'avatar_cleanup',
            error: error.message
        })
    }

    return results
}

const handleCacheClear = async (req, res) => {
    try {
        const results = await clearAllCaches()
        
        const status = results.errors.length === 0 ? 200 : 207
        res.status(status).json({
            success: results.errors.length === 0,
            message: results.errors.length === 0 
                ? 'All caches cleared successfully' 
                : 'Caches cleared with some errors',
            details: results
        })
    } catch (error) {
        console.error('Cache clear failed:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to clear caches',
            error: error.message
        })
    }
}

// ===== HEALTH CHECK =====
const healthCheck = async (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        caches: {
            avatar: {
                size: avatarCache.size,
                calculatedSize: avatarCache.calculatedSize
            },
            memory: {
                size: memoryCache.size,
                calculatedSize: memoryCache.calculatedSize
            }
        },
        services: {
            s3: s3CircuitBreaker.state,
            imageLoad: imageLoadCircuitBreaker.state
        },
        generationLocks: generationLocks.size,
        activeRequests: activeRequests.size,
        queuedRequests: requestQueue.length
    }

    // Test S3 connectivity
    try {
        await s3.headBucket({ Bucket: process.env.DO_SPACE_NAME }).promise()
        health.services.s3Connected = true
    } catch (error) {
        health.services.s3Connected = false
        health.status = 'degraded'
    }

    res.status(health.status === 'ok' ? 200 : 503).json(health)
}

// ===== GRACEFUL SHUTDOWN =====
const gracefulShutdown = async () => {
    console.log('Starting graceful shutdown...')
    
    // Stop accepting new requests
    if (cleanupInterval) {
        clearInterval(cleanupInterval)
    }

    // Wait for ongoing generations
    const maxWait = 30000 // 30 seconds
    const startTime = Date.now()
    
    while (generationLocks.size > 0 && Date.now() - startTime < maxWait) {
        console.log(`Waiting for ${generationLocks.size} generations to complete...`)
        await sleep(1000)
    }

    // Clear caches
    await clearAllCaches()

    console.log('Graceful shutdown completed')
    process.exit(0)
}

// Register shutdown handlers
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// ===== EXPORTS =====
export default {
    getAvatar: queuedGetAvatar,
    clearAllCaches,
    handleCacheClear,
    healthCheck
}