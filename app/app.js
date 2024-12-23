import bootstrap from './modules/_bootstrap.js'
import connectDB from './modules/db.js'
import express from 'express'
import bodyParser from 'body-parser'
import mongoSanitize from 'express-mongo-sanitize'
import multer from 'multer'
import os from 'os'

const app = express()

// Resource monitoring function
function monitorResources() {
    // Get CPU usage
    const cpus = os.cpus()
    let totalIdle = 0
    let totalTick = 0
    
    cpus.forEach(cpu => {
        for (const type in cpu.times) {
            totalTick += cpu.times[type]
        }
        totalIdle += cpu.times.idle
    })
    
    const cpuUsage = ((1 - totalIdle / totalTick) * 100).toFixed(2)
    
    // Get memory usage
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    const memoryUsage = ((usedMemory / totalMemory) * 100).toFixed(2)
    
    // Convert to MB for readability
    const usedMemoryMB = Math.round(usedMemory / 1024 / 1024)
    const totalMemoryMB = Math.round(totalMemory / 1024 / 1024)
    
    console.log(`
        Resource Usage:
        CPU: ${cpuUsage}%
        Memory: ${memoryUsage}% (${usedMemoryMB}MB / ${totalMemoryMB}MB)
        Timestamp: ${new Date().toISOString()}
        ---------------------------------------`)
}

// Start monitoring every 10 seconds
setInterval(monitorResources, 10000)

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
console.log(`Is Windows: ${process.platform === 'win32'}`)
console.log(`Server started @ ${process.env.PORT}`)

// API
app.get('/', (req, res) => res.send('it works! :D'))

import api from './modules/api.js'
app.get('/avatar/:type/:username.webp', async (req, res) => api.getAvatar(req, res))
app.get('/clear-cache', async (req, res) => api.handleCacheClear(req, res))