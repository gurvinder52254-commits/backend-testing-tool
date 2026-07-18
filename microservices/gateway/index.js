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
const { scanBrokenLinks } = require('../../controllers/brokenLinkController');

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
  const update = req.body || {};
  broadcastUpdate(update);
  res.json({ ok: true });

  const { testId } = update;
  if (testId) {
    (async () => {
      try {
        const { pool } = require('../../config/db');
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
        log.error(`Failed to process broadcast updates for database: ${err.message}`);
      }
    })();
  }
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
app.delete('/api/reports/:testId', verifyGoogleToken, controller.deleteReport);
app.post('/api/test', verifyGoogleToken, controller.testLegacy);
app.post('/api/groq-analyze', verifyGoogleToken, controller.groqAnalyze);
app.post('/api/scan-page', verifyGoogleToken, scanBrokenLinks);

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
