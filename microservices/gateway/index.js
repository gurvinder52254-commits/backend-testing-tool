/**
 * ============================================================
 * microservices/gateway — DROP-IN API + WebSocket Gateway
 * ============================================================
 * A drop-in replacement for the monolith server.js. It binds the
 * SAME port (3001) and exposes the SAME REST API + broadcast
 * WebSocket, so the existing frontend works with ZERO changes.
 *
 * The ONLY behavioural difference from the monolith: a scan is
 * pushed onto a durable queue (pg-boss) and executed by a
 * separate `worker` process — which runs the exact same
 * runWebsiteTest() engine (full functionality) and streams every
 * event back here via POST /internal/broadcast for WS fan-out.
 *
 * Reads (reports/login/groq/scan-domain) reuse the monolith's own
 * controllers, so their behaviour is identical.
 * ============================================================
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const config = require('../shared/config');
const { createLogger } = require('../shared/logger');
const queue = require('../shared/queue');
const scanStore = require('../shared/scanStore');

// Reuse the monolith's auth + controllers verbatim (identical behaviour).
const { verifyGoogleToken, generateSessionToken, checkCredits } = require('../../middleware/authMiddleware');
const controller = require('../../controllers/reportController');
const Report = require('../../models/Report');
const aiAudit = require('../../controllers/aiAuditController');

const log = createLogger('gateway');

const app = express();
const server = http.createServer(app);

// ---- WebSocket: identical broadcast model to the monolith ----
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4().substring(0, 8);
  wsClients.set(clientId, ws);
  log.info(`WS client connected: ${clientId}`);
  ws.on('close', () => wsClients.delete(clientId));
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

// ---- middleware ----
app.use(cors({ origin: process.env.MS_CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PATCH'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const reportsDir = config.reportsDir;
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
app.use('/api/screenshots', express.static(reportsDir));

// ---- internal: worker → gateway event relay → WS broadcast ----
// (localhost only; the worker posts every engine event here)
app.post('/internal/broadcast', (req, res) => {
  // ✅ SECURITY: Only allow requests from localhost/internal network
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ error: 'Forbidden: internal endpoint only' });
  }
  broadcastUpdate(req.body || {});
  res.json({ ok: true });
});

// ============================================================
// REST API — mirrors the monolith exactly
// ============================================================
app.get('/api/health', controller.getHealth);

app.post('/api/login', verifyGoogleToken, (req, res) => {
  const token = generateSessionToken({
    id: req.userId, email: req.userEmail, name: req.userName, picture: req.userPicture,
  });
  res.json({
    success: true,
    token,
    user: { id: req.userId, email: req.userEmail, name: req.userName, picture: req.userPicture },
  });
});

// start-test is the ONLY overridden endpoint: enqueue instead of run inline.
app.post('/api/start-test', verifyGoogleToken, checkCredits, async (req, res) => {
  try {
    let { frontendUrl, backendUrl, scanType, userDetails, urls } = req.body || {};
    if (!frontendUrl) {
      return res.status(400).json({ success: false, error: 'frontendUrl is required.' });
    }
    if (!/^https?:\/\//i.test(frontendUrl)) frontendUrl = 'https://' + frontendUrl;
    if (backendUrl && !/^https?:\/\//i.test(backendUrl)) backendUrl = 'https://' + backendUrl;
    try {
      new URL(frontendUrl);
      if (backendUrl) new URL(backendUrl);
    } catch (_) {
      return res.status(400).json({ success: false, error: 'Invalid URL format.' });
    }

    const testId = uuidv4().substring(0, 8);
    
    // Deduct 1 credit from user and log to ledger
    const { pool } = require('../../config/db');
    await pool.query('UPDATE users SET credits = credits - 1 WHERE id = $1', [req.userId]);
    await pool.query(
      'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, -1, $2)',
      [req.userId, `Scan initiated/enqueued for URL: ${frontendUrl}`]
    );

    await scanStore.createScan({ testId, userId: req.userId, frontendUrl, backendUrl, scanType });
    await queue.send(config.queues.scan, {
      testId, userId: req.userId, frontendUrl, backendUrl: backendUrl || null,
      scanType: scanType || 'domain', userDetails, urls,
    });

    log.info(`Scan queued: ${testId} (${frontendUrl})`);
    res.json({ success: true, testId, message: 'Test started. Connect to WebSocket for live updates.' });
  } catch (err) {
    log.error('start-test error:', err.message);
    res.status(500).json({ success: false, error: `Server error: ${err.message}` });
  }
});

// Live status backed by durable state (worker runs in another process, so the
// monolith's in-memory activeTests map isn't available here).
app.get('/api/test/:testId', verifyGoogleToken, async (req, res) => {
  const { testId } = req.params;
  try {
    const report = await Report.findById(testId, req.userId);
    if (report) return res.json({ success: true, status: report.status || 'running', report });
  } catch (_) {}
  const progress = await scanStore.getProgress(testId);
  if (progress && progress.userId === req.userId) {
    return res.json({ success: true, status: progress.status, report: null });
  }
  return res.status(404).json({ success: false, error: 'Test not found' });
});

// Everything else reuses the monolith controllers unchanged.
app.post('/api/scan-domain', verifyGoogleToken, controller.scanDomain);
app.get('/api/scan-status/:jobId', verifyGoogleToken, controller.getScanStatus);
app.get('/api/reports', verifyGoogleToken, controller.getReports);
app.get('/api/reports/:testId/pages', verifyGoogleToken, controller.getReportPages);
app.get('/api/reports/:testId', verifyGoogleToken, controller.getReport);
app.post('/api/test', verifyGoogleToken, controller.testLegacy);
app.post('/api/groq-analyze', verifyGoogleToken, controller.groqAnalyze);

// Profile and Credits route mounts
app.use('/api/profile', require('../../routes/profileRoutes'));

// ── AI Audit routes — mirrored from monolith ──────────────────
app.post('/api/ai-audit', verifyGoogleToken, aiAudit.runAiAudit);
app.get('/api/ai-issues/:testId', verifyGoogleToken, aiAudit.getAiIssues);
app.patch('/api/ai-issues/:issueId', verifyGoogleToken, aiAudit.updateIssueStatus);
app.post('/api/ai-verify/:issueId', verifyGoogleToken, aiAudit.verifyIssue);

app.get('/', (req, res) =>
  res.json({ message: '🚀 Website Testing Platform API v2.0 (microservices gateway)' })
);
app.use('*', (req, res) =>
  res.status(404).json({ success: false, error: `Route "${req.originalUrl}" not found` })
);
app.use((err, req, res, next) => {
  log.error('Unhandled:', err.message);
  res.status(500).json({ success: false, error: 'Internal Server Error: ' + err.message });
});

function start() {
  queue.getBoss().catch((err) => log.error('Queue connect failed:', err.message));
  server.listen(config.dropinPort, () => {
    log.ok(`Drop-in gateway on http://localhost:${config.dropinPort}  (WS ws://localhost:${config.dropinPort}/ws)`);
  });

  const shutdown = async () => {
    log.info('Shutting down gateway...');
    wss.close();
    server.close();
    await queue.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (r) => log.error('Unhandled rejection:', r));
}

if (require.main === module) start();

module.exports = { app };
