import { xxHash32 } from 'js-xxhash'
import { createCanvas, loadImage } from 'canvas'
import uploadContent from './uploadContent.js'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { LRUCache } from 'lru-cache'
import crypto from 'crypto'
import { Worker } from 'worker_threads'
import os from 'os'

import User from '../models/User.js'

// In-memory cache for both avatar buffers and processed results
const avatarCache = new LRUCache({
    max: 1000, // Adjust based on memory constraints
    ttl: 1000 * 60 * 60, // 1 hour TTL
    updateAgeOnGet: true
})

// Pre-initialize sharp for better performance
sharp.cache(true)
sharp.concurrency(1) // Adjust based on server CPU cores

const targetR = 0
const targetG = 255
const targetB = 4
const toleranceR = 50
const toleranceG = 150
const toleranceB = 50

const rMin = targetR - toleranceR
const rMax = targetR + toleranceR
const gMin = targetG - toleranceG
const gMax = targetG + toleranceG
const bMin = targetB - toleranceB
const bMax = targetB + toleranceB

const isColorSimilar = (r, g, b) => {
    return r >= rMin && r <= rMax &&
           g >= gMin && g <= gMax &&
           b >= bMin && b <= bMax
}

const getAvatar = async (req, res) => {
    try {
        const username = req.params.username
        
        // Find user with minimal projection
        const user = await User.findOne({ username }, 'username customization customizationHash clothing thumbnail', { lean: true })
        console.log(user)
        
        if (!user) {
            return res.status(404).send('User not found.')
        }

        // Calculate hash only once
        const hash = xxHash32(JSON.stringify({ username: user.username, customization: user.customization }), 0).toString()

        // Check if file exists without loading it first
        const avatarPath = path.join(process.cwd(), 'avatars', `${hash}.webp`)
        
        try {
            if (user.customizationHash === hash) {
                // First check memory cache using username as key
                const cachedAvatar = avatarCache.get(username)
                if (cachedAvatar) {
                    return res.status(200).send(cachedAvatar)
                }

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
        const generatedAvatar = await createAvatarThumbnail(user, hash)
        
        // Update cache and hash
        avatarCache.set(username, generatedAvatar)
        
        // Send response immediately
        res.status(200).send(generatedAvatar)
        
        // Update user hash asynchronously
        if (user.customizationHash !== hash) {
            User.updateOne(
                { username }, 
                { customizationHash: hash, clothing: user.clothing, thumbnail: user.thumbnail },
                { timestamps: false } // Disable automatic timestamp updates
            ).catch(console.error)
        }

    } 
    catch (error) {
        console.error('Avatar generation error:', error)
        res.status(500).send('Error generating avatar')
    }
}

const createAvatarThumbnail = async (user, hash) => {
    return new Promise(async (resolve, reject) => {
        let base = ''
        if (user.customization.isMale && user.customization.bodyType == 0)
            base = 'male_fit.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/male_fit.png'
        else if (user.customization.isMale && user.customization.bodyType == 1)
            base = 'male_fat.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/male_fat.png'
        else if (!user.customization.isMale && user.customization.bodyType == 0)
            base = 'female_fit.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/female_fit.png'
        else if (!user.customization.isMale && user.customization.bodyType == 1)
            base = 'female_fat.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/female_fat.png'
        try {
            const baseDir = path.join(process.cwd(), 'bases', base)
            base = await fs.readFile(baseDir)
        }
        catch (error) {
            console.error('Error loading base:', error)
        }
    
        base = await loadImage(base)
        let hair = await getImage(user.customization.hair.item)
        let beard = await getImage(user.customization.beard.item)
        let eyes = await getImage(user.customization.eyes.item)
        let eyebrows = await getImage(user.customization.eyebrows.item)
        let head = await getImage(user.customization.head)
        let nose = await getImage(user.customization.nose)
        let mouth = await getImage(user.customization.mouth)
        let hat = await getImage(user.customization.hat)
        let piercings = await getImage(user.customization.piercings)
        let glasses = await getImage(user.customization.glasses)
        let top = await getImage(user.customization.top)
        let coat = await getImage(user.customization.coat)
        let bottom = await getImage(user.customization.bottom)
        let foot = await getImage(user.customization.foot)
        let bracelets = await getImage(user.customization.bracelets)
        let neckwear = await getImage(user.customization.neckwear)
        let bag = await getImage(user.customization.bag)
        let gloves = await getImage(user.customization.gloves)
        let handheld = await getImage(user.customization.handheld)

        let tattoosHead = await getImage(user.customization.tattoos?.head)
        let tattoosNeck = await getImage(user.customization.tattoos?.neck)
        let tattoosChest = await getImage(user.customization.tattoos?.chest)
        let tattoosStomach = await getImage(user.customization.tattoos?.stomach)
        let tattoosBackUpper = await getImage(user.customization.tattoos?.backUpper)
        let tattoosBackLower = await getImage(user.customization.tattoos?.backLower)
        let tattoosArmRight = await getImage(user.customization.tattoos?.armRight)
        let tattoosArmLeft = await getImage(user.customization.tattoos?.armLeft)
        let tattoosLegRight = await getImage(user.customization.tattoos?.legRight)
        let tattoosLegLeft = await getImage(user.customization.tattoos?.legLeft)
    
        let generatedAvatar = await generateAvatar(425, 850, 0, 0, 425, 850, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
        generatedAvatar = await sharp(generatedAvatar).webp({ quality: 100 }).toBuffer()

        try {
            const avatarsDir = path.join(process.cwd(), 'avatars')
            await fs.mkdir(avatarsDir, { recursive: true })

            let filePath = path.join(avatarsDir, `${hash}.webp`)
            await fs.writeFile(filePath, generatedAvatar)
        }
        catch (error) {
            console.error('Error saving avatar:', error)
        }

        // return/resolve early so that we don't make the client wait
        resolve(generatedAvatar)

        // we generate this afterwards because we don't want to keep the client waiting
        let generatedSpriteSheet = await generateAvatar(2550, 850, 0, 0, 2550, 850, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
        let generatedThumbnail = await cropImage(generatedSpriteSheet, 103, 42, 218, 218)
        user.clothing = await uploadContent(user.clothing, { data: generatedSpriteSheet }, 'user-clothing', 5, "DONT", undefined, user.username)
        user.thumbnail = await uploadContent(user.thumbnail, { data: generatedThumbnail }, 'user-thumbnail', 5, undefined, undefined, user.username)
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

/**
 * Generates an avatar image by drawing various elements onto a canvas.
 * 
 * @param {number} canvasSizeX - The width of the canvas.
 * @param {number} canvasSizeY - The height of the canvas.
 * @param {number} sourceStartPositionX - X-coordinate of the source's top-left corner.
 * @param {number} sourceStartPositionY - Y-coordinate of the source's top-left corner.
 * @param {number} sourceWidth - The width of the source element.
 * @param {number} sourceHeight - The height of the source element.
**/
const generateAvatar = async (canvasSizeX, canvasSizeY, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft) => {
    return new Promise(async (resolve, reject) => {
        const canvas = createCanvas(canvasSizeX, canvasSizeY)
        const ctx = canvas.getContext('2d')

        if (base)
            ctx.drawImage(base, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosHead)
            ctx.drawImage(tattoosHead, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosNeck)
            ctx.drawImage(tattoosNeck, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosChest)
            ctx.drawImage(tattoosChest, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosStomach)
            ctx.drawImage(tattoosStomach, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosBackUpper)
            ctx.drawImage(tattoosBackUpper, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosBackLower)
            ctx.drawImage(tattoosBackLower, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosArmRight)
            ctx.drawImage(tattoosArmRight, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosArmLeft)
            ctx.drawImage(tattoosArmLeft, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosLegRight)
            ctx.drawImage(tattoosLegRight, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (tattoosLegLeft)
            ctx.drawImage(tattoosLegLeft, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (eyes)
            ctx.drawImage(eyes, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (hair) {
            if (hat)
            {
                let hairWithoutHat = await removePixelsByImage(hair, hat)
                hairWithoutHat = await loadImage(hairWithoutHat)
                ctx.drawImage(hairWithoutHat, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
                
                let hatWithoutMask = await removePixelsByColor(hat)
                hatWithoutMask = await loadImage(hatWithoutMask)
                ctx.drawImage(hatWithoutMask, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
            }
            else
            {
                ctx.drawImage(hair, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
            }
        }
        if (beard)
            ctx.drawImage(beard, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (eyebrows)
            ctx.drawImage(eyebrows, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (head)
            ctx.drawImage(head, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (nose)
            ctx.drawImage(nose, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (mouth)
            ctx.drawImage(mouth, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (hat && !hair) {
            let hatWithoutMask = await removePixelsByColor(hat)
            hatWithoutMask = await loadImage(hatWithoutMask)
            ctx.drawImage(hatWithoutMask, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        }
        if (piercings)
            ctx.drawImage(piercings, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (glasses)
            ctx.drawImage(glasses, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (bracelets)
            ctx.drawImage(bracelets, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (neckwear)
            ctx.drawImage(neckwear, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (bottom)
            ctx.drawImage(bottom, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (gloves)
            ctx.drawImage(gloves, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (handheld)
            ctx.drawImage(handheld, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (top)
            ctx.drawImage(top, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (coat)
            ctx.drawImage(coat, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (foot)
            ctx.drawImage(foot, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        if (bag)
            ctx.drawImage(bag, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)

        const data = canvas.toBuffer()
        resolve(data)
    })
}

// Process a chunk of pixels
const processPixelChunk = (sourceData, start, end, maskData = null) => {
    for (let i = start; i < end; i += 4) {
        if (maskData) {
            // Using mask image logic
            const maskR = maskData[i]
            const maskG = maskData[i + 1]
            const maskB = maskData[i + 2]
            const maskA = maskData[i + 3]

            // If mask pixel is opaque and matches our target color
            if (maskA === 255 && isColorSimilar(maskR, maskG, maskB)) {
                // Make the corresponding source pixel transparent
                sourceData[i + 3] = 0
            }
        } else {
            // Direct color removal logic
            const sourceA = sourceData[i + 3]
            if (sourceA === 255) {
                const sourceR = sourceData[i]
                const sourceG = sourceData[i + 1]
                const sourceB = sourceData[i + 2]

                if (isColorSimilar(sourceR, sourceG, sourceB)) {
                    sourceData[i + 3] = 0
                }
            }
        }
    }
}

// Get optimal chunk size based on image size and CPU cores
const getChunkSize = (totalPixels) => {
    const cpuCount = os.cpus().length
    return Math.ceil(totalPixels / (cpuCount * 4)) * 4
}

async function removePixelsByImage(sourceImagePath, maskImagePath) {
    try {
        // Load both images
        let sourceImage = sourceImagePath
        let maskImage = maskImagePath

        // Validate images
        if (!sourceImage || !maskImage || 
            sourceImage.width !== maskImage.width || 
            sourceImage.height !== maskImage.height) {
            throw new Error('Invalid or mismatched image dimensions')
        }

        // Create canvases
        let sourceCanvas = createCanvas(sourceImage.width, sourceImage.height)
        let maskCanvas = createCanvas(maskImage.width, maskImage.height)
        
        let sourceCtx = sourceCanvas.getContext('2d')
        let maskCtx = maskCanvas.getContext('2d')

        // Draw images
        sourceCtx.drawImage(sourceImage, 0, 0)
        maskCtx.drawImage(maskImage, 0, 0)

        // Get image data
        let sourceImageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)
        let maskImageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)

        const totalPixels = sourceImageData.data.length
        const chunkSize = getChunkSize(totalPixels)
        const chunks = Math.ceil(totalPixels / chunkSize)

        // Process chunks in parallel
        const promises = []
        for (let i = 0; i < chunks; i++) {
            const start = i * chunkSize
            const end = Math.min(start + chunkSize, totalPixels)
            promises.push(
                new Promise((resolve) => {
                    processPixelChunk(
                        sourceImageData.data,
                        start,
                        end,
                        maskImageData.data
                    )
                    resolve()
                })
            )
        }

        await Promise.all(promises)

        // Put modified image data back to canvas
        sourceCtx.putImageData(sourceImageData, 0, 0)
        return sourceCanvas.toBuffer()
    } 
    catch (error) {
        console.error('Error processing images:', error)
        throw error
    }
}

async function removePixelsByColor(sourceImage) {
    try {
        // Validate input
        if (!sourceImage) {
            throw new Error('Invalid source image')
        }

        let sourceCanvas = createCanvas(sourceImage.width, sourceImage.height)
        let sourceCtx = sourceCanvas.getContext('2d')
        sourceCtx.drawImage(sourceImage, 0, 0)
        let sourceImageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)

        const totalPixels = sourceImageData.data.length
        const chunkSize = getChunkSize(totalPixels)
        const chunks = Math.ceil(totalPixels / chunkSize)

        // Process chunks in parallel
        const promises = []
        for (let i = 0; i < chunks; i++) {
            const start = i * chunkSize
            const end = Math.min(start + chunkSize, totalPixels)
            promises.push(
                new Promise((resolve) => {
                    processPixelChunk(
                        sourceImageData.data,
                        start,
                        end
                    )
                    resolve()
                })
            )
        }

        await Promise.all(promises)

        // Put modified image data back to canvas
        sourceCtx.putImageData(sourceImageData, 0, 0)
        return sourceCanvas.toBuffer()
    }
    catch (error) {
        console.error('Error processing images:', error)
        throw error
    }
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

export default { getAvatar }