import bootstrap from './modules/_bootstrap.js'
import connectDB from './modules/db.js'
import express from 'express'
import bodyParser from 'body-parser'
import mongoSanitize from 'express-mongo-sanitize'
import multer from 'multer'
import os from 'os'

const app = express()

// Resource monitoring with error handling
function monitorResources() {
    try {
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
            ---------------------------------------
        `)
    } catch (error) {
        console.error('Error monitoring resources:', error)
    }
}

// Start monitoring every 10 seconds
const monitoringInterval = setInterval(monitorResources, 10000)

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Starting graceful shutdown...`)
    
    // Stop accepting new connections
    server.close(() => {
        console.log('HTTP server closed')
    })
    
    // Clear intervals
    clearInterval(monitoringInterval)
    
    // Give ongoing requests 30 seconds to complete
    setTimeout(() => {
        console.log('Forcing shutdown after timeout')
        process.exit(1)
    }, 30000)
    
    try {
        // Cleanup operations here (close DB connections, etc.)
        console.log('Cleanup completed')
        process.exit(0)
    } catch (error) {
        console.error('Error during cleanup:', error)
        process.exit(1)
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Uncaught exception handler
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    // Don't exit - let the process manager restart if needed
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    // Don't exit - let the process manager restart if needed
})

// CORS configuration
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, x-session-key')
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Max-Age', '86400')
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200)
    }
    
    next()
})

// Body parsing middleware with error handling
app.use(bodyParser.urlencoded({ 
    extended: true,
    limit: '10mb',
    parameterLimit: 10000
}))

app.use(bodyParser.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        try {
            JSON.parse(buf)
        } catch (error) {
            res.status(400).json({ error: 'Invalid JSON' })
            throw new Error('Invalid JSON')
        }
    }
}))

// File upload middleware with error handling
const upload = multer({
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        files: 1
    }
})

app.use((req, res, next) => {
    upload.none()(req, res, (err) => {
        if (err) {
            console.error('Multer error:', err)
            return res.status(400).json({ error: 'File upload error' })
        }
        next()
    })
})

// MongoDB sanitization
app.use(mongoSanitize({ 
    replaceWith: '_', 
    allowDots: true,
    onSanitize: ({ req, key }) => {
        console.warn(`Sanitized field ${key} in request`)
    }
}))

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now()
    
    // Log response when finished
    res.on('finish', () => {
        const duration = Date.now() - start
        console.log(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`)
    })
    
    next()
})

// Health check endpoint
app.get('/health', (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            used: process.memoryUsage().heapUsed / 1024 / 1024,
            total: process.memoryUsage().heapTotal / 1024 / 1024
        }
    }
    res.json(health)
})

// Initialize database connection with retry logic
const initializeApp = async () => {
    const maxRetries = 5
    let retries = 0
    
    while (retries < maxRetries) {
        try {
            await connectDB()
            console.log('Database connected successfully')
            break
        } catch (error) {
            retries++
            console.error(`Database connection attempt ${retries} failed:`, error.message)
            
            if (retries >= maxRetries) {
                console.error('Failed to connect to database after max retries')
                process.exit(1)
            }
            
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000))
        }
    }
}

// Start the server
let server
initializeApp().then(() => {
    server = app.listen(process.env.PORT || 3000, () => {
        console.log(`Server started @ ${process.env.PORT || 3000}`)
        console.log(`Platform: ${process.platform}`)
        console.log(`Node version: ${process.version}`)
    })
    
    // Set server timeout
    server.setTimeout(60000) // 60 seconds
    
    server.on('error', (error) => {
        console.error('Server error:', error)
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${process.env.PORT || 3000} is already in use`)
            process.exit(1)
        }
    })
})

// API Routes
app.get('/', (req, res) => {
    res.json({ 
        status: 'operational',
        timestamp: new Date().toISOString()
    })
})

// Import API routes with error handling
import api from './modules/api.js'

// Avatar routes with error wrapper
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
}

app.get('/avatar/:type/:username.webp', asyncHandler(api.getAvatar))
app.get('/clear-cache', asyncHandler(api.handleCacheClear))

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not found',
        path: req.originalUrl
    })
})

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error handler:', err)
    
    // Don't leak error details in production
    const isDevelopment = process.env.NODE_ENV === 'development'
    
    res.status(err.status || 500).json({
        error: isDevelopment ? err.message : 'Internal server error',
        ...(isDevelopment && { stack: err.stack })
    })
})

export default app