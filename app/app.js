import bootstrap from './modules/_bootstrap.js'
import connectDB from './modules/db.js'
import express from 'express'

import bodyParser from 'body-parser'
import mongoSanitize from 'express-mongo-sanitize'
import multer from 'multer'

import User from './models/User.js'
import Item from './models/Item.js'

const app = express()

// Express Plugins
app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', 'https://makichat.com')
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

await connectDB()

app.listen(process.env.PORT)
console.log(`Server started @ ${process.env.PORT}`)

// API
app.get('/', (req, res) => res.send('it works! :D'))

import api from './modules/api.js'
app.get('/avatar/:type/:username.webp', async (req, res) => api.getAvatar(req, res))
app.get('/clear-cache', async (req, res) => api.handleCacheClear(req, res))
//app.get('/download/webp/:hash', async (req, res) => api.download(req, res))