import { xxHash32 } from 'js-xxhash'
import { createCanvas, loadImage } from 'canvas'
import uploadContent from './uploadContent.js'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { LRUCache } from 'lru-cache'
import crypto from 'crypto'
import AWS from 'aws-sdk'
import EventEmitter from 'events'

import User from '../models/User.js'
import Item from '../models/Item.js'

// Simple in-memory queue implementation
class InMemoryQueue extends EventEmitter {
    constructor(options = {}) {
        super()
        this.concurrency = options.concurrency || 3
        this.maxQueueSize = options.maxQueueSize || 1000
        this.retryAttempts = options.retryAttempts || 3
        this.retryDelay = options.retryDelay || 2000
        
        this.queue = []
        this.processing = new Map()
        this.completed = 0
        this.failed = 0
        this.workers = 0
        
        // Start processing
        this.startProcessing()
    }
    
    async add(jobData, options = {}) {
        // Check if we're at capacity
        if (this.queue.length >= this.maxQueueSize) {
            throw new Error('Queue is at maximum capacity')
        }
        
        const job = {
            id: `${jobData.username}-${Date.now()}`,
            data: jobData,
            priority: options.priority || 0,
            attempts: 0,
            createdAt: Date.now(),
            ...options
        }
        
        // Check if already processing
        const key = `${jobData.username}-${jobData.hash}`
        if (this.processing.has(key)) {
            return { id: job.id, status: 'duplicate' }
        }
        
        // Add to queue (sorted by priority)
        this.queue.push(job)
        this.queue.sort((a, b) => b.priority - a.priority)
        
        this.emit('job-added', job)
        this.processNext()
        
        return { id: job.id, status: 'queued' }
    }
    
    async processNext() {
        // Check if we can process more jobs
        if (this.workers >= this.concurrency || this.queue.length === 0) {
            return
        }
        
        // Get next job
        const job = this.queue.shift()
        if (!job) return
        
        // Mark as processing
        const key = `${job.data.username}-${job.data.hash}`
        this.processing.set(key, job)
        this.workers++
        
        try {
            // Process the job
            await this.processJob(job)
            this.completed++
            this.emit('job-completed', job)
        } catch (error) {
            job.attempts++
            
            if (job.attempts < this.retryAttempts) {
                // Retry with exponential backoff
                const delay = this.retryDelay * Math.pow(2, job.attempts - 1)
                setTimeout(() => {
                    this.queue.unshift(job)
                    this.processNext()
                }, delay)
                this.emit('job-retry', job, error)
            } else {
                this.failed++
                this.emit('job-failed', job, error)
            }
        } finally {
            this.processing.delete(key)
            this.workers--
            // Process next job
            this.processNext()
        }
    }
    
    startProcessing() {
        // Check queue every 100ms
        setInterval(() => {
            for (let i = 0; i < this.concurrency; i++) {
                this.processNext()
            }
        }, 100)
    }
    
    async processJob(job) {
        // This will be overridden when setting up the queue
        throw new Error('Process function not implemented')
    }
    
    getStats() {
        return {
            waiting: this.queue.length,
            active: this.workers,
            completed: this.completed,
            failed: this.failed,
            inProgress: this.processing.size
        }
    }
    
    clear() {
        this.queue = []
        this.processing.clear()
        this.completed = 0
        this.failed = 0
    }
}

// Initialize queue
const avatarQueue = new InMemoryQueue({
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY) || 3,
    maxQueueSize: 1000,
    retryAttempts: 3,
    retryDelay: 2000
})

// Track jobs to prevent duplicates
const jobsInProgress = new Map()

const spacesEndpoint = new AWS.Endpoint(process.env.DO_ENDPOINT)
const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: process.env.DO_SPACE_ID,
    secretAccessKey: process.env.DO_SPACE_KEY
})

/**
 * Helper function to check if an object exists in DigitalOcean Spaces
 * @param {Object} params - S3 parameters with Bucket and Key
 * @returns {Promise<boolean>} - true if object exists, false otherwise
 */
const checkObjectExists = async (params) => {
    try {
        await s3.headObject({
            Bucket: params.Bucket,
            Key: params.Key
        }).promise()
        return true
    } catch (error) {
        if (error.code === 'NotFound') {
            return false
        }
        // Re-throw other errors
        throw error
    }
}

const AVATARS_DIR = path.join(process.cwd(), 'avatars')
;(async () => {
    await fs.mkdir(AVATARS_DIR, { recursive: true })
})()

// In-memory cache for both avatar buffers and processed results
const avatarCache = new LRUCache({
    max: 5, // Adjust based on memory constraints
    ttl: 1000 * 60 * 60, // 1 hour TTL
    updateAgeOnGet: true
})

// Pre-initialize sharp for better performance
sharp.cache(true)
sharp.concurrency(2) // Adjust based on server CPU cores

const getParams = (username) => {
    return {
        Bucket: process.env.DO_SPACE_NAME,
        Key: `user-clothing/${username}.webp`,
        Expires: 3600 // URL expires in 1 hour
    }
}

const getParamsAvatar = (username) => {
    return {
        Bucket: process.env.DO_SPACE_NAME,
        Key: `user-avatar/${username}.webp`,
        Expires: 3600 // URL expires in 1 hour
    }
}

const getParamsThumbnail = (username) => {
    return {
        Bucket: process.env.DO_SPACE_NAME,
        Key: `user-thumbnail/${username}.webp`,
        Expires: 3600 // URL expires in 1 hour
    }
}

// Default avatar response when nothing is available
const getDefaultAvatar = async (type) => {
    try {
        const defaultPath = path.join(process.cwd(), '_defaults', `default-${type}.webp`)
        return await fs.readFile(defaultPath)
    } catch (error) {
        // Return a simple 1x1 transparent webp if default doesn't exist
        return Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA=', 'base64')
    }
}

/**
 * Get or return existing avatar, queueing generation if needed
 */
const getAvatar = async (req, res) => {
    try {
        const type = req.params.type
        const username = req.params.username
        
        // Find user with minimal projection
        const user = await User.findOne({ username }, 'username customization customizationHash clothing thumbnail avatar', { lean: true })
        
        if (!user) {
            return res.status(404).send('User not found.')
        }

        // Calculate hash only once
        const currentHash = xxHash32(JSON.stringify({ username: user.username, customization: user.customization }), 0).toString()
        
        // Check if we have a valid cached version
        if (user.customizationHash === currentHash) {
            let params, exists
            
            switch (type) {
                case 'sprite':
                    params = getParams(username)
                    break
                case 'thumbnail':
                    params = getParamsThumbnail(username)
                    break
                default:
                    // Check memory cache first for regular avatars
                    const cachedAvatar = avatarCache.get(currentHash)
                    if (cachedAvatar) {
                        return res.status(200).send(cachedAvatar)
                    }
                    params = getParamsAvatar(username)
            }
            
            // Check if file exists on DigitalOcean
            exists = await checkObjectExists(params)
            
            if (exists) {
                const signedUrl = await s3.getSignedUrlPromise('getObject', params)
                return res.status(307).redirect(signedUrl)
            }
        }

        // If we get here, we need to generate or regenerate the avatar
        // Check if there's already a job in progress for this user
        const jobKey = `${username}-${currentHash}`
        const existingJobId = jobsInProgress.get(jobKey)
        
        if (existingJobId) {
            console.log(`Job already in progress for ${username}, returning old avatar if available`)
            // Return old avatar if available, otherwise default
            if (user.customizationHash && user.customizationHash !== currentHash) {
                // We have an old version, return it
                let params
                switch (type) {
                    case 'sprite':
                        params = getParams(username)
                        break
                    case 'thumbnail':
                        params = getParamsThumbnail(username)
                        break
                    default:
                        params = getParamsAvatar(username)
                }
                
                const exists = await checkObjectExists(params)
                if (exists) {
                    const signedUrl = await s3.getSignedUrlPromise('getObject', params)
                    return res.status(307).redirect(signedUrl)
                }
            }
            
            // No old version available, return default
            const defaultAvatar = await getDefaultAvatar(type)
            return res.status(200).contentType('image/webp').send(defaultAvatar)
        }

        // Add to queue for processing
        try {
            const job = await avatarQueue.add({
                username: user.username,
                customization: user.customization,
                hash: currentHash,
                type: type
            }, {
                priority: type === 'thumbnail' ? 1 : 0 // Prioritize thumbnails
            })

            jobsInProgress.set(jobKey, job.id)
        } catch (error) {
            if (error.message === 'Queue is at maximum capacity') {
                console.error(`Queue full, cannot process avatar for ${username}`)
                // Fall through to return existing/default
            } else {
                throw error
            }
        }

        // If we have an old version, return it while new one generates
        if (user.avatar || user.clothing || user.thumbnail) {
            let params
            switch (type) {
                case 'sprite':
                    if (user.clothing) {
                        params = getParams(username)
                    }
                    break
                case 'thumbnail':
                    if (user.thumbnail) {
                        params = getParamsThumbnail(username)
                    }
                    break
                default:
                    if (user.avatar) {
                        params = getParamsAvatar(username)
                    }
            }
            
            if (params) {
                const exists = await checkObjectExists(params)
                if (exists) {
                    const signedUrl = await s3.getSignedUrlPromise('getObject', params)
                    return res.status(307).redirect(signedUrl)
                }
            }
        }

        // No existing version, return default avatar
        const defaultAvatar = await getDefaultAvatar(type)
        return res.status(200).contentType('image/webp').send(defaultAvatar)
    } 
    catch (error) {
        console.error('Avatar request error:', error)
        res.status(500).send('Error processing avatar request')
    }
}

// Set up queue processor
avatarQueue.processJob = async (job) => {
    const { username, customization, hash, type } = job.data
    
    try {
        console.log(`Processing avatar generation for ${username}`)
        
        // Get fresh user data
        const user = await User.findOne({ username }, null, { lean: true })
        if (!user) {
            throw new Error('User not found')
        }

        // Verify hash hasn't changed
        const currentHash = xxHash32(JSON.stringify({ username: user.username, customization: user.customization }), 0).toString()
        if (currentHash !== hash) {
            console.log(`Hash mismatch for ${username}, skipping generation`)
            return { status: 'skipped', reason: 'hash_mismatch' }
        }

        // Generate avatar
        await generateAvatarAsync(user, hash)
        
        return { status: 'completed', username }
    } catch (error) {
        console.error(`Error processing avatar for ${username}:`, error)
        throw error
    } finally {
        // Remove from jobs in progress
        const jobKey = `${username}-${hash}`
        jobsInProgress.delete(jobKey)
    }
}

// Async avatar generation (moved from createAvatarThumbnail)
const generateAvatarAsync = async (user, hash) => {
    try {
        // Determine base image based on user customization
        let skinTone = user.customization.skinTone ?? 0
        let base = user.customization.isMale ? `male_${skinTone}.png` : `female_${skinTone}.png`
        
        const baseDir = path.join(process.cwd(), '_bases', base)
        base = await fs.readFile(baseDir)

        // Load all customization images
        const loadedImages = {
            base: await loadImage(base),
            makeup: await getImage(user.customization.makeup),
            hair: await getImage(user.customization.hair),
            beard: await getImage(user.customization.beard),
            eyes: await getImage(user.customization.eyes),
            eyebrows: await getImage(user.customization.eyebrows),
            head: await getImage(user.customization.head),
            nose: await getImage(user.customization.nose),
            mouth: await getImage(user.customization.mouth),
            hat: await getImage(user.customization.hat),
            piercings: await getImage(user.customization.piercings),
            earPiece: await getImage(user.customization.earPiece),
            glasses: await getImage(user.customization.glasses),
            horns: await getImage(user.customization.horns),
            top: await getImage(user.customization.top),
            necklace: await getImage(user.customization.necklace),
            neckwear: await getImage(user.customization.neckwear),
            coat: await getImage(user.customization.coat),
            belt: await getImage(user.customization.belt),
            bottom: await getImage(user.customization.bottom),
            socks: await getImage(user.customization.socks),
            shoes: await getImage(user.customization.shoes),
            bracelets: await getImage(user.customization.bracelets),
            wings: await getImage(user.customization.wings),
            bag: await getImage(user.customization.bag),
            gloves: await getImage(user.customization.gloves),
            handheld: await getImage(user.customization.handheld),
            // Load tattoos
            tattoo_head: await getImage(user.customization.tattoos?.head),
            tattoo_neck: await getImage(user.customization.tattoos?.neck),
            tattoo_chest: await getImage(user.customization.tattoos?.chest),
            tattoo_stomach: await getImage(user.customization.tattoos?.stomach),
            tattoo_backUpper: await getImage(user.customization.tattoos?.backUpper),
            tattoo_backLower: await getImage(user.customization.tattoos?.backLower),
            tattoo_armRight: await getImage(user.customization.tattoos?.armRight),
            tattoo_armLeft: await getImage(user.customization.tattoos?.armLeft),
            tattoo_legRight: await getImage(user.customization.tattoos?.legRight),
            tattoo_legLeft: await getImage(user.customization.tattoos?.legLeft)
        }

        // Check if shoes should be behind pants
        let shoesBehindPants = false
        if (user.customization.bottom) {
            const pants = await Item.findById(user.customization.bottom, 'description').lean()
            shoesBehindPants = pants?.description?.includes('!x') || false
        }

        let hairInfrontTop = false
        if (user.customization.hair) {
            const hair = await Item.findById(user.customization.hair, 'description').lean()
            hairInfrontTop = hair?.description?.includes('!s') || false
        }

        const spriteSheet = await generateFullSpriteSheet(loadedImages, shoesBehindPants, hairInfrontTop)

        // Generate front-facing avatar for thumbnail
        const frontFacingAvatar = await cropImage(spriteSheet, 0, 0, 425, 850)
        const frontFacingBuffer = await sharp(frontFacingAvatar).webp({ quality: 95 }).toBuffer()

        // Update cache
        avatarCache.set(hash, frontFacingBuffer)

        // Generate thumbnail from sprite sheet
        const thumbnail = await cropImage(spriteSheet, 103, 42, 218, 218)

        // Upload generated images
        const clothing = await uploadContent(user.clothing, { data: spriteSheet }, 'user-clothing', 5, "DONT", undefined, user.username)
        const thumbnailUrl = await uploadContent(user.thumbnail, { data: thumbnail }, 'user-thumbnail', 5, undefined, undefined, user.username)
        const avatar = await uploadContent(user.avatar, { data: frontFacingBuffer }, 'user-avatar', 5, "N", undefined, user.username)

        // Update user
        await User.updateOne(
            { username: user.username },
            {
                customizationHash: hash,
                clothing: clothing,
                thumbnail: thumbnailUrl,
                avatar: avatar
            },
            { timestamps: false }
        )

        console.log(`Avatar generation completed for ${user.username}`)
    }
    catch (error) {
        console.error('Error generating avatar:', error)
        throw error
    }
}

// Optional: Persist queue to disk periodically (basic persistence)
const QUEUE_BACKUP_FILE = path.join(process.cwd(), 'queue-backup.json')

const saveQueueToDisk = async () => {
    try {
        const backup = {
            queue: avatarQueue.queue,
            stats: avatarQueue.getStats(),
            timestamp: new Date().toISOString()
        }
        await fs.writeFile(QUEUE_BACKUP_FILE, JSON.stringify(backup, null, 2))
    } catch (error) {
        console.error('Failed to save queue backup:', error)
    }
}

const loadQueueFromDisk = async () => {
    try {
        const data = await fs.readFile(QUEUE_BACKUP_FILE, 'utf8')
        const backup = JSON.parse(data)
        
        // Restore queue if backup is less than 1 hour old
        const backupAge = Date.now() - new Date(backup.timestamp).getTime()
        if (backupAge < 60 * 60 * 1000) {
            avatarQueue.queue = backup.queue
            console.log(`Restored ${backup.queue.length} jobs from backup`)
        }
    } catch (error) {
        // No backup file, that's okay
    }
}

// Save queue every 5 minutes
setInterval(saveQueueToDisk, 5 * 60 * 1000)

// Load queue on startup
loadQueueFromDisk()

const memoryCache = new LRUCache({
    max: 20,
})

const CACHE_DIR = path.join(process.cwd(), 'cache')
;(async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true })
})()

const getImage = async (item) => {
    if (item == undefined || item == null || item == '')
        return null

    item = item.toString()
    const cacheKey = item.toLowerCase()

    // Check memory cache first
    const memCached = memoryCache.get(cacheKey)
    if (memCached) return memCached

    try {
        const diskCacheKey = crypto.createHash('md5').update(cacheKey).digest('hex')
        const diskCachePath = path.join(CACHE_DIR, `${diskCacheKey}.png`)
        
        // Check disk cache
        const diskCached = await fs.readFile(diskCachePath)
            .then(async data => await loadImage(data))
            .catch(() => null)
            
        if (diskCached) {
            memoryCache.set(cacheKey, diskCached)
            return diskCached
        }

        // Fetch and process image
        let data = await axios.get(
            `https://${process.env.DO_SPACE_ENDPOINT}item-sprite/${item}.webp`,
            { responseType: 'arraybuffer' }
        )
        
        const pngBuffer = await sharp(data.data).png().toBuffer()
        const image = await loadImage(pngBuffer)

        // Store in both caches
        memoryCache.set(cacheKey, image)
        await fs.writeFile(diskCachePath, pngBuffer)

        return image
    } 
    catch (error) {
        console.error(`Failed to load image for ${item}:`, error.message)
        return null
    }
}

const generateDirectionalAvatar = async (direction, layers, shoesBehindPants, hairInfrontTop) => {
    // Canvas size for single direction (425x850)
    const canvas = createCanvas(425, 850)
    const ctx = canvas.getContext('2d')
    
    // Calculate x offset based on direction (0-5)
    const sourceX = direction * 425
    
    // Different layer orders based on direction
    const getFacingOrder = (direction) => {
        // Forward-facing (0)
        if (direction === 0) {
            return [
                "base",
                "tattoo_head", "tattoo_neck", "tattoo_chest", "tattoo_stomach",
                "tattoo_backUpper", "tattoo_backLower", "tattoo_armRight",
                "tattoo_armLeft", "tattoo_legRight", "tattoo_legLeft",
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
        else if ([1, 4].includes(direction)) {
            return [
                "base",
                "tattoo_head", "tattoo_neck", "tattoo_chest", "tattoo_stomach",
                "tattoo_backUpper", "tattoo_backLower", "tattoo_armRight",
                "tattoo_armLeft", "tattoo_legRight", "tattoo_legLeft",
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
        else if ([2, 5].includes(direction)) {
            return [
                "base",
                "tattoo_head", "tattoo_neck", "tattoo_chest", "tattoo_stomach",
                "tattoo_backUpper", "tattoo_backLower", "tattoo_armRight",
                "tattoo_armLeft", "tattoo_legRight", "tattoo_legLeft",
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
                "tattoo_head", "tattoo_neck", "tattoo_chest", "tattoo_stomach",
                "tattoo_backUpper", "tattoo_backLower", "tattoo_armRight",
                "tattoo_armLeft", "tattoo_legRight", "tattoo_legLeft",
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

    // Draw layers in the correct order for this direction
    const layerOrder = getFacingOrder(direction)
    for (const layerName of layerOrder) {
        let layer = null
        if (layerName == 'shoes_before' && !shoesBehindPants)
            layer = layers["shoes"]
        else if (layerName == 'shoes_after' && shoesBehindPants)
            layer = layers["shoes"]
        else if (layerName == 'hair_behind' && !hairInfrontTop)
            layer = layers["hair"]
        else if (layerName == 'hair_infront' && hairInfrontTop)
            layer = layers["hair"]
        else
            layer = layers[layerName]
        if (!layer) continue

        if (layerName === 'hair_behind' && !hairInfrontTop) {
            ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
        }
        else if (layerName === 'hair_infront' && hairInfrontTop) {
            ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
        }
        // Special handling for shoes behind pants
        else if (layerName === 'shoes_before' && !shoesBehindPants) {
            ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
        }
        else if (layerName === 'shoes_after' && shoesBehindPants) {
            ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
        }
        // Normal layer drawing
        else {
            ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
        }
    }

    return canvas.toBuffer()
}

const generateFullSpriteSheet = async (allLayers, shoesBehindPants, hairInfrontTop) => {
    // Final sprite sheet canvas
    const canvas = createCanvas(2550, 850)
    const ctx = canvas.getContext('2d')

    // Combine all tattoos into a single layer for simplicity
    const combineTattoos = async (tattooLayers) => {
        const tattooCanvas = createCanvas(2550, 850)
        const tattooCtx = tattooCanvas.getContext('2d')
        
        for (const [key, tattoo] of Object.entries(tattooLayers)) {
            if (key.startsWith('tattoo_') && tattoo) {
                tattooCtx.drawImage(tattoo, 0, 0)
            }
        }
        
        return await loadImage(tattooCanvas.toBuffer())
    }

    // Create layers object with combined tattoos
    const tattoos = await combineTattoos(allLayers)
    const layers = {
        ...allLayers,
        tattoos,
    }

    // Remove individual tattoo layers to prevent double-drawing
    Object.keys(layers).forEach(key => {
        if (key.startsWith('tattoo_') && key !== 'tattoos') {
            delete layers[key]
        }
    })

    // Generate each direction
    for (let direction = 0; direction < 6; direction++) {
        const directionCanvas = await generateDirectionalAvatar(direction, layers, shoesBehindPants, hairInfrontTop)
        ctx.drawImage(
            await loadImage(directionCanvas),
            direction * 425, 0  // Place each direction in its correct position
        )
    }

    return canvas.toBuffer()
}

async function cropImage(sourceImage, x, y, width, height) {
    try {
        const loadedImage = await loadImage(sourceImage)
        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(loadedImage, x, y, width, height, 0, 0, width, height)
        return canvas.toBuffer()
    }
    catch (error) {
        console.error('Error processing images:', error)
        throw error
    }
}

// Batch process avatar deletion for old files
const cleanupOldAvatars = async () => {
    const avatarsDir = path.join(process.cwd(), 'avatars')
    const files = await fs.readdir(avatarsDir)
    const now = Date.now()
    const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days
    
    for (const file of files) {
        try {
            const filePath = path.join(avatarsDir, file)
            const stats = await fs.stat(filePath)
            if (now - stats.mtimeMs > maxAge) {
                await fs.unlink(filePath)
            }
        } catch (error) {
            console.error(`Error cleaning up file ${file}:`, error)
        }
    }
}

// Run cleanup periodically
setInterval(cleanupOldAvatars, 24 * 60 * 60 * 1000) // Once per day

/**
 * Clears all caches: memory caches and disk cache
 * @returns {Promise<Object>} Results of the cache clearing operations
 */
const clearAllCaches = async () => {
    try {
        const results = {
            memoryCachesCleared: false,
            diskCacheCleared: false,
            queueCleared: false,
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
            const CACHE_DIR = path.join(process.cwd(), 'cache')
            const files = await fs.readdir(CACHE_DIR)
            
            await Promise.all(files.map(async (file) => {
                const filePath = path.join(CACHE_DIR, file)
                try {
                    await fs.unlink(filePath)
                } catch (error) {
                    results.errors.push({
                        type: 'disk_cache_file',
                        file: file,
                        error: error.message
                    })
                }
            }))

            results.diskCacheCleared = true
        } catch (error) {
            if (error.code !== 'ENOENT') { // Ignore error if cache directory doesn't exist
                results.errors.push({
                    type: 'disk_cache_dir',
                    error: error.message
                })
            }
        }

        // Clear queue
        try {
            avatarQueue.clear()
            jobsInProgress.clear()
            results.queueCleared = true
        } catch (error) {
            results.errors.push({
                type: 'queue',
                error: error.message
            })
        }

        // Create fresh cache directory
        try {
            const CACHE_DIR = path.join(process.cwd(), 'cache')
            await fs.mkdir(CACHE_DIR, { recursive: true })
        } catch (error) {
            results.errors.push({
                type: 'cache_dir_creation',
                error: error.message
            })
        }

        return results
    } catch (error) {
        throw new Error(`Failed to clear caches: ${error.message}`)
    }
}

/**
 * Express middleware to handle cache clearing requests
 */
const handleCacheClear = async (req, res) => {
    try {
        const results = await clearAllCaches()
        
        if (results.errors.length === 0) {
            res.status(200).json({
                success: true,
                message: 'All caches cleared successfully',
                details: results
            })
        } else {
            res.status(207).json({
                success: true,
                message: 'Caches cleared with some errors',
                details: results
            })
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to clear caches',
            error: error.message
        })
    }
}

/**
 * Get queue statistics
 */
const getQueueStats = async () => {
    return avatarQueue.getStats()
}

// Graceful shutdown
const gracefulShutdown = async () => {
    console.log('Starting graceful shutdown...')
    
    // Save queue state
    await saveQueueToDisk()
    
    console.log('Graceful shutdown complete')
    process.exit(0)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// Log queue events for monitoring
avatarQueue.on('job-completed', (job) => {
    console.log(`✅ Avatar generated for ${job.data.username}`)
})

avatarQueue.on('job-failed', (job, error) => {
    console.error(`❌ Avatar generation failed for ${job.data.username}:`, error.message)
})

avatarQueue.on('job-retry', (job, error) => {
    console.log(`🔄 Retrying avatar generation for ${job.data.username} (attempt ${job.attempts})`)
})

export default { 
    getAvatar, 
    clearAllCaches, 
    handleCacheClear, 
    getQueueStats,
    avatarGenerationQueue: avatarQueue 
}