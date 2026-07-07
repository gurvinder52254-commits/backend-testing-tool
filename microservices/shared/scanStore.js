/**
 * ============================================================
 * microservices/shared/scanStore.js — Scan coordination state
 * ============================================================
 * Thin data-access helpers over scan_progress / scan_pages.
 * This is the DURABLE replacement for the monolith's in-memory
 * `activeTests` Map — survives restarts and is shared across
 * every service/process.
 * ============================================================
 */

const { pool } = require('./db');

async function createScan({ testId, userId, frontendUrl, backendUrl, scanType }) {
  await pool.query(
    `INSERT INTO scan_progress (test_id, user_id, frontend_url, backend_url, scan_type, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     ON CONFLICT (test_id) DO NOTHING`,
    [testId, userId, frontendUrl, backendUrl || null, scanType || 'domain']
  );
}

async function setStatus(testId, status, error = null) {
  await pool.query(
    `UPDATE scan_progress SET status = $2, error = $3, updated_at = NOW() WHERE test_id = $1`,
    [testId, status, error]
  );
}

async function setDiscovery(testId, { totalPages, headerLinks, footerLinks }) {
  await pool.query(
    `UPDATE scan_progress
     SET total_pages = $2, header_links = $3, footer_links = $4,
         status = 'running', updated_at = NOW()
     WHERE test_id = $1`,
    [testId, totalPages, JSON.stringify(headerLinks || []), JSON.stringify(footerLinks || [])]
  );
}

async function savePage(testId, pageIndex, url, result) {
  await pool.query(
    `INSERT INTO scan_pages (test_id, page_index, url, result)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (test_id, page_index) DO UPDATE
       SET url = EXCLUDED.url, result = EXCLUDED.result`,
    [testId, pageIndex, url, JSON.stringify(result)]
  );
}

/**
 * Atomically mark one more page done. Returns {completedPages, totalPages}.
 * The worker that pushes completed == total triggers finalization.
 */
async function incrementCompleted(testId) {
  const res = await pool.query(
    `UPDATE scan_progress
     SET completed_pages = completed_pages + 1, updated_at = NOW()
     WHERE test_id = $1
     RETURNING completed_pages AS "completedPages", total_pages AS "totalPages"`,
    [testId]
  );
  return res.rows[0] || { completedPages: 0, totalPages: 0 };
}

async function getProgress(testId) {
  const res = await pool.query(
    `SELECT test_id AS "testId", user_id AS "userId", frontend_url AS "frontendUrl",
            backend_url AS "backendUrl", scan_type AS "scanType", total_pages AS "totalPages",
            completed_pages AS "completedPages", header_links AS "headerLinks",
            footer_links AS "footerLinks", status, error, test_date AS "testDate"
     FROM scan_progress WHERE test_id = $1`,
    [testId]
  );
  return res.rows[0] || null;
}

async function getPages(testId) {
  const res = await pool.query(
    `SELECT page_index AS "pageIndex", url, result
     FROM scan_pages WHERE test_id = $1 ORDER BY page_index ASC`,
    [testId]
  );
  return res.rows.map((r) => r.result);
}

module.exports = {
  createScan,
  setStatus,
  setDiscovery,
  savePage,
  incrementCompleted,
  getProgress,
  getPages,
};
