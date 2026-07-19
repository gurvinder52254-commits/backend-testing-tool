'use strict';

const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/db');
const LinkCache = require('../models/LinkCache');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
const GATEWAY_PORT = process.env.PORT || 3001;

// On Render, Python service is a DIFFERENT server — use public URL for webhook.
// MS_INTERNAL_BROADCAST_URL overrides everything (set this on Render backend env).
// PUBLIC_BACKEND_URL = e.g. https://backend-testing-tool.onrender.com
const _backendBase = process.env.PUBLIC_BACKEND_URL
  ? process.env.PUBLIC_BACKEND_URL.replace(/\/$/, '')
  : `http://127.0.0.1:${GATEWAY_PORT}`;
const INTERNAL_BROADCAST_URL = process.env.MS_INTERNAL_BROADCAST_URL || `${_backendBase}/internal/broadcast`;

/**
 * Resolves the appropriate Python service URL dynamically.
 * - If user is Paid and has a dedicated service assigned, returns that dedicated URL.
 * - Otherwise, load balances (randomly) across active non-dedicated services in the free pool.
 * - Fallback to env-defined PYTHON_SERVICE_URL if no services registered in DB.
 */
async function resolvePythonServiceUrl(userId) {
    try {
        if (userId) {
            // Check if user is paid
            const userRes = await pool.query(
                'SELECT subscription_tier FROM users WHERE id = $1',
                [userId]
            );
            if (userRes.rows.length > 0) {
                const tier = userRes.rows[0].subscription_tier || 'Free';
                if (tier !== 'Free') {
                    // Check if they have a dedicated active service assigned
                    const serviceRes = await pool.query(
                        "SELECT service_url FROM python_services WHERE assigned_user_id = $1 AND status = 'active' LIMIT 1",
                        [userId]
                    );
                    if (serviceRes.rows.length > 0) {
                        const url = serviceRes.rows[0].service_url;
                        console.log(`[PythonBridge] Routing user ${userId} (${tier}) to dedicated instance: ${url}`);
                        return url;
                    }
                }
            }
        }

        // Get free pool active services
        const poolRes = await pool.query(
            "SELECT service_url FROM python_services WHERE is_dedicated = FALSE AND status = 'active'"
        );
        if (poolRes.rows.length > 0) {
            const index = Math.floor(Math.random() * poolRes.rows.length);
            const url = poolRes.rows[index].service_url;
            console.log(`[PythonBridge] Routing to shared pool instance: ${url}`);
            return url;
        }
    } catch (dbErr) {
        console.warn('⚠️ pythonBridge: Error resolving python service from DB:', dbErr.message);
    }

    // Default fallback
    return PYTHON_SERVICE_URL;
}

/**
 * Discover URLs using Python Playwright Crawler
 */
async function discoverDomainUrls(frontendUrl, userId = null) {
    try {
        const serviceUrl = await resolvePythonServiceUrl(userId);
        const response = await fetch(`${serviceUrl}/api/discover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frontendUrl })
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Python discover failed: ${errText}`);
        }
        const data = await response.json();
        return data.urls || [];
    } catch (err) {
        console.error('❌ Python discover error:', err.message);
        throw err;
    }
}

/**
 * Capture a screenshot using Python Playwright
 */
async function takeScreenshot(pageUrl, outputPath, isMobile = false, userId = null) {
    try {
        const serviceUrl = await resolvePythonServiceUrl(userId);
        const response = await fetch(`${serviceUrl}/api/screenshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageUrl, outputPath, isMobile })
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Python screenshot failed: ${errText}`);
        }
        return true;
    } catch (err) {
        console.error('❌ Python screenshot error:', err.message);
        throw err;
    }
}

/**
 * Main scan coordinator using Python Playwright
 */
async function runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userId, userDetails, sendUpdate, urlsToTest) {
    // 1. Resolve limits
    let subscriptionTier = 'Free';
    let totalUrlsTestedPreviously = 0;

    if (userId) {
        try {
            const userRes = await pool.query(
                'SELECT subscription_tier FROM users WHERE id = $1',
                [userId]
            );
            if (userRes.rows.length > 0) {
                subscriptionTier = userRes.rows[0].subscription_tier || 'Free';
            }

            const sumRes = await pool.query(
                "SELECT COALESCE(SUM(total_pages), 0)::int as count FROM reports WHERE user_id = $1 AND status != 'failed'",
                [userId]
            );
            totalUrlsTestedPreviously = sumRes.rows[0].count || 0;
        } catch (dbErr) {
            console.error('⚠️ pythonBridge: Error fetching user limits:', dbErr.message);
        }
    }

    // 2. Resolve link status cache for targetDomain
    let targetDomain = '';
    let linkCacheEntries = [];
    try {
        targetDomain = new URL(frontendUrl).hostname.replace(/^www\./, '');
        const dbCached = await LinkCache.getBulkForDomain(targetDomain);
        linkCacheEntries = Array.from(dbCached.entries());
    } catch (err) {
        console.warn('⚠️ pythonBridge: Pre-loading LinkCache failed:', err.message);
    }

    // 3. Prepare test directory absolute path
    const testDir = path.join(__dirname, '..', 'reports', testId);

    // 4. Resolve Python Service URL dynamically
    const serviceUrl = await resolvePythonServiceUrl(userId);

    // 5. Send scan request to Python FastAPI Service
    try {
        const response = await fetch(`${serviceUrl}/api/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                testId,
                frontendUrl,
                backendUrl,
                scanType,
                userId,
                userDetails,
                urlsToTest,
                subscriptionTier,
                totalUrlsTestedPreviously,
                linkCache: linkCacheEntries,
                testDir,
                webhookUrl: INTERNAL_BROADCAST_URL
            }),
            timeout: 600000 // 10 minutes timeout for deep scan
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Python scan failed: ${errText}`);
        }

        const result = await response.json();
        const report = result.report;

        // 5. Batch-persist new entries to DB cache (fire-and-forget, non-blocking)
        if (result.newCacheEntries && result.newCacheEntries.length > 0 && targetDomain) {
            LinkCache.setBulk(targetDomain, result.newCacheEntries).catch(err =>
                console.warn('⚠️ pythonBridge: LinkCache DB flush error:', err.message)
            );
        }

        // 6. Handle Free Plan Credit Burn (if limit reached)
        if (result.creditsBurned && userId) {
            try {
                const credCheck = await pool.query('SELECT credits FROM users WHERE id = $1', [userId]);
                if (credCheck.rows.length > 0 && credCheck.rows[0].credits > 0) {
                    await pool.query('UPDATE users SET credits = 0 WHERE id = $1', [userId]);
                    await pool.query(
                        'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, 0, $2)',
                        [userId, `Free Trial exhausted: credits set to 0.`]
                    );
                    console.log(`[FreePlan-Bridge] Credits burned to 0 for user ${userId}`);
                }
            } catch (burnErr) {
                console.error('[FreePlan-Bridge] Credits burn failed:', burnErr.message);
            }
        }

        return report;
    } catch (err) {
        console.error('❌ pythonBridge: Run scan error:', err.message);
        throw err;
    }
}

module.exports = {
    discoverDomainUrls,
    takeScreenshot,
    runWebsiteTest
};
