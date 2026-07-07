/**
 * ============================================================
 * microservices/worker/pageTester.js — Per-page tester
 * ============================================================
 * A focused, self-contained per-page test. Unlike the monolith's
 * 1,400-line loop, this handles exactly ONE page and is driven by
 * the queue (one job = one page), which is what makes pages run
 * in parallel across workers.
 *
 * It reuses a single shared browser (passed in) and opens a fresh
 * context per page for isolation, always torn down in `finally`
 * (fixing the monolith's "one bad page poisons the rest" risk).
 *
 * Returns a page-result object shaped like the monolith's so the
 * existing report viewer / DB schema render it unchanged.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const config = require('../shared/config');
const { captureViewport } = require('./responsiveCapture');
const { PROFILES } = require('./devices');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function emptyResult(index, url) {
  return {
    index,
    url,
    title: '',
    text: '',
    source: 'body',
    loadStatus: 'UNKNOWN',
    loadTimeMs: 0,
    httpStatus: 0,
    screenshotUrl: '',
    screenshots: { desktop: null, mobile: null },
    consoleErrors: [],
    networkErrors: [],
    elementsInfo: {},
    brokenLinksCheck: [],
    imageCheckResults: [],
    videoCheckResults: [],
    aiAnalysis: null,
    groqAnalysis: null,
    error: null,
  };
}

/**
 * @param {import('playwright').Browser} browser  shared browser
 * @param {{testId, pageIndex, url, source, text}} job
 * @returns {Promise<object>} page result
 */
async function testPage(browser, { testId, pageIndex, url, source = 'body', text = '' }) {
  const result = emptyResult(pageIndex, url);
  result.source = source;
  result.text = text;

  let context;
  let page;
  try {
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();

    // --- listeners ---
    page.on('console', (msg) => {
      if (msg.type() === 'error') result.consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on('requestfailed', (req) => {
      const f = req.failure();
      result.networkErrors.push({
        url: req.url().slice(0, 300),
        error: (f && f.errorText) || 'failed',
      });
    });

    // --- navigation (with fallback) ---
    const started = Date.now();
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'load',
        timeout: config.limits.pageNavTimeoutMs,
      });
    } catch (_) {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.round(config.limits.pageNavTimeoutMs * 0.6),
      });
    }
    result.loadTimeMs = Date.now() - started;
    result.httpStatus = response ? response.status() : 0;
    result.loadStatus = result.httpStatus && result.httpStatus < 400 ? 'OK' : 'ERROR';

    // gentle scroll to trigger lazy content, then settle
    await page
      .evaluate(async () => {
        await new Promise((resolve) => {
          let y = 0;
          const step = () => {
            window.scrollBy(0, 600);
            y += 600;
            if (y >= document.body.scrollHeight || y > 12000) return resolve();
            setTimeout(step, 100);
          };
          step();
        });
      })
      .catch(() => {});
    await page.waitForTimeout(500);

    result.title = (await page.title().catch(() => '')) || '';

    // --- SEO + element inventory (single evaluate) ---
    result.elementsInfo = await page
      .evaluate(() => {
        const q = (sel) => Array.from(document.querySelectorAll(sel));
        const images = q('img');
        const links = q('a[href]');
        const buttons = q('button, [role="button"], input[type="submit"]');
        const metaDesc = document.querySelector('meta[name="description"]');
        const canonical = document.querySelector('link[rel="canonical"]');
        const h1s = q('h1');

        const missingAlt = images.filter((i) => !i.getAttribute('alt')).length;
        const missingSrc = images.filter((i) => !i.getAttribute('src')).length;
        const placeholderLinks = links.filter((a) => {
          const h = a.getAttribute('href');
          return !h || h === '#' || h.trim() === '';
        }).length;

        return {
          seo: {
            title: document.title || '',
            titleLength: (document.title || '').length,
            description: metaDesc ? metaDesc.getAttribute('content') || '' : '',
            hasCanonical: !!canonical,
            h1Count: h1s.length,
            viewport: !!document.querySelector('meta[name="viewport"]'),
          },
          counts: {
            totalImages: images.length,
            totalLinks: links.length,
            totalButtons: buttons.length,
            totalMissingAlt: missingAlt,
            totalMissingSrc: missingSrc,
            placeholderLinks,
          },
        };
      })
      .catch(() => ({}));

    // --- DESKTOP screenshot (reuses this context; timeout-guarded) ---
    try {
      const dir = path.join(config.reportsDir, testId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filename = `page_${pageIndex}_desktop.png`;
      const filePath = path.join(dir, filename);
      await page.screenshot({ path: filePath, fullPage: true, timeout: 20000 });
      result.desktopPath = filePath;
      result.screenshotPath = filePath; // kept for AI (desktop) + backward compat
      result.screenshotUrl = `/api/screenshots/${testId}/${filename}`;
      result.screenshots.desktop = {
        url: result.screenshotUrl,
        viewport: PROFILES.desktop.viewport,
      };
    } catch (err) {
      result.error = `desktop screenshot failed: ${err.message}`;
    }

    // --- MOBILE screenshot (separate emulated context; non-fatal) ---
    try {
      const mobileShot = await captureViewport(browser, PROFILES.mobile, {
        url,
        testId,
        pageIndex,
        reportsDir: config.reportsDir,
      });
      result.mobilePath = mobileShot.path;
      result.screenshots.mobile = { url: mobileShot.url, viewport: mobileShot.viewport };
    } catch (err) {
      // Desktop result stays valid even if the mobile shot fails.
    }

    return result;
  } catch (err) {
    result.loadStatus = 'ERROR';
    result.error = err.message;
    return result;
  } finally {
    // Always tear down — a crashed/hung page can never affect the next job.
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

module.exports = { testPage };
