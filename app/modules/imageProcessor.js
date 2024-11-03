import { Worker } from 'worker_threads'
import { createCanvas } from 'canvas'
import os from 'os'
import path from 'path'

async function removePixelsByImage(sourceImagePath, maskImagePath) {
    try {
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

        const result = await processWithWorkers(sourceImageData.data, maskImageData.data, true)
        
        // Create new ImageData with processed result
        sourceImageData.data.set(result)
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
        if (!sourceImage) {
            throw new Error('Invalid source image')
        }

        let sourceCanvas = createCanvas(sourceImage.width, sourceImage.height)
        let sourceCtx = sourceCanvas.getContext('2d')
        sourceCtx.drawImage(sourceImage, 0, 0)
        let sourceImageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)

        const result = await processWithWorkers(sourceImageData.data, null, false)
        
        sourceImageData.data.set(result)
        sourceCtx.putImageData(sourceImageData, 0, 0)
        return sourceCanvas.toBuffer()
    }
    catch (error) {
        console.error('Error processing images:', error)
        throw error
    }
}

async function processWithWorkers(sourceData, maskData = null, useMask = false) {
    const numWorkers = os.cpus().length
    const chunkSize = Math.ceil(sourceData.length / numWorkers)
    const workers = []
    const promises = []

    // Create SharedArrayBuffer for the result
    const sharedResult = new SharedArrayBuffer(sourceData.length)
    const resultView = new Uint8Array(sharedResult)
    resultView.set(sourceData) // Copy source data to shared buffer

    if (useMask && maskData) {
        // Create SharedArrayBuffer for mask data
        const sharedMask = new SharedArrayBuffer(maskData.length)
        const maskView = new Uint8Array(sharedMask)
        maskView.set(maskData)
        maskData = sharedMask
    }

    // Create and run workers
    for (let i = 0; i < numWorkers; i++) {
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, sourceData.length)
        
        const worker = new Worker(path.join(process.cwd(), 'app/modules/imageWorker.js'))
        workers.push(worker)

        promises.push(
            new Promise((resolve, reject) => {
                worker.on('error', reject)
                worker.on('exit', (code) => {
                    if (code !== 0) {
                        reject(new Error(`Worker stopped with exit code ${code}`))
                    }
                    resolve()
                })
                
                worker.postMessage({
                    sharedResult,
                    maskData,
                    start,
                    end,
                    useMask,
                    targetR: 0,        // Make sure these match your constants
                    targetG: 255,
                    targetB: 4,
                    toleranceR: 50,
                    toleranceG: 150,
                    toleranceB: 50
                })
            })
        )
    }

    // Wait for all workers to complete
    await Promise.all(promises)
    
    // Cleanup workers
    for (const worker of workers) {
        worker.terminate()
    }

    return resultView
}

export { removePixelsByImage, removePixelsByColor }