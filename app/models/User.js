import mongoose from 'mongoose'
import moment from 'moment'
import { v4 as uuid } from 'uuid'

// Badge system constants
const BADGES = {
    EARLY_ACCESS: 1 << 0,    // Early access participant
    DONATOR: 1 << 1,        // Supported the platform financially
    BETA_TESTER: 1 << 2,    // Participated in beta testing
    CREATOR: 1 << 3,        // Content creator
    VERIFIED: 1 << 4,       // Verified user
    FASHION_ICON: 1 << 5,   // Extensive wardrobe collection
    COLLECTOR: 1 << 6,      // Large item collection
    CELEBRITY: 1 << 7,      // Recognized community figure
    AMBASSADOR: 1 << 8,     // Community ambassador
}

// Achievement badge schema
const achievementBadgeSchema = new mongoose.Schema({
    type: { type: String, required: true },
    earnedAt: { type: Date, default: Date.now },
    progress: { type: Number, default: 0 },
    maxProgress: { type: Number, required: true },
    level: { type: Number, default: 1 },
    metadata: {
        title: { type: String, required: true },
        description: { type: String, required: true },
        icon: { type: String, required: true },
        rarityTier: { type: String, enum: ['common', 'rare', 'epic', 'legendary'], default: 'common' }
    }
})

const userSchema = new mongoose.Schema({
    googleId: { type: String, require: false },
    profileImage: { type: String, required: false },
    access: { type: Number, default: 0 }, // 0 = user | 1 = game moderator | 2 = super moderator | 3 = administrator
    isOnline: { type: Boolean, default: false },
    instance: { type: mongoose.Schema.Types.ObjectId, ref: 'Instance' },
    location: { type: String },

    username: { type: String, required: false },
    email: { type: String, required: true },
    password: { type: String, required: false },
    
    isEmailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },

    thumbnail: { type: String, default: '' },
    avatar: { type: String, default: '' },
    clothing: { type: String, default: '' },
    honor: { type: Number, default: 1 },
    membership: { type: Number, default: 0 },
    coins: { type: Number, default: 50000 },
    gems: { type: Number, default: 50 },
    xp: { type: Number, default: 1 },

    // Badge system fields
    badges: { type: Number, default: 0 },
    achievementBadges: [achievementBadgeSchema],
    badgeHistory: [{
        badge: { type: String, required: true },
        earnedAt: { type: Date, default: Date.now },
        source: { type: String }
    }],

    sessionKey: { type: String },
    sessionExpire: { type: Date },
    resetLink: { type: String, default: '' },

    customizationHash: { type: String, default: '' },
    customization: {
        nametagColor: { type: String, default: '' },
        isMale: { type: Boolean, default: false },
        bodyType: { type: Number, default: 0 }, // 0 = Normal | 1 = Curvy | 2 = Thin (Female only)
        //isFat: { type: Boolean, default: false },
        skinTone: { type: Number, default: 0 },
        height: { type: Number, default: 1 },
        width: { type: Number, default: 1 },

        makeup: { type: mongoose.Types.ObjectId, ref: 'Item' },
        hair: { type: mongoose.Types.ObjectId, ref: 'Item' },
        beard: { type: mongoose.Types.ObjectId, ref: 'Item' },
        eyes: { type: mongoose.Types.ObjectId, ref: 'Item' },
        eyebrows: { type: mongoose.Types.ObjectId, ref: 'Item' },

        head: { type: mongoose.Types.ObjectId, ref: 'Item' },
        nose: { type: mongoose.Types.ObjectId, ref: 'Item' },
        mouth: { type: mongoose.Types.ObjectId, ref: 'Item' },

        hat: { type: mongoose.Types.ObjectId, ref: 'Item' },
        piercings: { type: mongoose.Types.ObjectId, ref: 'Item' },
        earPiece: { type: mongoose.Types.ObjectId, ref: 'Item' },
        glasses: { type: mongoose.Types.ObjectId, ref: 'Item' },
        horns: { type: mongoose.Types.ObjectId, ref: 'Item' },

        top: { type: mongoose.Types.ObjectId, ref: 'Item' },
        necklace: { type: mongoose.Types.ObjectId, ref: 'Item' },
        neckwear: { type: mongoose.Types.ObjectId, ref: 'Item' },
        coat: { type: mongoose.Types.ObjectId, ref: 'Item' },

        belt: { type: mongoose.Types.ObjectId, ref: 'Item' },
        bottom: { type: mongoose.Types.ObjectId, ref: 'Item' },
        socks: { type: mongoose.Types.ObjectId, ref: 'Item' },
        shoes: { type: mongoose.Types.ObjectId, ref: 'Item' },

        bracelets: { type: mongoose.Types.ObjectId, ref: 'Item' },
        wings: { type: mongoose.Types.ObjectId, ref: 'Item' },
        bag: { type: mongoose.Types.ObjectId, ref: 'Item' },

        gloves: { type: mongoose.Types.ObjectId, ref: 'Item' },
        handheld: { type: mongoose.Types.ObjectId, ref: 'Item' },

        tattoos: {
            head: { type: mongoose.Types.ObjectId, ref: 'Item' },
            neck: { type: mongoose.Types.ObjectId, ref: 'Item' },

            chest: { type: mongoose.Types.ObjectId, ref: 'Item' },
            stomach: { type: mongoose.Types.ObjectId, ref: 'Item' },

            backUpper: { type: mongoose.Types.ObjectId, ref: 'Item' },
            backLower: { type: mongoose.Types.ObjectId, ref: 'Item' },

            armRight: { type: mongoose.Types.ObjectId, ref: 'Item' },
            armLeft: { type: mongoose.Types.ObjectId, ref: 'Item' },

            legRight: { type: mongoose.Types.ObjectId, ref: 'Item' },
            legLeft: { type: mongoose.Types.ObjectId, ref: 'Item' },
        },
    },

    inventory: [{ type: mongoose.Types.ObjectId, ref: 'Item' }],
    wishList: [{ type: mongoose.Types.ObjectId, ref: 'Item' }],
    friendsList: [{ type: mongoose.Types.ObjectId, ref: 'User' }],
    blockedList: [{ type: mongoose.Types.ObjectId, ref: 'User' }],

    profile: {
        bio: { type: String, default: '' },
        bioColor: { type: String, default: '' },
        match: { type: mongoose.Types.ObjectId, ref: 'User' },
        location: { type: String, default: 'The Moon' },
        badges: [{ type: Number }]
    },

    activePetIndex: { type: Number, default: 0 },
    pets: [{
        pet: { type: mongoose.Types.ObjectId, ref: 'Pet' },
        name: { type: String, default: '' },
    }]
}, { timestamps: true })

const User = mongoose.model('User', userSchema)
export default User