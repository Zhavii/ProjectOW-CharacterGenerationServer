// avatarWorker.js
import { parentPort } from 'worker_threads'
import { createCanvas, loadImage } from 'canvas'

const getFacingOrder = (direction) => {
    // Forward-facing (0)
    if (direction === 0) {
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
    // Diagonal views (2, 5)
    else if ([2, 5].includes(direction)) {
        return [
            "base",
            "tattoo_head", "tattoo_neck", "tattoo_chest", "tattoo_stomach",
            "tattoo_backUpper", "tattoo_backLower", "tattoo_armRight",
            "tattoo_armLeft", "tattoo_legRight", "tattoo_legLeft",
            "makeup", "eyes", "eyebrows", "head", "nose", "mouth", "beard",
            "glasses",
            "socks",
            "shoes_before",
            "gloves", "bottom", "belt",
            "shoes_after",
            "bracelets", "handheld",
            "top", "necklace",
            "coat", "hair_behind", "piercings", "earPiece", "neckwear", "hair_infront", "hat", "horns",
            "wings", "bag"
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

const generateDirectionalAvatar = async (direction, layers, shoesBehindPants, hairInfrontTop) => {
    // Canvas size for single direction (425x850)
    const canvas = createCanvas(425, 850)
    const ctx = canvas.getContext('2d')
    
    // Calculate x offset based on direction (0-5)
    const sourceX = direction * 425
    
    // Draw layers in the correct order for this direction
    const layerOrder = getFacingOrder(direction)
    for (const layerName of layerOrder) {
        let layer = null
        if (layerName === 'shoes_before' && !shoesBehindPants)
            layer = layers["shoes"]
        else if (layerName === 'shoes_after' && shoesBehindPants)
            layer = layers["shoes"]
        else if (layerName === 'hair_behind' && !hairInfrontTop)
            layer = layers["hair"]
        else if (layerName === 'hair_infront' && hairInfrontTop)
            layer = layers["hair"]
        else
            layer = layers[layerName]
            
        if (!layer) continue

        // Draw the layer
        try {
            ctx.drawImage(layer, sourceX, 0, 425, 850, 0, 0, 425, 850)
        } catch (error) {
            console.error(`Error drawing layer ${layerName}:`, error)
            // Continue with other layers if one fails
            continue
        }
    }

    return canvas.toBuffer()
}

const generateFullSpriteSheet = async (layers, shoesBehindPants, hairInfrontTop) => {
    // Final sprite sheet canvas
    const canvas = createCanvas(2550, 850)
    const ctx = canvas.getContext('2d')

    // Generate each direction
    for (let direction = 0; direction < 6; direction++) {
        const directionCanvas = await generateDirectionalAvatar(direction, layers, shoesBehindPants, hairInfrontTop)
        const directionImage = await loadImage(directionCanvas)
        ctx.drawImage(
            directionImage,
            direction * 425, 0
        )
        // Allow intermediate buffers to be garbage collected
        directionImage.close?.()
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

// Handle messages from the main thread
parentPort.on('message', async (task) => {
    try {
        if (!task.type) {
            throw new Error('Task type is required')
        }

        let result;
        switch (task.type) {
            case 'spritesheet':
                result = await generateFullSpriteSheet(task.layers, task.shoesBehindPants, task.hairInfrontTop)
                break
            case 'crop':
                result = await cropImage(task.sourceImage, task.x, task.y, task.width, task.height)
                break
            case 'direction':
                result = await generateDirectionalAvatar(task.direction, task.layers, task.shoesBehindPants, task.hairInfrontTop)
                break
            default:
                throw new Error(`Unknown task type: ${task.type}`)
        }
        
        parentPort.postMessage(result)
    } catch (error) {
        parentPort.postMessage({ error: error.message || 'Unknown error occurred' })
    }
})

// Handle any uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    parentPort.postMessage({ error: error.message })
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason)
    parentPort.postMessage({ error: reason.message || 'Unhandled Promise rejection' })
})