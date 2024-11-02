import mongoose from 'mongoose'

const itemSchema = new mongoose.Schema({
    isPublished: { type: Boolean, default: false },
    numberOfPurchases: { type: Number, default: 0 },

    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String },
    description: { type: String },
    rarity: { type: Number, default: 0 }, // 0 - normal | 1 - rare | 2 - epic | 3 - legendary
    gender: { type: Number }, // Male = 0 | Female = 1 | Unisex = 2

    costCoins: { type: Number },
    costGems: { type: Number },

    canBuyWithCoins: { type: Boolean, default: true },
    canBuyWithGems: { type: Boolean, default: true },

    previewLocation: { type: String },
    spriteLocation: { type: String },

    // 100 = furniture
    // 101 = pose
    // 102 = animation
    // 0 = hair
    // 1 = beard
    // 2 = eyes
    // 3 = eyebrows
    // 4 = head
    // 5 = nose
    // 6 = mouth
    // 7 = hat
    // 8 = piercings
    // 9 = glasses
    // 10 = top
    // 11 = coat
    // 12 = bottom
    // 13 = foot
    // 14 = bracelets
    // 15 = neckwear
    // 16 = bag
    // 17 = gloves
    // 18 = handheld
    // 19 = tattoos head
    // 20 = tattoos neck
    // 21 = tattoos chest
    // 22 = tattoos stomach
    // 23 = tattoos backUpper
    // 24 = tattoos backLower
    // 25 = tattoos armRight
    // 26 = tattoos armLeft
    // 27 = tattoos legRight
    // 28 = tattoos legLeft
    category: { type: Number },
    tags: { type: Number }
}, { timestamps: true })

const Item = mongoose.model('Item', itemSchema)
export default Item