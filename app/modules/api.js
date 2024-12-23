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

import User from '../models/User.js'
import Item from '../models/Item.js'

const spacesEndpoint = new AWS.Endpoint(process.env.DO_ENDPOINT)
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.DO_SPACE_ID,
  secretAccessKey: process.env.DO_SPACE_KEY
});

// In-memory cache for both avatar buffers and processed results
const avatarCache = new LRUCache({
    max: 100, // Adjust based on memory constraints
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
        const hash = xxHash32(JSON.stringify({ username: user.username, customization: user.customization }), 0).toString()

        if (type === 'sprite' && user.customizationHash === hash) {
            const signedUrl = await s3.getSignedUrlPromise('getObject', getParams(username))
            return res.status(307).redirect(signedUrl)
        }

        if (type !== 'sprite') {
            // First check memory cache using username as key
            const cachedAvatar = avatarCache.get(hash)
            if (cachedAvatar) {
                return res.status(200).send(cachedAvatar)
            }
        }

        // Check if file exists without loading it first
        const avatarPath = path.join(process.cwd(), 'avatars', `${hash}.webp`)
        
        try {
            if (user.customizationHash === hash && type !== 'sprite') {
                const stats = await fs.stat(avatarPath)
                if (stats.isFile()) {
                    // Stream the file instead of loading into memory
                    const buffer = await fs.readFile(avatarPath)
                    avatarCache.set(username, buffer)
                    return res.status(200).send(buffer)
                }
            }
        } catch (error) {
            // File doesn't exist or other error, continue to generation
        }

        // Generate avatar if needed
        const generatedAvatar = await createAvatarThumbnail(user, hash, type, res)
        
        // Update cache and hash
        avatarCache.set(hash, generatedAvatar)
        
        if (type !== 'sprite') {
            // Send response immediately
            return res.status(200).send(generatedAvatar)
        }
    } 
    catch (error) {
        console.error('Avatar generation error:', error)
        res.status(500).send('Error generating avatar')
    }
}

const createAvatarThumbnail = async (user, hash, type, res) => {
    return new Promise(async (resolve, reject) => {
        try {
            // Determine base image based on user customization
            let skinTone = user.customization.skinTone ?? 0
            let base = user.customization.isMale ? `male_${skinTone}.png` : `female_${skinTone}.png`
            
            try {
                const baseDir = path.join(process.cwd(), '_bases', base)
                base = await fs.readFile(baseDir)
            }
            catch (error) {
                console.error('Error loading base:', error)
                throw error
            }

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
                shoesBehindPants = pants.description.includes('!x')
            }

            let hairInfrontTop = false
            if (user.customization.hair) {
                const hair = await Item.findById(user.customization.hair, 'description').lean()
                hairInfrontTop = hair.description.includes('!s')
            }

            // Generate front-facing avatar for thumbnail
            const frontFacingAvatar = await generateDirectionalAvatar(0, loadedImages, shoesBehindPants, hairInfrontTop)
            const frontFacingBuffer = await sharp(frontFacingAvatar).webp({ quality: 100 }).toBuffer()

            try {
                const avatarsDir = path.join(process.cwd(), 'avatars')
                await fs.mkdir(avatarsDir, { recursive: true })
                const filePath = path.join(avatarsDir, `${hash}.webp`)
                await fs.writeFile(filePath, frontFacingBuffer)
            }
            catch (error) {
                console.error('Error saving avatar:', error)
            }

            // Update cache and resolve with front-facing avatar
            avatarCache.set(hash, frontFacingBuffer)
            resolve(frontFacingBuffer)

            // Generate full sprite sheet asynchronously
            if (type === 'sprite') {
                try {
                    const spriteSheet = await generateFullSpriteSheet(loadedImages, shoesBehindPants, hairInfrontTop)
                    
                    // Generate thumbnail from sprite sheet
                    const thumbnail = await cropImage(spriteSheet, 103, 42, 218, 218)

                    // Upload generated images
                    user.clothing = await uploadContent(user.clothing, { data: spriteSheet }, 'user-clothing', 5, "DONT", undefined, user.username)
                    user.thumbnail = await uploadContent(user.thumbnail, { data: thumbnail }, 'user-thumbnail', 5, undefined, undefined, user.username)
                    user.avatar = await uploadContent(user.avatar, { data: frontFacingBuffer }, 'user-avatar', 5, "DONT", undefined, user.username)

                    // Update user asynchronously
                    const hash = xxHash32(JSON.stringify({ username: user.username, customization: user.customization }), 0).toString()
                    await User.updateOne(
                        { username: user.username },
                        {
                            customizationHash: hash,
                            clothing: user.clothing,
                            thumbnail: user.thumbnail,
                            avatar: user.avatar
                        },
                        { timestamps: false }
                    ).catch(console.error)

                    if (type === 'sprite') {
                        const signedUrl = await s3.getSignedUrlPromise('getObject', getParams(user.username))
                        return res.status(307).redirect(signedUrl)
                    }
                }
                catch (error) {
                    console.error('Error generating sprite sheet:', error)
                }
            }
        }
        catch (error) {
            console.error('Error generating avatar:', error)
            reject(error)
        }
    })
}

const memoryCache = new LRUCache({
    max: 500,
})

const CACHE_DIR = path.join(process.cwd(), 'cache');
(async () => {
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
            memoryCache.set(cacheKey, diskCached);
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
            if (key.startsWith('tattoos') && tattoo) {
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
        if (key.startsWith('tattoos') && key !== 'tattoos') {
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

export default { getAvatar, clearAllCaches, handleCacheClear }