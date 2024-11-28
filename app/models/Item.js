import mongoose from 'mongoose'

const itemSchema = new mongoose.Schema({
    isPublished: { type: Boolean, default: false },
    numberOfPurchases: { type: Number, default: 0 },
    sortingOrder: { type: Number, default: 0 },

    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String },
    description: { type: String }, // !x = example: shoes infront of pants
    rarity: { type: Number, default: 0 }, // 0 - normal | 1 - rare | 2 - epic | 3 - legendary
    gender: { type: Number }, // Male = 0 | Female = 1 | Unisex = 2
    hasFatSheet: { type: Boolean, default: false },

    isAnimated: { type: Boolean, default: false },
    group: { type: String },

    costCoins: { type: Number },
    costGems: { type: Number },

    canBuyWithCoins: { type: Boolean, default: true },
    canBuyWithGems: { type: Boolean, default: true },

    previewLocation: { type: String },
    spriteLocation: { type: String },
    fatSpriteLocation: { type: String },

    category: { type: Number },
    tags: { type: Number }
}, { timestamps: true })

const Item = mongoose.model('Item', itemSchema)
export default Item