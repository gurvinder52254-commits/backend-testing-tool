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

        // Content Analysis
        const bodyText = document.body.innerText.trim();
        const words = bodyText.match(/\b[\w'-]+\b/g)?.length || 0;
        const sentences = bodyText.match(/[.!?]+/g)?.length || 0;
        const paragraphs = bodyText.split(/\n\s*\n/).filter(p => p.trim()).length;
        const characters = bodyText.length;
        const charactersNoSpaces = bodyText.replace(/\s/g, "").length;
        const readingTime = (words / 200).toFixed(1);
        const speakingTime = (words / 130).toFixed(1);
        const avgWordsPerSentence = sentences ? (words / sentences).toFixed(1) : 0;

        // Image Analysis
        const images = q('img');
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

        const lazyImages = images.filter(img => img.getAttribute('loading') === "lazy" || img.loading === "lazy").length;
        const imagesWithoutSize = images.filter(img => !img.width || !img.height).length;

        // Link Analysis
        const brokenLinks = [];
        const links = q('a');
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

        const internalLinks = links.filter(link => link.hostname === location.hostname).length;
        const externalLinks = links.filter(link => link.hostname !== location.hostname).length;
        const emptyLinks = links.filter(link => link.getAttribute("href") === "#" || !link.textContent.trim()).length;
        const javascriptLinks = links.filter(link => (link.href || "").startsWith("javascript:")).length;
        const mailtoLinks = links.filter(link => (link.href || "").startsWith("mailto:")).length;
        const telLinks = links.filter(link => (link.href || "").startsWith("tel:")).length;

        // Headings
        const h1 = q("h1").length;
        const h2 = q("h2").length;
        const h3 = q("h3").length;
        const h4 = q("h4").length;
        const h5 = q("h5").length;
        const h6 = q("h6").length;

        // Structure
        const buttons = q("button").length;
        const forms = document.forms.length;
        const inputs = q("input").length;
        const textareas = q("textarea").length;
        const selects = q("select").length;
        const tables = q("table").length;
        const lists = q("ul,ol").length;
        const listItems = q("li").length;
        const videos = q("video").length;
        const audio = q("audio").length;
        const iframes = q("iframe").length;
        const codeBlocks = q("pre,code").length;
        const blockquotes = q("blockquote").length;
        const canvas = q("canvas").length;
        const svg = q("svg").length;

        // Assets
        const scripts = document.scripts.length;
        const cssFiles = q('link[rel="stylesheet"]').length;
        const styleTags = q("style").length;
        const styleBundles = cssFiles + styleTags;

        // Meta
        const title = document.title || "";
        const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
        const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
        const robots = document.querySelector('meta[name="robots"]')?.content || "";

        // DOM
        const domElements = q("*").length;

        return {
          seo: {
            title: document.title || '',
            titleLength: (document.title || '').length,
            description: metaDescription,
            hasCanonical: !!canonical,
            h1Count: h1,
            viewport: !!document.querySelector('meta[name="viewport"]'),
          },
          counts: {
            images: images.length,
            links: links.length,
            h1: h1,
            forms: forms,
            duplicateImages: totalDuplicateImages,
            duplicateLinks: totalDuplicateLinks,
            missingSrc: exactMissingSrc,
            missingAlt: exactMissingAlt,
            scripts: scripts,
            styles: styleBundles,
            buttons: buttons
          },
          structureStats: {
            words,
            sentences,
            paragraphs,
            characters,
            charactersNoSpaces,
            estimatedPages: Math.ceil(words / 500),
            readingTime,
            speakingTime,
            avgWordsPerSentence,
            h1, h2, h3, h4, h5, h6,
            images: images.length,
            missingSrc: exactMissingSrc,
            missingAlt: exactMissingAlt,
            duplicateImages: totalDuplicateImages,
            lazyLoadedImages: lazyImages,
            imagesWithoutSize,
            totalLinks: links.length,
            internalLinks,
            externalLinks,
            emptyLinks,
            duplicateLinks: totalDuplicateLinks,
            javascriptLinks,
            mailtoLinks,
            telLinks,
            buttons,
            forms,
            inputs,
            textareas,
            selects,
            tables,
            lists,
            listItems,
            videos,
            audio,
            iframes,
            codeBlocks,
            blockquotes,
            canvas,
            svg,
            jsScripts: scripts,
            cssFiles,
            styleTags,
            styleBundles,
            titleLength: title.length,
            metaDescriptionLength: metaDescription.length,
            canonical: canonical ? "Yes" : "No",
            robotsMeta: robots || "Missing",
            domElements
          }
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
