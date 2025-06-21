import User from '../models/User.js'
import Item from '../models/Item.js'

const getUrl = (location) => {
    if (location == null || location == undefined || location == '') {
        return null
    }

    return `https://${process.env.DO_SPACE_ENDPOINT}/${location}`
}

const getSpriteLocation = async (item) => {
    if (!item) {
        return null
    }
    
    /*
    let l = await Item.findById(item, 'spriteLocation').lean()
    if (!l) {
        return null
    }

    return getUrl(l.spriteLocation)
    */
    return `https://${process.env.DO_SPACE_ENDPOINT}/item-sprite/${item}.webp`
}

const getCustomizationByUsername = async (username) => {
    let user = await User.findOne({ username: req.params.username }, 'customization').lean()
    const c = await customizationLoader(user)

    return c
}

const getCustomization = async (userId) => {
    let user = await User.findById(userId, 'customization').lean()
    const c = await customizationLoader(user)

    //console.log(user.customization)
    return c
}

const customizationLoader = async (user) => {
    user.customization.hair.item = await getSpriteLocation(user.customization.hair.item)
    user.customization.beard.item = await getSpriteLocation(user.customization.beard.item)
    user.customization.eyes.item = await getSpriteLocation(user.customization.eyes.item)
    user.customization.eyebrows.item = await getSpriteLocation(user.customization.eyebrows.item)

    user.customization.head = await getSpriteLocation(user.customization.head)
    user.customization.nose = await getSpriteLocation(user.customization.nose)
    user.customization.mouth = await getSpriteLocation(user.customization.mouth)

    user.customization.hat = await getSpriteLocation(user.customization.hat)
    user.customization.piercings = await getSpriteLocation(user.customization.piercings)
    user.customization.glasses = await getSpriteLocation(user.customization.glasses)

    user.customization.top = await getSpriteLocation(user.customization.top)
    user.customization.coat = await getSpriteLocation(user.customization.coat)
    user.customization.bottom = await getSpriteLocation(user.customization.bottom)
    user.customization.foot = await getSpriteLocation(user.customization.foot)

    user.customization.bracelets = await getSpriteLocation(user.customization.bracelets)
    user.customization.neckwear = await getSpriteLocation(user.customization.neckwear)
    user.customization.bag = await getSpriteLocation(user.customization.bag)

    user.customization.gloves = await getSpriteLocation(user.customization.gloves)
    user.customization.handheld = await getSpriteLocation(user.customization.handheld)

    if (!user.customization.tattoos) {
        return user.customization
    }
    
    user.customization.tattoos.head = await getSpriteLocation(user.customization.tattoos.head)
    user.customization.tattoos.neck = await getSpriteLocation(user.customization.tattoos.neck)
    user.customization.tattoos.chest = await getSpriteLocation(user.customization.tattoos.chest)
    user.customization.tattoos.stomach = await getSpriteLocation(user.customization.tattoos.stomach)
    user.customization.tattoos.backUpper = await getSpriteLocation(user.customization.tattoos.backUpper)
    user.customization.tattoos.backLower = await getSpriteLocation(user.customization.tattoos.backLower)
    user.customization.tattoos.armRight = await getSpriteLocation(user.customization.tattoos.armRight)
    user.customization.tattoos.armLeft = await getSpriteLocation(user.customization.tattoos.armLeft)
    user.customization.tattoos.legRight = await getSpriteLocation(user.customization.tattoos.legRight)
    user.customization.tattoos.legLeft = await getSpriteLocation(user.customization.tattoos.legLeft)
    
    return user.customization
}

export default { getUrl, getCustomization, customizationLoader }