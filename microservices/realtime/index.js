/**
 * ============================================================
 * microservices/realtime — WebSocket Gateway
 * ============================================================
 * Fixes the monolith's two WS problems at once:
 *   - Auth: a client must present a valid token AND own the test
 *     before it joins that test's room (no more anonymous
 *     connections receiving everyone's data).
 *   - Rooms: events are delivered ONLY to sockets subscribed to
 *     that testId (no global broadcast / cross-tenant leak).
 *
 * Delivery uses Postgres LISTEN/NOTIFY as a wake-up signal and
 * reads the durable `scan_events` log, so a reconnecting client
 * can replay everything it missed (pass lastEventId).
 *
 * Client protocol:
 *   → { "type": "subscribe", "testId": "...", "token": "Bearer-less token", "lastEventId": 0 }
 *   ← { "type": "subscribed", "testId": "..." }
 *   ← { "type": "<event>", "testId": "...", "eventId": 12, ...payload }
 *   ← { "type": "error", "error": "..." }
 * ============================================================
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const config = require('../shared/config');
const { createLogger } = require('../shared/logger');
const { createListenerClient } = require('../shared/db');
const { fetchEventsSince, NOTIFY_CHANNEL } = require('../shared/events');
const { verifyToken } = require('../shared/auth');
const scanStore = require('../shared/scanStore');
const Report = require('../../models/Report');

const log = createLogger('realtime');

// testId -> Set<{ ws, userId, lastEventId }>
const rooms = new Map();

function addToRoom(testId, client) {
  if (!rooms.has(testId)) rooms.set(testId, new Set());
  rooms.get(testId).add(client);
}
function removeClient(client) {
  for (const [testId, set] of rooms) {
    if (set.delete(client) && set.size === 0) rooms.delete(testId);
  }
}

function sendEvent(ws, ev) {
  const payload = ev.payload || {};
  ws.send(
    JSON.stringify({
      type: ev.type,
      testId: ev.testId,
      eventId: Number(ev.id),
      ...payload,
    })
  );
}

async function ownsTest(userId, testId) {
  const progress = await scanStore.getProgress(testId);
  if (progress && progress.userId === userId) return true;
  // Also allow owners of an already-persisted report (e.g. viewing history).
  try {
    const report = await Report.findById(testId, userId);
    if (report) return true;
  } catch (_) {}
  return false;
}

/**
 * Push any events newer than the client's cursor.
 */
async function flushToClient(client) {
  try {
    const events = await fetchEventsSince(client.testId, client.lastEventId);
    for (const ev of events) {
      sendEvent(client.ws, ev);
      client.lastEventId = Math.max(client.lastEventId, Number(ev.id));
    }
  } catch (err) {
    log.warn('flushToClient failed:', err.message);
  }
}

async function handleSubscribe(ws, msg) {
  const { testId, token, lastEventId } = msg;
  if (!testId || !token) {
    ws.send(JSON.stringify({ type: 'error', error: 'testId and token are required.' }));
    return;
  }

  let user;
  try {
    user = await verifyToken(token);
  } catch (_) {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid or expired token.' }));
    return;
  }

  if (!(await ownsTest(user.userId, testId))) {
    ws.send(JSON.stringify({ type: 'error', error: 'Access denied for this test.' }));
    return;
  }

  const client = {
    ws,
    userId: user.userId,
    testId,
    lastEventId: Number.isFinite(+lastEventId) ? +lastEventId : 0,
  };
  ws._client = client;
  addToRoom(testId, client);
  ws.send(JSON.stringify({ type: 'subscribed', testId }));

  // Replay anything already recorded for this test.
  await flushToClient(client);
}

// ---- LISTEN/NOTIFY plumbing (with auto-reconnect) ----
async function startListener() {
  const client = createListenerClient();
  client.on('error', (err) => {
    log.warn('Listener client error, reconnecting in 2s:', err.message);
    setTimeout(startListener, 2000);
  });
  client.on('notification', async (msg) => {
    const testId = msg.payload;
    const set = rooms.get(testId);
    if (!set || set.size === 0) return;
    for (const c of set) await flushToClient(c);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    log.ok(`Listening on Postgres channel "${NOTIFY_CHANNEL}".`);
  } catch (err) {
    log.error('Failed to start listener, retrying in 2s:', err.message);
    setTimeout(startListener, 2000);
  }
}

function start() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, service: 'realtime', rooms: rooms.size }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON.' }));
      }
      if (msg.type === 'subscribe') await handleSubscribe(ws, msg);
      else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });
    ws.on('close', () => removeClient(ws._client || {}));
    ws.on('error', () => removeClient(ws._client || {}));
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  server.listen(config.ports.realtime, () =>
    log.ok(`Realtime WS gateway on ws://127.0.0.1:${config.ports.realtime}/ws`)
  );

  startListener();

  const shutdown = () => {
    log.info('Shutting down realtime gateway...');
    wss.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = { start };
