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
import pLimit from 'p-limit'

import User from '../models/User.js'
import Item from '../models/Item.js'

const spacesEndpoint = new AWS.Endpoint(process.env.DO_ENDPOINT)
const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: process.env.DO_SPACE_ID,
    secretAccessKey: process.env.DO_SPACE_KEY
});

const AVATARS_DIR = path.join(process.cwd(), 'avatars');
const CACHE_DIR = path.join(process.cwd(), 'cache');

// Initialize directories
await fs.mkdir(AVATARS_DIR, { recursive: true })
await fs.mkdir(CACHE_DIR, { recursive: true })

// Pre-initialize sharp for better performance
sharp.cache(true)
sharp.concurrency(2)

// Limit concurrent operations to prevent memory spikes
const imageLoadLimit = pLimit(5)
const s3Limit = pLimit(3)

// Enhanced caching strategy with multiple levels
const caches = {
    // Final avatar buffers
    avatarCache: new LRUCache({
        max: 50,
        ttl: 1000 * 60 * 60 * 2, // 2 hours
        updateAgeOnGet: true,
        sizeCalculation: (value) => value.length,
        maxSize: 100 * 1024 * 1024 // 100MB max
    }),
    
    // Individual item images
    itemImageCache: new LRUCache({
        max: 200,
        ttl: 1000 * 60 * 60 * 4, // 4 hours
        updateAgeOnGet: true
    }),
    
    // Sprite sheet sections (for reuse)
    spriteCache: new LRUCache({
        max: 20,
        ttl: 1000 * 60 * 60, // 1 hour
        sizeCalculation: (value) => value.length,
        maxSize: 50 * 1024 * 1024 // 50MB max
    })
}

// Helper functions for S3 URLs
const getS3Params = (type, username) => ({
    Bucket: process.env.DO_SPACE_NAME,
    Key: type === 'sprite' 
        ? `user-clothing/${username}.webp`
        : `user-avatar/${username}.webp`,
    Expires: 3600
})

// Main avatar endpoint
const getAvatar = async (req, res) => {
    try {
        const { type, username } = req.params
        
        // Find user with minimal projection
        const user = await User.findOne(
            { username }, 
            'username customization customizationHash clothing thumbnail avatar',
            { lean: true }
        )
        
        if (!user) {
            return res.status(404).send('User not found.')
        }

        // Calculate hash for caching
        const hash = xxHash32(JSON.stringify({ 
            username: user.username, 
            customization: user.customization 
        }), 0).toString()

        // Check if we can serve from S3 directly
        if (user.customizationHash === hash) {
            const signedUrl = await s3.getSignedUrlPromise(
                'getObject', 
                getS3Params(type, username)
            )
            return res.status(307).redirect(signedUrl)
        }

        // For non-sprite requests, check memory cache first
        if (type !== 'sprite') {
            const cachedAvatar = caches.avatarCache.get(hash)
            if (cachedAvatar) {
                res.set('X-Cache', 'HIT')
                return res.status(200).send(cachedAvatar)
            }
        }

        // Generate avatar if needed
        const result = await generateAvatar(user, hash, type)
        
        if (type === 'sprite') {
            // Redirect to the newly uploaded sprite
            const signedUrl = await s3.getSignedUrlPromise(
                'getObject',
                getS3Params('sprite', username)
            )
            return res.status(307).redirect(signedUrl)
        } else {
            // Serve the generated avatar directly
            res.set('X-Cache', 'MISS')
            return res.status(200).send(result)
        }
    } catch (error) {
        console.error('Avatar generation error:', error)
        res.status(500).send('Error generating avatar')
    }
}

// Optimized avatar generation
const generateAvatar = async (user, hash, type) => {
    try {
        // Determine skin tone and base image
        const skinTone = user.customization.skinTone ?? 0
        const baseName = user.customization.isMale 
            ? `male_${skinTone}.png` 
            : `female_${skinTone}.png`
        
        // Load base image
        const baseDir = path.join(process.cwd(), '_bases', baseName)
        const baseBuffer = await fs.readFile(baseDir)
        const baseImage = await loadImage(baseBuffer)

        // Prepare item IDs for batch loading
        const itemIds = [
            user.customization.makeup,
            user.customization.hair,
            user.customization.beard,
            user.customization.eyes,
            user.customization.eyebrows,
            user.customization.head,
            user.customization.nose,
            user.customization.mouth,
            user.customization.hat,
            user.customization.piercings,
            user.customization.earPiece,
            user.customization.glasses,
            user.customization.horns,
            user.customization.top,
            user.customization.necklace,
            user.customization.neckwear,
            user.customization.coat,
            user.customization.belt,
            user.customization.bottom,
            user.customization.socks,
            user.customization.shoes,
            user.customization.bracelets,
            user.customization.wings,
            user.customization.bag,
            user.customization.gloves,
            user.customization.handheld,
            // Tattoos
            user.customization.tattoos?.head,
            user.customization.tattoos?.neck,
            user.customization.tattoos?.chest,
            user.customization.tattoos?.stomach,
            user.customization.tattoos?.backUpper,
            user.customization.tattoos?.backLower,
            user.customization.tattoos?.armRight,
            user.customization.tattoos?.armLeft,
            user.customization.tattoos?.legRight,
            user.customization.tattoos?.legLeft
        ].filter(Boolean)

        // Load all images in parallel with concurrency limit
        const imagePromises = itemIds.map(id => 
            imageLoadLimit(() => loadItemImage(id))
        )
        const loadedImages = await Promise.all(imagePromises)

        // Create image map
        const imageMap = {
            base: baseImage,
            makeup: loadedImages[0],
            hair: loadedImages[1],
            // ... map all images to their keys
        }

        // Check for special rendering rules
        const [bottomItem, hairItem] = await Promise.all([
            user.customization.bottom 
                ? Item.findById(user.customization.bottom, 'description').lean()
                : null,
            user.customization.hair
                ? Item.findById(user.customization.hair, 'description').lean()
                : null
        ])

        const shoesBehindPants = bottomItem?.description?.includes('!x') ?? false
        const hairInfrontTop = hairItem?.description?.includes('!s') ?? false

        let result

        if (type === 'sprite') {
            // Generate full sprite sheet only when needed
            result = await generateFullSpriteSheet(
                imageMap, 
                shoesBehindPants, 
                hairInfrontTop
            )
            
            // Upload sprite sheet and update user
            await updateUserAssets(user, result, hash)
        } else {
            // Generate only front-facing avatar for non-sprite requests
            result = await generateSingleDirectionAvatar(
                0, // front-facing
                imageMap,
                shoesBehindPants,
                hairInfrontTop
            )
            
            // Convert to WebP and cache
            const webpBuffer = await sharp(result)
                .webp({ quality: 95 })
                .toBuffer()
            
            caches.avatarCache.set(hash, webpBuffer)
            result = webpBuffer
        }

        return result
    } catch (error) {
        console.error('Error in generateAvatar:', error)
        throw error
    }
}

// Optimized image loading with multiple cache levels
const loadItemImage = async (itemId) => {
    if (!itemId) return null

    const cacheKey = itemId.toString().toLowerCase()
    
    // Check memory cache
    const cached = caches.itemImageCache.get(cacheKey)
    if (cached) return cached

    try {
        // Check disk cache
        const diskCacheKey = crypto.createHash('md5').update(cacheKey).digest('hex')
        const diskCachePath = path.join(CACHE_DIR, `${diskCacheKey}.png`)
        
        try {
            const diskData = await fs.readFile(diskCachePath)
            const image = await loadImage(diskData)
            caches.itemImageCache.set(cacheKey, image)
            return image
        } catch (err) {
            // File doesn't exist, continue to fetch
        }

        // Fetch from S3
        const response = await axios.get(
            `https://${process.env.DO_SPACE_ENDPOINT}item-sprite/${itemId}.webp`,
            { 
                responseType: 'arraybuffer',
                timeout: 10000,
                maxContentLength: 10 * 1024 * 1024 // 10MB max
            }
        )
        
        // Convert to PNG for canvas compatibility
        const pngBuffer = await sharp(response.data)
            .png()
            .toBuffer()
        
        const image = await loadImage(pngBuffer)
        
        // Store in caches
        caches.itemImageCache.set(cacheKey, image)
        
        // Write to disk cache asynchronously (don't wait)
        fs.writeFile(diskCachePath, pngBuffer).catch(err => 
            console.error(`Failed to write cache for ${itemId}:`, err.message)
        )
        
        return image
    } catch (error) {
        console.error(`Failed to load image for ${itemId}:`, error.message)
        return null
    }
}

// Generate only the specific direction needed
const generateSingleDirectionAvatar = async (
    direction, 
    layers, 
    shoesBehindPants, 
    hairInfrontTop
) => {
    const canvas = createCanvas(425, 850)
    const ctx = canvas.getContext('2d')
    
    // Get layer order for this direction
    const layerOrder = getLayerOrder(direction)
    
    // Draw layers
    for (const layerName of layerOrder) {
        const layer = getLayerForName(
            layerName, 
            layers, 
            shoesBehindPants, 
            hairInfrontTop
        )
        
        if (!layer) continue
        
        // Draw from the appropriate section of the sprite
        const sourceX = direction * 425
        ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
    }
    
    return canvas.toBuffer()
}

// Helper to get the correct layer based on special rules
const getLayerForName = (layerName, layers, shoesBehindPants, hairInfrontTop) => {
    switch (layerName) {
        case 'shoes_before':
            return !shoesBehindPants ? layers.shoes : null
        case 'shoes_after':
            return shoesBehindPants ? layers.shoes : null
        case 'hair_behind':
            return !hairInfrontTop ? layers.hair : null
        case 'hair_infront':
            return hairInfrontTop ? layers.hair : null
        default:
            return layers[layerName]
    }
}

// Get layer order based on direction
const getLayerOrder = (direction) => {
    const baseOrder = [
        "base",
        "tattoo_head", "tattoo_neck", "tattoo_chest", "tattoo_stomach",
        "tattoo_backUpper", "tattoo_backLower", "tattoo_armRight",
        "tattoo_armLeft", "tattoo_legRight", "tattoo_legLeft",
        "makeup", "eyes", "eyebrows", "head", "nose", "mouth", "beard"
    ]
    
    // Direction-specific orders
    const directionOrders = {
        0: [ // Front
            ...baseOrder,
            "wings", "glasses", "hair_behind", "socks", "shoes_before",
            "gloves", "bottom", "belt", "shoes_after", "bracelets", 
            "handheld", "top", "necklace", "coat", "neckwear", 
            "hair_infront", "piercings", "earPiece", "hat", "horns", "bag"
        ],
        1: [ // Side-left
            ...baseOrder,
            "glasses", "hair_behind", "socks", "shoes_before",
            "gloves", "bottom", "belt", "shoes_after", "bracelets",
            "handheld", "top", "necklace", "coat", "neckwear",
            "hair_infront", "piercings", "earPiece", "hat", "horns",
            "wings", "bag"
        ],
        3: [ // Back
            ...baseOrder,
            "socks", "shoes_before", "gloves", "bottom", "belt",
            "shoes_after", "bracelets", "handheld", "piercings",
            "earPiece", "glasses", "horns", "top", "necklace",
            "coat", "hair_infront", "hair_behind", "hat", "neckwear",
            "wings", "bag"
        ]
    }
    
    // Directions 2, 4, 5 can reuse patterns
    if (direction === 2 || direction === 5) {
        return directionOrders[1] // Similar to side view
    }
    if (direction === 4) {
        return directionOrders[1]
    }
    
    return directionOrders[direction] || directionOrders[0]
}

// Update user assets in database and S3
const updateUserAssets = async (user, spriteSheet, hash) => {
    try {
        // Generate thumbnail from sprite sheet
        const thumbnail = await sharp(spriteSheet, {
            raw: {
                width: 2550,
                height: 850,
                channels: 4
            }
        })
        .extract({ left: 103, top: 42, width: 218, height: 218 })
        .toBuffer()

        // Generate front-facing avatar
        const frontAvatar = await sharp(spriteSheet, {
            raw: {
                width: 2550,
                height: 850,
                channels: 4
            }
        })
        .extract({ left: 0, top: 0, width: 425, height: 850 })
        .webp({ quality: 95 })
        .toBuffer()

        // Upload all assets in parallel with concurrency limit
        const [clothingUrl, thumbnailUrl, avatarUrl] = await Promise.all([
            s3Limit(() => uploadContent(
                user.clothing, 
                { data: spriteSheet }, 
                'user-clothing', 
                5, 
                "DONT", 
                undefined, 
                user.username
            )),
            s3Limit(() => uploadContent(
                user.thumbnail,
                { data: thumbnail },
                'user-thumbnail',
                5,
                undefined,
                undefined,
                user.username
            )),
            s3Limit(() => uploadContent(
                user.avatar,
                { data: frontAvatar },
                'user-avatar',
                5,
                "N",
                undefined,
                user.username
            ))
        ])

        // Update user record
        await User.updateOne(
            { username: user.username },
            {
                customizationHash: hash,
                clothing: clothingUrl,
                thumbnail: thumbnailUrl,
                avatar: avatarUrl
            },
            { timestamps: false }
        )

        // Cache the front avatar
        caches.avatarCache.set(hash, frontAvatar)
    } catch (error) {
        console.error('Error updating user assets:', error)
        throw error
    }
}

// Generate full sprite sheet (only when absolutely needed)
const generateFullSpriteSheet = async (layers, shoesBehindPants, hairInfrontTop) => {
    // Check if we have a cached version
    const cacheKey = `sprite_${xxHash32(JSON.stringify({
        layerKeys: Object.keys(layers).sort(),
        shoesBehindPants,
        hairInfrontTop
    }), 0).toString()}`
    
    const cached = caches.spriteCache.get(cacheKey)
    if (cached) return cached

    const canvas = createCanvas(2550, 850)
    const ctx = canvas.getContext('2d')
    
    // Generate each direction
    await Promise.all(
        Array.from({ length: 6 }, async (_, direction) => {
            const directionBuffer = await generateSingleDirectionAvatar(
                direction,
                layers,
                shoesBehindPants,
                hairInfrontTop
            )
            const directionImage = await loadImage(directionBuffer)
            ctx.drawImage(directionImage, direction * 425, 0)
        })
    )
    
    const result = canvas.toBuffer()
    caches.spriteCache.set(cacheKey, result)
    return result
}

// Enhanced cache clearing with granular control
const clearCaches = async (options = {}) => {
    const { 
        memory = true, 
        disk = true, 
        specific = null 
    } = options
    
    const results = {
        cleared: [],
        errors: []
    }
    
    try {
        if (memory) {
            if (!specific || specific === 'all') {
                Object.entries(caches).forEach(([name, cache]) => {
                    cache.clear()
                    results.cleared.push(`memory:${name}`)
                })
            } else if (caches[specific]) {
                caches[specific].clear()
                results.cleared.push(`memory:${specific}`)
            }
        }
        
        if (disk) {
            const files = await fs.readdir(CACHE_DIR)
            const deletePromises = files.map(file =>
                fs.unlink(path.join(CACHE_DIR, file))
                    .catch(err => results.errors.push({
                        file,
                        error: err.message
                    }))
            )
            await Promise.all(deletePromises)
            results.cleared.push(`disk:${files.length} files`)
        }
    } catch (error) {
        results.errors.push({
            type: 'general',
            error: error.message
        })
    }
    
    return results
}

// Express middleware for cache management
const handleCacheClear = async (req, res) => {
    try {
        const { type = 'all', target = 'all' } = req.query
        
        const options = {
            memory: type === 'all' || type === 'memory',
            disk: type === 'all' || type === 'disk',
            specific: target
        }
        
        const results = await clearCaches(options)
        
        res.status(200).json({
            success: true,
            message: 'Cache clearing completed',
            details: results
        })
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to clear caches',
            error: error.message
        })
    }
}

// Periodic cleanup tasks
const startCleanupTasks = () => {
    // Clean old avatar files every 6 hours
    setInterval(async () => {
        try {
            const files = await fs.readdir(AVATARS_DIR)
            const now = Date.now()
            const maxAge = 24 * 60 * 60 * 1000 // 24 hours
            
            for (const file of files) {
                const filePath = path.join(AVATARS_DIR, file)
                const stats = await fs.stat(filePath)
                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filePath)
                }
            }
        } catch (error) {
            console.error('Cleanup error:', error)
        }
    }, 6 * 60 * 60 * 1000)
    
    // Trim caches based on memory usage
    setInterval(() => {
        const used = process.memoryUsage()
        const heapUsedMB = used.heapUsed / 1024 / 1024
        
        // If memory usage is high, trim caches
        if (heapUsedMB > 1500) { // 1.5GB threshold
            console.log('High memory usage detected, trimming caches...')
            Object.values(caches).forEach(cache => {
                cache.prune() // Remove expired items
            })
        }
    }, 60 * 1000) // Check every minute
}

// Start cleanup tasks
startCleanupTasks()

export default { 
    getAvatar, 
    clearCaches, 
    handleCacheClear 
}