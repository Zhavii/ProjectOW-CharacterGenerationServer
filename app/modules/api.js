import { xxHash32 } from 'js-xxhash'
import uploadContent from './uploadContent.js'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { LRUCache } from 'lru-cache'
import crypto from 'crypto'
import AWS from 'aws-sdk'

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
(async () => {
    try {
        await fs.mkdir(AVATARS_DIR, { recursive: true })
        await fs.mkdir(CACHE_DIR, { recursive: true })
    } catch (error) {
        console.error('Failed to create directories:', error)
    }
})()

// In-memory cache for both avatar buffers and processed results
const avatarCache = new LRUCache({
    max: 20,
    ttl: 1000 * 60 * 60, // 1 hour TTL
    updateAgeOnGet: true
})

const memoryCache = new LRUCache({
    max: 100,
})

// Pre-initialize sharp for better performance
sharp.cache(true)
sharp.concurrency(2)

const getParams = (username) => {
    return {
        Bucket: process.env.DO_SPACE_NAME,
        Key: `user-clothing/${username}.webp`,
        Expires: 3600
    }
}

const getAvatar = async (req, res) => {
    try {
        const type = req.params.type
        const username = req.params.username
        
        // Find user with minimal projection
        const user = await User.findOne(
            { username }, 
            'username customization customizationHash clothing thumbnail avatar', 
            { lean: true }
        )
        
        if (!user) {
            return res.status(404).send('User not found.')
        }

        // Calculate hash only once
        const hash = xxHash32(JSON.stringify({ 
            username: user.username, 
            customization: user.customization 
        }), 0).toString()

        // Handle sprite type
        if (type === 'sprite' && user.customizationHash === hash) {
            try {
                const signedUrl = await s3.getSignedUrlPromise('getObject', getParams(username))
                return res.status(307).redirect(signedUrl)
            } catch (error) {
                console.error('Error generating signed URL:', error)
                // Fall through to regenerate
            }
        }

        // Check memory cache for non-sprite types
        if (type !== 'sprite') {
            const cachedAvatar = avatarCache.get(hash)
            if (cachedAvatar) {
                res.set('Content-Type', 'image/webp')
                return res.status(200).send(cachedAvatar)
            }
        }

        // Check disk cache for non-sprite types
        if (user.customizationHash === hash && type !== 'sprite') {
            try {
                const avatarPath = path.join(AVATARS_DIR, `${hash}.webp`)
                const stats = await fs.stat(avatarPath)
                if (stats.isFile()) {
                    const buffer = await fs.readFile(avatarPath)
                    avatarCache.set(hash, buffer)
                    res.set('Content-Type', 'image/webp')
                    return res.status(200).send(buffer)
                }
            } catch (error) {
                // File doesn't exist, will regenerate
            }
        }

        // Generate avatar if needed
        const generatedAvatar = await createAvatarThumbnail(user, hash, type, res)
        
        if (type !== 'sprite' && generatedAvatar) {
            res.set('Content-Type', 'image/webp')
            return res.status(200).send(generatedAvatar)
        }
    } catch (error) {
        console.error('Avatar generation error:', error)
        res.status(500).send('Error generating avatar')
    }
}

const createAvatarThumbnail = async (user, hash, type, res) => {
    try {
        // Determine base image
        const skinTone = user.customization.skinTone ?? 0
        const baseFileName = user.customization.isMale ? `male_${skinTone}.png` : `female_${skinTone}.png`
        const baseDir = path.join(process.cwd(), '_bases', baseFileName)
        
        let baseBuffer
        try {
            baseBuffer = await fs.readFile(baseDir)
        } catch (error) {
            console.error('Failed to load base image:', error)
            return null
        }

        // Load all customization images
        const loadedImages = await loadAllImages(user.customization)

        // Check special conditions
        let shoesBehindPants = false
        if (user.customization.bottom) {
            try {
                const pants = await Item.findById(user.customization.bottom, 'description').lean()
                shoesBehindPants = pants?.description?.includes('!x') || false
            } catch (error) {
                console.error('Failed to check pants:', error)
            }
        }

        let hairInfrontTop = false
        if (user.customization.hair) {
            try {
                const hair = await Item.findById(user.customization.hair, 'description').lean()
                hairInfrontTop = hair?.description?.includes('!s') || false
            } catch (error) {
                console.error('Failed to check hair:', error)
            }
        }

        // Generate sprite sheet
        const spriteSheet = await generateFullSpriteSheet(
            baseBuffer, 
            loadedImages, 
            shoesBehindPants, 
            hairInfrontTop
        )

        if (!spriteSheet) {
            console.error('Failed to generate sprite sheet')
            return null
        }

        // Generate front-facing avatar
        const frontFacingAvatar = await cropImage(spriteSheet, 0, 0, 425, 850)
        const frontFacingBuffer = await sharp(frontFacingAvatar)
            .webp({ quality: 95 })
            .toBuffer()

        // Save to disk cache
        try {
            const filePath = path.join(AVATARS_DIR, `${hash}.webp`)
            await fs.writeFile(filePath, frontFacingBuffer)
        } catch (error) {
            console.error('Failed to save avatar to disk:', error)
        }

        // Update memory cache
        avatarCache.set(hash, frontFacingBuffer)

        // Generate thumbnail
        const thumbnail = await cropImage(spriteSheet, 103, 42, 218, 218)

        // Upload to S3 (fire and forget)
        uploadToS3(user, spriteSheet, thumbnail, frontFacingBuffer, hash).catch(error => {
            console.error('Failed to upload to S3:', error)
        })

        if (type === 'sprite') {
            try {
                const signedUrl = await s3.getSignedUrlPromise('getObject', getParams(user.username))
                return res.status(307).redirect(signedUrl)
            } catch (error) {
                console.error('Failed to generate signed URL after upload:', error)
                res.status(500).send('Error generating sprite URL')
                return null
            }
        }

        return frontFacingBuffer
    } catch (error) {
        console.error('Error in createAvatarThumbnail:', error)
        return null
    }
}

const uploadToS3 = async (user, spriteSheet, thumbnail, frontFacingBuffer, hash) => {
    try {
        // Upload generated images
        user.clothing = await uploadContent(
            user.clothing, 
            { data: spriteSheet }, 
            'user-clothing', 
            5, 
            "DONT", 
            undefined, 
            user.username
        )
        
        user.thumbnail = await uploadContent(
            user.thumbnail, 
            { data: thumbnail }, 
            'user-thumbnail', 
            5, 
            undefined, 
            undefined, 
            user.username
        )
        
        user.avatar = await uploadContent(
            user.avatar, 
            { data: frontFacingBuffer }, 
            'user-avatar', 
            5, 
            "N", 
            undefined, 
            user.username
        )

        // Update user
        await User.updateOne(
            { username: user.username },
            {
                customizationHash: hash,
                clothing: user.clothing,
                thumbnail: user.thumbnail,
                avatar: user.avatar
            },
            { timestamps: false }
        )
    } catch (error) {
        console.error('Failed to update user after upload:', error)
    }
}

const loadAllImages = async (customization) => {
    const images = {}
    
    // Define all image fields to load
    const fields = [
        'makeup', 'hair', 'beard', 'eyes', 'eyebrows', 'head', 
        'nose', 'mouth', 'hat', 'piercings', 'earPiece', 'glasses', 
        'horns', 'top', 'necklace', 'neckwear', 'coat', 'belt', 
        'bottom', 'socks', 'shoes', 'bracelets', 'wings', 'bag', 
        'gloves', 'handheld'
    ]

    // Load regular fields
    for (const field of fields) {
        images[field] = await getImageBuffer(customization[field])
    }

    // Load tattoos
    if (customization.tattoos) {
        const tattooFields = [
            'head', 'neck', 'chest', 'stomach', 'backUpper', 
            'backLower', 'armRight', 'armLeft', 'legRight', 'legLeft'
        ]
        
        for (const field of tattooFields) {
            images[`tattoo_${field}`] = await getImageBuffer(customization.tattoos[field])
        }
    }

    return images
}

const getImageBuffer = async (item) => {
    if (!item || item === '') return null

    const itemId = item.toString()
    const cacheKey = itemId.toLowerCase()

    // Check memory cache
    const memCached = memoryCache.get(cacheKey)
    if (memCached) return memCached

    try {
        // Check disk cache
        const diskCacheKey = crypto.createHash('md5').update(cacheKey).digest('hex')
        const diskCachePath = path.join(CACHE_DIR, `${diskCacheKey}.png`)
        
        try {
            const diskData = await fs.readFile(diskCachePath)
            memoryCache.set(cacheKey, diskData)
            return diskData
        } catch (error) {
            // File not in disk cache, continue to fetch
        }

        // Fetch from S3
        const response = await axios.get(
            `https://${process.env.DO_SPACE_ENDPOINT}item-sprite/${itemId}.webp`,
            { 
                responseType: 'arraybuffer',
                timeout: 10000 // 10 second timeout
            }
        )
        
        // Convert to PNG for consistency
        const pngBuffer = await sharp(response.data)
            .png()
            .toBuffer()

        // Store in caches
        memoryCache.set(cacheKey, pngBuffer)
        
        // Save to disk cache (don't await)
        fs.writeFile(diskCachePath, pngBuffer).catch(error => {
            console.error(`Failed to save to disk cache: ${error.message}`)
        })

        return pngBuffer
    } catch (error) {
        console.error(`Failed to load image for ${itemId}:`, error.message)
        return null
    }
}

const generateFullSpriteSheet = async (baseBuffer, layers, shoesBehindPants, hairInfrontTop) => {
    try {
        // Create sprite sheet by compositing each direction
        const spriteWidth = 2550
        const spriteHeight = 850
        const directionWidth = 425
        
        // Create empty sprite sheet
        let spriteSheet = await sharp({
            create: {
                width: spriteWidth,
                height: spriteHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        }).png().toBuffer()

        // Generate each direction
        for (let direction = 0; direction < 6; direction++) {
            const directionAvatar = await generateDirectionalAvatar(
                direction, 
                baseBuffer, 
                layers, 
                shoesBehindPants, 
                hairInfrontTop
            )
            
            if (directionAvatar) {
                // Composite this direction onto the sprite sheet
                spriteSheet = await sharp(spriteSheet)
                    .composite([{
                        input: directionAvatar,
                        left: direction * directionWidth,
                        top: 0
                    }])
                    .png()
                    .toBuffer()
            }
        }

        return spriteSheet
    } catch (error) {
        console.error('Error generating sprite sheet:', error)
        return null
    }
}

const generateDirectionalAvatar = async (direction, baseBuffer, layers, shoesBehindPants, hairInfrontTop) => {
    try {
        const width = 425
        const height = 850
        const sourceX = direction * width

        // Start with base image
        let compositeOps = []
        
        // Get layer order for this direction
        const layerOrder = getLayerOrder(direction)
        
        for (const layerName of layerOrder) {
            let layerBuffer = null
            
            // Handle special layer logic
            if (layerName === 'base') {
                layerBuffer = baseBuffer
            } else if (layerName === 'shoes_before' && !shoesBehindPants) {
                layerBuffer = layers.shoes
            } else if (layerName === 'shoes_after' && shoesBehindPants) {
                layerBuffer = layers.shoes
            } else if (layerName === 'hair_behind' && !hairInfrontTop) {
                layerBuffer = layers.hair
            } else if (layerName === 'hair_infront' && hairInfrontTop) {
                layerBuffer = layers.hair
            } else {
                layerBuffer = layers[layerName]
            }
            
            if (!layerBuffer) continue

            // Extract the correct portion of the sprite
            try {
                const extractedPortion = await sharp(layerBuffer)
                    .extract({ left: sourceX, top: 0, width, height })
                    .png()
                    .toBuffer()
                
                compositeOps.push({
                    input: extractedPortion,
                    top: 0,
                    left: 0
                })
            } catch (error) {
                console.error(`Failed to extract layer ${layerName}:`, error.message)
            }
        }

        // Create the final composite image
        if (compositeOps.length === 0) return null
        
        const result = await sharp({
            create: {
                width,
                height,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        })
        .composite(compositeOps)
        .png()
        .toBuffer()

        return result
    } catch (error) {
        console.error(`Error generating directional avatar for direction ${direction}:`, error)
        return null
    }
}

const getLayerOrder = (direction) => {
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
    // Side views (1, 4)
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
    // Three-quarter views (2, 5)
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

const cropImage = async (sourceBuffer, x, y, width, height) => {
    try {
        return await sharp(sourceBuffer)
            .extract({ left: x, top: y, width, height })
            .toBuffer()
    } catch (error) {
        console.error('Error cropping image:', error)
        return null
    }
}

// Cleanup old avatars periodically
const cleanupOldAvatars = async () => {
    try {
        const files = await fs.readdir(AVATARS_DIR)
        const now = Date.now()
        const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days
        
        for (const file of files) {
            try {
                const filePath = path.join(AVATARS_DIR, file)
                const stats = await fs.stat(filePath)
                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filePath)
                }
            } catch (error) {
                console.error(`Error cleaning up file ${file}:`, error)
            }
        }
    } catch (error) {
        console.error('Error during cleanup:', error)
    }
}

// Run cleanup periodically
setInterval(cleanupOldAvatars, 24 * 60 * 60 * 1000) // Once per day

const clearAllCaches = async () => {
    const results = {
        memoryCachesCleared: false,
        diskCacheCleared: false,
        errors: []
    }

    try {
        // Clear memory caches
        avatarCache.clear()
        memoryCache.clear()
        results.memoryCachesCleared = true
    } catch (error) {
        results.errors.push({
            type: 'memory_cache',
            error: error.message
        })
    }

    try {
        // Clear disk cache
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
        if (error.code !== 'ENOENT') {
            results.errors.push({
                type: 'disk_cache_dir',
                error: error.message
            })
        }
    }

    // Recreate cache directory
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true })
    } catch (error) {
        results.errors.push({
            type: 'cache_dir_creation',
            error: error.message
        })
    }

    return results
}

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

export default { getAvatar, clearAllCaches, handleCacheClear }