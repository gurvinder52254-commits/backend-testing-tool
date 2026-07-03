/**
 * ============================================================
 * microservices/shared/migrate.js — Additive migrations
 * ============================================================
 * Creates ONLY new tables the microservices need. It never
 * alters or drops the monolith's `users` / `reports` tables.
 * It first runs the monolith's own migration (idempotent,
 * CREATE TABLE IF NOT EXISTS) so `reports`/`users` exist, then
 * adds:
 *   - link_status_cache  (fixes the missing table the engine's
 *                          LinkCache expects — additive)
 *   - scan_progress      (per-scan coordination state)
 *   - scan_pages         (per-page results, append-only)
 *   - scan_events        (durable realtime event log)
 * Plus a helpful index on reports(user_id, test_date).
 * ============================================================
 */

const { pool } = require('./db');
const { createLogger } = require('./logger');

const log = createLogger('migrate');

const STATEMENTS = [
  // Persistent link-status cache expected by models/LinkCache.js (was never
  // created by the monolith's migration — creating it here is purely additive).
  `CREATE TABLE IF NOT EXISTS link_status_cache (
     domain          TEXT NOT NULL,
     url             TEXT NOT NULL,
     normalized_url  TEXT NOT NULL,
     status          INTEGER,
     reason          TEXT,
     last_checked    TIMESTAMPTZ DEFAULT NOW(),
     PRIMARY KEY (domain, normalized_url)
   );`,

  // Coordination row for each scan (fan-out / completion tracking).
  `CREATE TABLE IF NOT EXISTS scan_progress (
     test_id         TEXT PRIMARY KEY,
     user_id         TEXT,
     frontend_url    TEXT,
     backend_url     TEXT,
     scan_type       TEXT,
     total_pages     INTEGER DEFAULT 0,
     completed_pages INTEGER DEFAULT 0,
     header_links    JSONB DEFAULT '[]'::jsonb,
     footer_links    JSONB DEFAULT '[]'::jsonb,
     status          TEXT DEFAULT 'queued',
     error           TEXT,
     test_date       TIMESTAMPTZ DEFAULT NOW(),
     created_at      TIMESTAMPTZ DEFAULT NOW(),
     updated_at      TIMESTAMPTZ DEFAULT NOW()
   );`,

  // Per-page results, one row per (test_id, page_index).
  `CREATE TABLE IF NOT EXISTS scan_pages (
     test_id      TEXT NOT NULL,
     page_index   INTEGER NOT NULL,
     url          TEXT,
     result       JSONB,
     created_at   TIMESTAMPTZ DEFAULT NOW(),
     PRIMARY KEY (test_id, page_index)
   );`,

  // Durable event log for realtime delivery + reconnect replay.
  `CREATE TABLE IF NOT EXISTS scan_events (
     id          BIGSERIAL PRIMARY KEY,
     test_id     TEXT NOT NULL,
     user_id     TEXT,
     type        TEXT NOT NULL,
     payload     JSONB,
     created_at  TIMESTAMPTZ DEFAULT NOW()
   );`,

  `CREATE INDEX IF NOT EXISTS idx_scan_events_test ON scan_events (test_id, id);`,

  // Helpful index for the (existing) reports listing query — additive.
  `CREATE INDEX IF NOT EXISTS idx_reports_user_date ON reports (user_id, test_date DESC);`,
];

async function migrate() {
  // 1) Make sure the monolith's base tables exist (idempotent).
  try {
    const { runMigrations } = require('../../db/migrate');
    await runMigrations();
  } catch (err) {
    log.warn('Monolith base migration skipped/failed (continuing):', err.message);
  }

  // 2) Apply additive microservice tables.
  const client = await pool.connect();
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    log.ok('Microservice tables ready (link_status_cache, scan_progress, scan_pages, scan_events).');
  } finally {
    client.release();
  }
}

module.exports = { migrate };

// Allow `node microservices/shared/migrate.js` to run standalone.
if (require.main === module) {
  migrate()
    .then(() => {
      log.ok('Migration complete.');
      process.exit(0);
    })
    .catch((err) => {
      log.error('Migration failed:', err);
      process.exit(1);
    });
}
