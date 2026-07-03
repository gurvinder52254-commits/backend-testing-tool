/**
 * ============================================================
 * microservices/shared/events.js — Realtime event bus
 * ============================================================
 * Transactional-outbox + LISTEN/NOTIFY pattern (no Redis):
 *   1. The producing service inserts the full event into the
 *      durable `scan_events` table (any size — it's JSONB).
 *   2. It fires a tiny NOTIFY carrying only the testId.
 *   3. The Realtime WS gateway LISTENs, and on each ping reads
 *      the new rows for that testId and pushes them to the
 *      subscribed clients (scoped per test — no global broadcast).
 *
 * Durability means a client that reconnects can replay every
 * event it missed (via lastEventId), which the old monolith's
 * fire-and-forget broadcast could not do.
 * ============================================================
 */

const { pool } = require('./db');
const { createLogger } = require('./logger');

const log = createLogger('events');

const NOTIFY_CHANNEL = 'scan_events';

// Canonical event types shared by producers and the WS gateway.
const EventType = {
  SCAN_QUEUED: 'scan-queued',
  SCAN_STARTED: 'scan-started',
  STATUS: 'status',
  LINKS_DISCOVERED: 'links-discovered',
  PAGE_START: 'page-start',
  PAGE_COMPLETE: 'page-complete',
  PAGE_ERROR: 'page-error',
  TEST_COMPLETE: 'test-complete',
  TEST_ERROR: 'test-error',
};

/**
 * Persist an event and wake up the WS gateway. Best-effort:
 * a realtime failure must never break the scan itself.
 * @returns {Promise<string|null>} inserted event id (as string) or null
 */
async function emitEvent({ testId, userId = null, type, payload = {} }) {
  try {
    const res = await pool.query(
      `INSERT INTO scan_events (test_id, user_id, type, payload)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [testId, userId, type, JSON.stringify(payload)]
    );
    // pg_notify() lets us parameterize the payload safely.
    await pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, testId]);
    return String(res.rows[0].id);
  } catch (err) {
    log.warn(`emitEvent(${type}) for ${testId} failed:`, err.message);
    return null;
  }
}

/**
 * Fetch events for a test newer than `afterId` (for replay / delivery).
 */
async function fetchEventsSince(testId, afterId = 0) {
  const res = await pool.query(
    `SELECT id, test_id AS "testId", user_id AS "userId", type, payload, created_at AS "createdAt"
     FROM scan_events
     WHERE test_id = $1 AND id > $2
     ORDER BY id ASC`,
    [testId, afterId]
  );
  return res.rows;
}

module.exports = { emitEvent, fetchEventsSince, NOTIFY_CHANNEL, EventType };
