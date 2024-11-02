import dotenv from 'dotenv'
import connectDB from './modules/db.js'
import api from './modules/api.js'
import customization from './modules/customization.js'
import { createCanvas, loadImage } from 'canvas'
import uploadContent from './modules/uploadContent.js'
import sharp from 'sharp'
import axios from 'axios'

import express from 'express'

import bodyParser from 'body-parser'
import mongoSanitize from 'express-mongo-sanitize'
import multer from 'multer'

import User from './models/User.js'
import Item from './models/Item.js'

const app = express()

// Express Plugins
app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', process.env.CENTRAL_SERVER)
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, x-session-key')
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Max-Age', '86400')
    next()
})
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(multer().none())
app.use(mongoSanitize({ replaceWith: '_', allowDots: true }))

dotenv.config()
await connectDB()

app.listen(process.env.PORT)
console.log(`Server started @ ${process.env.PORT}`)

// API
app.get('/', (req, res) => res.send('it works! :D'))

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

app.get('/avatar/:username', async (req, res) => {
    
})

//app.get('/profile/customization/:username', checkSessionKey, async (req, res) => api.getCustomization(req, res))
//app.get('/profile/:username', checkSessionKey, async (req, res) => api.getProfile(req, res))
//app.post('/profile/bio', checkSessionKey, async (req, res) => api.updateBio(req, res))
//app.post('/profile/location', checkSessionKey, async (req, res) => api.updateLocation(req, res))
//app.post('/profile/bioColor', checkSessionKey, async (req, res) => api.updateBioColor(req, res))
//app.get('/profile/:username/match/:value', checkSessionKey, async (req, res) => api.updateMatch(req, res))
//app.get('/profile/:username/getLocation', checkSessionKey, async (req, res) => api.getLocation(req, res))
//
//app.post('/customization/nameColor', checkSessionKey, async (req, res) => api.updateNameColor(req, res))
//
//app.get('/profile/:username/comment', checkSessionKey, async (req, res) => api.getComment(req, res))
//app.post('/profile/:username/comment', checkSessionKey, async (req, res) => api.addComment(req, res))
//app.delete('/profile/comment/:id', checkSessionKey, async (req, res) => api.deleteComment(req, res))
//
//app.get('/inventory', checkSessionKey, async (req, res) => api.getInventory(req, res))
//
//import apiMail from './controllers/apiMail.js'
//app.post('/mail/:username', checkSessionKey, async (req, res) => apiMail.sendMail(req, res))
//app.post('/mail/:id/reply', checkSessionKey, async (req, res) => apiMail.sendMailReply(req, res))
//app.get('/mail', checkSessionKey, async (req, res) => apiMail.getMail(req, res))
//app.get('/mail/:id/read', checkSessionKey, async (req, res) => apiMail.readMail(req, res))
//app.get('/mail/:id/save/:value', checkSessionKey, async (req, res) => apiMail.saveMail(req, res))
//app.delete('/mail/:id', checkSessionKey, async (req, res) => apiMail.deleteMail(req, res))
//app.get('/mail/unread/count', checkSessionKey, async (req, res) => apiMail.getUnreadCount(req, res))
//
//import apiFriend from './controllers/apiFriend.js'
//import { log } from 'console'
//app.post('/friend/:username', checkSessionKey, async (req, res) => apiFriend.sendFriendRequest(req, res))
//app.get('/friend/:id/accept', checkSessionKey, async (req, res) => apiFriend.acceptFriendRequest(req, res))
//app.delete('/friend/:username', checkSessionKey, async (req, res) => apiFriend.deleteFriend(req, res))
//app.get('/friend/list', checkSessionKey, async (req, res) => apiFriend.getFriendsList(req, res))
//app.get('/friend/list/online', checkSessionKey, async (req, res) => apiFriend.getOnlineFriendsList(req, res))