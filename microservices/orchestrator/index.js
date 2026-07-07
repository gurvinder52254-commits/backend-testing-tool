/**
 * ============================================================
 * microservices/orchestrator — Scan Orchestrator
 * ============================================================
 * Owns the scan LIFECYCLE boundaries:
 *
 *   scan     → mark running, kick off a `discovery` job.
 *   finalize → read every page result, assemble the final report
 *              (same shape the monolith produces), persist it to
 *              the SAME `reports` table (so it shows up in the
 *              existing dashboard), and emit `test-complete`.
 *
 * The heavy fan-out (page jobs) lives in the worker; the
 * orchestrator only coordinates start and finish via durable
 * Postgres state — no in-memory scan state anywhere.
 * ============================================================
 */

const http = require('http');

const config = require('../shared/config');
const { createLogger } = require('../shared/logger');
const queue = require('../shared/queue');
const scanStore = require('../shared/scanStore');
const { emitEvent, EventType } = require('../shared/events');
const Report = require('../../models/Report');

const log = createLogger('orchestrator');

// ---- scan handler: start + delegate discovery ----
async function handleScan(data) {
  const { testId, userId, frontendUrl } = data;
  log.info(`Scan started: ${testId} (${frontendUrl})`);

  await scanStore.setStatus(testId, 'running');
  await emitEvent({ testId, userId, type: EventType.SCAN_STARTED, payload: { frontendUrl } });

  await queue.send(config.queues.discovery, {
    testId,
    userId,
    frontendUrl,
    userDetails: data.userDetails,
    urls: data.urls,
  });
}

// ---- aggregate per-page results into the report shape ----
function buildReport(progress, pages) {
  const elementStats = {
    totalImages: 0,
    totalLinks: 0,
    totalButtons: 0,
    totalMissingAlt: 0,
    totalMissingSrc: 0,
    totalDuplicateImages: 0,
  };
  const seoIssues = [];
  let totalErrors = 0;

  for (const p of pages) {
    totalErrors += (p.consoleErrors?.length || 0) + (p.networkErrors?.length || 0);
    const counts = p.elementsInfo?.counts;
    if (counts) {
      elementStats.totalImages += counts.totalImages || 0;
      elementStats.totalLinks += counts.totalLinks || 0;
      elementStats.totalButtons += counts.totalButtons || 0;
      elementStats.totalMissingAlt += counts.totalMissingAlt || 0;
      elementStats.totalMissingSrc += counts.totalMissingSrc || 0;
    }
    const seo = p.elementsInfo?.seo;
    if (seo) {
      if (!seo.description) seoIssues.push({ url: p.url, issue: 'Missing meta description' });
      if (seo.h1Count === 0) seoIssues.push({ url: p.url, issue: 'No H1 heading' });
      if (seo.h1Count > 1) seoIssues.push({ url: p.url, issue: `Multiple H1 headings (${seo.h1Count})` });
      if (!seo.hasCanonical) seoIssues.push({ url: p.url, issue: 'Missing canonical link' });
    }
  }

  const suggestedFixes = [];
  if (elementStats.totalMissingAlt > 0)
    suggestedFixes.push(`Add alt text to ${elementStats.totalMissingAlt} image(s).`);
  if (seoIssues.some((i) => i.issue.includes('description')))
    suggestedFixes.push('Add meta descriptions to pages that are missing them.');
  if (totalErrors > 0) suggestedFixes.push(`Investigate ${totalErrors} console/network error(s).`);

  const scored = pages
    .filter((p) => p.aiAnalysis && p.aiAnalysis.overallScore > 0)
    .map((p) => p.aiAnalysis.overallScore);
  const overallScore = scored.length
    ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
    : 0;

  return {
    testId: progress.testId,
    frontendUrl: progress.frontendUrl,
    backendUrl: progress.backendUrl || null,
    testDate: progress.testDate || new Date().toISOString(),
    totalPages: progress.totalPages || pages.length,
    pagesCompleted: pages.length,
    headerLinks: progress.headerLinks || [],
    footerLinks: progress.footerLinks || [],
    pages,
    overallScore,
    status: 'complete',
    globalSummary: {
      totalErrors,
      brokenLinks: [],
      missingResources: [],
      seoIssues,
      elementStats,
      suggestedFixes,
    },
  };
}

// ---- finalize handler: assemble + persist + announce ----
async function handleFinalize(data) {
  const { testId, userId } = data;
  const progress = await scanStore.getProgress(testId);
  if (!progress) {
    log.warn(`finalize: no progress row for ${testId}`);
    return;
  }
  const pages = await scanStore.getPages(testId);
  const report = buildReport(progress, pages);
  report.userId = progress.userId || userId;

  try {
    await Report.upsertReport({
      testId,
      userId: report.userId,
      frontendUrl: report.frontendUrl,
      backendUrl: report.backendUrl,
      testDate: report.testDate,
      overallScore: report.overallScore,
      totalPages: report.totalPages,
      status: 'complete',
      reportData: report,
    });
    log.ok(`Report saved for ${testId} (score ${report.overallScore}, ${pages.length} pages).`);
  } catch (err) {
    log.error(`Failed to save report ${testId}:`, err.message);
  }

  await scanStore.setStatus(testId, 'complete');
  await emitEvent({
    testId,
    userId: report.userId,
    type: EventType.TEST_COMPLETE,
    payload: {
      overallScore: report.overallScore,
      totalPages: report.totalPages,
      pagesCompleted: report.pagesCompleted,
    },
  });
}

function startHealthServer() {
  http
    .createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, service: 'orchestrator' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(config.ports.orchestratorHealth, () =>
      log.info(`Health on http://127.0.0.1:${config.ports.orchestratorHealth}/health`)
    );
}

async function start() {
  await queue.work(config.queues.scan, { concurrency: config.concurrency.scan }, handleScan);
  await queue.work(config.queues.finalize, { concurrency: config.concurrency.finalize }, handleFinalize);
  startHealthServer();
  log.ok('Orchestrator ready (scan + finalize consumers running).');

  const shutdown = async () => {
    log.info('Shutting down orchestrator...');
    await queue.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((err) => {
    log.error('Orchestrator failed to start:', err);
    process.exit(1);
  });
}

module.exports = { start, buildReport };
