/**
 * ============================================================
 * controllers/reportController.js - Scan Testing Controllers
 * ============================================================
 */

const { runWebsiteTest } = require('../playwrightTester');
const { runGroqAnalysisPipeline } = require('../groqAnalyzer');
const { executeGroqTests } = require('../groqTestRunner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const Report = require('../models/Report');

// Active/completed in-memory tests store
const activeTests = new Map();

/**
 * Health check endpoint
 */
function getHealth(req, res) {
  res.json({
    success: true,
    status: 'Server is running ✅',
    timestamp: new Date().toISOString(),
    service: 'Website Testing Platform v2.0',
    activeTests: activeTests.size,
  });
}

/**
 * Get live progress of an active test
 */
function getLiveTestStatus(req, res) {
  const { testId } = req.params;
  const test = activeTests.get(testId);

  if (!test) {
    return res.status(404).json({ success: false, error: 'Test not found' });
  }

  res.json({ success: true, ...test });
}

/**
 * Starts website scan test (asynchronous background worker)
 */
async function startTest(req, res) {
  try {
    const userId = req.userId;
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

    // Return immediately to the client
    res.json({
      success: true,
      testId,
      message: 'Test started. Connect to WebSocket for live updates.',
    });

    // Store test status with userId in memory
    activeTests.set(testId, { status: 'running', startTime: Date.now(), userId });

    // Run Playwright scan test in background
    try {
      const report = await runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userDetails, (update) => {
        broadcast({ ...update, testId });
      });

      // Save report to PostgreSQL
      if (report) {
        report.userId = userId;

        // Save to PostgreSQL using Report model
        try {
          await Report.upsertReport({
            testId,
            userId,
            frontendUrl: report.frontendUrl || frontendUrl,
            backendUrl: report.backendUrl || backendUrl || null,
            testDate: report.testDate || new Date().toISOString(),
            overallScore: report.overallScore || 0,
            totalPages: report.totalPages || 0,
            status: report.status || 'complete',
            reportData: report
          });
          console.log(`💾 [${testId}] Report saved to PostgreSQL database.`);
        } catch (dbErr) {
          console.error('⚠️ Failed to save report to PostgreSQL:', dbErr.message);
        }
      }

      activeTests.set(testId, { status: 'complete', report, endTime: Date.now(), userId });
    } catch (err) {
      activeTests.set(testId, { status: 'error', error: err.message, endTime: Date.now(), userId });
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
}

/**
 * List all scan reports for the authenticated user
 */
async function getReports(req, res) {
  const userId = req.userId;

  // Try to load reports from PostgreSQL database first
  try {
    const dbReports = await Report.findByUserId(userId);
    if (dbReports) {
      console.log(`📂 Loaded ${dbReports.length} reports from PostgreSQL database.`);
      return res.json({ success: true, totalReports: dbReports.length, reports: dbReports });
    }
  } catch (dbErr) {
    console.warn('⚠️ PostgreSQL reports fetch failed. Falling back to local filesystem:', dbErr.message);
  }

  // Fallback: local reports directory
  const reportsDir = path.join(__dirname, '..', 'reports');
  try {
    if (!fs.existsSync(reportsDir)) {
      return res.json({ success: true, totalReports: 0, reports: [] });
    }
    const dirs = fs.readdirSync(reportsDir).filter((f) => {
      const stat = fs.statSync(path.join(reportsDir, f));
      return stat.isDirectory();
    });

    const reports = dirs
      .map((dir) => {
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
          userId: report?.userId || null,
          frontendUrl: report?.frontendUrl || 'N/A',
          testDate: report?.testDate || 'N/A',
          overallScore: report?.overallScore || 0,
          totalPages: report?.totalPages || 0,
          status: report?.status || 'unknown',
        };
      })
      .filter((r) => r.userId === userId);

    res.json({ success: true, totalReports: reports.length, reports });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Get detailed individual report
 */
async function getReport(req, res) {
  const { testId } = req.params;
  const userId = req.userId;

  // Try loading from PostgreSQL database first
  try {
    const dbReport = await Report.findById(testId, userId);
    if (dbReport) {
      console.log(`📂 Loaded report [${testId}] from PostgreSQL database.`);
      return res.json({ success: true, report: dbReport });
    }
  } catch (dbErr) {
    console.warn(`⚠️ PostgreSQL fetch for report [${testId}] failed. Falling back to local filesystem:`, dbErr.message);
  }

  // Fallback: local reports directory
  const reportPath = path.join(__dirname, '..', 'reports', testId, 'report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ success: false, error: 'Report not found' });
  }

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (report.userId && report.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Access denied. This report belongs to another user.' });
    }
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to read report: ' + error.message });
  }
}

/**
 * legacy /api/test - synchronous scan endpoint
 */
async function testLegacy(req, res) {
  try {
    let { url, frontendUrl } = req.body;
    const targetUrl = frontendUrl || url;

    if (!targetUrl) {
      return res.status(400).json({ success: false, error: 'URL is required.' });
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
}

/**
 * POST /api/groq-analyze
 */
async function groqAnalyze(req, res) {
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

    console.log(`\n🧠 Groq analysis request: ${url} [ID: ${analyzeId}]`);

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
        broadcast({
          type: 'groq-status',
          analyzeId,
          step: 'screenshot',
          message: '📷 Taking screenshot of ' + url + '...',
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

        const screenshotDir = path.join(__dirname, '..', 'reports', 'groq_' + analyzeId);
        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }
        const screenshotPath = path.join(screenshotDir, 'screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });

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

        const groqResult = await runGroqAnalysisPipeline(
          screenshotPath, url, pageTitle, userDetails,
          (update) => broadcast({ ...update, analyzeId })
        );

        if (groqResult.playwrightCode && groqResult.playwrightCode.testCode) {
          broadcast({
            type: 'groq-status',
            analyzeId,
            step: 'test-execution',
            message: '🧪 Running AI-generated test cases...',
          });

          const executionResults = await executeGroqTests(
            groqResult.playwrightCode.testCode,
            url,
            groqResult.playwrightCode.testFileName || 'groq_test.spec.js',
            (update) => broadcast({ ...update, analyzeId })
          );

          groqResult.executionResults = executionResults;
        }

        broadcast({
          type: 'groq-analysis-complete',
          analyzeId,
          url,
          result: groqResult,
          message: `✅ Groq AI analysis complete for ${url}`,
        });

      } catch (err) {
        console.error('❌ Groq analysis failed:', err.message);
        broadcast({
          type: 'groq-analysis-error',
          analyzeId,
          error: err.message,
          message: `❌ Groq analysis failed: ${err.message}`,
        });
      } finally {
        if (browser) await browser.close();
      }
    })();
  } catch (error) {
    console.error('❌ Groq route error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = {
  getHealth,
  getLiveTestStatus,
  startTest,
  getReports,
  getReport,
  testLegacy,
  groqAnalyze
};
