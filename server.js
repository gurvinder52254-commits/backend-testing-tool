/**
 * ============================================================
 * server.js - Express + WebSocket Server
 * ============================================================
 * Main entry point. Serves the REST API, handles WebSocket
 * connections for live testing updates, and serves static
 * screenshot files.
 * ============================================================
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { initializeGemini } = require('./geminiAnalyzer');
const { initializeGroq } = require('./groqAnalyzer');

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server (for both Express and WebSocket)
const server = http.createServer(app);

// ============================================================
// WebSocket Server Setup
// ============================================================
const wss = new WebSocketServer({ server, path: '/ws' });

// Store active WebSocket clients
const wsClients = new Map();

wss.on('connection', (ws) => {
    const clientId = require('uuid').v4().substring(0, 8);
    wsClients.set(clientId, ws);
    console.log(`🔗 WebSocket client connected: ${clientId}`);

    ws.on('close', () => {
        wsClients.delete(clientId);
        console.log(`🔌 WebSocket client disconnected: ${clientId}`);
    });

    ws.on('error', (err) => {
        console.error(`❌ WebSocket error [${clientId}]:`, err.message);
        wsClients.delete(clientId);
    });

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'WebSocket connected successfully',
    }));
});

/**
 * Broadcast update to all connected WebSocket clients
 */
function broadcastUpdate(data) {
    const message = JSON.stringify(data);
    wsClients.forEach((ws, clientId) => {
        if (ws.readyState === ws.OPEN) {
            try {
                ws.send(message);
            } catch (err) {
                console.error(`❌ Failed to send to ${clientId}`);
            }
        }
    });
}

// Make broadcast available to routes
app.set('broadcastUpdate', broadcastUpdate);

// ============================================================
// Middleware
// ============================================================
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/screenshots')) {
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        console.log(`[${timestamp}] ${req.method} ${req.path}`);
    }
    next();
});

// Serve screenshots statically
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}
app.use('/api/screenshots', express.static(reportsDir));

// ============================================================
// Routes
// ============================================================
const testRoutes = require('./routes/testRoutes');
app.use('/api', testRoutes);

// Root route
app.get('/', (req, res) => {
    res.json({
        message: '🚀 Website Testing Platform API v2.0',
        endpoints: {
            startTest: 'POST /api/start-test',
            health: 'GET /api/health',
            reports: 'GET /api/reports',
            screenshots: 'GET /api/screenshots/:testId/:filename',
        },
        websocket: `ws://localhost:${PORT}/ws`,
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: `Route "${req.originalUrl}" not found`,
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('❌ Unhandled Error:', err.message);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error: ' + err.message,
    });
});

// ============================================================
// Initialize & Start Server
// ============================================================
initializeGemini();
initializeGroq();

server.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('  🚀 WEBSITE TESTING PLATFORM v2.0');
    console.log('='.repeat(60));
    console.log(`  🌐 HTTP Server  : http://localhost:${PORT}`);
    console.log(`  🔗 WebSocket    : ws://localhost:${PORT}/ws`);
    console.log(`  🔬 Test API     : POST http://localhost:${PORT}/api/start-test`);
    console.log(`  🧠 Groq AI      : POST http://localhost:${PORT}/api/groq-analyze`);
    console.log(`  ❤️  Health      : GET http://localhost:${PORT}/api/health`);
    console.log(`  📁 Reports      : ${reportsDir}`);
    console.log('='.repeat(60));
    console.log('  ✅ Ready for connections...');
    console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    wss.close();
    server.close();
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
});
