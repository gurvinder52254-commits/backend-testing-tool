/**
 * ============================================================
 * microservices/gateway — API Gateway + Auth
 * ============================================================
 * The single public entry point. Stateless, so it scales
 * horizontally. Responsibilities:
 *   - Auth: verify Google tokens, issue session tokens.
 *   - Intake: validate a scan request and ENQUEUE it (returns
 *     immediately with a testId) — it never runs a browser.
 *   - Reads: reports list / detail / pages (reuses the monolith
 *     models, so results match the existing dashboard).
 *   - Serves screenshots from the shared reports dir.
 *
 * Runs on its own port (default 4000), leaving the monolith on
 * 3001 completely untouched.
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const config = require('../shared/config');
const { createLogger } = require('../shared/logger');
const queue = require('../shared/queue');
const scanStore = require('../shared/scanStore');
const { emitEvent, fetchEventsSince, EventType } = require('../shared/events');
const { requireAuth, verifyToken } = require('../shared/auth');
const { generateSessionToken } = require('../../middleware/authMiddleware');
const Report = require('../../models/Report');

const log = createLogger('gateway');
const app = express();

app.use(cors({ origin: process.env.MS_CORS_ORIGIN || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10mb' }));

// Static screenshots (same folder the worker writes to).
if (!fs.existsSync(config.reportsDir)) fs.mkdirSync(config.reportsDir, { recursive: true });
app.use('/api/screenshots', express.static(config.reportsDir));

function normalizeUrl(u) {
  if (!u) return u;
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}

// ---- health / root ----
app.get('/api/health', (req, res) =>
  res.json({ success: true, service: 'gateway', ts: new Date().toISOString() })
);
app.get('/', (req, res) =>
  res.json({
    message: '🚀 Website Testing Platform — Microservices Gateway',
    endpoints: ['POST /api/login', 'POST /api/start-test', 'GET /api/test/:id', 'GET /api/reports'],
    realtime: `ws://127.0.0.1:${config.ports.realtime}/ws`,
  })
);

// ---- auth: exchange a Google token for a session token ----
app.post('/api/login', async (req, res) => {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  try {
    const user = await verifyToken(header.split(' ')[1]);
    const token = generateSessionToken({
      id: user.userId,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
    res.json({ success: true, token, user: { id: user.userId, ...user } });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid token.' });
  }
});

// ---- intake: enqueue a scan ----
app.post('/api/start-test', requireAuth, async (req, res) => {
  try {
    let { frontendUrl, backendUrl, scanType, userDetails, urls } = req.body || {};
    if (!frontendUrl) {
      return res.status(400).json({ success: false, error: 'frontendUrl is required.' });
    }
    frontendUrl = normalizeUrl(frontendUrl);
    backendUrl = backendUrl ? normalizeUrl(backendUrl) : null;

    try {
      new URL(frontendUrl);
      if (backendUrl) new URL(backendUrl);
    } catch (_) {
      return res.status(400).json({ success: false, error: 'Invalid URL format.' });
    }

    const testId = uuidv4().substring(0, 8);

    // Durable state BEFORE responding, so the client can subscribe immediately.
    await scanStore.createScan({
      testId,
      userId: req.userId,
      frontendUrl,
      backendUrl,
      scanType: scanType || 'domain',
    });
    await emitEvent({
      testId,
      userId: req.userId,
      type: EventType.SCAN_QUEUED,
      payload: { frontendUrl },
    });
    await queue.send(config.queues.scan, {
      testId,
      userId: req.userId,
      frontendUrl,
      backendUrl,
      scanType: scanType || 'domain',
      userDetails,
      urls,
    });

    res.json({
      success: true,
      testId,
      message: 'Test queued. Subscribe over WebSocket for live updates.',
      realtime: { url: `ws://127.0.0.1:${config.ports.realtime}/ws`, testId },
    });
  } catch (err) {
    log.error('start-test error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- live status of a running scan ----
app.get('/api/test/:testId', requireAuth, async (req, res) => {
  const progress = await scanStore.getProgress(req.params.testId);
  if (!progress) return res.status(404).json({ success: false, error: 'Test not found.' });
  if (progress.userId !== req.userId) {
    return res.status(403).json({ success: false, error: 'Access denied.' });
  }
  res.json({ success: true, ...progress });
});

// ---- event replay (REST fallback for reconnects) ----
app.get('/api/scan-events/:testId', requireAuth, async (req, res) => {
  const progress = await scanStore.getProgress(req.params.testId);
  const owns = progress
    ? progress.userId === req.userId
    : !!(await Report.findById(req.params.testId, req.userId).catch(() => null));
  if (!owns) return res.status(403).json({ success: false, error: 'Access denied.' });
  const since = parseInt(req.query.since, 10) || 0;
  const events = await fetchEventsSince(req.params.testId, since);
  res.json({ success: true, events });
});

// ---- reports (reuse monolith models; already user-scoped) ----
app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const [reports, totalCount] = await Promise.all([
      Report.findByUserIdPaginated(req.userId, page, limit),
      Report.countByUserId(req.userId),
    ]);
    res.json({
      success: true,
      totalReports: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      hasNextPage: page * limit < totalCount,
      reports,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/:testId', requireAuth, async (req, res) => {
  try {
    const report = await Report.findById(req.params.testId, req.userId);
    if (!report) return res.status(404).json({ success: false, error: 'Report not found.' });
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/reports/:testId/pages', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const result = await Report.findPagesByTestId(req.params.testId, req.userId, page, limit);
    if (!result) return res.status(404).json({ success: false, error: 'Report not found.' });
    const totalPageCount = result.totalPages || 0;
    res.json({
      success: true,
      pages: result.pages || [],
      totalPages: totalPageCount,
      page,
      limit,
      hasNextPage: page * limit < totalPageCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((req, res) =>
  res.status(404).json({ success: false, error: `Route "${req.originalUrl}" not found` })
);
app.use((err, req, res, next) => {
  log.error('Unhandled:', err.message);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

function start() {
  // Warm the queue connection so the first request is fast (and fails loudly if DB is down).
  queue.getBoss().catch((err) => log.error('Queue connect failed:', err.message));

  const server = app.listen(config.ports.gateway, () =>
    log.ok(`API gateway on http://127.0.0.1:${config.ports.gateway}`)
  );

  const shutdown = async () => {
    log.info('Shutting down gateway...');
    server.close();
    await queue.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = { app };
