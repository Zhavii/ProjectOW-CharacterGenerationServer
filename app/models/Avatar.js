import mongoose from 'mongoose'
import moment from 'moment'
import { v4 as uuid } from 'uuid'

const avatarSchema = new mongoose.Schema({
    user: { type: mongoose.Types.ObjectId, ref: 'Item' },
    username: { type: String, required: false },
    customizationHash: { type: String, default: '' },
})

const Avatar = mongoose.model('Avatar', avatarSchema)
export default Avatar