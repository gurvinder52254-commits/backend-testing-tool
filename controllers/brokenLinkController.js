/**
 * ============================================================
 * controllers/brokenLinkController.js — Scan Page for Broken Links
 * ============================================================
 * Standalone, on-demand broken-link scanner for a single page.
 *   POST /api/scan-page   body: { url }
 * Loads the page in a headless browser, extracts every <a href>,
 * checks each link's HTTP status, and returns the total count and
 * the list of broken links (url, text, status, reason).
 *
 * Self-contained (launches its own browser) — does not touch or
 * change the existing scan engine / reports flow.
 * ============================================================
 */

'use strict';

const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_LINKS = 300;   // safety cap on links checked per scan
const CONCURRENCY = 8;   // parallel status checks
const LINK_TIMEOUT = 15000;

async function scanBrokenLinks(req, res) {
  let { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'A "url" is required.' });
  }
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format.' });
  }

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ userAgent: USER_AGENT, ignoreHTTPSErrors: true });
    const page = await context.newPage();

    console.log(`🔗 [Scan Page] Loading ${url}`);
    await page
      .goto(url, { waitUntil: 'load', timeout: 35000 })
      .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }));
    await page.waitForTimeout(1000);

    // Extract unique, absolute http(s) links (skip #, mailto, tel, javascript, data)
    let links = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const raw = a.getAttribute('href') || '';
        if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) return;
        let abs;
        try { abs = new URL(raw, location.href).href; } catch { return; }
        if (!/^https?:/i.test(abs)) return;
        const norm = abs.split('#')[0];
        if (seen.has(norm)) return;
        seen.add(norm);
        out.push({ url: abs, text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) });
      });
      return out;
    });

    const totalLinks = links.length;
    const capped = totalLinks > MAX_LINKS;
    if (capped) links = links.slice(0, MAX_LINKS);

    // Check each link's status with bounded concurrency
    const reqCtx = context.request;
    const broken = [];
    let cursor = 0;
    async function worker() {
      while (cursor < links.length) {
        const link = links[cursor++];
        let status = 0;
        let statusText = '';
        let reason = '';
        try {
          const r = await reqCtx.get(link.url, { timeout: LINK_TIMEOUT, maxRedirects: 5, failOnStatusCode: false });
          status = r.status();
          statusText = r.statusText() || '';
          if (status >= 400) reason = `HTTP ${status}${statusText ? ' ' + statusText : ''}`;
        } catch (e) {
          status = 0;
          reason = String(e && e.message ? e.message : 'Request failed').split('\n')[0].slice(0, 160);
        }
        if (status === 0 || status >= 400) {
          broken.push({ url: link.url, text: link.text, status, statusText, reason });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length) }, worker));

    // Worst first
    broken.sort((a, b) => (b.status || 999) - (a.status || 999));

    console.log(`🔗 [Scan Page] ${broken.length} broken / ${links.length} checked for ${url}`);
    return res.json({
      success: true,
      url,
      totalLinks,
      checkedLinks: links.length,
      capped,
      brokenCount: broken.length,
      brokenLinks: broken,
    });
  } catch (err) {
    console.error('❌ [Scan Page] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { scanBrokenLinks };
