import { v4 as uuid } from 'uuid'
import aws from 'aws-sdk'
import sharp from 'sharp'
import path from 'path'

const s3 = new aws.S3({
    endpoint: new aws.Endpoint(process.env.DO_ENDPOINT),
    credentials: new aws.Credentials(process.env.DO_SPACE_ID, process.env.DO_SPACE_KEY)
})

/**
 * @description Uploads a file to DigitalOcean Spaces with optional resizing and returns the new filename.
 * @param {string} previousMedia - The previous media to be deleted.
 * @param {object} file - The file to be uploaded.
 * @param {string} location - The location in the bucket to upload the file.
 * @param {number} maxSize - The maximum file size in MB.
 * @param {number|string} resizePixels - The maximum width/height of the image.
 * @param {array} errors - The array of errors to be appended to.
 * @param {string} fileName - The custom filename to be used.
 * @returns {Promise<string|null>} The new filename if successful, otherwise null.
 */
const uploadImage = async (previousMedia, file, location, maxSize, resizePixels, errors, fileName) => {
    try {
        // Validate inputs
        if (!file || !file.data) {
            console.error('No file data provided')
            if (errors) errors.push({ msg: 'No file data provided.' })
            return null
        }

        if (!location) {
            console.error('No location specified')
            if (errors) errors.push({ msg: 'No upload location specified.' })
            return null
        }

        // Check file size (if applicable)
        if (file.size && file.size / 1024 / 1024 > maxSize) {
            if (errors) errors.push({ msg: 'File too large.' })
            return null
        }

        // Delete previous media if exists (non-blocking)
        if (previousMedia && previousMedia !== '') {
            s3.deleteObject({
                Bucket: process.env.DO_SPACE_NAME,
                Key: previousMedia
            }, (err) => {
                if (err) console.error('Failed to delete previous media:', err)
            })
        }

        // Process image with Sharp
        let processedData
        try {
            processedData = await processImage(file.data, resizePixels)
        } catch (error) {
            console.error('Image processing failed:', error)
            if (errors) errors.push({ msg: 'Failed to process image.' })
            return null
        }

        // Generate key for upload
        const key = `${location}/${fileName || uuid()}.webp`

        // Upload to S3
        try {
            const uploadParams = {
                Bucket: process.env.DO_SPACE_NAME,
                Body: processedData,
                ACL: 'public-read',
                Key: key,
                ContentType: 'image/webp'
            }

            const uploadResult = await s3.upload(uploadParams).promise()
            return uploadResult.Key
        } catch (error) {
            console.error('S3 upload failed:', error)
            if (errors) errors.push({ msg: 'Failed to upload to storage.' })
            return null
        }
    } catch (error) {
        console.error('Unexpected error in uploadImage:', error)
        if (errors) errors.push({ msg: 'Unexpected error during upload.' })
        return null
    }
}

/**
 * Process image data with Sharp based on resize parameters
 * @param {Buffer} data - Image data buffer
 * @param {number|string} resizePixels - Resize parameter
 * @returns {Promise<Buffer>} Processed image buffer
 */
const processImage = async (data, resizePixels) => {
    try {
        let sharpInstance = sharp(data)

        // Get image metadata to validate
        const metadata = await sharpInstance.metadata()
        
        if (!metadata.width || !metadata.height) {
            throw new Error('Invalid image data')
        }

        // Apply processing based on resizePixels parameter
        if (resizePixels === "N") {
            // No processing, return original
            return data
        } else if (resizePixels === "DONT") {
            // Convert to WebP without resizing
            return await sharpInstance
                .webp({ quality: 100 })
                .toBuffer()
        } else if (resizePixels && typeof resizePixels === 'number') {
            // Resize to specified dimensions
            return await sharpInstance
                .resize(resizePixels, resizePixels, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .webp({ quality: 75 })
                .toBuffer()
        } else {
            // Default: convert to WebP with standard quality
            return await sharpInstance
                .webp({ quality: 75 })
                .toBuffer()
        }
    } catch (error) {
        console.error('Sharp processing error:', error)
        throw error
    }
}

/**
 * Batch upload multiple images
 * @param {Array} uploads - Array of upload configurations
 * @returns {Promise<Array>} Results of all uploads
 */
export const batchUpload = async (uploads) => {
    const results = await Promise.allSettled(
        uploads.map(upload => 
            uploadImage(
                upload.previousMedia,
                upload.file,
                upload.location,
                upload.maxSize,
                upload.resizePixels,
                upload.errors,
                upload.fileName
            )
        )
    )

    return results.map((result, index) => ({
        ...uploads[index],
        success: result.status === 'fulfilled',
        key: result.value || null,
        error: result.reason || null
    }))
}

/**
 * Check if a file exists in S3
 * @param {string} key - S3 object key
 * @returns {Promise<boolean>} True if exists
 */
export const checkFileExists = async (key) => {
    try {
        await s3.headObject({
            Bucket: process.env.DO_SPACE_NAME,
            Key: key
        }).promise()
        return true
    } catch (error) {
        return false
    }
}

/**
 * Delete a file from S3
 * @param {string} key - S3 object key
 * @returns {Promise<boolean>} True if deleted successfully
 */
export const deleteFile = async (key) => {
    try {
        await s3.deleteObject({
            Bucket: process.env.DO_SPACE_NAME,
            Key: key
        }).promise()
        return true
    } catch (error) {
        console.error('Failed to delete file:', error)
        return false
    }
}

export default uploadImage