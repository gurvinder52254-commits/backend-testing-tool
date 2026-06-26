/**
 * ============================================================
 * testRoutes.js - API Routes for Website Testing Platform
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { runWebsiteTest } = require('../playwrightTester');
const { runGroqAnalysisPipeline } = require('../groqAnalyzer');
const { executeGroqTests } = require('../groqTestRunner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// In-memory store for active/completed tests
const activeTests = new Map();

/**
 * POST /api/start-test
 * Starts a website test. Returns immediately with testId.
 * Live updates are sent via WebSocket.
 */
router.post('/start-test', async (req, res) => {
    try {
        let { frontendUrl, backendUrl, scanType, userDetails } = req.body;

        if (!frontendUrl) {
            return res.status(400).json({
                success: false,
                error: 'frontendUrl is required.',
                example: '{ "frontendUrl": "https://example.com", "backendUrl": "https://api.example.com" }',
            });
        }

        // Auto-add https if missing
        if (!frontendUrl.startsWith('http://') && !frontendUrl.startsWith('https://')) {
            frontendUrl = 'https://' + frontendUrl;
        }
        if (backendUrl && !backendUrl.startsWith('http://') && !backendUrl.startsWith('https://')) {
            backendUrl = 'https://' + backendUrl;
        }

        // Validate URL
        try {
            new URL(frontendUrl);
            if (backendUrl) new URL(backendUrl);
        } catch (urlError) {
            return res.status(400).json({
                success: false,
                error: 'Invalid URL format. Please provide a valid URL.',
            });
        }

        const testId = uuidv4().substring(0, 8);
        const broadcast = req.app.get('broadcastUpdate');

        console.log(`\n📨 New test request: ${frontendUrl} [TestID: ${testId}]`);

        // Return immediately
        res.json({
            success: true,
            testId,
            message: 'Test started. Connect to WebSocket for live updates.',
        });

        // Store test status
        activeTests.set(testId, { status: 'running', startTime: Date.now() });

        // Run test in background
        try {
            const report = await runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userDetails, (update) => {
                // Attach testId to every update
                broadcast({ ...update, testId });
            });

            activeTests.set(testId, { status: 'complete', report, endTime: Date.now() });
        } catch (err) {
            activeTests.set(testId, { status: 'error', error: err.message, endTime: Date.now() });
            broadcast({
                type: 'test-error',
                testId,
                error: err.message,
            });
        }
    } catch (error) {
        console.error('❌ Route error:', error.message);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`,
        });
    }
});

/**
 * POST /api/test (Legacy - synchronous test)
 */
router.post('/test', async (req, res) => {
    try {
        let { url, frontendUrl } = req.body;
        const targetUrl = frontendUrl || url;

        if (!targetUrl) {
            return res.status(400).json({
                success: false,
                error: 'URL is required.',
            });
        }

        let validatedUrl = targetUrl.trim();
        if (!validatedUrl.startsWith('http://') && !validatedUrl.startsWith('https://')) {
            validatedUrl = 'https://' + validatedUrl;
        }

        const testId = uuidv4().substring(0, 8);
        const report = await runWebsiteTest(testId, validatedUrl, null, 'domain', () => {});

        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'Server is running ✅',
        timestamp: new Date().toISOString(),
        service: 'Website Testing Platform v2.0',
        activeTests: activeTests.size,
    });
});

/**
 * GET /api/test/:testId
 * Get results for a specific test
 */
router.get('/test/:testId', (req, res) => {
    const { testId } = req.params;
    const test = activeTests.get(testId);

    if (!test) {
        return res.status(404).json({ success: false, error: 'Test not found' });
    }

    res.json({ success: true, ...test });
});

/**
 * GET /api/reports
 * List all test reports
 */
router.get('/reports', (req, res) => {
    const reportsDir = path.join(__dirname, '..', 'reports');
    try {
        const dirs = fs.readdirSync(reportsDir).filter((f) => {
            const stat = fs.statSync(path.join(reportsDir, f));
            return stat.isDirectory();
        });

        const reports = dirs.map((dir) => {
            const reportPath = path.join(reportsDir, dir, 'report.json');
            let report = null;
            if (fs.existsSync(reportPath)) {
                try {
                    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
                } catch (_) {}
            }
            return {
                testId: dir,
                hasReport: !!report,
                frontendUrl: report?.frontendUrl || 'N/A',
                testDate: report?.testDate || 'N/A',
                overallScore: report?.overallScore || 0,
                totalPages: report?.totalPages || 0,
                status: report?.status || 'unknown',
            };
        });

        res.json({ success: true, totalReports: reports.length, reports });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/reports/:testId
 * Get a specific test report by ID
 */
router.get('/reports/:testId', (req, res) => {
    const { testId } = req.params;
    const reportPath = path.join(__dirname, '..', 'reports', testId, 'report.json');

    if (!fs.existsSync(reportPath)) {
        return res.status(404).json({ success: false, error: 'Report not found' });
    }

    try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to read report: ' + error.message });
    }
});

/**
 * POST /api/groq-analyze
 * Run Groq AI analysis pipeline on a URL
 * Takes screenshot → Analyzes elements → Suggests tests → Generates code → Executes tests
 */
router.post('/groq-analyze', async (req, res) => {
    try {
        let { url, userDetails } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'url is required.',
                example: '{ "url": "https://example.com" }',
            });
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        try {
            new URL(url);
        } catch (urlError) {
            return res.status(400).json({ success: false, error: 'Invalid URL format.' });
        }

        const analyzeId = uuidv4().substring(0, 8);
        const broadcast = req.app.get('broadcastUpdate');

        console.log(`\n\uD83E\uDDE0 Groq analysis request: ${url} [ID: ${analyzeId}]`);

        // Return immediately
        res.json({
            success: true,
            analyzeId,
            message: 'Groq analysis started. Connect to WebSocket for live updates.',
        });

        // Run analysis in background
        (async () => {
            let browser = null;
            try {
                // Step 1: Take screenshot
                broadcast({
                    type: 'groq-status',
                    analyzeId,
                    step: 'screenshot',
                    message: `\uD83D\uDCF8 Taking screenshot of ${url}...`,
                });

                browser = await chromium.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                });

                const context = await browser.newContext({
                    viewport: { width: 1920, height: 1080 },
                    ignoreHTTPSErrors: true,
                });

                const page = await context.newPage();
                await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {
                    return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                });
                await page.waitForTimeout(2000);

                const pageTitle = await page.title();

                // Take screenshot
                const screenshotDir = path.join(__dirname, '..', 'reports', 'groq_' + analyzeId);
                if (!fs.existsSync(screenshotDir)) {
                    fs.mkdirSync(screenshotDir, { recursive: true });
                }
                const screenshotPath = path.join(screenshotDir, 'screenshot.png');
                await page.screenshot({ path: screenshotPath, fullPage: true });

                // Send live screenshot
                const liveBuffer = fs.readFileSync(screenshotPath);
                broadcast({
                    type: 'groq-screenshot',
                    analyzeId,
                    image: liveBuffer.toString('base64'),
                    url,
                    screenshotUrl: `/api/screenshots/groq_${analyzeId}/screenshot.png`,
                });

                await browser.close();
                browser = null;

                // Step 2: Run Groq AI Pipeline
                const groqResult = await runGroqAnalysisPipeline(
                    screenshotPath, url, pageTitle, userDetails,
                    (update) => broadcast({ ...update, analyzeId })
                );

                // Step 3: Execute generated tests
                if (groqResult.playwrightCode && groqResult.playwrightCode.testCode) {
                    broadcast({
                        type: 'groq-status',
                        analyzeId,
                        step: 'test-execution',
                        message: `\uD83E\uDDEA Running AI-generated test cases...`,
                    });

                    const executionResults = await executeGroqTests(
                        groqResult.playwrightCode.testCode,
                        url,
                        groqResult.playwrightCode.testFileName || 'groq_test.spec.js',
                        (update) => broadcast({ ...update, analyzeId })
                    );

                    groqResult.executionResults = executionResults;
                }

                // Send complete result
                broadcast({
                    type: 'groq-analysis-complete',
                    analyzeId,
                    url,
                    result: groqResult,
                    message: `\u2705 Groq AI analysis complete for ${url}`,
                });

            } catch (err) {
                console.error('\u274C Groq analysis failed:', err.message);
                broadcast({
                    type: 'groq-analysis-error',
                    analyzeId,
                    error: err.message,
                    message: `\u274C Groq analysis failed: ${err.message}`,
                });
            } finally {
                if (browser) await browser.close();
            }
        })();
    } catch (error) {
        console.error('\u274C Groq route error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
