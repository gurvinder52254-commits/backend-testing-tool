/**
 * ============================================================
 * microservices/worker — Crawler + Page-Tester Worker
 * ============================================================
 * The heavy, browser-bound service. Consumes two queues:
 *
 *   discovery  → crawl the site, cap to maxPages, record the URL
 *                set, then fan OUT one `page-test` job per URL.
 *   page-test  → test a single page, ask the AI service to score
 *                it, persist the result, and when the LAST page
 *                of a scan finishes, enqueue `finalize`.
 *
 * One shared Chromium is reused across page jobs; each page gets
 * its own context (isolation) that is always closed. Page-level
 * parallelism = MS_PAGE_CONCURRENCY.
 * ============================================================
 */

const http = require('http');
const { chromium } = require('playwright');

const config = require('../shared/config');
const { createLogger } = require('../shared/logger');
const queue = require('../shared/queue');
const scanStore = require('../shared/scanStore');
const { emitEvent, EventType } = require('../shared/events');
const { discover } = require('./crawler');
const { testPage } = require('./pageTester');

const log = createLogger('worker');

// ---- shared browser lifecycle ----
let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
  });
  log.ok('Chromium launched.');
  return browser;
}

// ---- best-effort call to the AI service (never throws) ----
async function requestAiAnalysis(payload) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), config.limits.aiTimeoutMs + 5000);
    const res = await fetch(`${config.urls.ai}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`AI service HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    log.warn('AI analysis unavailable (using defaults):', err.message);
    return { aiAnalysis: null, groqAnalysis: null };
  }
}

// best-effort call to the responsive (desktop+mobile) analysis endpoint
async function requestResponsiveAnalysis(payload) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), config.limits.aiTimeoutMs + 5000);
    const res = await fetch(`${config.urls.ai}/analyze-responsive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`AI service HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    log.warn('Responsive analysis unavailable:', err.message);
    return { responsiveAnalysis: null };
  }
}

// ---- discovery handler ----
async function handleDiscovery(data) {
  const { testId, userId, frontendUrl, userDetails, urls: providedUrls } = data;
  log.info(`Discovery for ${testId} → ${frontendUrl}`);

  let urls = [];
  let headerLinks = [];
  let footerLinks = [];

  if (Array.isArray(providedUrls) && providedUrls.length > 0) {
    // Explicit URL list supplied by the client — skip crawling.
    urls = providedUrls.map((u) =>
      typeof u === 'string' ? { url: u, text: '', source: 'body' } : u
    );
  } else {
    const found = await discover(frontendUrl);
    urls = found.urls;
    headerLinks = found.headerLinks;
    footerLinks = found.footerLinks;
  }

  // Safety cap — and log what we dropped (no silent truncation).
  const total = urls.length;
  if (total > config.limits.maxPages) {
    log.warn(`Capping ${total} pages → ${config.limits.maxPages} (MS_MAX_PAGES).`);
    urls = urls.slice(0, config.limits.maxPages);
  }

  await scanStore.setDiscovery(testId, {
    totalPages: urls.length,
    headerLinks,
    footerLinks,
  });
  await emitEvent({
    testId,
    userId,
    type: EventType.LINKS_DISCOVERED,
    payload: { totalPages: urls.length, headerLinks, footerLinks, cappedFrom: total },
  });

  if (urls.length === 0) {
    // Nothing to test — go straight to finalize.
    await queue.send(config.queues.finalize, { testId, userId });
    return;
  }

  // Fan out: one job per page.
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    await queue.send(config.queues.pageTest, {
      testId,
      userId,
      pageIndex: i,
      url: u.url,
      source: u.source || 'body',
      text: u.text || '',
      userDetails,
    });
  }
  log.ok(`Discovery ${testId}: enqueued ${urls.length} page jobs.`);
}

// ---- page-test handler ----
async function handlePageTest(data) {
  const { testId, userId, pageIndex, url, source, text, userDetails } = data;

  await emitEvent({
    testId,
    userId,
    type: EventType.PAGE_START,
    payload: { pageIndex, url },
  });

  const b = await getBrowser();
  const result = await testPage(b, { testId, pageIndex, url, source, text });

  // Enrich with AI (best-effort; page result already valid without it).
  if (result.screenshotPath) {
    const ai = await requestAiAnalysis({
      screenshotPath: result.screenshotPath,
      url,
      title: result.title,
      userDetails,
    });
    result.aiAnalysis = ai.aiAnalysis || null;
    result.groqAnalysis = ai.groqAnalysis || null;
  }

  // Responsive (desktop + mobile) analysis — both screenshots to AI in one call.
  if (result.desktopPath && result.mobilePath) {
    const r = await requestResponsiveAnalysis({
      desktopPath: result.desktopPath,
      mobilePath: result.mobilePath,
      url,
      title: result.title,
    });
    result.responsiveAnalysis = r.responsiveAnalysis || null;
    // Keep overall scoring working even if the single-shot analysis was skipped.
    if ((!result.aiAnalysis || !result.aiAnalysis.overallScore) && result.responsiveAnalysis) {
      result.aiAnalysis = {
        overallScore: result.responsiveAnalysis.overallScore || 0,
        summary: result.responsiveAnalysis.summary,
        source: 'responsive',
      };
    }
  }

  // internal-only fields; clients get the URLs via result.screenshots
  delete result.screenshotPath;
  delete result.desktopPath;
  delete result.mobilePath;

  await scanStore.savePage(testId, pageIndex, url, result);
  await emitEvent({
    testId,
    userId,
    type: result.error ? EventType.PAGE_ERROR : EventType.PAGE_COMPLETE,
    payload: { pageIndex, result },
  });

  // Was this the last page? If so, trigger finalization exactly once.
  const { completedPages, totalPages } = await scanStore.incrementCompleted(testId);
  log.info(`Page ${pageIndex} done for ${testId} (${completedPages}/${totalPages}).`);
  if (totalPages > 0 && completedPages >= totalPages) {
    await queue.send(config.queues.finalize, { testId, userId });
  }
}

// ---- health endpoint ----
function startHealthServer() {
  http
    .createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ success: true, service: 'worker', browser: !!(browser && browser.isConnected()) })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(config.ports.workerHealth, () =>
      log.info(`Health on http://127.0.0.1:${config.ports.workerHealth}/health`)
    );
}

async function start() {
  await queue.work(config.queues.discovery, { concurrency: config.concurrency.discovery }, handleDiscovery);
  await queue.work(config.queues.pageTest, { concurrency: config.concurrency.pageTest }, handlePageTest);
  startHealthServer();
  log.ok('Worker ready (discovery + page-test consumers running).');

  const shutdown = async () => {
    log.info('Shutting down worker...');
    try {
      if (browser) await browser.close();
    } catch (_) {}
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
