import bootstrap from './modules/_bootstrap.js'
import connectDB from './modules/db.js'
import express from 'express'
import bodyParser from 'body-parser'
import mongoSanitize from 'express-mongo-sanitize'
import multer from 'multer'
import os from 'os'
import Bull from 'bull'

const app = express()

// Resource monitoring function with queue stats
async function monitorResources() {
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
    
    // Get queue stats
    let queueStats = { waiting: 0, active: 0, completed: 0, failed: 0, inProgress: 0 }
    try {
        const api = await import('./modules/api.js')
        queueStats = await api.default.getQueueStats()
    } catch (error) {
        // Queue not initialized yet
    }
    
    console.log(`
        Resource Usage:
        CPU: ${cpuUsage}%
        Memory: ${memoryUsage}% (${usedMemoryMB}MB / ${totalMemoryMB}MB)
        Queue Stats:
        - Waiting: ${queueStats.waiting}
        - Active: ${queueStats.active}
        - Completed: ${queueStats.completed}
        - Failed: ${queueStats.failed}
        - In Progress: ${queueStats.inProgress}
        Timestamp: ${new Date().toISOString()}
        ---------------------------------------`)
}

// Start monitoring every 10 seconds
setInterval(monitorResources, 10000)

// Express Plugins
app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*')
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

// Add request timeout middleware
app.use((req, res, next) => {
    // Set a reasonable timeout for avatar requests
    if (req.path.includes('/avatar/')) {
        req.setTimeout(5000) // 5 second timeout for avatar requests
    }
    next()
})

await connectDB()

app.listen(process.env.PORT, () => {
    console.log(`Server started @ ${process.env.PORT}`)
    console.log(`Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`)
})
console.log(`Is Windows: ${process.platform === 'win32'}`)

// API
app.get('/', (req, res) => res.send('it works! :D'))

import api from './modules/api.js'

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const queueStats = await api.getQueueStats()
        const healthy = queueStats.failed < 100 && queueStats.waiting < 1000
        
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            queue: queueStats
        })
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error.message
        })
    }
})

// Avatar endpoints
app.get('/avatar/:type/:username.webp', async (req, res) => api.getAvatar(req, res))

// Cache management
app.get('/clear-cache', async (req, res) => api.handleCacheClear(req, res))

// Queue management endpoints
app.get('/queue/stats', async (req, res) => {
    try {
        const stats = await api.getQueueStats()
        res.json(stats)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// Optional: Admin endpoint to pause/resume queue processing
app.post('/queue/pause', async (req, res) => {
    try {
        await api.avatarGenerationQueue.pause()
        res.json({ status: 'paused' })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/queue/resume', async (req, res) => {
    try {
        await api.avatarGenerationQueue.resume()
        res.json({ status: 'resumed' })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// Optional: Force process a specific user
app.post('/queue/process/:username', async (req, res) => {
    try {
        const { username } = req.params
        const priority = req.body.priority || 10 // High priority
        
        // This would need to be implemented in api.js
        // For now, just return a placeholder
        res.json({ 
            message: 'Job queued for processing',
            username,
            priority
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})