/**
 * ============================================================
 * models/LinkCache.js - Persistent Link Status Cache
 * ============================================================
 * Stores HTTP status results for individual URLs per domain.
 * Enables cross-test-run caching so the same URL is never
 * re-evaluated if a recent result already exists in the DB.
 * Cache TTL is configurable (default: 7 days).
 * ============================================================
 */

const { pool } = require('../config/db');

const CACHE_TTL_DAYS = parseInt(process.env.LINK_CACHE_TTL_DAYS || '7', 10);

class LinkCache {
    /**
     * Get a single cached URL status for a given domain.
     * Returns null if not found or expired.
     * @param {string} domain
     * @param {string} normalizedUrl
     * @returns {Promise<{status: number, reason: string}|null>}
     */
    static async get(domain, normalizedUrl) {
        try {
            const query = `
                SELECT status, reason, last_checked
                FROM link_status_cache
                WHERE domain = $1 AND normalized_url = $2
                LIMIT 1;
            `;
            const res = await pool.query(query, [domain, normalizedUrl]);
            if (res.rows.length === 0) return null;

            const row = res.rows[0];
            // Check TTL
            const ageMs = Date.now() - new Date(row.last_checked).getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            if (ageDays > CACHE_TTL_DAYS) return null; // expired

            return { status: row.status, reason: row.reason };
        } catch (err) {
            // Non-fatal: DB cache miss is acceptable
            console.warn('⚠️ LinkCache.get error:', err.message);
            return null;
        }
    }

    /**
     * Save or update a URL's status in the cache for a domain.
     * Uses UPSERT to avoid conflicts.
     * @param {string} domain
     * @param {string} url          - Original URL
     * @param {string} normalizedUrl
     * @param {number} status       - HTTP-like status code (200, 0, etc.)
     * @param {string} reason       - Human-readable reason string
     */
    static async set(domain, url, normalizedUrl, status, reason) {
        try {
            const query = `
                INSERT INTO link_status_cache (domain, url, normalized_url, status, reason, last_checked)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (domain, normalized_url) DO UPDATE
                    SET url          = EXCLUDED.url,
                        status       = EXCLUDED.status,
                        reason       = EXCLUDED.reason,
                        last_checked = NOW();
            `;
            await pool.query(query, [domain, url, normalizedUrl, status, reason]);
        } catch (err) {
            console.warn('⚠️ LinkCache.set error:', err.message);
        }
    }

    /**
     * Bulk get: retrieve all cached entries for a domain.
     * Returns a Map<normalizedUrl, {status, reason}> for fast O(1) lookup.
     * Only returns entries within the TTL window.
     * @param {string} domain
     * @returns {Promise<Map<string, {status: number, reason: string}>>}
     */
    static async getBulkForDomain(domain) {
        const cacheMap = new Map();
        try {
            const query = `
                SELECT normalized_url, status, reason, last_checked
                FROM link_status_cache
                WHERE domain = $1
                  AND last_checked > NOW() - INTERVAL '${CACHE_TTL_DAYS} days';
            `;
            const res = await pool.query(query, [domain]);
            for (const row of res.rows) {
                cacheMap.set(row.normalized_url, {
                    status: row.status,
                    reason: row.reason
                });
            }
            if (cacheMap.size > 0) {
                console.log(`   📦 LinkCache: Pre-loaded ${cacheMap.size} cached URLs for domain "${domain}"`);
            }
        } catch (err) {
            console.warn('⚠️ LinkCache.getBulkForDomain error:', err.message);
        }
        return cacheMap;
    }

    /**
     * Bulk upsert: persist multiple new URL statuses to DB.
     * @param {string} domain
     * @param {Array<{url: string, normalizedUrl: string, status: number, reason: string}>} entries
     */
    static async setBulk(domain, entries) {
        if (!entries || entries.length === 0) return;
        try {
            // Build parameterized bulk insert
            const values = [];
            const placeholders = entries.map((entry, i) => {
                const base = i * 5;
                values.push(domain, entry.url, entry.normalizedUrl, entry.status, entry.reason);
                return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, NOW())`;
            });

            const query = `
                INSERT INTO link_status_cache (domain, url, normalized_url, status, reason, last_checked)
                VALUES ${placeholders.join(', ')}
                ON CONFLICT (domain, normalized_url) DO UPDATE
                    SET url          = EXCLUDED.url,
                        status       = EXCLUDED.status,
                        reason       = EXCLUDED.reason,
                        last_checked = NOW();
            `;
            await pool.query(query, values);
        } catch (err) {
            console.warn('⚠️ LinkCache.setBulk error:', err.message);
        }
    }

    /**
     * Evict old cache entries for a domain beyond the TTL window.
     * Useful for cleanup runs.
     * @param {string} domain
     * @param {number} maxAgeDays
     */
    static async evictOld(domain, maxAgeDays = CACHE_TTL_DAYS) {
        try {
            const query = `
                DELETE FROM link_status_cache
                WHERE domain = $1
                  AND last_checked < NOW() - INTERVAL '${maxAgeDays} days';
            `;
            const res = await pool.query(query, [domain]);
            if (res.rowCount > 0) {
                console.log(`   🗑️  LinkCache: Evicted ${res.rowCount} old entries for domain "${domain}"`);
            }
        } catch (err) {
            console.warn('⚠️ LinkCache.evictOld error:', err.message);
        }
    }
}

module.exports = LinkCache;
