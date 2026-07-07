/**
 * ============================================================
 * microservices/worker/responsiveCapture.js
 * ============================================================
 * Captures a single full-page screenshot for a given device
 * profile, in its own isolated browser context (always closed).
 * Used to add the MOBILE screenshot alongside the desktop one
 * the page tester already produces.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const config = require('../shared/config');

async function autoScroll(page) {
  // Trigger lazy-loaded images/content before the full-page shot.
  await page
    .evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 600);
          y += 600;
          if (y >= document.body.scrollHeight || y > 12000) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    })
    .catch(() => {});
}

/**
 * Capture one viewport. Returns { path, url, viewport } or throws.
 * @param {import('playwright').Browser} browser
 * @param {object} profile  a PROFILES entry (name, viewport, ua, isMobile, ...)
 * @param {{url, testId, pageIndex, reportsDir?}} opts
 */
async function captureViewport(browser, profile, { url, testId, pageIndex, reportsDir }) {
  const dir = path.join(reportsDir || config.reportsDir, testId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const context = await browser.newContext({
    viewport: profile.viewport,
    userAgent: profile.userAgent,
    deviceScaleFactor: profile.deviceScaleFactor || 1,
    isMobile: !!profile.isMobile,
    hasTouch: !!profile.hasTouch,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    await page
      .goto(url, { waitUntil: 'load', timeout: config.limits.pageNavTimeoutMs })
      .catch(() =>
        page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.round(config.limits.pageNavTimeoutMs * 0.6),
        })
      );
    await autoScroll(page);
    await page.waitForTimeout(400);

    const filename = `page_${pageIndex}_${profile.name}.png`;
    const filePath = path.join(dir, filename);
    await page.screenshot({ path: filePath, fullPage: true, timeout: 20000 });

    return {
      path: filePath,
      url: `/api/screenshots/${testId}/${filename}`,
      viewport: profile.viewport,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = { captureViewport, autoScroll };
