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
 * Discover URLs using Python Playwright Crawler
 */
async function discoverDomainUrls(frontendUrl) {
    try {
        const response = await fetch(`${PYTHON_SERVICE_URL}/api/discover`, {
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
async function takeScreenshot(pageUrl, outputPath, isMobile = false) {
    try {
        const response = await fetch(`${PYTHON_SERVICE_URL}/api/screenshot`, {
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

    // 4. Send scan request to Python FastAPI Service
    try {
        const response = await fetch(`${PYTHON_SERVICE_URL}/api/scan`, {
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
