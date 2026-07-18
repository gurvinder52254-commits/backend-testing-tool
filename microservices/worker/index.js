/**
 * ============================================================
 * microservices/worker — DROP-IN Scan Worker
 * ============================================================
 * Consumes `scan` jobs from the durable queue and runs the FULL
 * monolith engine (runWebsiteTest) — so functionality is
 * identical to the monolith (crawl, SEO, images, videos,
 * broken links, Groq tests, desktop+mobile screenshots, live
 * previews, scoring, everything).
 *
 * Every engine event is:
 *   1) POSTed to the gateway's /internal/broadcast → WS fan-out
 *      (same events the frontend already understands), and
 *   2) folded into an incremental report that is upserted to
 *      Postgres — exactly like the monolith controller did.
 * ============================================================
 */

const http = require('http');

const config = require('../shared/config'); // loads dotenv FIRST
const { createLogger } = require('../shared/logger');
const queue = require('../shared/queue');
const scanStore = require('../shared/scanStore');
const { runWebsiteTest } = require('../../playwrightTester');
const Report = require('../../models/Report');

const log = createLogger('worker');

// Forward one engine event to the gateway for WS broadcast (order-preserving).
async function postEvent(update) {
  try {
    await fetch(config.internalBroadcastUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
  } catch (_) {
    // Gateway unreachable — non-fatal; the scan + DB save still proceed.
  }
}

function freshReport(testId, frontendUrl, backendUrl) {
  return {
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
    globalSummary: {
      totalErrors: 0,
      brokenLinks: [],
      missingResources: [],
      seoIssues: [],
      elementStats: {
        totalImages: 0, totalLinks: 0, totalButtons: 0,
        totalMissingAlt: 0, totalMissingSrc: 0, totalDuplicateImages: 0,
      },
      suggestedFixes: [],
    },
  };
}

async function handleScan(data) {
  const { testId, userId, frontendUrl, backendUrl, scanType, userDetails, urls } = data;
  log.info(`Running scan ${testId} → ${frontendUrl}`);
  await scanStore.setStatus(testId, 'running');

  const rep = freshReport(testId, frontendUrl, backendUrl);

  // Initialize report immediately in the database to prevent null state on page reload
  try {
    await Report.upsertReport({
      testId, userId, frontendUrl, backendUrl: backendUrl || null,
      testDate: rep.testDate, overallScore: rep.overallScore,
      totalPages: rep.totalPages, status: 'running', reportData: rep,
    });
  } catch (dbInitErr) {
    log.warn('⚠️ Failed to initialize report in database:', dbInitErr.message);
  }

  const onUpdate = async (update) => {
    // 1) live event → gateway WS
    postEvent({ ...update, testId });

    // 2) incremental persistence (same logic as the monolith controller)
    try {
      // Accumulate logs in memory for restoration on refresh
      if (!rep.statusLogs) rep.statusLogs = [];
      const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
      const logType = update.type === 'page-error' || update.type === 'test-error' ? 'error' :
                      (update.type === 'ai-analyzing' || update.type === 'groq-status' ? 'ai' : 
                       (update.type === 'page-complete' || update.type === 'test-complete' ? 'success' : 'info'));
      
      let logMessage = '';
      if (update.message) {
        logMessage = update.message;
      } else if (update.type === 'links-discovered') {
        logMessage = `Discovered ${update.totalPages} pages (${update.headerLinks} header, ${update.footerLinks} footer)`;
      } else if (update.type === 'page-start') {
        logMessage = `Testing page ${update.pageIndex + 1}/${update.totalPages}: ${update.text || update.url}`;
      } else if (update.type === 'screenshot-taken') {
        logMessage = `📸 Screenshot captured: ${update.url}`;
      } else if (update.type === 'ai-analyzing') {
        logMessage = `🤖 AI analyzing page ${update.pageIndex + 1}...`;
      } else if (update.type === 'ai-complete') {
        logMessage = `✅ AI analysis complete for page ${update.pageIndex + 1}`;
      }

      if (logMessage) {
        rep.statusLogs.push({
          id: rep.statusLogs.length + 1,
          message: logMessage,
          type: logType,
          time
        });
      }

      if (update.type === 'live-screenshot') {
        rep.latestLiveScreenshot = `data:image/png;base64,${update.image}`;
        rep.latestLiveUrl = update.url;
      }

      if (update.type === 'links-discovered') {
        rep.totalPages = update.totalPages;
        rep.headerLinks = update.headerLinks || [];
        rep.footerLinks = update.footerLinks || [];
      } else if (update.type === 'page-complete') {
        rep.pagesCompleted = update.pageIndex + 1;
        const result = update.result || {};
        const pageData = {
          index: update.pageIndex,
          url: result.url,
          title: result.title,
          text: result.title || '',
          source: result.source || 'body',
          loadStatus: result.loadStatus,
          loadTimeMs: result.loadTimeMs || 0,
          httpStatus: result.httpStatus || 200,
          screenshotUrl: result.screenshotUrl,
          desktopScreenshotUrl: result.desktopScreenshotUrl || result.screenshotUrl,
          mobileScreenshotUrl: result.mobileScreenshotUrl || '',
          indexStatus: result.indexStatus || 'unknown',
          robots: result.robots || null,
          consoleErrors: result.consoleErrors || [],
          networkErrors: result.networkErrors || [],
          // ✅ FIX: networkLog was missing — Network Activity was not showing in new scans
          networkLog: result.networkLog || { requests: [], summary: { totalRequests: 0, totalSize: 0, totalTransferred: 0, domContentLoaded: 0, loadTime: 0, finishTime: 0 } },
          elementsInfo: result.elementsInfo || {},
          brokenLinksCheck: result.brokenLinksCheck || [],
          imageCheckResults: result.imageCheckResults || [],
          videoCheckResults: result.videoCheckResults || [],
          aiAnalysis: result.aiAnalysis,
          groqAnalysis: result.groqAnalysis,
          error: result.error || null,
        };
        const idx = rep.pages.findIndex((p) => p.url === result.url);
        if (idx >= 0) rep.pages[idx] = pageData;
        else rep.pages.push(pageData);

        rep.globalSummary.totalErrors = rep.pages.reduce(
          (s, p) => s + p.consoleErrors.length + p.networkErrors.length, 0
        );
        const scores = rep.pages
          .filter((p) => p.aiAnalysis && p.aiAnalysis.overallScore > 0)
          .map((p) => p.aiAnalysis.overallScore);
        rep.overallScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      } else if (update.type === 'page-error') {
        rep.pagesCompleted = update.pageIndex + 1;
        const pageData = {
          index: update.pageIndex, url: update.url, title: 'Error', text: 'Error',
          source: 'error', loadStatus: 'ERROR', loadTimeMs: 0, httpStatus: 500,
          screenshotUrl: '', desktopScreenshotUrl: '', mobileScreenshotUrl: '',
          consoleErrors: [], networkErrors: [], elementsInfo: {},
          brokenLinksCheck: [], imageCheckResults: [], videoCheckResults: [],
          error: update.error,
        };
        const idx = rep.pages.findIndex((p) => p.url === update.url);
        if (idx >= 0) rep.pages[idx] = pageData;
        else rep.pages.push(pageData);
      }

      // Save incremental report on every update
      await Report.upsertReport({
        testId, userId, frontendUrl, backendUrl: backendUrl || null,
        testDate: rep.testDate, overallScore: rep.overallScore,
        totalPages: rep.totalPages, status: 'running', reportData: rep,
      });
    } catch (dbErr) {
      log.warn('Incremental save failed:', dbErr.message);
    }
  };

  try {
    const report = await runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userId, userDetails, onUpdate, urls);
    if (report) {
      report.userId = userId;
      await Report.upsertReport({
        testId, userId,
        frontendUrl: report.frontendUrl || frontendUrl,
        backendUrl: report.backendUrl || backendUrl || null,
        testDate: report.testDate || new Date().toISOString(),
        overallScore: report.overallScore || 0,
        totalPages: report.totalPages || 0,
        status: report.status || 'complete',
        reportData: report,
      });
    }
    await scanStore.setStatus(testId, 'complete');
    log.ok(`Scan ${testId} complete (score ${report?.overallScore ?? 0}).`);
  } catch (err) {
    log.error(`Scan ${testId} failed:`, err.message);
    await scanStore.setStatus(testId, 'error', err.message);
    postEvent({ type: 'test-error', testId, error: err.message });
  }
}

function startHealthServer() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, service: 'worker' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  // The health endpoint is optional — a port clash must NOT crash the worker.
  srv.on('error', (err) => {
    log.warn(`Health server not started on ${config.ports.workerHealth} (${err.code}); worker still running.`);
  });
  srv.listen(config.ports.workerHealth, () =>
    log.info(`Health on http://127.0.0.1:${config.ports.workerHealth}/health`)
  );
}

async function start() {
  // One scan at a time per worker by default (each scan runs a full browser).
  await queue.work(config.queues.scan, { concurrency: config.concurrency.scan }, handleScan);
  startHealthServer();
  log.ok('Drop-in worker ready (scan consumer running — full runWebsiteTest engine).');

  const shutdown = async () => {
    log.info('Shutting down worker...');
    await queue.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((err) => {
    log.error('Worker failed to start:', err);
    process.exit(1);
  });
}

module.exports = { start };
