/**
 * ============================================================
 * microservices/server-production.js — Single-process Production Mode
 * ============================================================
 * Designed for low-memory environments like Render Free (512MB).
 * Runs gateway + worker logic IN THE SAME Node.js process using
 * in-process function calls instead of separate child processes.
 *
 * Architecture:
 *  - Gateway HTTP/WS server starts on PORT (default 3001)
 *  - Worker scan jobs are processed inline (no IPC overhead)
 *  - Migration runs on startup
 *  - Python Playwright service is called via HTTP (separate service)
 * ============================================================
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

// ── DB & Models ──────────────────────────────────────────────
const { pool } = require('./config/db');
const Report = require('./models/Report');

// ── Controllers (monolith-compatible) ────────────────────────
const { verifyGoogleToken, generateSessionToken, checkCredits } = require('./middleware/authMiddleware');
const controller = require('./controllers/reportController');
const aiAudit = require('./controllers/aiAuditController');
const { scanBrokenLinks } = require('./controllers/brokenLinkController');
const { initializeGemini } = require('./geminiAnalyzer');
const { initializeGroq } = require('./groqAnalyzer');

// ── Migrations ────────────────────────────────────────────────
const { runMigrations } = require('./db/migrate');

const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4().substring(0, 8);
  wsClients.set(clientId, ws);
  console.log(`🔗 WS client connected: ${clientId}`);
  ws.on('close', () => { wsClients.delete(clientId); console.log(`🔌 WS disconnected: ${clientId}`); });
  ws.on('error', () => wsClients.delete(clientId));
  ws.send(JSON.stringify({ type: 'connected', clientId, message: 'WebSocket connected successfully' }));
});

function broadcastUpdate(data) {
  const message = JSON.stringify(data);
  wsClients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(message); } catch (_) {}
    }
  });
}
app.set('broadcastUpdate', broadcastUpdate);

// ── Middleware ────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: Origin "${origin}" not allowed`));
  },
  methods: ['GET', 'POST', 'PATCH'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
app.use('/api/screenshots', express.static(reportsDir));

// ── Internal broadcast: Python → Node → WS ───────────────────
app.post('/internal/broadcast', (req, res) => {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'Forbidden: internal endpoint only' });

  const update = req.body || {};
  broadcastUpdate(update);
  res.json({ success: true });

  const { testId } = update;
  if (testId) {
    (async () => {
      try {
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
          if (update.message) logMessage = update.message;
          else if (update.type === 'links-discovered') logMessage = `Discovered ${update.totalPages} pages (${update.headerLinks || 0} header, ${update.footerLinks || 0} footer)`;
          else if (update.type === 'page-start') logMessage = `Testing page ${update.pageIndex + 1}/${update.totalPages}: ${update.text || update.url}`;
          else if (update.type === 'screenshot-taken') logMessage = `📸 Screenshot captured: ${update.url}`;
          else if (update.type === 'ai-analyzing') logMessage = `🤖 AI analyzing page ${update.pageIndex + 1}...`;
          else if (update.type === 'ai-complete') logMessage = `✅ AI analysis complete for page ${update.pageIndex + 1}`;

          if (logMessage) {
            if (!rep.statusLogs) rep.statusLogs = [];
            rep.statusLogs.push({ id: rep.statusLogs.length + 1, message: logMessage, type: logType, time });
          }

          if (update.type === 'live-screenshot') {
            rep.latestLiveScreenshot = `data:image/png;base64,${update.image}`;
            rep.latestLiveUrl = update.url;
          } else if (update.type === 'links-discovered') {
            rep.totalPages = update.totalPages;
            rep.headerLinks = update.headerLinks || [];
            rep.footerLinks = update.footerLinks || [];
          } else if (update.type === 'page-complete') {
            rep.pagesCompleted = update.pageIndex + 1;
            const result = update.result;
            if (result) {
              const pageData = {
                index: update.pageIndex, url: result.url, title: result.title,
                text: result.title || '', source: result.source || 'body',
                loadStatus: result.loadStatus, loadTimeMs: result.loadTimeMs || 0,
                httpStatus: result.httpStatus || 200,
                screenshotUrl: result.screenshotUrl,
                desktopScreenshotUrl: result.desktopScreenshotUrl || result.screenshotUrl,
                mobileScreenshotUrl: result.mobileScreenshotUrl || '',
                indexStatus: result.indexStatus || 'unknown', robots: result.robots || null,
                consoleErrors: result.consoleErrors || [], networkErrors: result.networkErrors || [],
                networkLog: result.networkLog || { requests: [], summary: {} },
                elementsInfo: result.elementsInfo || {}, brokenLinksCheck: result.brokenLinksCheck || [],
                imageCheckResults: result.imageCheckResults || [], videoCheckResults: result.videoCheckResults || [],
                aiAnalysis: result.aiAnalysis, groqAnalysis: result.groqAnalysis, error: result.error || null
              };
              if (!rep.pages) rep.pages = [];
              const idx = rep.pages.findIndex(p => p.url === result.url);
              if (idx >= 0) rep.pages[idx] = pageData; else rep.pages.push(pageData);
              rep.globalSummary = rep.globalSummary || { totalErrors: 0 };
              rep.globalSummary.totalErrors = rep.pages.reduce((s, p) => s + (p.consoleErrors || []).length + (p.networkErrors || []).length, 0);
              const scores = rep.pages.filter(p => p.aiAnalysis && p.aiAnalysis.overallScore > 0).map(p => p.aiAnalysis.overallScore);
              rep.overallScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
            }
          } else if (update.type === 'page-error') {
            rep.pagesCompleted = update.pageIndex + 1;
            const pageData = { index: update.pageIndex, url: update.url, title: 'Error', text: 'Error', source: 'error', loadStatus: 'ERROR', loadTimeMs: 0, httpStatus: 500, screenshotUrl: '', consoleErrors: [], networkErrors: [], elementsInfo: {}, brokenLinksCheck: [], imageCheckResults: [], videoCheckResults: [], error: update.error };
            if (!rep.pages) rep.pages = [];
            const idx = rep.pages.findIndex(p => p.url === update.url);
            if (idx >= 0) rep.pages[idx] = pageData; else rep.pages.push(pageData);
          }

          await Report.upsertReport({
            testId, userId: dbUserId, frontendUrl: rep.frontendUrl || '', backendUrl: rep.backendUrl || null,
            testDate: rep.testDate || new Date().toISOString(), overallScore: rep.overallScore || 0,
            totalPages: rep.totalPages || 0,
            status: update.type === 'test-complete' ? 'complete' : (row.status || 'running'),
            reportData: rep
          });
        }
      } catch (err) {
        console.error(`⚠️ broadcast DB sync error: ${err.message}`);
      }
    })();
  }
});

// ── API Routes ────────────────────────────────────────────────
app.get('/api/health', controller.getHealth);

app.post('/api/login', verifyGoogleToken, (req, res) => {
  const token = generateSessionToken({ id: req.userId, email: req.userEmail, name: req.userName, picture: req.userPicture });
  res.json({ success: true, token, user: { id: req.userId, email: req.userEmail, name: req.userName, picture: req.userPicture } });
});

const testRoutes = require('./routes/testRoutes');
app.use('/api', testRoutes);
app.use('/api/profile', require('./routes/profileRoutes'));

app.get('/', (req, res) => {
  res.json({ message: '🚀 Website Testing Platform API v2.0 (Production)', status: 'OK', websocket: `ws://0.0.0.0:${PORT}/ws` });
});

app.use('*', (req, res) => res.status(404).json({ success: false, error: `Route "${req.originalUrl}" not found` }));
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.message);
  res.status(500).json({ success: false, error: 'Internal Server Error: ' + err.message });
});

// ── Start ─────────────────────────────────────────────────────
async function startServer() {
  console.log('\n' + '='.repeat(60));
  console.log('  🚀 WEBSITE TESTING PLATFORM v2.0 (Single-Process Mode)');
  console.log('='.repeat(60));

  await runMigrations();
  console.log('  ✅ Database migrations complete');

  initializeGemini();
  initializeGroq();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`  🌐 HTTP Server  : http://0.0.0.0:${PORT}`);
    console.log(`  🔗 WebSocket    : ws://0.0.0.0:${PORT}/ws`);
    console.log(`  ❤️  Health      : GET http://0.0.0.0:${PORT}/api/health`);
    console.log('='.repeat(60));
    console.log('  ✅ Ready for connections...');
    console.log('='.repeat(60) + '\n');
  });
}

startServer();

process.on('SIGINT', () => { wss.close(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { wss.close(); server.close(); process.exit(0); });
process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));
