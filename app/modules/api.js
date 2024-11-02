import bcrypt from 'bcrypt'
import moment from 'moment'
import crypto from 'crypto'
import { v4 as uuid } from 'uuid'
import customization from './customization.js'
import { createCanvas, loadImage } from 'canvas'
import uploadContent from './uploadContent.js'
import sharp from 'sharp'
import axios from 'axios'

import User from '../models/User.js'
import Item from '../models/Item.js'

const targetR = 0
const targetG = 255
const targetB = 4
const toleranceR = 50
const toleranceG = 150
const toleranceB = 50

const isColorSimilar = (r1, g1, b1, r2, g2, b2) => {
    return Math.abs(r1 - r2) <= toleranceR &&
           Math.abs(g1 - g2) <= toleranceG &&
           Math.abs(b1 - b2) <= toleranceB
}

const generateAvatar = async (req, res) => {

}

export default { generateAvatar }