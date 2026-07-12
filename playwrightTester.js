/**
 * ============================================================
 * playwrightTester.js - Multi-Page Playwright Automation
 * ============================================================
 * Crawls entire website: extracts header/footer nav links,
 * visits each page, takes screenshots, sends to Gemini AI,
 * and broadcasts live progress via WebSocket callbacks.
 * ============================================================
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { analyzeScreenshot } = require('./geminiAnalyzer');
const { runGroqAnalysisPipeline } = require('./groqAnalyzer');
const { executeGroqTests } = require('./groqTestRunner');
const fetch = require('node-fetch');
const LinkCache = require('./models/LinkCache');
const { captureFullPage } = require('./utils/fullPageCapture');

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Turn a raw Playwright/Chromium navigation error into a clear, actionable
 * message instead of a cryptic net::ERR_* dump.
 */
function friendlyNavError(err, url) {
    const msg = (err && err.message) || String(err);
    if (msg.includes('ERR_NAME_NOT_RESOLVED')) {
        return `Could not reach "${url}" — the domain name could not be resolved (DNS lookup failed). Check that the URL is spelled correctly and that the site and your internet/DNS connection are working, then try again.`;
    }
    if (msg.includes('ERR_INTERNET_DISCONNECTED')) {
        return `No internet connection while trying to reach "${url}". Reconnect and try again.`;
    }
    if (msg.includes('ERR_CONNECTION_REFUSED')) {
        return `Connection refused by "${url}". The server may be down or blocking automated requests.`;
    }
    if (msg.includes('ERR_CONNECTION_TIMED_OUT') || msg.includes('ERR_TIMED_OUT') || /timeout|exceeded/i.test(msg)) {
        return `Timed out trying to reach "${url}". The site may be slow, down, or unreachable from this network.`;
    }
    if (msg.includes('ERR_CERT') || msg.includes('SSL')) {
        return `SSL/certificate problem while reaching "${url}".`;
    }
    if (msg.includes('ERR_ABORTED')) {
        return `Navigation to "${url}" was aborted (the page may have blocked automation or redirected unexpectedly).`;
    }
    return `Could not load "${url}": ${msg.split('\n')[0]}`;
}

/**
 * Navigate to a URL with a retry + 'load' → 'domcontentloaded' fallback.
 * Throws a friendly error only after all attempts fail.
 */
async function gotoWithRetry(page, url, sendUpdate, attempts = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            try {
                return await page.goto(url, { waitUntil: 'load', timeout: 45000 });
            } catch (err) {
                if (page.isClosed()) throw err;
                return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
        } catch (err) {
            lastErr = err;
            if (page.isClosed()) break;
            if (attempt < attempts) {
                const waitMs = attempt * 3000;
                try {
                    sendUpdate && sendUpdate({
                        type: 'status',
                        message: `⚠️ Could not reach ${url} (attempt ${attempt}/${attempts}). Retrying in ${waitMs / 1000}s...`,
                        step: 'nav-retry',
                    });
                } catch (_) { }
                await page.waitForTimeout(waitMs);
            }
        }
    }
    throw new Error(friendlyNavError(lastErr, url));
}

/**
 * Main multi-page website test
 * @param {string} testId - Unique test identifier
 * @param {string} frontendUrl - Frontend domain to test
 * @param {string} backendUrl - Backend domain (optional)
 * @param {string} scanType - 'domain' or 'url'
 * @param {object[]} userDetails - Key-value pair configs for testing
 * @param {function} sendUpdate - Callback to send live updates
 * @param {string} userId - The user's ID (passed directly from caller, not queried from DB)
 * @param {object[]} [urlsToTest] - Specific URLs to test (optional)
 * @returns {object} Complete test report
 */
async function runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userId, userDetails, sendUpdate, urlsToTest) {
    const testStartTime = Date.now();
    const testDir = path.join(REPORTS_DIR, testId);
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    const report = {
        testId,
        frontendUrl,
        backendUrl: backendUrl || null,
        testDate: new Date().toISOString(),
        totalPages: 0,
        pagesCompleted: 0,
        headerLinks: [],
        footerLinks: [],
        pages: [],
        overallScore: 0,
        status: 'running',
        errorMessage: null,
        testDurationMs: 0,
        globalSummary: {
            totalErrors: 0,
            brokenLinks: [],
            missingResources: [],
            seoIssues: [],
            elementStats: {
                totalImages: 0,
                totalLinks: 0,
                totalButtons: 0,
                totalMissingAlt: 0,
                totalMissingSrc: 0,
                totalDuplicateImages: 0
            },
            suggestedFixes: []
        }
    };

    let browser = null;

    try {
        const { pool } = require('./config/db');
        let subscriptionTier = 'Free';
        let totalUrlsTestedPreviously = 0;

        // userId is passed directly from the caller — do NOT query reports table
        // (the report row doesn't exist yet when the scan starts)
        if (userId) {
            try {
                const userRes = await pool.query(
                    'SELECT subscription_tier FROM users WHERE id = $1',
                    [userId]
                );
                if (userRes.rows.length > 0) {
                    subscriptionTier = userRes.rows[0].subscription_tier || 'Free';
                }

                // Sum total_pages of ALL non-failed, non-current reports for this user
                const sumRes = await pool.query(
                    "SELECT COALESCE(SUM(total_pages), 0)::int as count FROM reports WHERE user_id = $1 AND status != 'failed'",
                    [userId]
                );
                totalUrlsTestedPreviously = sumRes.rows[0].count || 0;
                console.log(`[FreePlan] userId=${userId}, tier=${subscriptionTier}, previousURLs=${totalUrlsTestedPreviously}`);
            } catch (dbErr) {
                console.error('Error fetching user limits in runWebsiteTest:', dbErr.message);
            }
        }

        // STEP 1: Launch Browser
        sendUpdate({
            type: 'status',
            message: 'Launching browser...',
            step: 'browser-launch',
        });

        browser = await chromium.launch({
            headless: true,  // Render Linux server par display nahi hota, isliye true zaroori hai
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--start-maximized',
                '--disable-infobars',
            ],
        });


        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        // STEP 2: Open Homepage
        sendUpdate({
            type: 'status',
            message: `Opening homepage: ${frontendUrl}`,
            step: 'opening-homepage',
        });

        const loadStart = Date.now();
        // Navigate with retry + fallback; throws a clear, friendly error if the
        // site is unreachable (bad URL, DNS failure, no internet, timeout, etc.)
        const response = await gotoWithRetry(page, frontendUrl, sendUpdate);
        await page.waitForTimeout(2000);

        // Scroll the page to the bottom (or simulate scrolling)
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
        const loadTime = Date.now() - loadStart;
        const homeTitle = await page.title();

        sendUpdate({
            type: 'status',
            message: `Homepage loaded in ${loadTime}ms - "${homeTitle}"`,
            step: 'homepage-loaded',
        });

        let headerLinks = [];
        let footerLinks = [];
        let bodyLinks = [];

        let baseDomain = '';
        try {
            baseDomain = new URL(frontendUrl).hostname.replace(/^www\./, '');
        } catch (e) { }

        const isSameDomain = (href) => {
            try {
                const linkDomain = new URL(href).hostname.replace(/^www\./, '');
                return linkDomain === baseDomain;
            } catch (e) { return false; }
        };

        const isValidPageLink = (href) => {
            return href &&
                href.startsWith('http') &&
                !href.includes('#') &&
                !href.startsWith('javascript:') &&
                !href.startsWith('mailto:') &&
                !href.startsWith('tel:') &&
                !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3|doc|docx|xls|xlsx|ppt|css|js|json|xml|woff|woff2|ttf|eot)$/i) &&
                isSameDomain(href);
        };

        let allPages = [];
        if (urlsToTest && Array.isArray(urlsToTest) && urlsToTest.length > 0) {
            allPages = urlsToTest.map((p, idx) => {
                if (typeof p === 'string') {
                    return { href: p, text: p === frontendUrl ? 'Homepage' : `Custom URL ${idx + 1}`, source: 'custom' };
                }
                return { href: p.url || p.href, text: p.text || 'URL', source: p.source || 'custom' };
            });
        } else {
            if (scanType !== 'url') {
                // STEP 3: Extract Header Navigation Links
                sendUpdate({
                    type: 'status',
                    message: 'Extracting header navigation links...',
                    step: 'extracting-header-links',
                });

                headerLinks = await page.evaluate((baseUrl) => {
                    const links = [];
                    const selectors = [
                        'header a[href]',
                        'nav a[href]',
                        '[role="navigation"] a[href]',
                        '.navbar a[href]',
                        '.nav a[href]',
                        '.header a[href]',
                        '.menu a[href]',
                        '.main-nav a[href]',
                        '.dropdown-menu a[href]',
                        '.sub-menu a[href]',
                        '.mega-menu a[href]',
                        '[class*="dropdown"] a[href]',
                        '[class*="submenu"] a[href]',
                    ];
                    const seen = new Set();

                    for (const selector of selectors) {
                        document.querySelectorAll(selector).forEach((a) => {
                            const href = a.href;
                            const text = a.textContent.trim().substring(0, 100);
                            if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
                                seen.add(href);
                                links.push({ href, text: text || 'No Text', source: 'header' });
                            }
                        });
                    }
                    return links;
                }, frontendUrl);

                report.headerLinks = headerLinks;

                // STEP 4: Extract Footer Links
                sendUpdate({
                    type: 'status',
                    message: 'Extracting footer links...',
                    step: 'extracting-footer-links',
                });

                footerLinks = await page.evaluate((baseUrl) => {
                    const links = [];
                    const selectors = [
                        'footer a[href]',
                        '.footer a[href]',
                        '#footer a[href]',
                        '.site-footer a[href]',
                    ];
                    const seen = new Set();

                    for (const selector of selectors) {
                        document.querySelectorAll(selector).forEach((a) => {
                            const href = a.href;
                            const text = a.textContent.trim().substring(0, 100);
                            if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
                                seen.add(href);
                                links.push({ href, text: text || 'No Text', source: 'footer' });
                            }
                        });
                    }
                    return links;
                }, frontendUrl);

                report.footerLinks = footerLinks;

                // STEP 4.5: Extract ALL Body/Content Links (Full Domain mode)
                sendUpdate({
                    type: 'status',
                    message: 'Extracting all page links from body content...',
                    step: 'extracting-body-links',
                });

                bodyLinks = await page.evaluate(() => {
                    const links = [];
                    const seen = new Set();
                    document.querySelectorAll('a[href]').forEach((a) => {
                        const href = a.href;
                        const text = a.textContent.trim().substring(0, 100);
                        if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                            // Skip pure anchor links on same page
                            try {
                                const url = new URL(href);
                                if (url.hash && url.origin + url.pathname === window.location.origin + window.location.pathname) return;
                            } catch (e) { }
                            seen.add(href);
                            links.push({ href, text: text || 'No Text', source: 'body' });
                        }
                    });
                    return links;
                });

                // Also expose hidden dropdown/mega-menu links by hovering nav items
                try {
                    const navItems = await page.locator('nav li, .navbar li, .menu li, header li').all();
                    for (const item of navItems.slice(0, 30)) {
                        try {
                            await item.hover({ timeout: 500 }).catch(() => { });
                            await page.waitForTimeout(200);
                        } catch (e) { }
                    }
                    // Re-extract after hovering to catch any newly visible dropdown links
                    const dropdownLinks = await page.evaluate(() => {
                        const links = [];
                        const seen = new Set();
                        document.querySelectorAll('.dropdown-menu a[href], .sub-menu a[href], [class*="dropdown"] a[href], [class*="submenu"] a[href], .mega-menu a[href]').forEach((a) => {
                            const href = a.href;
                            const text = a.textContent.trim().substring(0, 100);
                            if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:')) {
                                seen.add(href);
                                links.push({ href, text: text || 'No Text', source: 'dropdown' });
                            }
                        });
                        return links;
                    });
                    bodyLinks = [...bodyLinks, ...dropdownLinks];
                } catch (e) {
                    console.log('Dropdown hover extraction skipped:', e.message);
                }
            }

            // Combine all unique links (homepage + header + footer + body)
            const allLinksMap = new Map();
            allLinksMap.set(frontendUrl, { href: frontendUrl, text: homeTitle || 'Homepage', source: 'homepage' });

            if (scanType !== 'url') {
                [...headerLinks, ...footerLinks, ...bodyLinks].forEach((link) => {
                    // Normalize URL: remove trailing slash and query params for dedup
                    let normalizedHref = link.href;
                    try {
                        const u = new URL(normalizedHref);
                        normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
                    } catch (e) { }

                    if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
                        allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
                    }
                });
            }

            allPages = Array.from(allLinksMap.values());

            // STEP 4.6: Deep crawl — visit discovered pages to find MORE links (depth 2)
            if (scanType !== 'url' && allPages.length > 1) {
                sendUpdate({
                    type: 'status',
                    message: `Deep crawling ${Math.min(allPages.length - 1, 15)} discovered pages for more links...`,
                    step: 'deep-crawl',
                });

                const pagesToDeepCrawl = allPages.slice(1, 16); // skip homepage (already crawled), max 15 sub-pages
                let newLinksFound = 0;

                for (const pageInfo of pagesToDeepCrawl) {
                    try {
                        await page.goto(pageInfo.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                        await page.waitForTimeout(500);

                        const subPageLinks = await page.evaluate(() => {
                            const links = [];
                            const seen = new Set();
                            document.querySelectorAll('a[href]').forEach((a) => {
                                const href = a.href;
                                const text = a.textContent.trim().substring(0, 100);
                                if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                                    seen.add(href);
                                    links.push({ href, text: text || 'No Text', source: 'deep-crawl' });
                                }
                            });
                            return links;
                        });

                        for (const link of subPageLinks) {
                            let normalizedHref = link.href;
                            try {
                                const u = new URL(normalizedHref);
                                normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
                            } catch (e) { }

                            if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
                                allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
                                newLinksFound++;
                            }
                        }
                    } catch (e) {
                        // Skip pages that fail to load
                    }
                }

                if (newLinksFound > 0) {
                    console.log(`   🔍 Deep crawl found ${newLinksFound} additional pages`);
                    allPages = Array.from(allLinksMap.values());

                    sendUpdate({
                        type: 'status',
                        message: `Deep crawl found ${newLinksFound} more pages. Total: ${allPages.length}`,
                        step: 'deep-crawl-complete',
                    });
                }

                // Navigate back to homepage for testing
                await page.goto(frontendUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
            }
        }

        // ── FREE PLAN URL CAP ────────────────────────────────────────────────
        // Free plan: max 5 URLs total across ALL scans (account-level)
        // Slice allPages BEFORE the loop so report.totalPages is also capped.
        if (subscriptionTier === 'Free') {
            const remainingAllowed = Math.max(0, 5 - totalUrlsTestedPreviously);
            if (allPages.length > remainingAllowed) {
                console.log(`[FreePlan] Capping allPages from ${allPages.length} → ${remainingAllowed} (already tested: ${totalUrlsTestedPreviously})`);
                allPages = allPages.slice(0, remainingAllowed);

                // Immediately burn credits to 0 if remaining is 0 (or will be 0 after this scan)
                if (remainingAllowed === 0) {
                    try {
                        await pool.query('UPDATE users SET credits = 0 WHERE id = $1', [userId]);
                        await pool.query(
                            'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, 0, $2)',
                            [userId, 'Free Trial scan capacity exhausted (5 URLs tested). Credits set to 0.']
                        );
                        sendUpdate({
                            type: 'status',
                            message: '⚠️ Free Trial URL limit reached (5/5). No more pages can be scanned. Please upgrade to continue.',
                            step: 'limit-reached'
                        });
                    } catch (burnErr) {
                        console.error('[FreePlan] Failed to burn credits:', burnErr.message);
                    }
                }
            }
        }
        // ────────────────────────────────────────────────────────────────────

        report.totalPages = allPages.length;

        sendUpdate({
            type: 'links-discovered',
            headerLinks: headerLinks.length,
            footerLinks: footerLinks.length,
            bodyLinks: bodyLinks.length,
            totalPages: allPages.length,
            pages: allPages.map((p) => ({ url: p.href, text: p.text, source: p.source })),
        });

        console.log(`\n📊 [${testId}] Full Domain Scan Summary:`);
        console.log(`   Header links: ${headerLinks.length}`);
        console.log(`   Footer links: ${footerLinks.length}`);
        console.log(`   Body links: ${bodyLinks.length}`);
        console.log(`   Total unique pages to test: ${allPages.length}\n`);

        // ============================================================
        // BROKEN LINKS URL CACHE — Session-level (cross-page) + DB (cross-run)
        // ============================================================
        // key:   normalized URL string
        // value: { status, reason, fromPage }
        const linkStatusCache = new Map();

        // Extract domain for DB cache keying
        let targetDomain = '';
        try { targetDomain = new URL(frontendUrl).hostname.replace(/^www\./, ''); } catch (e) { }

        // Helper: normalize a URL for cache key (strip hash, trailing slash)
        function normalizeLinkUrl(href) {
            if (!href || href === 'MISSING') return href || 'MISSING';
            if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return href;
            try {
                const u = new URL(href);
                return u.origin + u.pathname.replace(/\/+$/, '') + u.search;
            } catch {
                return href.trim();
            }
        }

        // Helper: determine link status from href alone (no HTTP fetch — mirrors current logic)
        function determineLinkStatus(link) {
            const href = link.href;
            if (!href || href === 'MISSING' || href.trim() === '') {
                return { status: 0, reason: 'Missing href' };
            }
            if (href === '#') {
                return { status: 0, reason: 'Placeholder href (#)' };
            }
            if (href.startsWith('javascript:')) {
                return { status: 0, reason: 'JavaScript pseudo-link' };
            }
            if (href.startsWith('mailto:') || href.startsWith('tel:')) {
                return { status: 200, reason: 'Protocol link (mailto/tel)' };
            }
            if (link.isDuplicate) {
                return { status: 200, reason: 'Duplicate Link' };
            }
            return { status: 200, reason: 'Link Discovered' };
        }

        // Pre-load DB cache for this domain into the in-memory Map
        // This means previously seen URLs (from past test runs) are instantly available
        try {
            const dbCached = await LinkCache.getBulkForDomain(targetDomain);
            for (const [normUrl, entry] of dbCached.entries()) {
                // fromPage -1 = came from persistent DB cache (prior test run)
                linkStatusCache.set(normUrl, { status: entry.status, reason: entry.reason, fromPage: -1 });
            }
        } catch (cachePreloadErr) {
            console.warn('⚠️ Could not pre-load link cache from DB:', cachePreloadErr.message);
        }

        // STEP 5: Visit Each Page
        for (let i = 0; i < allPages.length; i++) {
            const pageInfo = allPages[i];
            const pageIndex = i;

            // ── Safety guard (should rarely trigger after slice above) ─────
            // If somehow more pages sneak in, hard-stop at the 5-URL ceiling.
            if (subscriptionTier === 'Free' && (totalUrlsTestedPreviously + i) >= 5) {
                try {
                    sendUpdate({
                        type: 'status',
                        message: '⚠️ Free Trial URL limit reached (5/5). Additional pages skipped. Please upgrade to Basic, Pro, or Business to unlock unlimited scan capacity.',
                        step: 'limit-reached'
                    });
                } catch (_) { }
                try {
                    await pool.query('UPDATE users SET credits = 0 WHERE id = $1', [userId]);
                    await pool.query(
                        'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, 0, $2)',
                        [userId, 'Free Trial scan capacity exhausted (5 URLs tested). Credits set to 0.']
                    );
                } catch (creditsErr) {
                    console.error('Failed to set credits to 0:', creditsErr.message);
                }
                break;
            }

            sendUpdate({
                type: 'page-start',
                pageIndex,
                totalPages: allPages.length,
                url: pageInfo.href,
                text: pageInfo.text,
                progress: Math.round((i / allPages.length) * 100),
            });

            const pageResult = {
                index: pageIndex,
                url: pageInfo.href,
                text: pageInfo.text,
                source: pageInfo.source,
                title: '',
                loadStatus: 'UNKNOWN',
                loadTimeMs: 0,
                httpStatus: 0,
                screenshotPath: '',
                screenshotUrl: '',
                mobileScreenshotUrl: '',
                desktopScreenshotUrl: '',
                indexStatus: 'unknown',
                robots: null,
                consoleErrors: [],
                networkErrors: [],
                networkLog: {
                    requests: [],
                    summary: {
                        totalRequests: 0,
                        totalSize: 0,
                        totalTransferred: 0,
                        domContentLoaded: 0,
                        loadTime: 0,
                        finishTime: 0,
                    }
                },
                brokenLinksCheck: [],
                elementsInfo: {},
                imageCheckResults: [],
                videoCheckResults: [],
                aiAnalysis: null,
                groqAnalysis: null,
                error: null,
            };

            // Global listeners for this page visit
            const consoleErrors = [];
            const consoleHandler = (msg) => {
                if (msg.type() === 'error') {
                    consoleErrors.push({
                        type: 'CONSOLE_ERROR',
                        text: msg.text(),
                        location: msg.location().url || pageInfo.href
                    });
                }
            };

            const networkErrors = [];
            const requestFailedHandler = (request) => {
                networkErrors.push({
                    type: 'REQUEST_FAILED',
                    url: request.url(),
                    errorText: request.failure() ? request.failure().errorText : 'Unknown Error'
                });
            };

            const responseHandler = (res) => {
                if (res.status() >= 400) {
                    networkErrors.push({
                        type: 'HTTP_ERROR',
                        url: res.url(),
                        status: res.status(),
                        statusText: res.statusText()
                    });
                }
            };

            // --- NETWORK LOG: Track all requests with timing ---
            const networkRequests = new Map();
            const requestHandler = (request) => {
                networkRequests.set(request, {
                    url: request.url(),
                    name: request.url().split('/').pop()?.split('?')[0] || request.url(),
                    method: request.method(),
                    resourceType: request.resourceType(),
                    startTime: Date.now(),
                    status: 0,
                    size: 0,
                    time: 0,
                });
            };

            const responseLogHandler = async (response) => {
                const entry = networkRequests.get(response.request());
                if (entry) {
                    entry.status = response.status();
                    entry.time = Date.now() - entry.startTime;
                    try {
                        const body = await response.body().catch(() => null);
                        entry.size = body ? body.length : 0;
                    } catch {
                        entry.size = 0;
                    }
                }
            };

            page.on('console', consoleHandler);
            page.on('requestfailed', requestFailedHandler);
            page.on('response', responseHandler);
            page.on('request', requestHandler);
            page.on('response', responseLogHandler);

            try {
                const pageLoadStart = Date.now();
                let pageResponse;
                try {
                    pageResponse = await page.goto(pageInfo.href, {
                        waitUntil: 'load',
                        timeout: 35000,
                    });
                } catch (gotoErr) {
                    if (page.isClosed()) {
                        throw gotoErr;
                    }
                    console.log(`⚠️ Failed to load ${pageInfo.href} with 'load', falling back...`);
                    pageResponse = await page.goto(pageInfo.href, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000,
                    }).catch(e => null);
                }

                pageResult.loadTimeMs = Date.now() - pageLoadStart;
                pageResult.httpStatus = pageResponse ? pageResponse.status() : 0;
                pageResult.loadStatus = pageResponse && pageResponse.ok() ? 'SUCCESS' : 'FAILED';
                pageResult.title = await page.title();
                pageResult.consoleErrors = consoleErrors;
                pageResult.networkErrors = networkErrors;

                // Capture performance timing from the browser
                const perfTiming = await page.evaluate(() => {
                    const p = performance.timing;
                    return {
                        domContentLoaded: p.domContentLoadedEventEnd - p.navigationStart,
                        loadTime: p.loadEventEnd - p.navigationStart,
                        finishTime: Date.now() - p.navigationStart,
                    };
                }).catch(() => ({ domContentLoaded: 0, loadTime: 0, finishTime: 0 }));

                // Build network log from captured requests
                const allNetworkEntries = Array.from(networkRequests.values());
                const totalSize = allNetworkEntries.reduce((sum, r) => sum + (r.size || 0), 0);
                pageResult.networkLog = {
                    requests: allNetworkEntries.map(r => ({
                        name: r.name,
                        url: r.url,
                        method: r.method,
                        status: r.status,
                        type: r.resourceType,
                        size: r.size,
                        time: r.time,
                    })),
                    summary: {
                        totalRequests: allNetworkEntries.length,
                        totalSize: totalSize,
                        totalTransferred: totalSize,
                        domContentLoaded: perfTiming.domContentLoaded,
                        loadTime: perfTiming.loadTime,
                        finishTime: perfTiming.finishTime,
                    }
                };

                // Wait for content to settle
                await page.waitForTimeout(1000);

                // Send live screenshot
                const liveBuffer = await page.screenshot({ type: 'png' });
                sendUpdate({
                    type: 'live-screenshot',
                    image: liveBuffer.toString('base64'),
                    url: pageInfo.href,
                    pageIndex,
                });

                // Gather deep page element info (SEO, element counts, broken items)
                pageResult.elementsInfo = await page.evaluate(async () => {
                    const getMetaContent = (names) => {
                        for (const name of names) {
                            const el = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
                            if (el) return el.getAttribute('content');
                        }
                        return null;
                    };

                    const description = getMetaContent(['description', 'og:description', 'twitter:description']) || 'No description found';
                    const ogType = getMetaContent(['og:type']) || 'No og:type found';
                    const ogTitle = getMetaContent(['og:title']) || document.title;
                    const keywords = getMetaContent(['keywords', 'news_keywords']) || 'None';

                    // Image Analysis: Total, Missing Src/Alt, Duplicates
                    const images = Array.from(document.querySelectorAll('img'));
                    const badImages = [];
                    const srcStats = new Map();
                    let exactMissingSrc = 0;
                    let exactMissingAlt = 0;

                    images.forEach((img, idx) => {
                        const rawSrc = img.getAttribute('src');
                        const rawAlt = img.getAttribute('alt');

                        const src = rawSrc !== null ? String(rawSrc).trim() : null;
                        const alt = rawAlt !== null ? String(rawAlt).trim() : null;

                        const isHidden = img.offsetParent === null && img.style.display === 'none';
                        const isLazy = img.getAttribute('loading') === 'lazy' && !img.complete;
                        const isBroken = !isHidden && !isLazy && img.complete && img.naturalWidth === 0 && src && src !== '#';

                        const missingSrc = src === null || src === '' || src === '#' || src === 'javascript:void(0)' || src === '/';
                        const missingAlt = alt === null || alt === '' || alt.toLowerCase() === 'null' || alt.toLowerCase() === 'undefined';

                        if (missingSrc) exactMissingSrc++;
                        if (missingAlt) exactMissingAlt++;

                        if (src && !missingSrc) {
                            let normalizedSrc;
                            try {
                                normalizedSrc = new URL(src, document.baseURI).href;
                            } catch {
                                normalizedSrc = src;
                            }
                            srcStats.set(normalizedSrc, (srcStats.get(normalizedSrc) || 0) + 1);
                        }

                        if (missingAlt || missingSrc || isBroken) {
                            badImages.push({
                                index: idx,
                                src: src || 'MISSING',
                                alt: rawAlt === null ? 'NULL' : (alt === '' ? 'EMPTY' : alt),
                                issue: missingSrc ? 'Missing SRC' : (isBroken ? 'Broken Image' : 'Missing ALT'),
                                missingSrc,
                                missingAlt,
                                isBroken,
                                tag: 'img'
                            });
                        }
                    });
                    const totalDuplicateImages = Array.from(srcStats.values())
                        .reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);

                    const brokenLinks = [];
                    const links = Array.from(document.querySelectorAll('a'));
                    const linkStats = new Map();

                    links.forEach(a => {
                        const rawHref = a.getAttribute('href');
                        const text = a.textContent.trim() || 'Empty Link';

                        if (rawHref && rawHref !== '#' && rawHref.trim() !== '' && !rawHref.startsWith('javascript:') && !rawHref.startsWith('mailto:') && !rawHref.startsWith('tel:')) {
                            let absoluteHref;
                            try {
                                absoluteHref = new URL(rawHref.trim(), document.baseURI).href;
                            } catch {
                                absoluteHref = rawHref.trim();
                            }

                            let normalizedHref = absoluteHref.split('#')[0];
                            if (normalizedHref.endsWith('/')) {
                                normalizedHref = normalizedHref.slice(0, -1);
                            }

                            linkStats.set(normalizedHref, (linkStats.get(normalizedHref) || 0) + 1);
                        }

                        if (!rawHref || rawHref === '#' || rawHref.trim() === '' || rawHref.startsWith('javascript:')) {
                            brokenLinks.push({
                                text,
                                href: rawHref || 'MISSING',
                                tag: 'a',
                                reason: !rawHref ? 'Missing href' : (rawHref === '#' ? 'Placeholder href' : 'Invalid href')
                            });
                        }
                    });

                    const totalDuplicateLinks = Array.from(linkStats.values()).reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);

                    return {
                        seo: {
                            title: document.title,
                            description,
                            keywords,
                            ogType,
                            ogTitle,
                            hasMetaDescription: !!getMetaContent(['description']),
                            hasOgDescription: !!getMetaContent(['og:description']),
                            hasOgType: !!getMetaContent(['og:type']),
                            hasViewport: !!document.querySelector('meta[name="viewport" i]'),
                            metaRobots: getMetaContent(['robots']) || '',
                            metaGooglebot: getMetaContent(['googlebot']) || ''
                        },
                         counts: {
                            images: images.length,
                            links: links.length,
                            h1: document.querySelectorAll('h1').length,
                            forms: document.querySelectorAll('form').length,
                            duplicateImages: totalDuplicateImages,
                            duplicateLinks: totalDuplicateLinks,
                            missingSrc: exactMissingSrc,
                            missingAlt: exactMissingAlt,
                            scripts: document.querySelectorAll('script').length,
                            styles: document.querySelectorAll('link[rel="stylesheet"]').length + document.querySelectorAll('style').length
                        },
                        broken: {
                            images: badImages.filter(img => img.isBroken || img.missingSrc),
                            links: brokenLinks
                        },
                        badImages,
                    };
                });

                // Indexability check: <meta name="robots|googlebot" content="noindex"> or X-Robots-Tag header
                try {
                    const xRobotsTag = (pageResponse && typeof pageResponse.headers === 'function')
                        ? (pageResponse.headers()['x-robots-tag'] || '')
                        : '';
                    const metaRobots = String(pageResult.elementsInfo?.seo?.metaRobots || '').toLowerCase();
                    const metaGooglebot = String(pageResult.elementsInfo?.seo?.metaGooglebot || '').toLowerCase();
                    const isNoindex = /noindex/.test(metaRobots) || /noindex/.test(metaGooglebot) || /noindex/i.test(String(xRobotsTag));
                    pageResult.indexStatus = isNoindex ? 'noindex' : 'indexed';
                    pageResult.robots = {
                        metaRobots: pageResult.elementsInfo?.seo?.metaRobots || '',
                        metaGooglebot: pageResult.elementsInfo?.seo?.metaGooglebot || '',
                        xRobotsTag: String(xRobotsTag || ''),
                    };
                    if (pageResult.elementsInfo && pageResult.elementsInfo.seo) {
                        pageResult.elementsInfo.seo.indexable = !isNoindex;
                    }
                } catch (idxErr) {
                    pageResult.indexStatus = 'unknown';
                }

                // Update global summary stats
                report.globalSummary.elementStats.totalImages += pageResult.elementsInfo.counts.images;
                report.globalSummary.elementStats.totalLinks += pageResult.elementsInfo.counts.links;

                const missingAltCount = pageResult.elementsInfo.counts.missingAlt;
                const missingSrcCount = pageResult.elementsInfo.counts.missingSrc;

                report.globalSummary.elementStats.totalMissingAlt += missingAltCount;
                report.globalSummary.elementStats.totalMissingSrc += missingSrcCount;
                report.globalSummary.elementStats.totalDuplicateImages += pageResult.elementsInfo.counts.duplicateImages;

                pageResult.elementsInfo.broken.links.forEach(bl => {
                    report.globalSummary.brokenLinks.push({ url: pageResult.url, ...bl });
                });

                pageResult.elementsInfo.badImages.filter(img => img.issue === 'Broken Image' || img.issue === 'Missing SRC').forEach(bi => {
                    report.globalSummary.missingResources.push({ url: pageResult.url, type: 'IMAGE', ...bi });
                });

                networkErrors.forEach(ne => {
                    report.globalSummary.missingResources.push({ url: pageResult.url, type: 'NETWORK', ...ne });
                });

                // IMAGE CHECK: Visibility + Load Status (complete & width > 0)
                sendUpdate({
                    type: 'status',
                    message: `🖼️ Checking images on page ${pageIndex + 1}...`,
                    step: 'image-check',
                });

                try {
                    const imageCheckResults = await page.evaluate(() => {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        return imgs.map((img, idx) => {
                            const rawSrc = img.getAttribute('src');
                            const rawAlt = img.getAttribute('alt');
                            const src = rawSrc !== null ? String(rawSrc).trim() : null;
                            const alt = rawAlt !== null ? String(rawAlt).trim() : null;

                            // 1. Visibility check
                            const rect = img.getBoundingClientRect();
                            const style = window.getComputedStyle(img);
                            const isVisible = (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0 &&
                                img.offsetParent !== null
                            );

                            // 2. Load check: complete + naturalWidth > 0
                            const isComplete = img.complete;
                            const naturalWidth = img.naturalWidth || 0;
                            const naturalHeight = img.naturalHeight || 0;
                            const isLoaded = isComplete && naturalWidth > 0;
                            const isBroken = isComplete && naturalWidth === 0 && src && src !== '' && src !== '#';

                            // Determine overall status
                            let status = 'OK';
                            let reason = '';
                            if (!src || src === '' || src === '#') {
                                status = 'MISSING_SRC';
                                reason = 'Image has no valid src attribute';
                            } else if (!isVisible) {
                                status = 'HIDDEN';
                                reason = 'Image is not visible on screen (display:none, hidden, or zero size)';
                            } else if (isBroken) {
                                status = 'BROKEN';
                                reason = `Image failed to load (complete=true, naturalWidth=0). Src: ${src.substring(0, 100)}`;
                            } else if (!isComplete) {
                                status = 'LOADING';
                                reason = 'Image is still loading';
                            } else if (isLoaded && isVisible) {
                                status = 'OK';
                                reason = `Image loaded successfully (${naturalWidth}x${naturalHeight})`;
                            }

                            return {
                                index: idx,
                                src: src || 'MISSING',
                                alt: alt || 'MISSING',
                                isVisible,
                                isComplete,
                                naturalWidth,
                                naturalHeight,
                                isLoaded,
                                isBroken,
                                status,
                                reason,
                                displayWidth: Math.round(rect.width),
                                displayHeight: Math.round(rect.height),
                            };
                        });
                    });

                    pageResult.imageCheckResults = imageCheckResults;

                    const totalImages = imageCheckResults.length;
                    const okImages = imageCheckResults.filter(i => i.status === 'OK').length;
                    const brokenImages = imageCheckResults.filter(i => i.status === 'BROKEN').length;
                    const hiddenImages = imageCheckResults.filter(i => i.status === 'HIDDEN').length;
                    const missingSrcImages = imageCheckResults.filter(i => i.status === 'MISSING_SRC').length;

                    console.log(`   🖼️ [Page ${pageIndex + 1}] Image Check: ${totalImages} total | ${okImages} OK | ${brokenImages} Broken | ${hiddenImages} Hidden | ${missingSrcImages} Missing Src`);

                    sendUpdate({
                        type: 'image-check-complete',
                        pageIndex,
                        url: pageInfo.href,
                        summary: { totalImages, okImages, brokenImages, hiddenImages, missingSrcImages },
                        details: imageCheckResults,
                    });

                } catch (imgCheckErr) {
                    console.log('Image check error:', imgCheckErr.message);
                    pageResult.imageCheckResults = [];
                }

                // VIDEO CHECK: Visibility + readyState >= 3 (buffering complete)
                sendUpdate({
                    type: 'status',
                    message: `🎥 Checking videos on page ${pageIndex + 1}...`,
                    step: 'video-check',
                });

                try {
                    const videoCheckResults = await page.evaluate(() => {
                        const videos = Array.from(document.querySelectorAll('video'));
                        // Also check iframes for embedded videos (YouTube, Vimeo, etc.)
                        const iframeVideos = Array.from(document.querySelectorAll('iframe')).filter(iframe => {
                            const src = (iframe.getAttribute('src') || '').toLowerCase();
                            return src.includes('youtube') || src.includes('youtu.be') ||
                                src.includes('vimeo') || src.includes('dailymotion') ||
                                src.includes('wistia') || src.includes('player');
                        });

                        const results = [];

                        // Check native <video> elements
                        videos.forEach((video, idx) => {
                            const sources = Array.from(video.querySelectorAll('source'));
                            const videoSrc = video.getAttribute('src') || (sources.length > 0 ? sources[0].getAttribute('src') : null);
                            const poster = video.getAttribute('poster') || null;

                            // 1. Visibility check
                            const rect = video.getBoundingClientRect();
                            const style = window.getComputedStyle(video);
                            const isVisible = (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0
                            );

                            // 2. readyState check
                            const readyState = video.readyState;
                            const isReady = readyState >= 3;
                            const duration = video.duration || 0;
                            const paused = video.paused;
                            const muted = video.muted;
                            const autoplay = video.autoplay;
                            const networkState = video.networkState;
                            const errorCode = video.error ? video.error.code : null;

                            // Determine readyState label
                            const readyStateLabels = {
                                0: 'HAVE_NOTHING',
                                1: 'HAVE_METADATA',
                                2: 'HAVE_CURRENT_DATA',
                                3: 'HAVE_FUTURE_DATA',
                                4: 'HAVE_ENOUGH_DATA'
                            };

                            let status = 'OK';
                            let reason = '';

                            if (!videoSrc && sources.length === 0) {
                                status = 'MISSING_SRC';
                                reason = 'Video has no src or source elements';
                            } else if (!isVisible) {
                                status = 'HIDDEN';
                                reason = 'Video player is not visible on screen';
                            } else if (errorCode) {
                                status = 'ERROR';
                                const errorMessages = {
                                    1: 'MEDIA_ERR_ABORTED - Playback aborted by user',
                                    2: 'MEDIA_ERR_NETWORK - Network error while downloading',
                                    3: 'MEDIA_ERR_DECODE - Error decoding video',
                                    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - Video format not supported'
                                };
                                reason = errorMessages[errorCode] || `Unknown error code: ${errorCode}`;
                            } else if (readyState === 0) {
                                status = 'NOT_LOADED';
                                reason = 'Video has not started loading (readyState=0)';
                            } else if (readyState < 3) {
                                status = 'BUFFERING';
                                reason = `Video is buffering (readyState=${readyState}: ${readyStateLabels[readyState] || 'Unknown'})`;
                            } else {
                                status = 'OK';
                                reason = `Video ready to play (readyState=${readyState}: ${readyStateLabels[readyState] || 'Unknown'}, duration=${duration.toFixed(1)}s)`;
                            }

                            results.push({
                                index: idx,
                                type: 'native',
                                src: videoSrc || 'MISSING',
                                poster: poster || 'NONE',
                                isVisible,
                                readyState,
                                readyStateLabel: readyStateLabels[readyState] || 'Unknown',
                                isReady,
                                duration: Math.round(duration * 10) / 10,
                                paused,
                                muted,
                                autoplay,
                                errorCode,
                                status,
                                reason,
                                displayWidth: Math.round(rect.width),
                                displayHeight: Math.round(rect.height),
                            });
                        });

                        // Check embedded iframe videos
                        iframeVideos.forEach((iframe, idx) => {
                            const src = iframe.getAttribute('src') || '';
                            const rect = iframe.getBoundingClientRect();
                            const style = window.getComputedStyle(iframe);
                            const isVisible = (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0
                            );

                            let platform = 'unknown';
                            if (src.includes('youtube') || src.includes('youtu.be')) platform = 'YouTube';
                            else if (src.includes('vimeo')) platform = 'Vimeo';
                            else if (src.includes('dailymotion')) platform = 'Dailymotion';
                            else if (src.includes('wistia')) platform = 'Wistia';
                            else platform = 'Embedded Player';

                            results.push({
                                index: videos.length + idx,
                                type: 'iframe',
                                src: src.substring(0, 200),
                                platform,
                                isVisible,
                                readyState: isVisible ? 4 : 0,
                                readyStateLabel: isVisible ? 'EMBEDDED_VISIBLE' : 'EMBEDDED_HIDDEN',
                                isReady: isVisible,
                                duration: 0,
                                paused: false,
                                muted: false,
                                autoplay: false,
                                errorCode: null,
                                status: isVisible ? 'OK' : 'HIDDEN',
                                reason: isVisible
                                    ? `${platform} embed is visible and loaded`
                                    : `${platform} embed is not visible on screen`,
                                displayWidth: Math.round(rect.width),
                                displayHeight: Math.round(rect.height),
                            });
                        });

                        return results;
                    });

                    pageResult.videoCheckResults = videoCheckResults;

                    const totalVideos = videoCheckResults.length;
                    const nativeVideos = videoCheckResults.filter(v => v.type === 'native').length;
                    const iframeVideos = videoCheckResults.filter(v => v.type === 'iframe').length;
                    const readyVideos = videoCheckResults.filter(v => v.status === 'OK').length;
                    const brokenVideos = videoCheckResults.filter(v => ['ERROR', 'NOT_LOADED', 'MISSING_SRC'].includes(v.status)).length;
                    const bufferingVideos = videoCheckResults.filter(v => v.status === 'BUFFERING').length;

                    console.log(`   🎥 [Page ${pageIndex + 1}] Video Check: ${totalVideos} total (${nativeVideos} native, ${iframeVideos} iframe) | ${readyVideos} Ready | ${brokenVideos} Broken | ${bufferingVideos} Buffering`);

                    sendUpdate({
                        type: 'video-check-complete',
                        pageIndex,
                        url: pageInfo.href,
                        summary: { totalVideos, nativeVideos, iframeVideos, readyVideos, brokenVideos, bufferingVideos },
                        details: videoCheckResults,
                    });

                } catch (vidCheckErr) {
                    console.log('Video check error:', vidCheckErr.message);
                    pageResult.videoCheckResults = [];
                }

                // --- BROKEN LINK VERIFICATION (cache-aware, cross-page deduplication) ---
                // New URLs are evaluated and cached; previously seen URLs are served from cache.
                sendUpdate({
                    type: 'status',
                    message: `Checking links on page ${pageIndex + 1} — deduplication cache active...`,
                    step: 'broken-link-check',
                });

                try {
                    // Extract all anchor tags from the current page DOM
                    const allPageLinks = await page.evaluate(() => {
                        const anchors = Array.from(document.querySelectorAll('a'));
                        const results = [];
                        const seen = new Set();

                        anchors.forEach(a => {
                            const href = a.getAttribute('href');
                            const text = (a.textContent || '').trim().substring(0, 60) || 'No Text Found';

                            let finalUrl = href || 'MISSING';
                            if (href && href.trim() !== '' && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:') && href !== '#') {
                                try {
                                    finalUrl = new URL(href.trim(), document.baseURI).href;
                                } catch {
                                    finalUrl = href;
                                }
                            }

                            let isDuplicate = false;
                            let normalizedForDup = finalUrl.split('#')[0];
                            if (normalizedForDup.endsWith('/')) {
                                normalizedForDup = normalizedForDup.slice(0, -1);
                            }

                            if (normalizedForDup !== 'MISSING' && normalizedForDup !== '') {
                                if (seen.has(normalizedForDup)) {
                                    isDuplicate = true;
                                } else {
                                    seen.add(normalizedForDup);
                                }
                            }

                            results.push({ text, href: finalUrl, isDuplicate });
                        });
                        return results;
                    });

                    const allLinksList = [];
                    // Collect new (uncached) URLs to flush to DB in one batch
                    const newDbEntries = [];
                    let cachedCount = 0;
                    let newCount = 0;

                    for (const link of allPageLinks) {
                        const normKey = normalizeLinkUrl(link.href);

                        if (linkStatusCache.has(normKey)) {
                            // ✅ Cache HIT — reuse result from a previous page or prior test run
                            const cached = linkStatusCache.get(normKey);
                            const fromLabel = cached.fromPage === -1
                                ? 'DB cache'
                                : `page ${cached.fromPage + 1}`;
                            allLinksList.push({
                                text: link.text || 'No Text Found',
                                href: link.href,
                                isDuplicate: link.isDuplicate,
                                status: cached.status,
                                reason: `${cached.reason} (cached from ${fromLabel})`,
                                fromCache: true,
                                cachedFromPage: cached.fromPage
                            });
                            cachedCount++;
                        } else {
                            // 🆕 Cache MISS — evaluate this URL and store in cache
                            const determined = determineLinkStatus(link);

                            // Store in in-session memory cache
                            linkStatusCache.set(normKey, {
                                status: determined.status,
                                reason: determined.reason,
                                fromPage: pageIndex
                            });

                            // Queue for batch DB flush (only valid absolute URLs)
                            if (link.href && link.href !== 'MISSING' && link.href.startsWith('http')) {
                                newDbEntries.push({
                                    url: link.href,
                                    normalizedUrl: normKey,
                                    status: determined.status,
                                    reason: determined.reason
                                });
                            }

                            allLinksList.push({
                                text: link.text || 'No Text Found',
                                href: link.href,
                                isDuplicate: link.isDuplicate,
                                status: determined.status,
                                reason: determined.reason,
                                fromCache: false
                            });
                            newCount++;
                        }
                    }

                    // Batch-persist new entries to DB cache (fire-and-forget, non-blocking)
                    if (newDbEntries.length > 0 && targetDomain) {
                        LinkCache.setBulk(targetDomain, newDbEntries).catch(err =>
                            console.warn('⚠️ LinkCache DB flush error:', err.message)
                        );
                    }

                    pageResult.brokenLinksCheck = allLinksList;

                    if (pageResult.elementsInfo && pageResult.elementsInfo.counts) {
                        pageResult.elementsInfo.counts.brokenLinks = 0;
                        pageResult.elementsInfo.counts.linksChecked = allLinksList.length;
                    }

                    console.log(`   🔗 [Page ${pageIndex + 1}] Links: ${allLinksList.length} total | ✅ ${cachedCount} from cache | 🆕 ${newCount} newly evaluated`);

                    // Notify frontend with cache stats
                    sendUpdate({
                        type: 'link-check-complete',
                        pageIndex,
                        url: pageInfo.href,
                        totalLinks: allLinksList.length,
                        cachedLinks: cachedCount,
                        newLinks: newCount,
                        cacheSize: linkStatusCache.size
                    });

                } catch (blErr) {
                    console.log('List links error:', blErr.message);
                    pageResult.brokenLinksCheck = [];
                }

                // Take full-page DESKTOP screenshot (stitched viewport-by-viewport
                // so lazy/scroll-animated sections are never left blank)
                const screenshotName = `page_${pageIndex}_${Date.now()}.png`;
                const screenshotPath = path.join(testDir, screenshotName);
                await captureFullPage(page, screenshotPath);
                pageResult.screenshotPath = screenshotPath;
                pageResult.screenshotUrl = `/api/screenshots/${testId}/${screenshotName}`;
                pageResult.desktopScreenshotUrl = pageResult.screenshotUrl;

                // Take full-page MOBILE screenshot (separate emulated context; non-fatal)
                try {
                    const mobileContext = await browser.newContext({
                        viewport: { width: 390, height: 844 },
                        deviceScaleFactor: 3,
                        isMobile: true,
                        hasTouch: true,
                        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
                        ignoreHTTPSErrors: true,
                    });
                    const mobilePage = await mobileContext.newPage();
                    try {
                        await mobilePage.goto(pageInfo.href, { waitUntil: 'load', timeout: 35000 })
                            .catch(() => mobilePage.goto(pageInfo.href, { waitUntil: 'domcontentloaded', timeout: 20000 }));
                        // gentle scroll so lazy content/images load on mobile too
                        await mobilePage.evaluate(async () => {
                            await new Promise((resolve) => {
                                let y = 0;
                                const t = setInterval(() => {
                                    window.scrollBy(0, 600); y += 600;
                                    if (y >= document.body.scrollHeight || y > 12000) { clearInterval(t); resolve(); }
                                }, 100);
                            });
                        }).catch(() => { });
                        await mobilePage.waitForTimeout(400);
                        const mobileName = `page_${pageIndex}_mobile_${Date.now()}.png`;
                        await captureFullPage(mobilePage, path.join(testDir, mobileName));
                        pageResult.mobileScreenshotUrl = `/api/screenshots/${testId}/${mobileName}`;
                    } finally {
                        await mobilePage.close().catch(() => { });
                        await mobileContext.close().catch(() => { });
                    }
                } catch (mobileErr) {
                    console.log(`   ⚠️ [Page ${pageIndex + 1}] Mobile screenshot failed:`, mobileErr.message);
                }

                sendUpdate({
                    type: 'ai-analyzing',
                    pageIndex,
                    url: pageInfo.href,
                    message: `Analyzing page ${pageIndex + 1}/${allPages.length} with Gemini AI...`,
                });

                const aiAnalysis = await analyzeScreenshot(screenshotPath, pageInfo.href, pageResult.title);
                pageResult.aiAnalysis = aiAnalysis;

                sendUpdate({
                    type: 'ai-complete',
                    pageIndex,
                    url: pageInfo.href,
                    analysis: aiAnalysis,
                    screenshotUrl: pageResult.screenshotUrl,
                    title: pageResult.title,
                });

                // GROQ AI ANALYSIS
                try {
                    sendUpdate({
                        type: 'status',
                        message: `🧠 Groq AI analyzing page ${pageIndex + 1}/${allPages.length}...`,
                        step: 'groq-analysis',
                    });

                    const groqResult = await runGroqAnalysisPipeline(
                        screenshotPath, pageInfo.href, pageResult.title,
                        userDetails, sendUpdate
                    );

                    if (groqResult.playwrightCode && groqResult.playwrightCode.success && groqResult.playwrightCode.testCode) {
                        sendUpdate({
                            type: 'status',
                            message: `🧪 Running Groq AI test cases for page ${pageIndex + 1}...`,
                            step: 'groq-test-execution',
                        });

                        const executionResults = await executeGroqTests(
                            groqResult.playwrightCode.testCode,
                            pageInfo.href,
                            groqResult.playwrightCode.testFileName || 'groq_test.spec.js',
                            sendUpdate,
                            page
                        );
                        groqResult.executionResults = executionResults;
                    }

                    pageResult.groqAnalysis = groqResult;

                    sendUpdate({
                        type: 'groq-page-complete',
                        pageIndex,
                        url: pageInfo.href,
                        groqAnalysis: groqResult,
                    });

                    console.log(`   🧠 [Page ${pageIndex + 1}] Groq AI analysis complete`);
                } catch (groqErr) {
                    console.log(`   ⚠️ [Page ${pageIndex + 1}] Groq analysis error:`, groqErr.message);
                    pageResult.groqAnalysis = { status: 'error', error: groqErr.message };
                }

            } catch (pageError) {
                pageResult.loadStatus = 'ERROR';
                pageResult.error = pageError.message;
                sendUpdate({
                    type: 'page-error',
                    pageIndex,
                    url: pageInfo.href,
                    error: pageError.message,
                });
            } finally {
                page.off('console', consoleHandler);
                page.off('requestfailed', requestFailedHandler);
                page.off('response', responseHandler);
                page.off('request', requestHandler);
                page.off('response', responseLogHandler);
            }

            report.pages.push(pageResult);
            report.pagesCompleted = i + 1;

            sendUpdate({
                type: 'page-complete',
                pageIndex,
                totalPages: allPages.length,
                progress: Math.round(((i + 1) / allPages.length) * 100),
                result: {
                    url: pageResult.url,
                    title: pageResult.title,
                    loadStatus: pageResult.loadStatus,
                    score: pageResult.aiAnalysis?.overallScore || 0,
                    screenshotUrl: pageResult.screenshotUrl,
                    desktopScreenshotUrl: pageResult.desktopScreenshotUrl,
                    mobileScreenshotUrl: pageResult.mobileScreenshotUrl,
                    indexStatus: pageResult.indexStatus,
                    robots: pageResult.robots,
                    elementsInfo: pageResult.elementsInfo,
                    consoleErrors: pageResult.consoleErrors,
                    networkErrors: pageResult.networkErrors,
                    networkLog: pageResult.networkLog,
                    brokenLinksCheck: pageResult.brokenLinksCheck,
                    imageCheckResults: pageResult.imageCheckResults,
                    videoCheckResults: pageResult.videoCheckResults,
                    aiAnalysis: pageResult.aiAnalysis,
                    groqAnalysis: pageResult.groqAnalysis,
                },
            });
        }

        // STEP 7: Generate Final Summary and Suggested Fixes
        report.globalSummary.totalErrors = report.pages.reduce((sum, p) => sum + p.consoleErrors.length + p.networkErrors.length, 0);

        report.pages.forEach(p => {
            if (p.elementsInfo && p.elementsInfo.seo) {
                const seo = p.elementsInfo.seo;
                if (!seo.hasMetaDescription && !seo.hasOgDescription) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'Missing meta description (standard & OG)' });
                }
                if (!seo.hasOgType) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'Missing og:type tag' });
                }
                if (p.elementsInfo.counts.h1 === 0) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'No H1 tag found' });
                } else if (p.elementsInfo.counts.h1 > 1) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'Multiple H1 tags found' });
                }
            }
        });

        const fixes = new Set();
        if (report.globalSummary.brokenLinks.length > 0) fixes.add('Fix "href=#" and empty links by pointing them to valid endpoints or removing placeholders.');
        if (report.globalSummary.missingResources.some(r => r.type === 'IMAGE')) fixes.add('Ensure all image src paths are correct and images are present on the server.');
        if (report.globalSummary.missingResources.some(r => r.status === 404)) fixes.add('Resolve 404 errors by checking if resources (scripts, styles, images) were moved or renamed.');
        if (report.globalSummary.missingResources.some(r => r.status === 500)) fixes.add('Check backend server logs for "Internal Server Error" details on failing API calls.');
        if (report.globalSummary.totalErrors > 0) fixes.add('Review browser console for JavaScript type errors or unhandled promise rejections.');
        if (report.globalSummary.seoIssues.length > 0) fixes.add('Update <head> section with unique meta descriptions and OpenGraph tags for better SEO/Social sharing.');

        report.globalSummary.suggestedFixes = Array.from(fixes);

        const scores = report.pages
            .filter((p) => p.aiAnalysis && p.aiAnalysis.overallScore > 0)
            .map((p) => p.aiAnalysis.overallScore);

        report.overallScore = scores.length > 0
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : 0;

        report.status = 'complete';
        report.testDurationMs = Date.now() - testStartTime;

        sendUpdate({
            type: 'test-complete',
            report: {
                testId: report.testId,
                frontendUrl: report.frontendUrl,
                backendUrl: report.backendUrl,
                testDate: report.testDate,
                totalPages: report.totalPages,
                pagesCompleted: report.pagesCompleted,
                overallScore: report.overallScore,
                status: report.status,
                testDurationMs: report.testDurationMs,
                headerLinks: report.headerLinks.length,
                footerLinks: report.footerLinks.length,
                globalSummary: report.globalSummary,
                pages: report.pages.map((p) => ({
                    index: p.index,
                    url: p.url,
                    title: p.title,
                    text: p.text,
                    source: p.source,
                    loadStatus: p.loadStatus,
                    loadTimeMs: p.loadTimeMs,
                    httpStatus: p.httpStatus,
                    screenshotUrl: p.screenshotUrl,
                    mobileScreenshotUrl: p.mobileScreenshotUrl,
                    desktopScreenshotUrl: p.desktopScreenshotUrl,
                    indexStatus: p.indexStatus,
                    robots: p.robots,
                    consoleErrors: p.consoleErrors,
                    networkErrors: p.networkErrors,
                    networkLog: p.networkLog,
                    elementsInfo: p.elementsInfo,
                    brokenLinksCheck: p.brokenLinksCheck || [],
                    imageCheckResults: p.imageCheckResults || [],
                    videoCheckResults: p.videoCheckResults || [],
                    aiAnalysis: p.aiAnalysis,
                    groqAnalysis: p.groqAnalysis,
                    error: p.error,
                })),
            },
        });

        // ── Post-scan: burn credits for Free plan users who hit the 5-URL ceiling ──
        if (subscriptionTier === 'Free' && userId) {
            try {
                const newTotal = totalUrlsTestedPreviously + report.pages.length;
                if (newTotal >= 5) {
                    // Check current credits first to avoid duplicate ledger entries
                    const credCheck = await pool.query('SELECT credits FROM users WHERE id = $1', [userId]);
                    if (credCheck.rows.length > 0 && credCheck.rows[0].credits > 0) {
                        await pool.query('UPDATE users SET credits = 0 WHERE id = $1', [userId]);
                        await pool.query(
                            'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, 0, $2)',
                            [userId, `Free Trial exhausted: ${newTotal}/5 URLs scanned total. Credits set to 0.`]
                        );
                        console.log(`[FreePlan] Credits burned to 0 for user ${userId} (total URLs tested: ${newTotal})`);
                    }
                }
            } catch (burnErr) {
                console.error('[FreePlan] Post-scan credits burn failed:', burnErr.message);
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

        return report;

    } catch (error) {

        report.status = 'error';
        report.errorMessage = error.message;
        report.testDurationMs = Date.now() - testStartTime;

        sendUpdate({
            type: 'test-error',
            error: error.message,
            report,
        });

        return report;
    } finally {
        if (browser) {
            await browser.close();
            console.log(`🔒 [${testId}] Browser closed`);
        }
    }
}

/**
 * Scans a domain to discover and extract all unique internal page links
 * @param {string} frontendUrl - The domain URL to scan
 * @returns {Promise<object[]>} List of discovered page objects { url, text, source }
 */
async function discoverDomainUrls(frontendUrl) {
    let browser = null;
    try {
        if (!frontendUrl.startsWith('http://') && !frontendUrl.startsWith('https://')) {
            frontendUrl = 'https://' + frontendUrl;
        }

        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--start-maximized',
                '--disable-infobars',
            ],
        });

        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        try {
            await page.goto(frontendUrl, { waitUntil: 'load', timeout: 30000 });
        } catch (err) {
            console.log(`⚠️ Discover: initial load with 'load' failed, trying 'domcontentloaded'...`);
            await page.goto(frontendUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        await page.waitForTimeout(2000);

        // Scroll the page to trigger lazy loaded items
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 80);
            });
        });
        await page.waitForTimeout(1000);

        const homeTitle = await page.title();

        let baseDomain = '';
        try {
            baseDomain = new URL(frontendUrl).hostname.replace(/^www\./, '');
        } catch (e) { }

        const isSameDomain = (href) => {
            try {
                const linkDomain = new URL(href).hostname.replace(/^www\./, '');
                return linkDomain === baseDomain;
            } catch (e) { return false; }
        };

        const isValidPageLink = (href) => {
            return href &&
                href.startsWith('http') &&
                !href.includes('#') &&
                !href.startsWith('javascript:') &&
                !href.startsWith('mailto:') &&
                !href.startsWith('tel:') &&
                !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3|doc|docx|xls|xlsx|ppt|css|js|json|xml|woff|woff2|ttf|eot)$/i) &&
                isSameDomain(href);
        };

        // Extract Header Navigation Links
        const headerLinks = await page.evaluate(() => {
            const links = [];
            const selectors = [
                'header a[href]', 'nav a[href]', '[role="navigation"] a[href]',
                '.navbar a[href]', '.nav a[href]', '.header a[href]', '.menu a[href]',
                '.main-nav a[href]', '.dropdown-menu a[href]', '.sub-menu a[href]',
                '.mega-menu a[href]', '[class*="dropdown"] a[href]', '[class*="submenu"] a[href]'
            ];
            const seen = new Set();
            for (const selector of selectors) {
                document.querySelectorAll(selector).forEach((a) => {
                    const href = a.href;
                    const text = a.textContent.trim().substring(0, 100);
                    if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
                        seen.add(href);
                        links.push({ href, text: text || 'No Text', source: 'header' });
                    }
                });
            }
            return links;
        });

        // Extract Footer Links
        const footerLinks = await page.evaluate(() => {
            const links = [];
            const selectors = ['footer a[href]', '.footer a[href]', '#footer a[href]', '.site-footer a[href]'];
            const seen = new Set();
            for (const selector of selectors) {
                document.querySelectorAll(selector).forEach((a) => {
                    const href = a.href;
                    const text = a.textContent.trim().substring(0, 100);
                    if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
                        seen.add(href);
                        links.push({ href, text: text || 'No Text', source: 'footer' });
                    }
                });
            }
            return links;
        });

        // Extract Body/Content Links
        let bodyLinks = await page.evaluate(() => {
            const links = [];
            const seen = new Set();
            document.querySelectorAll('a[href]').forEach((a) => {
                const href = a.href;
                const text = a.textContent.trim().substring(0, 100);
                if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                    try {
                        const url = new URL(href);
                        if (url.hash && url.origin + url.pathname === window.location.origin + window.location.pathname) return;
                    } catch (e) { }
                    seen.add(href);
                    links.push({ href, text: text || 'No Text', source: 'body' });
                }
            });
            return links;
        });

        // Expose dropdown links by hovering
        try {
            const navItems = await page.locator('nav li, .navbar li, .menu li, header li').all();
            for (const item of navItems.slice(0, 15)) {
                try {
                    await item.hover({ timeout: 400 }).catch(() => { });
                } catch (e) { }
            }
            const dropdownLinks = await page.evaluate(() => {
                const links = [];
                const seen = new Set();
                document.querySelectorAll('.dropdown-menu a[href], .sub-menu a[href], [class*="dropdown"] a[href], [class*="submenu"] a[href], .mega-menu a[href]').forEach((a) => {
                    const href = a.href;
                    const text = a.textContent.trim().substring(0, 100);
                    if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:')) {
                        seen.add(href);
                        links.push({ href, text: text || 'No Text', source: 'dropdown' });
                    }
                });
                return links;
            });
            bodyLinks = [...bodyLinks, ...dropdownLinks];
        } catch (e) { }

        // Combine unique links
        const allLinksMap = new Map();
        allLinksMap.set(frontendUrl, { href: frontendUrl, text: homeTitle || 'Homepage', source: 'homepage' });

        [...headerLinks, ...footerLinks, ...bodyLinks].forEach((link) => {
            let normalizedHref = link.href;
            try {
                const u = new URL(normalizedHref);
                normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
            } catch (e) { }

            if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
                allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
            }
        });

        let allPages = Array.from(allLinksMap.values());

        // Fast crawl up to 10 sub-pages
        const pagesToDeepCrawl = allPages.slice(1, 11);
        for (const pageInfo of pagesToDeepCrawl) {
            try {
                await page.goto(pageInfo.href, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
                await page.waitForTimeout(200);

                const subPageLinks = await page.evaluate(() => {
                    const links = [];
                    const seen = new Set();
                    document.querySelectorAll('a[href]').forEach((a) => {
                        const href = a.href;
                        const text = a.textContent.trim().substring(0, 100);
                        if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                            seen.add(href);
                            links.push({ href, text: text || 'No Text', source: 'deep-crawl' });
                        }
                    });
                    return links;
                });

                for (const link of subPageLinks) {
                    let normalizedHref = link.href;
                    try {
                        const u = new URL(normalizedHref);
                        normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
                    } catch (e) { }

                    if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
                        allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
                    }
                }
            } catch (e) {
                // Ignore page crawl failures
            }
        }

        allPages = Array.from(allLinksMap.values());
        return allPages.map(p => ({
            url: p.href,
            text: p.text,
            source: p.source
        }));

    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = { runWebsiteTest, discoverDomainUrls };