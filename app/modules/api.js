import bcrypt from 'bcrypt'
import { xxHash32 } from 'js-xxhash'
import { createCanvas, loadImage } from 'canvas'
import uploadContent from './uploadContent.js'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

// Constants
const COLOR_TOLERANCE = {
    R: 50,
    G: 150,
    B: 50
}

const TARGET_COLOR = {
    R: 0,
    G: 255,
    B: 4
}

const CANVAS_DIMENSIONS = {
    STANDARD: { width: 425, height: 850 },
    SPRITE: { width: 2550, height: 850 },
    THUMBNAIL: { width: 218, height: 218 }
}

// Cache for loaded images
const imageCache = new Map()

// Helper Functions
const isColorSimilar = (r1, g1, b1) => {
    return Math.abs(r1 - TARGET_COLOR.R) <= COLOR_TOLERANCE.R &&
           Math.abs(g1 - TARGET_COLOR.G) <= COLOR_TOLERANCE.G &&
           Math.abs(b1 - TARGET_COLOR.B) <= COLOR_TOLERANCE.B
}

const getImageFromCache = async (item) => {
    if (!item) return null
    
    if (imageCache.has(item)) {
        return imageCache.get(item)
    }

    try {
        const response = await axios.get(
            `https://${process.env.DO_SPACE_ENDPOINT}item-sprite/${item}.webp`,
            { responseType: 'arraybuffer' }
        )
        const pngBuffer = await sharp(response.data).png().toBuffer()
        const image = await loadImage(pngBuffer)
        imageCache.set(item, image)
        return image
    } catch {
        return null
    }
}

const createCustomizedCanvas = async (width, height, components, sourceCoords = { x: 0, y: 0, width: 425, height: 850 }) => {
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')

    for (const [component, image] of Object.entries(components)) {
        if (!image) continue

        if (component === 'hair' && components.hat) {
            const hairWithoutHat = await removePixelsByImage(image, components.hat)
            const processedHair = await loadImage(hairWithoutHat)
            ctx.drawImage(processedHair, sourceCoords.x, sourceCoords.y, sourceCoords.width, sourceCoords.height, 0, 0, width, height)
            
            const hatWithoutMask = await removePixelsByColor(components.hat)
            const processedHat = await loadImage(hatWithoutMask)
            ctx.drawImage(processedHat, sourceCoords.x, sourceCoords.y, sourceCoords.width, sourceCoords.height, 0, 0, width, height)
        } else {
            ctx.drawImage(image, sourceCoords.x, sourceCoords.y, sourceCoords.width, sourceCoords.height, 0, 0, width, height)
        }
    }

    return canvas.toBuffer()
}

const removePixelsByImage = async (sourceImage, maskImage) => {
    const sourceCanvas = createCanvas(sourceImage.width, sourceImage.height)
    const sourceCtx = sourceCanvas.getContext('2d')
    sourceCtx.drawImage(sourceImage, 0, 0)
    
    const maskCanvas = createCanvas(maskImage.width, maskImage.height)
    const maskCtx = maskCanvas.getContext('2d')
    maskCtx.drawImage(maskImage, 0, 0)

    const sourceData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)
    const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)

    for (let i = 0; i < sourceData.data.length; i += 4) {
        if (maskData.data[i + 3] === 255 && 
            isColorSimilar(
                maskData.data[i],
                maskData.data[i + 1],
                maskData.data[i + 2]
            )) {
            sourceData.data[i + 3] = 0
        }
    }

    sourceCtx.putImageData(sourceData, 0, 0)
    return sourceCanvas.toBuffer()
}

const removePixelsByColor = async (sourceImage) => {
    const canvas = createCanvas(sourceImage.width, sourceImage.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(sourceImage, 0, 0)
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

    for (let i = 0; i < imageData.data.length; i += 4) {
        if (imageData.data[i + 3] === 255 && 
            isColorSimilar(
                imageData.data[i],
                imageData.data[i + 1],
                imageData.data[i + 2]
            )) {
            imageData.data[i + 3] = 0
        }
    }

    ctx.putImageData(imageData, 0, 0)
    return canvas.toBuffer()
}

const generateAvatarFiles = async (user, hash) => {
    const componentImages = {
        base: await getBaseImage(user.customization),
        ...await loadCustomizationImages(user.customization)
    }

    // Generate main avatar
    const avatar = await createCustomizedCanvas(
        CANVAS_DIMENSIONS.STANDARD.width,
        CANVAS_DIMENSIONS.STANDARD.height,
        componentImages
    )
    
    // Convert to WebP and save
    const avatarWebp = await sharp(avatar).webp({ quality: 100 }).toBuffer()
    await saveFile(hash, avatarWebp)

    // Async generation of sprite sheet and thumbnail
    generateAdditionalAssets(user, componentImages, hash).catch(console.error)

    return avatarWebp
}

const generateAdditionalAssets = async (user, componentImages, hash) => {
    // Generate sprite sheet
    const spriteSheet = await createCustomizedCanvas(
        CANVAS_DIMENSIONS.SPRITE.width,
        CANVAS_DIMENSIONS.SPRITE.height,
        componentImages
    )

    // Generate thumbnail from sprite sheet
    const thumbnail = await createCustomizedCanvas(
        CANVAS_DIMENSIONS.THUMBNAIL.width,
        CANVAS_DIMENSIONS.THUMBNAIL.height,
        componentImages,
        { x: 103, y: 42, width: 218, height: 218 }
    )

    // Convert and upload
    const [spriteWebp, thumbnailWebp] = await Promise.all([
        sharp(spriteSheet).webp({ quality: 100 }).toBuffer(),
        sharp(thumbnail).webp({ quality: 80 }).toBuffer()
    ])

    await Promise.all([
        uploadContent(user.clothing, { data: spriteWebp }, 'user-clothing', 5, "DONT", undefined, user.username),
        uploadContent(user.thumbnail, { data: thumbnailWebp }, 'user-thumbnail', 5, undefined, undefined, user.username),
        saveFile(`${hash}_spritesheet`, spriteWebp),
        saveFile(`${hash}_thumbnail`, thumbnailWebp)
    ])
}

const saveFile = async (filename, buffer) => {
    const avatarsDir = path.join(process.cwd(), 'avatars')
    await fs.mkdir(avatarsDir, { recursive: true })
    await fs.writeFile(path.join(avatarsDir, `${filename}.webp`), buffer)
}

const getBaseImage = async (customization) => {
    const baseFileName = `${customization.isMale ? 'male' : 'female'}_${customization.bodyType === 0 ? 'fit' : 'fat'}.png`
    const baseBuffer = await fs.readFile(path.join(process.cwd(), 'bases', baseFileName))
    return await loadImage(baseBuffer)
}

const loadCustomizationImages = async (customization) => {
    const components = [
        'hair', 'beard', 'eyes', 'eyebrows', 'head', 'nose', 'mouth', 'hat',
        'piercings', 'glasses', 'top', 'coat', 'bottom', 'foot', 'bracelets',
        'neckwear', 'bag', 'gloves', 'handheld'
    ]

    const tattooComponents = [
        'head', 'neck', 'chest', 'stomach', 'backUpper', 'backLower',
        'armRight', 'armLeft', 'legRight', 'legLeft'
    ].map(part => `tattoos.${part}`)

    const loadPromises = [
        ...components.map(comp => getImageFromCache(customization[comp]?.item || customization[comp])),
        ...tattooComponents.map(comp => {
            const value = comp.split('.').reduce((obj, key) => obj?.[key], customization)
            return getImageFromCache(value)
        })
    ]

    const images = await Promise.all(loadPromises)

    return Object.fromEntries([
        ...components.map((comp, i) => [comp, images[i]]),
        ...tattooComponents.map((comp, i) => [comp, images[i + components.length]])
    ])
}

// Controller Functions
const getAvatar = async (req, res) => {
    try {
        const { type, username } = req.params
        const user = await User.findOne({ username }, 'username customization customizationHash')
        
        if (!user) return res.status(404).send('User not found.')

        const hash = xxHash32(JSON.stringify({ 
            username: user.username, 
            customization: user.customization 
        }), 0).toString()

        const fileName = type ? `${hash}_${type}` : hash
        
        try {
            await fs.access(path.join(process.cwd(), 'avatars', `${fileName}.webp`))
            return res.redirect(`/download/webp/${fileName}`)
        } catch {
            const avatar = await generateAvatarFiles(user, hash)
            user.customizationHash = hash
            await user.save()
            return res.redirect(`/download/webp/${hash}`)
        }
    } catch (error) {
        console.error('Avatar generation error:', error)
        res.status(500).send('Error generating avatar')
    }
}

const download = async (req, res) => {
    try {
        const buffer = await fs.readFile(
            path.join(process.cwd(), 'avatars', `${req.params.hash}.webp`)
        )
        res.status(200).send(buffer)
    } catch (error) {
        console.error('Download error:', error)
        res.status(500).send('Error downloading avatar')
    }
}

export default { getAvatar, download }

//import bcrypt from 'bcrypt'
//import moment from 'moment'
//import crypto from 'crypto'
//import { xxHash32 } from 'js-xxhash'
//import { v4 as uuid } from 'uuid'
//import customization from './customization.js'
//import { createCanvas, loadImage } from 'canvas'
//import uploadContent from './uploadContent.js'
//import axios from 'axios'
//import fs from 'fs'
//import path from 'path'
//import sharp from 'sharp'
//
//import User from '../models/User.js'
//import Item from '../models/Item.js'
//import Avatar from '../models/Avatar.js'
//
//const targetR = 0
//const targetG = 255
//const targetB = 4
//const toleranceR = 50
//const toleranceG = 150
//const toleranceB = 50
//
//const isColorSimilar = (r1, g1, b1, r2, g2, b2) => {
//    return Math.abs(r1 - r2) <= toleranceR &&
//           Math.abs(g1 - g2) <= toleranceG &&
//           Math.abs(b1 - b2) <= toleranceB
//}
//
//const getAvatar = async (req, res) => {
//    const type = req.params.type
//    const username = req.params.username
//    const user = await User.findOne({ username: username }, 'username customization customizationHash')
//    if (!user) {
//        return res.status(404).send('User not found.')
//    }
//
//    const hash = xxHash32(JSON.stringify({ username: user.username, customization: user.customization }), 0).toString()
//
//    let file = `${hash}.webp`
//    if (type === 'thumbnail')
//        file = `${hash}_thumbnail.webp`
//    else if (type === 'sprite')
//        file = `${hash}_spritesheet.webp`
//
//    if (user.customizationHash === hash) {
//        try {
//            //const avatarsDir = path.join(process.cwd(), 'avatars', file)
//            //const buffer = await fs.promises.readFile(avatarsDir)
//            //return res.status(200).send(buffer)
//            await fs.promises.access(path.join(process.cwd(), 'avatars', file))
//            return res.redirect(`/download/webp/${hash}`)
//        }
//        catch (error) {
//            console.error('Error saving avatar:', error)
//        }
//    }
//
//    const generatedAvatar = await createAvatarThumbnail(user, hash, type)
//    user.customizationHash = hash
//    res.status(200).redirect(`/download/webp/${hash}`)//.send(generatedAvatar)
//    user.save()
//}
//
//const download = async (req, res) => {
//    try {
//        const avatarsDir = path.join(process.cwd(), 'avatars', `${req.params.hash}.webp`)
//        const buffer = await fs.promises.readFile(avatarsDir)
//        return res.status(200).send(buffer)
//    }
//    catch (error) {
//        console.error('Error saving avatar:', error)
//    }
//}
//
//const createAvatarThumbnail = async (user, hash, getType) => {
//    return new Promise(async (resolve, reject) => {
//        let base = ''
//        if (user.customization.isMale && user.customization.bodyType == 0)
//            base = 'male_fit.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/male_fit.png'
//        else if (user.customization.isMale && user.customization.bodyType == 1)
//            base = 'male_fat.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/male_fat.png'
//        else if (!user.customization.isMale && user.customization.bodyType == 0)
//            base = 'female_fit.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/female_fit.png'
//        else if (!user.customization.isMale && user.customization.bodyType == 1)
//            base = 'female_fat.png'//'https://project-ow.nyc3.digitaloceanspaces.com/__main/female_fat.png'
//        try {
//            const baseDir = path.join(process.cwd(), 'bases', base)
//            base = await fs.promises.readFile(baseDir)
//        }
//        catch (error) {
//            console.error('Error loading base:', error)
//        }
//    
//        base = await loadImage(base)
//        let hair = await getImage(user.customization.hair.item)
//        let beard = await getImage(user.customization.beard.item)
//        let eyes = await getImage(user.customization.eyes.item)
//        let eyebrows = await getImage(user.customization.eyebrows.item)
//        let head = await getImage(user.customization.head)
//        let nose = await getImage(user.customization.nose)
//        let mouth = await getImage(user.customization.mouth)
//        let hat = await getImage(user.customization.hat)
//        let piercings = await getImage(user.customization.piercings)
//        let glasses = await getImage(user.customization.glasses)
//        let top = await getImage(user.customization.top)
//        let coat = await getImage(user.customization.coat)
//        let bottom = await getImage(user.customization.bottom)
//        let foot = await getImage(user.customization.foot)
//        let bracelets = await getImage(user.customization.bracelets)
//        let neckwear = await getImage(user.customization.neckwear)
//        let bag = await getImage(user.customization.bag)
//        let gloves = await getImage(user.customization.gloves)
//        let handheld = await getImage(user.customization.handheld)
//
//        let tattoosHead = await getImage(user.customization.tattoos.head)
//        let tattoosNeck = await getImage(user.customization.tattoos.neck)
//        let tattoosChest = await getImage(user.customization.tattoos.chest)
//        let tattoosStomach = await getImage(user.customization.tattoos.stomach)
//        let tattoosBackUpper = await getImage(user.customization.tattoos.backUpper)
//        let tattoosBackLower = await getImage(user.customization.tattoos.backLower)
//        let tattoosArmRight = await getImage(user.customization.tattoos.armRight)
//        let tattoosArmLeft = await getImage(user.customization.tattoos.armLeft)
//        let tattoosLegRight = await getImage(user.customization.tattoos.legRight)
//        let tattoosLegLeft = await getImage(user.customization.tattoos.legLeft)
//    
//        //let generatedThumbnail = await generateAvatar(256, 256, 103, 42, 218, 218, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
//        //let generatedAvatar = await generateAvatar(425, 850, 0, 0, 425, 850, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
//        //let generatedClothing = await generateAvatar(2550, 850, 0, 0, 2550, 850, null, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
//
//        //let generatedSpriteSheet = await addClothingToAvatar(base, generatedClothing)
//        let generatedAvatar = await generateAvatar(425, 850, 0, 0, 425, 850, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
//        generatedAvatar = await sharp(generatedAvatar).webp({ quality: 100 }).toBuffer()
//        //generatedThumbnail = await sharp(generatedThumbnail).webp({ quality: 80 }).toBuffer()
//        //generatedSpriteSheet = await sharp(generatedSpriteSheet).webp({ quality: 100 }).toBuffer()
//
//        try {
//            const avatarsDir = path.join(process.cwd(), 'avatars')
//            await fs.promises.mkdir(avatarsDir, { recursive: true })
//
//            let filePath = path.join(avatarsDir, `${hash}.webp`)
//            await fs.promises.writeFile(filePath, generatedAvatar)
//
//            //filePath = path.join(avatarsDir, `${hash}_thumbnail.webp`)
//            //await fs.promises.writeFile(filePath, generatedThumbnail)
//
//            //filePath = path.join(avatarsDir, `${hash}_spritesheet.webp`)
//            //await fs.promises.writeFile(filePath, generatedSpriteSheet)
//        }
//        catch (error) {
//            console.error('Error saving avatar:', error)
//        }
//
//        // return/resolve early so that we don't make the client wait
//        if (getType === 'thumbnail')
//            resolve(generatedThumbnail)
//        else if (getType === 'sprite')
//            resolve(generatedSpriteSheet)
//        else
//            resolve(generatedAvatar)
//
//        // we generate this afterwards because we don't want to keep the client waiting
//        let generatedSpriteSheet = await generateAvatar(2550, 850, 0, 0, 2550, 850, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft)
//        let generatedThumbnail = await cropImage(generatedSpriteSheet, 103, 42, 218, 218)
//        user.clothing = await uploadContent(user.clothing, { data: generatedSpriteSheet }, 'user-clothing', 5, "DONT", undefined, user.username)
//        user.thumbnail = await uploadContent(user.thumbnail, { data: generatedThumbnail }, 'user-thumbnail', 5, undefined, undefined, user.username)
//        //user.avatar = await uploadContent(user.avatar, { data: generatedAvatar }, 'user-avatar', 5, undefined, undefined, user.username)
//    })
//}
//
//const getImage = async (item) => {
//    if (item == undefined || item == null || item == '')
//        return null
//    //let hair = await axios.get(`https://project-ow.nyc3.digitaloceanspaces.com/item-sprite/${user.customization.hair.item}.webp`, { responseType: 'arraybuffer' })
//    //hair = await sharp(hair.data).png().toBuffer()
//    //hair = await loadImage(hair)
//    try {
//        let data = await axios.get(`https://${process.env.DO_SPACE_ENDPOINT}item-sprite/${item}.webp`, { responseType: 'arraybuffer' })
//        data = await sharp(data.data).png().toBuffer()
//        data = await loadImage(data)
//        //const canvas = createCanvas(data.width, data.height)
//        //const ctx = canvas.getContext('2d')
//        //ctx.drawImage(data, 0, 0)
//        return data//ctx.getImageData(0, 0, data.width, data.height)
//    } 
//    catch (error) {
//        return null
//    }
//}
//
///**
// * Generates an avatar image by drawing various elements onto a canvas.
// * 
// * @param {number} canvasSizeX - The width of the canvas.
// * @param {number} canvasSizeY - The height of the canvas.
// * @param {number} sourceStartPositionX - X-coordinate of the source's top-left corner.
// * @param {number} sourceStartPositionY - Y-coordinate of the source's top-left corner.
// * @param {number} sourceWidth - The width of the source element.
// * @param {number} sourceHeight - The height of the source element.
//**/
//const generateAvatar = async (canvasSizeX, canvasSizeY, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, base, hair, beard, eyes, eyebrows, head, nose, mouth, hat, piercings, glasses, top, coat, bottom, foot, bracelets, neckwear, bag, gloves, handheld, tattoosHead, tattoosNeck, tattoosChest, tattoosStomach, tattoosBackUpper, tattoosBackLower, tattoosArmRight, tattoosArmLeft, tattoosLegRight, tattoosLegLeft) => {
//    return new Promise(async (resolve, reject) => {
//        const canvas = createCanvas(canvasSizeX, canvasSizeY)
//        const ctx = canvas.getContext('2d')
//
//        if (base)
//            ctx.drawImage(base, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosHead)
//            ctx.drawImage(tattoosHead, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosNeck)
//            ctx.drawImage(tattoosNeck, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosChest)
//            ctx.drawImage(tattoosChest, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosStomach)
//            ctx.drawImage(tattoosStomach, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosBackUpper)
//            ctx.drawImage(tattoosBackUpper, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosBackLower)
//            ctx.drawImage(tattoosBackLower, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosArmRight)
//            ctx.drawImage(tattoosArmRight, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosArmLeft)
//            ctx.drawImage(tattoosArmLeft, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosLegRight)
//            ctx.drawImage(tattoosLegRight, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (tattoosLegLeft)
//            ctx.drawImage(tattoosLegLeft, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (eyes)
//            ctx.drawImage(eyes, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (hair) {
//            if (hat)
//            {
//                let hairWithoutHat = await removePixelsByImage(hair, hat)
//                hairWithoutHat = await loadImage(hairWithoutHat)
//                ctx.drawImage(hairWithoutHat, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//                
//                let hatWithoutMask = await removePixelsByColor(hat)
//                hatWithoutMask = await loadImage(hatWithoutMask)
//                ctx.drawImage(hatWithoutMask, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//            }
//            else
//            {
//                ctx.drawImage(hair, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//            }
//        }
//        if (beard)
//            ctx.drawImage(beard, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (eyebrows)
//            ctx.drawImage(eyebrows, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (head)
//            ctx.drawImage(head, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (nose)
//            ctx.drawImage(nose, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (mouth)
//            ctx.drawImage(mouth, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (hat && !hair) {
//            let hatWithoutMask = await removePixelsByColor(hat)
//            hatWithoutMask = await loadImage(hatWithoutMask)
//            ctx.drawImage(hatWithoutMask, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        }
//        if (piercings)
//            ctx.drawImage(piercings, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (glasses)
//            ctx.drawImage(glasses, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (bracelets)
//            ctx.drawImage(bracelets, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (neckwear)
//            ctx.drawImage(neckwear, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (bottom)
//            ctx.drawImage(bottom, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (gloves)
//            ctx.drawImage(gloves, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (handheld)
//            ctx.drawImage(handheld, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (top)
//            ctx.drawImage(top, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (coat)
//            ctx.drawImage(coat, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (foot)
//            ctx.drawImage(foot, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//        if (bag)
//            ctx.drawImage(bag, sourceStartPositionX, sourceStartPositionY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
//
//        const data = canvas.toBuffer()
//        resolve(data)
//    })
//}
//
//async function removePixelsByImage(sourceImagePath, maskImagePath) {
//    try {
//        // Load both images
//        let sourceImage = sourceImagePath
//        let maskImage = maskImagePath
//
//        // Create canvases for source and mask images
//        let sourceCanvas = createCanvas(sourceImage.width, sourceImage.height)
//        let maskCanvas = createCanvas(maskImage.width, maskImage.height)
//        
//        let sourceCtx = sourceCanvas.getContext('2d')
//        let maskCtx = maskCanvas.getContext('2d')
//
//        // Draw images onto canvases
//        sourceCtx.drawImage(sourceImage, 0, 0)
//        maskCtx.drawImage(maskImage, 0, 0)
//
//        // Get image data for both images
//        let sourceImageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)
//        let maskImageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
//
//        let pixelsProcessed = 0
//        let pixelsMatched = 0
//  
//        // Process pixels
//        for (let y = 0; y < sourceImageData.height; y++) {
//            for (let x = 0; x < sourceImageData.width; x++) {
//                const sourceIndex = (y * sourceImageData.width + x) * 4
//                const maskIndex = (y * maskImageData.width + x) * 4
//                
//                const maskR = maskImageData.data[maskIndex]
//                const maskG = maskImageData.data[maskIndex + 1]
//                const maskB = maskImageData.data[maskIndex + 2]
//                const maskA = maskImageData.data[maskIndex + 3]
//      
//                pixelsProcessed++
//      
//                // Only process fully opaque pixels in the mask
//                if (maskA === 255 && isColorSimilar(maskR, maskG, maskB, targetR, targetG, targetB)) {
//                    sourceImageData.data[sourceIndex + 3] = 0 // Make source pixel transparent
//                    pixelsMatched++
//                    
//                    // Debug logging for first few matches
//                    //if (pixelsMatched < 5) {
//                    //    console.log(`Match found at (${x}, ${y}):`);
//                    //    console.log(`  Mask pixel: R=${maskR}, G=${maskG}, B=${maskB}`);
//                    //    console.log(`  Target: R=${targetR}, G=${targetG}, B=${targetB}`);
//                    //}
//                }
//            }
//        }
//  
//        // Put modified image data back to canvas
//        sourceCtx.putImageData(sourceImageData, 0, 0)
//        const data = sourceCanvas.toBuffer()
//
//        //const out = fs.createWriteStream("output.png");
//        //const stream = sourceCanvas.createPNGStream();
//        //stream.pipe(out);
//        return data
//    } 
//    catch (error) {
//        console.error('Error processing images:', error)
//        throw error
//    }
//}
//
//async function removePixelsByColor(sourceImage) {
//    try {
//        let sourceCanvas = createCanvas(sourceImage.width, sourceImage.height)
//        let sourceCtx = sourceCanvas.getContext('2d')
//        sourceCtx.drawImage(sourceImage, 0, 0)
//        let sourceImageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)
//
//        let pixelsProcessed = 0
//        let pixelsMatched = 0
//        
//        for (let y = 0; y < sourceImageData.height; y++) {
//            for (let x = 0; x < sourceImageData.width; x++) {
//                const sourceIndex = (y * sourceImageData.width + x) * 4
//                
//                const maskR = sourceImageData.data[sourceIndex]
//                const maskG = sourceImageData.data[sourceIndex + 1]
//                const maskB = sourceImageData.data[sourceIndex + 2]
//                const maskA = sourceImageData.data[sourceIndex + 3]
//      
//                pixelsProcessed++
//      
//                // Only process fully opaque pixels in the mask
//                if (maskA === 255 && isColorSimilar(maskR, maskG, maskB, targetR, targetG, targetB)) {
//                    sourceImageData.data[sourceIndex + 3] = 0 // Make source pixel transparent
//                    pixelsMatched++
//                }
//            }
//        }
//  
//        // Put modified image data back to canvas
//        sourceCtx.putImageData(sourceImageData, 0, 0)
//        const data = sourceCanvas.toBuffer()
//        return data
//    }
//    catch (error) {
//        console.error('Error processing images:', error);
//        throw error
//    }
//}
//
//async function addClothingToAvatar(base, clothing) {
//    try {
//        clothing = await loadImage(clothing)
//        const canvas = createCanvas(base.width, base.height)
//        const ctx = canvas.getContext('2d')
//        ctx.drawImage(base, 0, 0, canvas.width, canvas.height)
//        ctx.drawImage(clothing, 0, 0, canvas.width, canvas.height)
//        return canvas.toBuffer()
//    }
//    catch (error) {
//        console.error('Error processing images:', error)
//        throw error
//    }
//}
//
//async function cropImage(sourceImage, x, y, width, height) {
//    try {
//        const loadedImage = await loadImage(sourceImage)
//        const canvas = createCanvas(width, height)
//        const ctx = canvas.getContext('2d')
//        ctx.drawImage(loadedImage, x, y, width, height, 0, 0, width, height)
//        return canvas.toBuffer()
//    }
//    catch (error) {
//        console.error('Error processing images:', error)
//        throw error
//    }
//}
//
//export default { getAvatar, download }