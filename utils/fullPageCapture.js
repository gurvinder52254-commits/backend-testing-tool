/**
 * ============================================================
 * utils/fullPageCapture.js — Stitched full-page screenshot
 * ============================================================
 * Playwright's `fullPage: true` captures the whole page from a
 * single scroll position, which leaves BLANK gaps on pages with
 * lazy-loaded / scroll-animated sections.
 *
 * This captures the page in viewport-sized BITS and stitches them
 * into one tall PNG, so every section is captured while visible.
 *
 * Correctness guarantees (why the footer no longer repeats):
 *  - It scrolls by one viewport at a time and reads back the
 *    ACTUAL scroll offset. The moment scrolling stops advancing
 *    (page bottom reached, or the page is shorter than a measured
 *    scrollHeight), capture STOPS — so the bottom/footer is never
 *    captured more than once.
 *  - Each segment is placed at its ACTUAL scroll offset, so the
 *    stitched image is exactly as tall as the real content.
 *  - Fixed / sticky overlays (cookie banners, chat widgets,
 *    sticky headers) are hidden after the first segment, so they
 *    appear once instead of repeating in every segment.
 *
 * Pure-JS stitching via `pngjs` (no native build). Always falls
 * back to a normal fullPage screenshot on any error — capture
 * must never break a scan.
 * ============================================================
 */

const fs = require('fs');
const { PNG } = require('pngjs');

const DEFAULTS = {
  maxSegments: 80, // hard stop (also guards infinite-scroll pages)
  settleMs: 320, // wait after each scroll for lazy/animated content
  hardDeviceMax: 80000, // absolute cap on output image pixel height
};

async function captureFullPage(page, outPath, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  try {
    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    const viewHeight = await page.evaluate(() => window.innerHeight) || 800;

    // Disable smooth scrolling so scroll offsets settle immediately.
    await page.addStyleTag({ content: 'html,body{scroll-behavior:auto !important}' }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(opts.settleMs);

    const segments = [];
    let prevActual = -1;
    let target = 0;
    let hid = false;

    for (let i = 0; i < opts.maxSegments; i++) {
      // scrollTo a concrete target (reliable), then read the ACTUAL offset —
      // which clamps at the real bottom even if scrollHeight is inflated.
      await page.evaluate((t) => window.scrollTo(0, t), target);
      await page.waitForTimeout(opts.settleMs);
      const actualY = await page.evaluate(
        () => window.pageYOffset || document.documentElement.scrollTop || 0
      );

      // Didn't advance past the previous shot → we've reached the real bottom.
      if (actualY <= prevActual) break;

      // After the first (top) segment, hide fixed/sticky overlays so they
      // don't repeat in every segment. visibility:hidden keeps layout intact.
      if (i >= 1 && !hid) {
        await page.evaluate(() => {
          window.__hiddenFixed = [];
          for (const el of document.querySelectorAll('body *')) {
            const p = getComputedStyle(el).position;
            if (p === 'fixed' || p === 'sticky') {
              window.__hiddenFixed.push([el, el.style.visibility]);
              el.style.visibility = 'hidden';
            }
          }
        });
        hid = true;
      }

      const buf = await page.screenshot({ type: 'png' });
      segments.push({ y: actualY, png: PNG.sync.read(buf) });
      prevActual = actualY;

      // Safety height cap.
      if ((actualY + viewHeight) * dpr >= opts.hardDeviceMax) break;

      target = actualY + viewHeight;
    }

    // Restore hidden overlays + reset scroll.
    await page
      .evaluate(() => {
        (window.__hiddenFixed || []).forEach(([el, v]) => (el.style.visibility = v));
        window.__hiddenFixed = null;
      })
      .catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // 0 or 1 segment → the page fits (about) one screen; a plain fullPage is correct.
    if (segments.length <= 1) {
      await page.screenshot({ path: outPath, fullPage: true, timeout: 30000 });
      return { stitched: false, segments: segments.length };
    }

    // Stitch using the ACTUAL scroll offsets.
    const width = segments[0].png.width;
    const height = Math.min(
      Math.max(...segments.map((s) => Math.round(s.y * dpr) + s.png.height)),
      opts.hardDeviceMax
    );
    const out = new PNG({ width, height });
    const rowBytes = width * 4;

    for (const { y, png } of segments) {
      const dy = Math.round(y * dpr);
      const copyH = Math.min(png.height, height - dy);
      if (copyH <= 0) continue;
      const srcRowBytes = png.width * 4;
      const n = Math.min(rowBytes, srcRowBytes);
      for (let row = 0; row < copyH; row++) {
        png.data.copy(out.data, (dy + row) * rowBytes, row * srcRowBytes, row * srcRowBytes + n);
      }
    }

    fs.writeFileSync(outPath, PNG.sync.write(out));
    return { stitched: true, segments: segments.length, width, height };
  } catch (err) {
    // Never fail the scan because of screenshotting.
    try {
      await page.evaluate(() => {
        (window.__hiddenFixed || []).forEach(([el, v]) => (el.style.visibility = v));
        window.__hiddenFixed = null;
        window.scrollTo(0, 0);
      }).catch(() => {});
      await page.screenshot({ path: outPath, fullPage: true, timeout: 30000 });
    } catch (_) {}
    return { stitched: false, error: err.message };
  }
}

module.exports = { captureFullPage };
