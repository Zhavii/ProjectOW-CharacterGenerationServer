import { v4 as uuid } from 'uuid'
import multer from 'multer'
import aws from 'aws-sdk'
import sharp from 'sharp'
import path from 'path'

const upload = multer({ storage: multer.memoryStorage() })

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
 * @param {number} resizePixels - The maximum width/height of the image.
 * @param {array} errors - The array of errors to be appended to.
 * @param {string} fileName - The custom filename to be used.
 * @returns {Promise<string|undefined>} The new filename if successful, otherwise undefined.
 */
const uploadImage = (previousMedia, file, location, maxSize, resizePixels, errors, fileName) => {
    if (file.size / 1024 / 1024 > maxSize) {
        if (errors) {
            errors.push({ msg: 'File too large.' })
        }
        return null
    }

    return new Promise(async (resolve, reject) => {
        try {
            if (previousMedia != undefined && previousMedia != null && previousMedia != '') {
                s3.deleteObject({
                    Bucket: process.env.DO_SPACE_NAME,
                    Key: previousMedia
                }, async (err, data) => {
                    if (err) console.log(err)
                })
            }

            let data = file.data
            if (resizePixels == "DONT") {
                data = await sharp(data).webp({ quality: 100 }).toBuffer()
            }
            else if (resizePixels != undefined && resizePixels != null && resizePixels != '') {
                data = await sharp(data).resize(resizePixels ? resizePixels : 512).webp({ quality: 75 }).toBuffer()
            }
            else {
                data = await sharp(data).webp({ quality: 75 }).toBuffer()
            }

            const uploadData = {
                Bucket: process.env.DO_SPACE_NAME,
                Body: data,
                ACL: 'public-read'/*'private'*/,
                Key: `${location}/${fileName ? fileName : uuid()}.webp` //`${location}/${fileName ? fileName : uuid()}${path.extname(file.name)}` 
            }
            const uploadDone = await s3.upload(uploadData).promise()
            resolve(uploadDone.Key)
        }
        catch (error) {
            console.log(error)
            reject(error)
        }
    })
}

export default uploadImage