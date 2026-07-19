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
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// ✅ SECURITY: Restrict CORS to known frontend origins only
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. Postman, server-to-server) and allowed origins
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: Origin "${origin}" not allowed`));
  },
  methods: ['GET', 'POST', 'PATCH'],
  credentials: true,
}));
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
app.use('/api/profile', require('./routes/profileRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));

// Relay updates from Python service to WebSocket clients
app.post('/internal/broadcast', (req, res) => {
    const broadcast = req.app.get('broadcastUpdate');
    const update = req.body || {};
    if (broadcast) {
        broadcast(update);
    }
    res.json({ success: true });

    const { testId } = update;
    if (testId) {
        (async () => {
            try {
                const { pool } = require('./config/db');
                const Report = require('./models/Report');
                const dbRes = await pool.query('SELECT user_id, report_data, status FROM reports WHERE test_id = $1', [testId]);
                if (dbRes.rows.length > 0) {
                    const row = dbRes.rows[0];
                    const rep = row.report_data || {};
                    const dbUserId = row.user_id;

                    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
                    const logType = update.type === 'page-error' || update.type === 'test-error' ? 'error' :
                                    (update.type === 'ai-analyzing' || update.type === 'groq-status' ? 'ai' : 
                                     (update.type === 'page-complete' || update.type === 'test-complete' ? 'success' : 'info'));
                    
                    let logMessage = '';
                    if (update.message) {
                        logMessage = update.message;
                    } else if (update.type === 'links-discovered') {
                        logMessage = `Discovered ${update.totalPages} pages (${update.headerLinks || 0} header, ${update.footerLinks || 0} footer)`;
                    } else if (update.type === 'page-start') {
                        logMessage = `Testing page ${update.pageIndex + 1}/${update.totalPages}: ${update.text || update.url}`;
                    } else if (update.type === 'screenshot-taken') {
                        logMessage = `📸 Screenshot captured: ${update.url}`;
                    } else if (update.type === 'ai-analyzing') {
                        logMessage = `🤖 AI analyzing page ${update.pageIndex + 1}...`;
                    } else if (update.type === 'ai-complete') {
                        logMessage = `✅ AI analysis complete for page ${update.pageIndex + 1}`;
                    }

                    if (logMessage) {
                        if (!rep.statusLogs) rep.statusLogs = [];
                        rep.statusLogs.push({
                            id: rep.statusLogs.length + 1,
                            message: logMessage,
                            type: logType,
                            time
                        });
                    }

                    if (update.type === 'live-screenshot') {
                        rep.latestLiveScreenshot = `data:image/png;base64,${update.image}`;
                        rep.latestLiveUrl = update.url;
                    }

                    if (update.type === 'links-discovered') {
                        rep.totalPages = update.totalPages;
                        rep.headerLinks = update.headerLinks || [];
                        rep.footerLinks = update.footerLinks || [];
                    } else if (update.type === 'page-complete') {
                        rep.pagesCompleted = update.pageIndex + 1;
                        const result = update.result;
                        if (result) {
                            const pageData = {
                                index: update.pageIndex,
                                url: result.url,
                                title: result.title,
                                text: result.title || '',
                                source: result.source || 'body',
                                loadStatus: result.loadStatus,
                                loadTimeMs: result.loadTimeMs || 0,
                                httpStatus: result.httpStatus || 200,
                                screenshotUrl: result.screenshotUrl,
                                desktopScreenshotUrl: result.desktopScreenshotUrl || result.screenshotUrl,
                                mobileScreenshotUrl: result.mobileScreenshotUrl || '',
                                indexStatus: result.indexStatus || 'unknown',
                                robots: result.robots || null,
                                consoleErrors: result.consoleErrors || [],
                                networkErrors: result.networkErrors || [],
                                networkLog: result.networkLog || { requests: [], summary: { totalRequests: 0, totalSize: 0, totalTransferred: 0, domContentLoaded: 0, loadTime: 0, finishTime: 0 } },
                                elementsInfo: result.elementsInfo || {},
                                brokenLinksCheck: result.brokenLinksCheck || [],
                                imageCheckResults: result.imageCheckResults || [],
                                videoCheckResults: result.videoCheckResults || [],
                                aiAnalysis: result.aiAnalysis,
                                groqAnalysis: result.groqAnalysis,
                                error: result.error || null
                            };

                            if (!rep.pages) rep.pages = [];
                            const existingIdx = rep.pages.findIndex(p => p.url === result.url);
                            if (existingIdx >= 0) {
                                rep.pages[existingIdx] = pageData;
                            } else {
                                rep.pages.push(pageData);
                            }

                            rep.globalSummary = rep.globalSummary || { totalErrors: 0 };
                            rep.globalSummary.totalErrors = rep.pages.reduce((sum, p) => sum + (p.consoleErrors || []).length + (p.networkErrors || []).length, 0);

                            const scores = rep.pages
                                .filter((p) => p.aiAnalysis && p.aiAnalysis.overallScore > 0)
                                .map((p) => p.aiAnalysis.overallScore);
                            rep.overallScore = scores.length > 0
                                ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                                : 0;
                        }
                    } else if (update.type === 'page-error') {
                        rep.pagesCompleted = update.pageIndex + 1;
                        const pageData = {
                            index: update.pageIndex,
                            url: update.url,
                            title: 'Error',
                            text: 'Error',
                            source: 'error',
                            loadStatus: 'ERROR',
                            loadTimeMs: 0,
                            httpStatus: 500,
                            screenshotUrl: '',
                            consoleErrors: [],
                            networkErrors: [],
                            elementsInfo: {},
                            brokenLinksCheck: [],
                            imageCheckResults: [],
                            videoCheckResults: [],
                            error: update.error
                        };
                        if (!rep.pages) rep.pages = [];
                        const existingIdx = rep.pages.findIndex(p => p.url === update.url);
                        if (existingIdx >= 0) {
                            rep.pages[existingIdx] = pageData;
                        } else {
                            rep.pages.push(pageData);
                        }
                    }

                    await Report.upsertReport({
                        testId,
                        userId: dbUserId,
                        frontendUrl: rep.frontendUrl || '',
                        backendUrl: rep.backendUrl || null,
                        testDate: rep.testDate || new Date().toISOString(),
                        overallScore: rep.overallScore || 0,
                        totalPages: rep.totalPages || 0,
                        status: update.type === 'test-complete' ? 'complete' : (row.status || 'running'),
                        reportData: rep
                    });
                }
            } catch (err) {
                console.error(`Failed to process broadcast updates in server.js: ${err.message}`);
            }
        })();
    }
});


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
const { runMigrations } = require('./db/migrate');

async function startServer() {
    // Run database migrations on startup
    await runMigrations();

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
}

startServer();

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

