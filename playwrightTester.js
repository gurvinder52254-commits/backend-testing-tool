// /**
//  * ============================================================
//  * playwrightTester.js - Multi-Page Playwright Automation
//  * ============================================================
//  * Crawls entire website: extracts header/footer nav links,
//  * visits each page, takes screenshots, sends to Gemini AI,
//  * and broadcasts live progress via WebSocket callbacks.
//  * ============================================================
//  */

// const { chromium } = require('playwright');
// const path = require('path');
// const fs = require('fs');
// const { v4: uuidv4 } = require('uuid');
// const { analyzeScreenshot } = require('./geminiAnalyzer');
// const { runGroqAnalysisPipeline } = require('./groqAnalyzer');
// const { executeGroqTests } = require('./groqTestRunner');
// const fetch = require('node-fetch');

// const REPORTS_DIR = path.join(__dirname, 'reports');
// if (!fs.existsSync(REPORTS_DIR)) {
//     fs.mkdirSync(REPORTS_DIR, { recursive: true });
// }

// /**
//  * Main multi-page website test
//  * @param {string} testId - Unique test identifier
//  * @param {string} frontendUrl - Frontend domain to test
//  * @param {string} backendUrl - Backend domain (optional)
//  * @param {string} scanType - 'domain' or 'url'
//  * @param {object[]} userDetails - Key-value pair configs for testing
//  * @param {function} sendUpdate - Callback to send live updates
//  * @returns {object} Complete test report
//  */
// async function runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userDetails, sendUpdate) {
//     const testStartTime = Date.now();
//     const testDir = path.join(REPORTS_DIR, testId);
//     if (!fs.existsSync(testDir)) {
//         fs.mkdirSync(testDir, { recursive: true });
//     }

//     const report = {
//         testId,
//         frontendUrl,
//         backendUrl: backendUrl || null,
//         testDate: new Date().toISOString(),
//         totalPages: 0,
//         pagesCompleted: 0,
//         headerLinks: [],
//         footerLinks: [],
//         pages: [],
//         overallScore: 0,
//         status: 'running',
//         errorMessage: null,
//         testDurationMs: 0,
//         // Global summary for new features
//         globalSummary: {
//             totalErrors: 0,
//             brokenLinks: [],
//             missingResources: [],
//             seoIssues: [],
//             elementStats: {
//                 totalImages: 0,
//                 totalLinks: 0,
//                 totalButtons: 0,
//                 totalMissingAlt: 0,
//                 totalMissingSrc: 0,
//                 totalDuplicateImages: 0
//             },
//             suggestedFixes: []
//         }
//     };

//     let browser = null;

//     try {
//         // STEP 1: Launch Browser
//         sendUpdate({
//             type: 'status',
//             message: 'Launching browser...',
//             step: 'browser-launch',
//         });

//         browser = await chromium.launch({
//             headless: false,
//             slowMo: 300,
//             args: [
//                 '--no-sandbox',
//                 '--disable-setuid-sandbox',
//                 '--disable-dev-shm-usage',
//                 '--start-maximized',
//                 '--disable-infobars',
//             ],
//         });

//         const context = await browser.newContext({
//             viewport: { width: 1920, height: 1080 },
//             userAgent:
//                 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
//             ignoreHTTPSErrors: true,
//         });

//         const page = await context.newPage();

//         // STEP 2: Open Homepage
//         sendUpdate({
//             type: 'status',
//             message: `Opening homepage: ${frontendUrl}`,
//             step: 'opening-homepage',
//         });

//         const loadStart = Date.now();
//         let response;
//         try {
//             response = await page.goto(frontendUrl, {
//                 waitUntil: 'load',
//                 timeout: 45000,
//             });
//         } catch (err) {
//             console.log(`⚠️ Initial load with 'load' failed, trying 'domcontentloaded'...`);
//             response = await page.goto(frontendUrl, {
//                 waitUntil: 'domcontentloaded',
//                 timeout: 30000,
//             });
//         }
//         await page.waitForTimeout(2000);

//         // Scroll the page to the bottom (or simulate scrolling)
//         await page.evaluate(async () => {
//             await new Promise((resolve) => {
//                 let totalHeight = 0;
//                 const distance = 100;
//                 const timer = setInterval(() => {
//                     const scrollHeight = document.body.scrollHeight;
//                     window.scrollBy(0, distance);
//                     totalHeight += distance;

//                     if (totalHeight >= scrollHeight) {
//                         clearInterval(timer);
//                         resolve();
//                     }
//                 }, 100);
//             });
//         });
//         const loadTime = Date.now() - loadStart;
//         const homeTitle = await page.title();

//         sendUpdate({
//             type: 'status',
//             message: `Homepage loaded in ${loadTime}ms - "${homeTitle}"`,
//             step: 'homepage-loaded',
//         });

//         let headerLinks = [];
//         let footerLinks = [];
//         let bodyLinks = [];

//         // Parse the base domain for same-domain filtering
//         let baseDomain = '';
//         try {
//             baseDomain = new URL(frontendUrl).hostname.replace(/^www\./, '');
//         } catch (e) { }

//         const isSameDomain = (href) => {
//             try {
//                 const linkDomain = new URL(href).hostname.replace(/^www\./, '');
//                 return linkDomain === baseDomain;
//             } catch (e) { return false; }
//         };

//         const isValidPageLink = (href) => {
//             return href &&
//                 href.startsWith('http') &&
//                 !href.includes('#') &&
//                 !href.startsWith('javascript:') &&
//                 !href.startsWith('mailto:') &&
//                 !href.startsWith('tel:') &&
//                 !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3|doc|docx|xls|xlsx|ppt|css|js|json|xml|woff|woff2|ttf|eot)$/i) &&
//                 isSameDomain(href);
//         };

//         if (scanType !== 'url') {
//             // STEP 3: Extract Header Navigation Links
//             sendUpdate({
//                 type: 'status',
//                 message: 'Extracting header navigation links...',
//                 step: 'extracting-header-links',
//             });

//             headerLinks = await page.evaluate((baseUrl) => {
//                 const links = [];
//                 const selectors = [
//                     'header a[href]',
//                     'nav a[href]',
//                     '[role="navigation"] a[href]',
//                     '.navbar a[href]',
//                     '.nav a[href]',
//                     '.header a[href]',
//                     '.menu a[href]',
//                     '.main-nav a[href]',
//                     '.dropdown-menu a[href]',
//                     '.sub-menu a[href]',
//                     '.mega-menu a[href]',
//                     '[class*="dropdown"] a[href]',
//                     '[class*="submenu"] a[href]',
//                 ];
//                 const seen = new Set();

//                 for (const selector of selectors) {
//                     document.querySelectorAll(selector).forEach((a) => {
//                         const href = a.href;
//                         const text = a.textContent.trim().substring(0, 100);
//                         if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
//                             seen.add(href);
//                             links.push({ href, text: text || 'No Text', source: 'header' });
//                         }
//                     });
//                 }
//                 return links;
//             }, frontendUrl);

//             report.headerLinks = headerLinks;

//             // STEP 4: Extract Footer Links
//             sendUpdate({
//                 type: 'status',
//                 message: 'Extracting footer links...',
//                 step: 'extracting-footer-links',
//             });

//             footerLinks = await page.evaluate((baseUrl) => {
//                 const links = [];
//                 const selectors = [
//                     'footer a[href]',
//                     '.footer a[href]',
//                     '#footer a[href]',
//                     '.site-footer a[href]',
//                 ];
//                 const seen = new Set();

//                 for (const selector of selectors) {
//                     document.querySelectorAll(selector).forEach((a) => {
//                         const href = a.href;
//                         const text = a.textContent.trim().substring(0, 100);
//                         if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
//                             seen.add(href);
//                             links.push({ href, text: text || 'No Text', source: 'footer' });
//                         }
//                     });
//                 }
//                 return links;
//             }, frontendUrl);

//             report.footerLinks = footerLinks;

//             // STEP 4.5: Extract ALL Body/Content Links (Full Domain mode)
//             sendUpdate({
//                 type: 'status',
//                 message: 'Extracting all page links from body content...',
//                 step: 'extracting-body-links',
//             });

//             bodyLinks = await page.evaluate(() => {
//                 const links = [];
//                 const seen = new Set();
//                 document.querySelectorAll('a[href]').forEach((a) => {
//                     const href = a.href;
//                     const text = a.textContent.trim().substring(0, 100);
//                     if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
//                         // Skip pure anchor links on same page
//                         try {
//                             const url = new URL(href);
//                             if (url.hash && url.origin + url.pathname === window.location.origin + window.location.pathname) return;
//                         } catch (e) { }
//                         seen.add(href);
//                         links.push({ href, text: text || 'No Text', source: 'body' });
//                     }
//                 });
//                 return links;
//             });

//             // Also expose hidden dropdown/mega-menu links by hovering nav items
//             try {
//                 const navItems = await page.locator('nav li, .navbar li, .menu li, header li').all();
//                 for (const item of navItems.slice(0, 30)) {
//                     try {
//                         await item.hover({ timeout: 500 }).catch(() => { });
//                         await page.waitForTimeout(200);
//                     } catch (e) { }
//                 }
//                 // Re-extract after hovering to catch any newly visible dropdown links
//                 const dropdownLinks = await page.evaluate(() => {
//                     const links = [];
//                     const seen = new Set();
//                     document.querySelectorAll('.dropdown-menu a[href], .sub-menu a[href], [class*="dropdown"] a[href], [class*="submenu"] a[href], .mega-menu a[href]').forEach((a) => {
//                         const href = a.href;
//                         const text = a.textContent.trim().substring(0, 100);
//                         if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:')) {
//                             seen.add(href);
//                             links.push({ href, text: text || 'No Text', source: 'dropdown' });
//                         }
//                     });
//                     return links;
//                 });
//                 bodyLinks = [...bodyLinks, ...dropdownLinks];
//             } catch (e) {
//                 console.log('Dropdown hover extraction skipped:', e.message);
//             }
//         }

//         // Combine all unique links (homepage + header + footer + body)
//         const allLinksMap = new Map();
//         allLinksMap.set(frontendUrl, { href: frontendUrl, text: homeTitle || 'Homepage', source: 'homepage' });

//         if (scanType !== 'url') {
//             [...headerLinks, ...footerLinks, ...bodyLinks].forEach((link) => {
//                 // Normalize URL: remove trailing slash and query params for dedup
//                 let normalizedHref = link.href;
//                 try {
//                     const u = new URL(normalizedHref);
//                     normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
//                 } catch (e) { }

//                 if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
//                     allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
//                 }
//             });
//         }

//         let allPages = Array.from(allLinksMap.values());

//         // STEP 4.6: Deep crawl — visit discovered pages to find MORE links (depth 2)
//         if (scanType !== 'url' && allPages.length > 1) {
//             sendUpdate({
//                 type: 'status',
//                 message: `Deep crawling ${Math.min(allPages.length - 1, 15)} discovered pages for more links...`,
//                 step: 'deep-crawl',
//             });

//             const pagesToDeepCrawl = allPages.slice(1, 16); // skip homepage (already crawled), max 15 sub-pages
//             let newLinksFound = 0;

//             for (const pageInfo of pagesToDeepCrawl) {
//                 try {
//                     await page.goto(pageInfo.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
//                     await page.waitForTimeout(500);

//                     const subPageLinks = await page.evaluate(() => {
//                         const links = [];
//                         const seen = new Set();
//                         document.querySelectorAll('a[href]').forEach((a) => {
//                             const href = a.href;
//                             const text = a.textContent.trim().substring(0, 100);
//                             if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
//                                 seen.add(href);
//                                 links.push({ href, text: text || 'No Text', source: 'deep-crawl' });
//                             }
//                         });
//                         return links;
//                     });

//                     for (const link of subPageLinks) {
//                         let normalizedHref = link.href;
//                         try {
//                             const u = new URL(normalizedHref);
//                             normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
//                         } catch (e) { }

//                         if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
//                             allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
//                             newLinksFound++;
//                         }
//                     }
//                 } catch (e) {
//                     // Skip pages that fail to load
//                 }
//             }

//             if (newLinksFound > 0) {
//                 console.log(`   🔍 Deep crawl found ${newLinksFound} additional pages`);
//                 allPages = Array.from(allLinksMap.values());

//                 sendUpdate({
//                     type: 'status',
//                     message: `Deep crawl found ${newLinksFound} more pages. Total: ${allPages.length}`,
//                     step: 'deep-crawl-complete',
//                 });
//             }

//             // Navigate back to homepage for testing
//             await page.goto(frontendUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
//             await page.waitForTimeout(1000);
//         }

//         report.totalPages = allPages.length;

//         sendUpdate({
//             type: 'links-discovered',
//             headerLinks: headerLinks.length,
//             footerLinks: footerLinks.length,
//             bodyLinks: bodyLinks.length,
//             totalPages: allPages.length,
//             pages: allPages.map((p) => ({ url: p.href, text: p.text, source: p.source })),
//         });

//         console.log(`\n📊 [${testId}] Full Domain Scan Summary:`);
//         console.log(`   Header links: ${headerLinks.length}`);
//         console.log(`   Footer links: ${footerLinks.length}`);
//         console.log(`   Body links: ${bodyLinks.length}`);
//         console.log(`   Total unique pages to test: ${allPages.length}\n`);

//         // STEP 5: Visit Each Page
//         for (let i = 0; i < allPages.length; i++) {
//             const pageInfo = allPages[i];
//             const pageIndex = i;

//             sendUpdate({
//                 type: 'page-start',
//                 pageIndex,
//                 totalPages: allPages.length,
//                 url: pageInfo.href,
//                 text: pageInfo.text,
//                 progress: Math.round((i / allPages.length) * 100),
//             });

//             const pageResult = {
//                 index: pageIndex,
//                 url: pageInfo.href,
//                 text: pageInfo.text,
//                 source: pageInfo.source,
//                 title: '',
//                 loadStatus: 'UNKNOWN',
//                 loadTimeMs: 0,
//                 httpStatus: 0,
//                 screenshotPath: '',
//                 screenshotUrl: '',
//                 consoleErrors: [],
//                 networkErrors: [],
//                 networkLog: {
//                     requests: [],
//                     summary: {
//                         totalRequests: 0,
//                         totalSize: 0,
//                         totalTransferred: 0,
//                         domContentLoaded: 0,
//                         loadTime: 0,
//                         finishTime: 0,
//                     }
//                 },
//                 brokenLinksCheck: [],
//                 formTestResults: [],
//                 elementsInfo: {},
//                 imageCheckResults: [],
//                 videoCheckResults: [],
//                 aiAnalysis: null,
//                 groqAnalysis: null,
//                 error: null,
//             };

//             // Global listeners for this page visit
//             const consoleErrors = [];
//             const consoleHandler = (msg) => {
//                 if (msg.type() === 'error') {
//                     consoleErrors.push({
//                         type: 'CONSOLE_ERROR',
//                         text: msg.text(),
//                         location: msg.location().url || pageInfo.href
//                     });
//                 }
//             };

//             const networkErrors = [];
//             const requestFailedHandler = (request) => {
//                 networkErrors.push({
//                     type: 'REQUEST_FAILED',
//                     url: request.url(),
//                     errorText: request.failure() ? request.failure().errorText : 'Unknown Error'
//                 });
//             };

//             const responseHandler = (res) => {
//                 if (res.status() >= 400) {
//                     networkErrors.push({
//                         type: 'HTTP_ERROR',
//                         url: res.url(),
//                         status: res.status(),
//                         statusText: res.statusText()
//                     });
//                 }
//             };

//             // --- NETWORK LOG: Track all requests with timing ---
//             const networkRequests = new Map();
//             const requestHandler = (request) => {
//                 networkRequests.set(request.url() + '_' + request.resourceType(), {
//                     url: request.url(),
//                     name: request.url().split('/').pop()?.split('?')[0] || request.url(),
//                     method: request.method(),
//                     resourceType: request.resourceType(),
//                     startTime: Date.now(),
//                     status: 0,
//                     size: 0,
//                     time: 0,
//                 });
//             };

//             const responseLogHandler = async (response) => {
//                 const key = response.url() + '_' + response.request().resourceType();
//                 const entry = networkRequests.get(key);
//                 if (entry) {
//                     entry.status = response.status();
//                     entry.time = Date.now() - entry.startTime;
//                     try {
//                         const body = await response.body().catch(() => null);
//                         entry.size = body ? body.length : 0;
//                     } catch {
//                         entry.size = 0;
//                     }
//                 }
//             };

//             page.on('console', consoleHandler);
//             page.on('requestfailed', requestFailedHandler);
//             page.on('response', responseHandler);
//             page.on('request', requestHandler);
//             page.on('response', responseLogHandler);

//             try {
//                 const pageLoadStart = Date.now();
//                 let pageResponse;
//                 try {
//                     pageResponse = await page.goto(pageInfo.href, {
//                         waitUntil: 'load',
//                         timeout: 35000,
//                     });
//                 } catch (gotoErr) {
//                     console.log(`⚠️ Failed to load ${pageInfo.href} with 'load', falling back...`);
//                     pageResponse = await page.goto(pageInfo.href, {
//                         waitUntil: 'domcontentloaded',
//                         timeout: 20000,
//                     }).catch(e => null);
//                 }

//                 pageResult.loadTimeMs = Date.now() - pageLoadStart;
//                 pageResult.httpStatus = pageResponse ? pageResponse.status() : 0;
//                 pageResult.loadStatus = pageResponse && pageResponse.ok() ? 'SUCCESS' : 'FAILED';
//                 pageResult.title = await page.title();
//                 pageResult.consoleErrors = consoleErrors;
//                 pageResult.networkErrors = networkErrors;

//                 // Capture performance timing from the browser
//                 const perfTiming = await page.evaluate(() => {
//                     const p = performance.timing;
//                     return {
//                         domContentLoaded: p.domContentLoadedEventEnd - p.navigationStart,
//                         loadTime: p.loadEventEnd - p.navigationStart,
//                         finishTime: Date.now() - p.navigationStart,
//                     };
//                 }).catch(() => ({ domContentLoaded: 0, loadTime: 0, finishTime: 0 }));

//                 // Build network log from captured requests
//                 const allNetworkEntries = Array.from(networkRequests.values());
//                 const totalSize = allNetworkEntries.reduce((sum, r) => sum + (r.size || 0), 0);
//                 pageResult.networkLog = {
//                     requests: allNetworkEntries.map(r => ({
//                         name: r.name,
//                         url: r.url,
//                         method: r.method,
//                         status: r.status,
//                         type: r.resourceType,
//                         size: r.size,
//                         time: r.time,
//                     })),
//                     summary: {
//                         totalRequests: allNetworkEntries.length,
//                         totalSize: totalSize,
//                         totalTransferred: totalSize,
//                         domContentLoaded: perfTiming.domContentLoaded,
//                         loadTime: perfTiming.loadTime,
//                         finishTime: perfTiming.finishTime,
//                     }
//                 };

//                 // Wait for content to settle
//                 await page.waitForTimeout(1000);

//                 // Send live screenshot
//                 const liveBuffer = await page.screenshot({ type: 'png' });
//                 sendUpdate({
//                     type: 'live-screenshot',
//                     image: liveBuffer.toString('base64'),
//                     url: pageInfo.href,
//                     pageIndex,
//                 });

//                 // Gather deep page element info (SEO, element counts, broken items)
//                 pageResult.elementsInfo = await page.evaluate(async () => {
//                     const getMetaContent = (names) => {
//                         for (const name of names) {
//                             const el = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
//                             if (el) return el.getAttribute('content');
//                         }
//                         return null;
//                     };

//                     const description = getMetaContent(['description', 'og:description', 'twitter:description']) || 'No description found';
//                     const ogType = getMetaContent(['og:type']) || 'No og:type found';
//                     const ogTitle = getMetaContent(['og:title']) || document.title;
//                     const keywords = getMetaContent(['keywords', 'news_keywords']) || 'None';

//                     // Image Analysis: Total, Missing Src/Alt, Duplicates
//                     const images = Array.from(document.querySelectorAll('img'));
//                     const badImages = [];
//                     const srcStats = new Map();
//                     let exactMissingSrc = 0;
//                     let exactMissingAlt = 0;

//                     images.forEach((img, idx) => {
//                         const rawSrc = img.getAttribute('src');
//                         const rawAlt = img.getAttribute('alt');

//                         const src = rawSrc !== null ? String(rawSrc).trim() : null;
//                         const alt = rawAlt !== null ? String(rawAlt).trim() : null;

//                         const isHidden = img.offsetParent === null && img.style.display === 'none';
//                         const isLazy = img.getAttribute('loading') === 'lazy' && !img.complete;
//                         const isBroken = !isHidden && !isLazy && img.complete && img.naturalWidth === 0 && src && src !== '#';

//                         const missingSrc = src === null || src === '' || src === '#' || src === 'javascript:void(0)' || src === '/';
//                         const missingAlt = alt === null || alt === '' || alt.toLowerCase() === 'null' || alt.toLowerCase() === 'undefined';

//                         if (missingSrc) exactMissingSrc++;
//                         if (missingAlt) exactMissingAlt++;

//                         if (src && !missingSrc) {
//                             let normalizedSrc;
//                             try {
//                                 normalizedSrc = new URL(src, document.baseURI).href;
//                             } catch {
//                                 normalizedSrc = src;
//                             }
//                             srcStats.set(normalizedSrc, (srcStats.get(normalizedSrc) || 0) + 1);
//                         }

//                         if (missingAlt || missingSrc || isBroken) {
//                             badImages.push({
//                                 index: idx,
//                                 src: src || 'MISSING',
//                                 alt: rawAlt === null ? 'NULL' : (alt === '' ? 'EMPTY' : alt),
//                                 issue: missingSrc ? 'Missing SRC' : (isBroken ? 'Broken Image' : 'Missing ALT'),
//                                 missingSrc,
//                                 missingAlt,
//                                 isBroken,
//                                 tag: 'img'
//                             });
//                         }
//                     });
//                     const totalDuplicateImages = Array.from(srcStats.values())
//                         .reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);

//                     const brokenLinks = [];
//                     const links = Array.from(document.querySelectorAll('a'));
//                     const linkStats = new Map();

//                     links.forEach(a => {
//                         const rawHref = a.getAttribute('href');
//                         const text = a.textContent.trim() || 'Empty Link';

//                         if (rawHref && rawHref !== '#' && rawHref.trim() !== '' && !rawHref.startsWith('javascript:') && !rawHref.startsWith('mailto:') && !rawHref.startsWith('tel:')) {
//                             let absoluteHref;
//                             try {
//                                 absoluteHref = new URL(rawHref.trim(), document.baseURI).href;
//                             } catch {
//                                 absoluteHref = rawHref.trim();
//                             }

//                             let normalizedHref = absoluteHref.split('#')[0];
//                             if (normalizedHref.endsWith('/')) {
//                                 normalizedHref = normalizedHref.slice(0, -1);
//                             }

//                             linkStats.set(normalizedHref, (linkStats.get(normalizedHref) || 0) + 1);
//                         }

//                         if (!rawHref || rawHref === '#' || rawHref.trim() === '' || rawHref.startsWith('javascript:')) {
//                             brokenLinks.push({
//                                 text,
//                                 href: rawHref || 'MISSING',
//                                 tag: 'a',
//                                 reason: !rawHref ? 'Missing href' : (rawHref === '#' ? 'Placeholder href' : 'Invalid href')
//                             });
//                         }
//                     });

//                     const totalDuplicateLinks = Array.from(linkStats.values()).reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);

//                     const buttonSelector = 'button:not([type="hidden"]):not([style*="display: none"]), input[type="button"], input[type="submit"], a.btn, a.button, [role="button"]:not([aria-hidden="true"])';
//                     const buttonElements = Array.from(document.querySelectorAll(buttonSelector));

//                     const visibleButtons = buttonElements.filter(btn => {
//                         const style = window.getComputedStyle(btn);
//                         const rect = btn.getBoundingClientRect();
//                         return style.display !== 'none' &&
//                             style.visibility !== 'hidden' &&
//                             style.opacity !== '0' &&
//                             rect.width > 0 &&
//                             rect.height > 0;
//                     });
//                     const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'github.com', 'whatsapp.com', 'telegram.org', 'reddit.com'];
//                     const buttonsData = visibleButtons.map((btn, bIdx) => {
//                         const text = (btn.textContent.trim() || btn.getAttribute('aria-label') || btn.value || '').substring(0, 50);
//                         const isImageButton = btn.querySelector('img') || btn.tagName.toLowerCase() === 'img' || (btn.style.backgroundImage && btn.style.backgroundImage !== 'none');

//                         const inHeader = !!btn.closest('header, nav, .header, .navbar, .nav, .main-nav, .menu, [role="navigation"], #header');
//                         const inFooter = !!btn.closest('footer, .footer, .site-footer, #footer');
//                         const region = inHeader ? 'header' : (inFooter ? 'footer' : 'body');

//                         const rawHref = btn.getAttribute('href') || '';
//                         let href = '';
//                         try { href = rawHref ? new URL(rawHref, document.baseURI).href : ''; } catch { href = rawHref; }

//                         const isDropdownTrigger = !!(
//                             btn.getAttribute('data-toggle') === 'dropdown' ||
//                             btn.getAttribute('data-bs-toggle') === 'dropdown' ||
//                             btn.classList.contains('dropdown-toggle') ||
//                             btn.getAttribute('aria-haspopup') === 'true' ||
//                             btn.closest('.dropdown, .has-dropdown, .nav-item.dropdown')
//                         );

//                         const isExternal = href ? !href.startsWith(window.location.origin) : false;
//                         const isSocialMedia = href ? socialDomains.some(d => href.includes(d)) : false;

//                         const elType = btn.tagName.toLowerCase() === 'a' ? 'link' :
//                             (btn.tagName.toLowerCase() === 'input' ? btn.getAttribute('type') || 'button' : 'button');

//                         return {
//                             index: bIdx,
//                             text: text || (isImageButton ? '[Image Button]' : 'Unnamed Button'),
//                             tag: btn.tagName.toLowerCase(),
//                             elType,
//                             region,
//                             href,
//                             isImageButton: !!isImageButton,
//                             isDropdownTrigger,
//                             isExternal,
//                             isSocialMedia,
//                             working: 'Pending',
//                             reason: ''
//                         };
//                     });

//                     return {
//                         seo: {
//                             title: document.title,
//                             description,
//                             keywords,
//                             ogType,
//                             ogTitle,
//                             hasMetaDescription: !!getMetaContent(['description']),
//                             hasOgDescription: !!getMetaContent(['og:description']),
//                             hasOgType: !!getMetaContent(['og:type']),
//                             hasViewport: !!document.querySelector('meta[name="viewport" i]')
//                         },
//                         counts: {
//                             images: images.length,
//                             links: links.length,
//                             buttons: buttonElements.length,
//                             h1: document.querySelectorAll('h1').length,
//                             forms: document.querySelectorAll('form').length,
//                             duplicateImages: totalDuplicateImages,
//                             duplicateLinks: totalDuplicateLinks,
//                             missingSrc: exactMissingSrc,
//                             missingAlt: exactMissingAlt
//                         },
//                         broken: {
//                             images: badImages.filter(img => img.isBroken || img.missingSrc),
//                             links: brokenLinks
//                         },
//                         badImages,
//                         buttons: buttonsData
//                     };
//                 });

//                 // Update global summary stats
//                 report.globalSummary.elementStats.totalImages += pageResult.elementsInfo.counts.images;
//                 report.globalSummary.elementStats.totalLinks += pageResult.elementsInfo.counts.links;
//                 report.globalSummary.elementStats.totalButtons += pageResult.elementsInfo.counts.buttons;

//                 const missingAltCount = pageResult.elementsInfo.counts.missingAlt;
//                 const missingSrcCount = pageResult.elementsInfo.counts.missingSrc;

//                 report.globalSummary.elementStats.totalMissingAlt += missingAltCount;
//                 report.globalSummary.elementStats.totalMissingSrc += missingSrcCount;
//                 report.globalSummary.elementStats.totalDuplicateImages += pageResult.elementsInfo.counts.duplicateImages;

//                 pageResult.elementsInfo.broken.links.forEach(bl => {
//                     report.globalSummary.brokenLinks.push({ url: pageResult.url, ...bl });
//                 });

//                 pageResult.elementsInfo.badImages.filter(img => img.issue === 'Broken Image' || img.issue === 'Missing SRC').forEach(bi => {
//                     report.globalSummary.missingResources.push({ url: pageResult.url, type: 'IMAGE', ...bi });
//                 });

//                 networkErrors.forEach(ne => {
//                     report.globalSummary.missingResources.push({ url: pageResult.url, type: 'NETWORK', ...ne });
//                 });

//                 // ═══════════════════════════════════════════════════════════════
//                 // IMAGE CHECK: Visibility + Load Status (complete & width > 0)
//                 // ═══════════════════════════════════════════════════════════════
//                 sendUpdate({
//                     type: 'status',
//                     message: `🖼️ Checking images on page ${pageIndex + 1}...`,
//                     step: 'image-check',
//                 });

//                 try {
//                     const imageCheckResults = await page.evaluate(() => {
//                         const imgs = Array.from(document.querySelectorAll('img'));
//                         return imgs.map((img, idx) => {
//                             const rawSrc = img.getAttribute('src');
//                             const rawAlt = img.getAttribute('alt');
//                             const src = rawSrc !== null ? String(rawSrc).trim() : null;
//                             const alt = rawAlt !== null ? String(rawAlt).trim() : null;

//                             // 1. Visibility check
//                             const rect = img.getBoundingClientRect();
//                             const style = window.getComputedStyle(img);
//                             const isVisible = (
//                                 style.display !== 'none' &&
//                                 style.visibility !== 'hidden' &&
//                                 style.opacity !== '0' &&
//                                 rect.width > 0 &&
//                                 rect.height > 0 &&
//                                 img.offsetParent !== null
//                             );

//                             // 2. Load check: complete + naturalWidth > 0
//                             const isComplete = img.complete;
//                             const naturalWidth = img.naturalWidth || 0;
//                             const naturalHeight = img.naturalHeight || 0;
//                             const isLoaded = isComplete && naturalWidth > 0;
//                             const isBroken = isComplete && naturalWidth === 0 && src && src !== '' && src !== '#';

//                             // Determine overall status
//                             let status = 'OK';
//                             let reason = '';
//                             if (!src || src === '' || src === '#') {
//                                 status = 'MISSING_SRC';
//                                 reason = 'Image has no valid src attribute';
//                             } else if (!isVisible) {
//                                 status = 'HIDDEN';
//                                 reason = 'Image is not visible on screen (display:none, hidden, or zero size)';
//                             } else if (isBroken) {
//                                 status = 'BROKEN';
//                                 reason = `Image failed to load (complete=true, naturalWidth=0). Src: ${src.substring(0, 100)}`;
//                             } else if (!isComplete) {
//                                 status = 'LOADING';
//                                 reason = 'Image is still loading';
//                             } else if (isLoaded && isVisible) {
//                                 status = 'OK';
//                                 reason = `Image loaded successfully (${naturalWidth}x${naturalHeight})`;
//                             }

//                             return {
//                                 index: idx,
//                                 src: src || 'MISSING',
//                                 alt: alt || 'MISSING',
//                                 isVisible,
//                                 isComplete,
//                                 naturalWidth,
//                                 naturalHeight,
//                                 isLoaded,
//                                 isBroken,
//                                 status,
//                                 reason,
//                                 displayWidth: Math.round(rect.width),
//                                 displayHeight: Math.round(rect.height),
//                             };
//                         });
//                     });

//                     pageResult.imageCheckResults = imageCheckResults;

//                     const totalImages = imageCheckResults.length;
//                     const okImages = imageCheckResults.filter(i => i.status === 'OK').length;
//                     const brokenImages = imageCheckResults.filter(i => i.status === 'BROKEN').length;
//                     const hiddenImages = imageCheckResults.filter(i => i.status === 'HIDDEN').length;
//                     const missingSrcImages = imageCheckResults.filter(i => i.status === 'MISSING_SRC').length;

//                     console.log(`   🖼️ [Page ${pageIndex + 1}] Image Check: ${totalImages} total | ${okImages} OK | ${brokenImages} Broken | ${hiddenImages} Hidden | ${missingSrcImages} Missing Src`);

//                     sendUpdate({
//                         type: 'image-check-complete',
//                         pageIndex,
//                         url: pageInfo.href,
//                         summary: { totalImages, okImages, brokenImages, hiddenImages, missingSrcImages },
//                         details: imageCheckResults,
//                     });

//                 } catch (imgCheckErr) {
//                     console.log('Image check error:', imgCheckErr.message);
//                     pageResult.imageCheckResults = [];
//                 }

//                 // ═══════════════════════════════════════════════════════════════
//                 // VIDEO CHECK: Visibility + readyState >= 3 (buffering complete)
//                 // ═══════════════════════════════════════════════════════════════
//                 sendUpdate({
//                     type: 'status',
//                     message: `🎥 Checking videos on page ${pageIndex + 1}...`,
//                     step: 'video-check',
//                 });

//                 try {
//                     const videoCheckResults = await page.evaluate(() => {
//                         const videos = Array.from(document.querySelectorAll('video'));
//                         // Also check iframes for embedded videos (YouTube, Vimeo, etc.)
//                         const iframeVideos = Array.from(document.querySelectorAll('iframe')).filter(iframe => {
//                             const src = (iframe.getAttribute('src') || '').toLowerCase();
//                             return src.includes('youtube') || src.includes('youtu.be') ||
//                                 src.includes('vimeo') || src.includes('dailymotion') ||
//                                 src.includes('wistia') || src.includes('player');
//                         });

//                         const results = [];

//                         // Check native <video> elements
//                         videos.forEach((video, idx) => {
//                             const sources = Array.from(video.querySelectorAll('source'));
//                             const videoSrc = video.getAttribute('src') || (sources.length > 0 ? sources[0].getAttribute('src') : null);
//                             const poster = video.getAttribute('poster') || null;

//                             // 1. Visibility check
//                             const rect = video.getBoundingClientRect();
//                             const style = window.getComputedStyle(video);
//                             const isVisible = (
//                                 style.display !== 'none' &&
//                                 style.visibility !== 'hidden' &&
//                                 style.opacity !== '0' &&
//                                 rect.width > 0 &&
//                                 rect.height > 0
//                             );

//                             // 2. readyState check
//                             // 0 = HAVE_NOTHING, 1 = HAVE_METADATA, 2 = HAVE_CURRENT_DATA
//                             // 3 = HAVE_FUTURE_DATA, 4 = HAVE_ENOUGH_DATA
//                             const readyState = video.readyState;
//                             const isReady = readyState >= 3; // Buffering complete, ready to play
//                             const duration = video.duration || 0;
//                             const paused = video.paused;
//                             const muted = video.muted;
//                             const autoplay = video.autoplay;
//                             const networkState = video.networkState;
//                             const errorCode = video.error ? video.error.code : null;

//                             // Determine readyState label
//                             const readyStateLabels = {
//                                 0: 'HAVE_NOTHING',
//                                 1: 'HAVE_METADATA',
//                                 2: 'HAVE_CURRENT_DATA',
//                                 3: 'HAVE_FUTURE_DATA',
//                                 4: 'HAVE_ENOUGH_DATA'
//                             };

//                             let status = 'OK';
//                             let reason = '';

//                             if (!videoSrc && sources.length === 0) {
//                                 status = 'MISSING_SRC';
//                                 reason = 'Video has no src or source elements';
//                             } else if (!isVisible) {
//                                 status = 'HIDDEN';
//                                 reason = 'Video player is not visible on screen';
//                             } else if (errorCode) {
//                                 status = 'ERROR';
//                                 const errorMessages = {
//                                     1: 'MEDIA_ERR_ABORTED - Playback aborted by user',
//                                     2: 'MEDIA_ERR_NETWORK - Network error while downloading',
//                                     3: 'MEDIA_ERR_DECODE - Error decoding video',
//                                     4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - Video format not supported'
//                                 };
//                                 reason = errorMessages[errorCode] || `Unknown error code: ${errorCode}`;
//                             } else if (readyState === 0) {
//                                 status = 'NOT_LOADED';
//                                 reason = 'Video has not started loading (readyState=0)';
//                             } else if (readyState < 3) {
//                                 status = 'BUFFERING';
//                                 reason = `Video is buffering (readyState=${readyState}: ${readyStateLabels[readyState] || 'Unknown'})`;
//                             } else {
//                                 status = 'OK';
//                                 reason = `Video ready to play (readyState=${readyState}: ${readyStateLabels[readyState] || 'Unknown'}, duration=${duration.toFixed(1)}s)`;
//                             }

//                             results.push({
//                                 index: idx,
//                                 type: 'native',
//                                 src: videoSrc || 'MISSING',
//                                 poster: poster || 'NONE',
//                                 isVisible,
//                                 readyState,
//                                 readyStateLabel: readyStateLabels[readyState] || 'Unknown',
//                                 isReady,
//                                 duration: Math.round(duration * 10) / 10,
//                                 paused,
//                                 muted,
//                                 autoplay,
//                                 errorCode,
//                                 status,
//                                 reason,
//                                 displayWidth: Math.round(rect.width),
//                                 displayHeight: Math.round(rect.height),
//                             });
//                         });

//                         // Check embedded iframe videos
//                         iframeVideos.forEach((iframe, idx) => {
//                             const src = iframe.getAttribute('src') || '';
//                             const rect = iframe.getBoundingClientRect();
//                             const style = window.getComputedStyle(iframe);
//                             const isVisible = (
//                                 style.display !== 'none' &&
//                                 style.visibility !== 'hidden' &&
//                                 style.opacity !== '0' &&
//                                 rect.width > 0 &&
//                                 rect.height > 0
//                             );

//                             let platform = 'unknown';
//                             if (src.includes('youtube') || src.includes('youtu.be')) platform = 'YouTube';
//                             else if (src.includes('vimeo')) platform = 'Vimeo';
//                             else if (src.includes('dailymotion')) platform = 'Dailymotion';
//                             else if (src.includes('wistia')) platform = 'Wistia';
//                             else platform = 'Embedded Player';

//                             results.push({
//                                 index: videos.length + idx,
//                                 type: 'iframe',
//                                 src: src.substring(0, 200),
//                                 platform,
//                                 isVisible,
//                                 readyState: isVisible ? 4 : 0,
//                                 readyStateLabel: isVisible ? 'EMBEDDED_VISIBLE' : 'EMBEDDED_HIDDEN',
//                                 isReady: isVisible,
//                                 duration: 0,
//                                 paused: false,
//                                 muted: false,
//                                 autoplay: false,
//                                 errorCode: null,
//                                 status: isVisible ? 'OK' : 'HIDDEN',
//                                 reason: isVisible
//                                     ? `${platform} embed is visible and loaded`
//                                     : `${platform} embed is not visible on screen`,
//                                 displayWidth: Math.round(rect.width),
//                                 displayHeight: Math.round(rect.height),
//                             });
//                         });

//                         return results;
//                     });

//                     pageResult.videoCheckResults = videoCheckResults;

//                     const totalVideos = videoCheckResults.length;
//                     const nativeVideos = videoCheckResults.filter(v => v.type === 'native').length;
//                     const iframeVideos = videoCheckResults.filter(v => v.type === 'iframe').length;
//                     const readyVideos = videoCheckResults.filter(v => v.status === 'OK').length;
//                     const brokenVideos = videoCheckResults.filter(v => ['ERROR', 'NOT_LOADED', 'MISSING_SRC'].includes(v.status)).length;
//                     const bufferingVideos = videoCheckResults.filter(v => v.status === 'BUFFERING').length;

//                     console.log(`   🎥 [Page ${pageIndex + 1}] Video Check: ${totalVideos} total (${nativeVideos} native, ${iframeVideos} iframe) | ${readyVideos} Ready | ${brokenVideos} Broken | ${bufferingVideos} Buffering`);

//                     sendUpdate({
//                         type: 'video-check-complete',
//                         pageIndex,
//                         url: pageInfo.href,
//                         summary: { totalVideos, nativeVideos, iframeVideos, readyVideos, brokenVideos, bufferingVideos },
//                         details: videoCheckResults,
//                     });

//                 } catch (vidCheckErr) {
//                     console.log('Video check error:', vidCheckErr.message);
//                     pageResult.videoCheckResults = [];
//                 }

//                 // --- BROKEN LINK VERIFICATION (actual HTTP checks) ---
//                 sendUpdate({
//                     type: 'status',
//                     message: `Checking links on page ${pageIndex + 1} for broken URLs...`,
//                     step: 'broken-link-check',
//                 });

//                 try {
//                     const allPageLinks = await page.evaluate(() => {
//                         const anchors = Array.from(document.querySelectorAll('a'));
//                         const results = [];
//                         const seen = new Set();

//                         anchors.forEach(a => {
//                             const href = a.getAttribute('href');
//                             const text = (a.textContent || '').trim().substring(0, 60) || 'No Text Found';

//                             let finalUrl = href || 'MISSING';
//                             if (href && href.trim() !== '' && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:') && href !== '#') {
//                                 try {
//                                     finalUrl = new URL(href.trim(), document.baseURI).href;
//                                 } catch {
//                                     finalUrl = href;
//                                 }
//                             }

//                             let isDuplicate = false;
//                             let normalizedForDup = finalUrl.split('#')[0];
//                             if (normalizedForDup.endsWith('/')) {
//                                 normalizedForDup = normalizedForDup.slice(0, -1);
//                             }

//                             if (normalizedForDup !== 'MISSING' && normalizedForDup !== '') {
//                                 if (seen.has(normalizedForDup)) {
//                                     isDuplicate = true;
//                                 } else {
//                                     seen.add(normalizedForDup);
//                                 }
//                             }

//                             results.push({ text, href: finalUrl, isDuplicate });
//                         });
//                         return results;
//                     });

//                     const linksToCheck = allPageLinks;
//                     const allLinksList = [];

//                     for (const link of linksToCheck) {
//                         allLinksList.push({
//                             text: link.text || 'No Text Found',
//                             href: link.href,
//                             isDuplicate: link.isDuplicate,
//                             status: 200,
//                             reason: link.isDuplicate ? 'Duplicate Link' : 'Link Discovered'
//                         });
//                     }

//                     pageResult.brokenLinksCheck = allLinksList;

//                     if (pageResult.elementsInfo && pageResult.elementsInfo.counts) {
//                         pageResult.elementsInfo.counts.brokenLinks = 0;
//                         pageResult.elementsInfo.counts.linksChecked = allLinksList.length;
//                     }

//                     console.log(`   🔗 [Page ${pageIndex + 1}] Found ${allLinksList.length} links to display.`);
//                 } catch (blErr) {
//                     console.log('List links error:', blErr.message);
//                     pageResult.brokenLinksCheck = [];
//                 }

//                 // Take full-page screenshot
//                 const screenshotName = `page_${pageIndex}_${Date.now()}.png`;
//                 const screenshotPath = path.join(testDir, screenshotName);
//                 await page.screenshot({
//                     path: screenshotPath,
//                     fullPage: true,
//                 });
//                 pageResult.screenshotPath = screenshotPath;
//                 pageResult.screenshotUrl = `/api/screenshots/${testId}/${screenshotName}`;

//                 // ═══════════════════════════════════════════════════════════════
//                 // REUSABLE BUTTON TESTING FUNCTION (used for header, body, footer)
//                 // ═══════════════════════════════════════════════════════════════
//                 const buttonsArray = pageResult.elementsInfo.buttons;

//                 const testSingleButton = async (btnInfo, tIndex) => {
//                     let locator;

//                     locator = page.locator('button, input[type="button"], input[type="submit"], a.btn, a.button, [role="button"]').nth(btnInfo.index);

//                     const count = await locator.count().catch(() => 0);
//                     if (count === 0) {
//                         btnInfo.working = 'No (Not Found)';
//                         btnInfo.reason = `Button index ${btnInfo.index} not found in DOM`;
//                         return;
//                     }

//                     let isVisible = false;
//                     let isEnabled = false;

//                     try {
//                         await locator.waitFor({ state: 'attached', timeout: 2000 });
//                         isVisible = await locator.isVisible();
//                         isEnabled = await locator.isEnabled();
//                     } catch (e) {
//                         btnInfo.working = 'No (Detached)';
//                         btnInfo.reason = 'Element detached during check';
//                         return;
//                     }

//                     if (!isVisible || !isEnabled) {
//                         const jsState = await locator.evaluate(el => ({
//                             visible: el.offsetParent !== null,
//                             disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
//                             display: window.getComputedStyle(el).display,
//                             visibility: window.getComputedStyle(el).visibility
//                         })).catch(() => null);

//                         if (jsState) {
//                             isVisible = jsState.visible && jsState.display !== 'none' && jsState.visibility !== 'hidden';
//                             isEnabled = !jsState.disabled;
//                         }
//                     }

//                     if (!isVisible) {
//                         btnInfo.working = 'No (Hidden)';
//                         btnInfo.reason = 'Button not visible (display:none, hidden, or off-screen)';
//                         return;
//                     }

//                     if (!isEnabled) {
//                         btnInfo.working = 'No (Disabled)';
//                         btnInfo.reason = 'Button has disabled attribute or aria-disabled';
//                         return;
//                     }

//                     try {
//                         await locator.waitFor({ state: 'visible', timeout: 3000 });
//                     } catch (e) {
//                         btnInfo.working = 'No (Unstable)';
//                         btnInfo.reason = 'Element visible but not stable (animating)';
//                         return;
//                     }

//                     await locator.scrollIntoViewIfNeeded().catch(() => { });

//                     if (btnInfo.isDropdownTrigger) {
//                         try {
//                             await locator.hover({ timeout: 2000 });
//                             await page.waitForTimeout(300);

//                             const dropdownVisible = await page.locator('.dropdown-menu, .dropdown, [class*="dropdown"], [role="menu"]').first().isVisible().catch(() => false);

//                             if (dropdownVisible) {
//                                 btnInfo.working = 'Yes (Working)';
//                                 btnInfo.reason = 'Dropdown menu opened on hover';
//                                 return;
//                             }
//                         } catch (e) {
//                             // Continue to click test if hover fails
//                         }
//                     }

//                     const urlBefore = page.url();
//                     let htmlBefore = 0;
//                     try {
//                         htmlBefore = await page.evaluate(() => document.body.innerHTML.length);
//                     } catch (e) { }

//                     const pagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
//                     const navigationPromise = page.waitForNavigation({
//                         waitUntil: 'domcontentloaded',
//                         timeout: 5000
//                     }).catch(() => null);

//                     let clickSuccessful = false;
//                     let clickError = '';

//                     try {
//                         try {
//                             await locator.click({ timeout: 3000 });
//                             clickSuccessful = true;
//                         } catch (normalClickErr) {
//                             try {
//                                 await locator.click({ force: true, timeout: 2000 });
//                                 clickSuccessful = true;
//                             } catch (forceClickErr) {
//                                 await locator.evaluate(el => el.click());
//                                 clickSuccessful = true;
//                             }
//                         }
//                     } catch (e) {
//                         clickError = e.message;
//                     }

//                     if (!clickSuccessful) {
//                         btnInfo.working = 'No (Click Failed)';
//                         btnInfo.reason = clickError || 'All click methods failed';
//                         return;
//                     }

//                     await page.waitForTimeout(500);

//                     const [newPage, navigationResult] = await Promise.all([
//                         pagePromise,
//                         navigationPromise
//                     ]);

//                     const urlAfter = page.url();
//                     let htmlAfter = 0;
//                     try {
//                         htmlAfter = await page.evaluate(() => document.body.innerHTML.length);
//                     } catch (e) { }

//                     if (newPage) {
//                         btnInfo.working = 'Yes (Working)';
//                         btnInfo.reason = 'Opened new tab';
//                         await newPage.close().catch(() => { });
//                         await page.goto(urlBefore, { waitUntil: 'load', timeout: 8000 }).catch(() => { });
//                         await page.waitForTimeout(1000);
//                     } else if (urlAfter !== urlBefore) {
//                         btnInfo.working = 'Yes (Working)';
//                         btnInfo.reason = `Navigated to: ${urlAfter.substring(0, 60)}`;
//                         await page.goBack({ waitUntil: 'load', timeout: 8000 }).catch(() => {
//                             return page.goto(urlBefore, { waitUntil: 'load', timeout: 8000 }).catch(() => { });
//                         });
//                         await page.waitForTimeout(1000);
//                     } else if (Math.abs(htmlAfter - htmlBefore) > 50) {
//                         btnInfo.working = 'Yes (Working)';
//                         btnInfo.reason = 'Modal/DOM updated';
//                     } else {
//                         const hasSuccessIndicator = await page.locator(
//                             '.toast, .notification, .alert, .modal.show, [role="alert"], ' +
//                             '.success, .dropdown-menu.show, .open, .active'
//                         ).first().isVisible().catch(() => false);

//                         if (hasSuccessIndicator) {
//                             btnInfo.working = 'Yes (Working)';
//                             btnInfo.reason = 'Success indicator visible';
//                         } else {
//                             btnInfo.working = 'No (No Response)';
//                             btnInfo.reason = 'Click executed but no visible change';
//                         }
//                     }
//                 };

//                 const testButtonsByRegion = async (region, limitPerRegion = 15) => {
//                     const regionButtons = buttonsArray.filter(b => b.region === region);
//                     let tested = 0;

//                     for (const btnInfo of regionButtons) {
//                         if (tested >= limitPerRegion) {
//                             btnInfo.working = 'Skipped (Limit)';
//                             btnInfo.reason = `Exceeded ${limitPerRegion} button limit for ${region}`;
//                             continue;
//                         }

//                         if (btnInfo.working && btnInfo.working !== 'Pending') {
//                             continue;
//                         }

//                         tested++;
//                         await testSingleButton(btnInfo, btnInfo.index);
//                     }
//                     return tested;
//                 };

//                 // PHASE 1: TEST HEADER BUTTONS & DROPDOWNS
//                 sendUpdate({
//                     type: 'status',
//                     message: `Testing header buttons & dropdowns on page ${pageIndex + 1}...`,
//                     step: 'header-button-testing',
//                 });

//                 try {
//                     const headerTested = await testButtonsByRegion('header', 20);
//                     console.log(`   🔝 [Page ${pageIndex + 1}] Tested ${headerTested} header buttons`);
//                 } catch (headerBtnErr) {
//                     console.log('Header button testing error:', headerBtnErr.message);
//                 }

//                 // PHASE 2: TEST BODY BUTTONS
//                 sendUpdate({
//                     type: 'status',
//                     message: `Testing body buttons on page ${pageIndex + 1}...`,
//                     step: 'body-button-testing',
//                 });

//                 try {
//                     const bodyTested = await testButtonsByRegion('body', 20);
//                     console.log(`   📦 [Page ${pageIndex + 1}] Tested ${bodyTested} body buttons`);
//                 } catch (bodyBtnErr) {
//                     console.log('Body button testing error:', bodyBtnErr.message);
//                 }

//                 // ═══════════════════════════════════════════════════════════════
//                 // PAGE STATE RECOVERY: Ensure clean page before form testing
//                 // Button testing may have navigated away, submitted forms,
//                 // opened modals, or otherwise corrupted the DOM state.
//                 // ═══════════════════════════════════════════════════════════════
//                 const currentUrlBeforeForms = page.url();
//                 if (currentUrlBeforeForms !== pageInfo.href) {
//                     console.log(`   🔄 [Page ${pageIndex + 1}] URL drifted to ${currentUrlBeforeForms}, re-navigating to ${pageInfo.href}`);
//                     await page.goto(pageInfo.href, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
//                     await page.waitForTimeout(2000);
//                 } else {
//                     console.log(`   🔄 [Page ${pageIndex + 1}] Reloading page for clean form testing state...`);
//                     await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => { });
//                     await page.waitForTimeout(1500);
//                 }

//                 // --- INTERACTIVE FORM TESTING ---
//                 sendUpdate({
//                     type: 'status',
//                     message: `Testing forms on page ${pageIndex + 1}...`,
//                     step: 'form-testing',
//                 });

//                 try {
//                     // Step 1: Discover all forms on the page (both <form> and div-based sections)
//                     const formsMetadata = await page.evaluate(() => {
//                         // ── Helper: Extract fields from a container element ──
//                         const extractFields = (container) => {
//                             const fields = [];
//                             const seenCheckboxGroups = new Set();
//                             const seenRadioGroups = new Set();
//                             const inputs = container.querySelectorAll('input, textarea, select');
//                             inputs.forEach((inp, iIdx) => {
//                                 let type = inp.getAttribute('type') || (inp.tagName === 'TEXTAREA' ? 'textarea' : (inp.tagName === 'SELECT' ? 'select' : 'text'));
//                                 const knownTypes = ['text', 'email', 'password', 'tel', 'url', 'number', 'textarea', 'select', 'checkbox', 'radio', 'date', 'datetime-local', 'time', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'color', 'range', 'search', 'month', 'week'];
//                                 if (!knownTypes.includes(type)) type = 'text';
//                                 if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return;

//                                 const name = inp.getAttribute('name') || inp.getAttribute('id') || `field-${iIdx}`;

//                                 if (type === 'checkbox' && name) {
//                                     const groupKey = name.replace('[]', '');
//                                     if (seenCheckboxGroups.has(groupKey)) return;
//                                     seenCheckboxGroups.add(groupKey);
//                                 }

//                                 if (type === 'radio' && name) {
//                                     if (seenRadioGroups.has(name)) return;
//                                     seenRadioGroups.add(name);
//                                 }

//                                 const placeholder = inp.getAttribute('placeholder') || '';
//                                 const required = inp.hasAttribute('required') || inp.getAttribute('aria-required') === 'true';

//                                 const labelEl = inp.id ? document.querySelector(`label[for="${inp.id}"]`) : null;
//                                 const labelElText = labelEl ? labelEl.textContent.trim() : '';
//                                 const ariaLabel = inp.getAttribute('aria-label') || '';
//                                 const closestLabel = inp.closest('label')?.textContent?.trim() || '';
//                                 const prevSibLabel = inp.previousElementSibling?.tagName === 'LABEL' ? inp.previousElementSibling.textContent.trim() : '';
//                                 const parentLabel = inp.parentElement?.querySelector('label')?.textContent?.trim() || '';

//                                 let nextSibLabel = '';
//                                 let nextSib = inp.nextElementSibling;
//                                 for (let s = 0; s < 3 && nextSib; s++) {
//                                     const tag = nextSib.tagName;
//                                     if ((tag === 'SPAN' || tag === 'DIV' || tag === 'P') && !nextSib.querySelector('input, textarea, select')) {
//                                         const sibText = nextSib.textContent?.trim() || '';
//                                         const cls = nextSib.className || '';
//                                         if (sibText && !cls.includes('error') && !cls.includes('invalid') && !cls.includes('help')) {
//                                             nextSibLabel = sibText;
//                                             break;
//                                         }
//                                     }
//                                     nextSib = nextSib.nextElementSibling;
//                                 }

//                                 let parentSpanLabel = '';
//                                 const parentEl = inp.closest('.field, [class*="field"], [class*="input"], [class*="group"]') || inp.parentElement;
//                                 if (parentEl) {
//                                     const labelSpan = parentEl.querySelector('span[class*="label"], span[class*="title"], div[class*="label"]');
//                                     if (labelSpan && labelSpan !== inp) {
//                                         parentSpanLabel = labelSpan.textContent?.trim() || '';
//                                     }
//                                 }

//                                 const label = labelElText || ariaLabel || closestLabel || prevSibLabel || parentLabel || nextSibLabel || parentSpanLabel || placeholder || name;

//                                 const pattern = inp.getAttribute('pattern') || '';
//                                 const minLength = inp.getAttribute('minlength') || '';
//                                 const maxLength = inp.getAttribute('maxlength') || '';

//                                 const isPhoneWidget = inp.closest('.iti, .intl-tel-input, [class*="phone-input"], [class*="tel-input"]') !== null;

//                                 const nameLC = name.toLowerCase();
//                                 const labelLC = label.toLowerCase();
//                                 const isConfirmPassword = type === 'password' && (nameLC.includes('confirm') || nameLC.includes('retype') || nameLC.includes('re_pass') || nameLC.includes('password2') || labelLC.includes('confirm') || labelLC.includes('retype') || labelLC.includes('re-enter'));

//                                 fields.push({
//                                     index: iIdx,
//                                     name,
//                                     type,
//                                     label: label.substring(0, 60),
//                                     placeholder,
//                                     required,
//                                     pattern,
//                                     minLength,
//                                     maxLength,
//                                     isPhoneWidget,
//                                     isConfirmPassword,
//                                 });
//                             });
//                             return fields;
//                         };

//                         // ── Helper: Extract submit/action buttons from a container ──
//                         const extractButtons = (container, isDivForm) => {
//                             let submitBtns;
//                             if (isDivForm) {
//                                 submitBtns = Array.from(container.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn, a.button, [role="button"], i[class*="search"], i[class*="submit"], span[class*="submit"], span[class*="search-btn"], div[class*="submit"], svg'));
//                                 submitBtns = submitBtns.filter(btn => {
//                                     const text = (btn.textContent?.trim() || btn.value || '').toLowerCase();
//                                     const hasIcon = btn.querySelector('svg, i[class*="icon"], i[class*="fa"], img') !== null;
//                                     return (text && !['cancel', 'reset', 'close', 'back'].includes(text)) || (!text && hasIcon);
//                                 });
//                             } else {
//                                 submitBtns = Array.from(container.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])'));
//                             }
//                             const hasSubmitButton = submitBtns.length > 0;
//                             const submitButtonText = hasSubmitButton
//                                 ? (submitBtns[0].textContent?.trim() || submitBtns[0].value || submitBtns[0].getAttribute('aria-label') || submitBtns[0].getAttribute('title') || 'Icon Button').substring(0, 40)
//                                 : 'No Submit Button';
//                             return { hasSubmitButton, submitButtonText };
//                         };

//                         const results = [];

//                         // PART A: Discover standard <form> elements
//                         const forms = Array.from(document.querySelectorAll('form'));
//                         forms.forEach((form, fIdx) => {
//                             const formId = form.id || form.getAttribute('name') || `form-${fIdx}`;
//                             const action = form.getAttribute('action') || 'N/A';
//                             const method = (form.getAttribute('method') || 'GET').toUpperCase();
//                             const fields = extractFields(form);
//                             const { hasSubmitButton, submitButtonText } = extractButtons(form, false);

//                             results.push({
//                                 formIndex: fIdx,
//                                 formId,
//                                 action,
//                                 method,
//                                 fields,
//                                 hasSubmitButton,
//                                 submitButtonText,
//                                 totalFields: fields.length,
//                                 isDivForm: false,
//                             });
//                         });

//                         // PART B: Discover div-based form sections
//                         const orphanInputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(inp => {
//                             if (inp.closest('form')) return false;
//                             const type = inp.getAttribute('type') || (inp.tagName === 'TEXTAREA' ? 'textarea' : (inp.tagName === 'SELECT' ? 'select' : 'text'));
//                             return !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type);
//                         });

//                         if (orphanInputs.length > 0) {
//                             const containerSelectors = 'header, nav, [role="search"], [class*="header"], [class*="navbar"], section, [role="form"], [class*="form"], [class*="contact"], [class*="login"], [class*="signup"], [class*="register"], [class*="search"], [class*="newsletter"], [class*="subscribe"], [class*="auth"], [class*="signin"], [class*="sign-in"], [class*="checkout"], [class*="modal"], [class*="dialog"], .card, .panel, .modal-body, .dialog, [class*="widget"], main, article, aside';
//                             const seenContainers = new Set();
//                             const divForms = [];

//                             for (const inp of orphanInputs) {
//                                 const isSearchInput = inp.type === 'search' || (inp.name || '').toLowerCase() === 's' || (inp.name || '').toLowerCase().includes('search') || (inp.id || '').toLowerCase().includes('search') || (inp.placeholder || '').toLowerCase().includes('search');

//                                 let container = inp.closest(containerSelectors);
//                                 if (!container) {
//                                     let parent = inp.parentElement;
//                                     while (parent && parent !== document.body && parent.tagName !== 'HTML') {
//                                         const inputCount = parent.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
//                                         const btnCount = parent.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, [role="button"], i[class*="search"], svg').length;

//                                         if (inputCount >= 2 || (inputCount === 1 && btnCount >= 1) || isSearchInput) {
//                                             container = parent;
//                                             break;
//                                         }
//                                         parent = parent.parentElement;
//                                     }
//                                 }
//                                 if (!container) continue;

//                                 const containerKey = container.outerHTML.substring(0, 200);
//                                 if (seenContainers.has(containerKey)) continue;
//                                 if (container.closest('form')) continue;
//                                 seenContainers.add(containerKey);

//                                 const fields = extractFields(container);
//                                 if (fields.length < 1) continue;

//                                 const { hasSubmitButton, submitButtonText } = extractButtons(container, true);

//                                 const divId = container.id || container.getAttribute('name') ||
//                                     container.className?.split?.(' ')?.find?.(c => c.includes('form') || c.includes('contact') || c.includes('login') || c.includes('search') || c.includes('newsletter')) ||
//                                     `div-section-${divForms.length}`;

//                                 divForms.push({
//                                     container,
//                                     formId: typeof divId === 'string' ? divId.substring(0, 50) : `div-section-${divForms.length}`,
//                                     fields,
//                                     hasSubmitButton,
//                                     submitButtonText,
//                                 });
//                             }

//                             divForms.forEach((df, dIdx) => {
//                                 let selector = '';
//                                 if (df.container.id) {
//                                     selector = `#${df.container.id}`;
//                                 } else {
//                                     const tag = df.container.tagName.toLowerCase();
//                                     const cls = df.container.className?.split?.(' ')?.filter?.(c => c.trim())?.slice(0, 2)?.join('.') || '';
//                                     selector = cls ? `${tag}.${cls}` : tag;
//                                 }

//                                 results.push({
//                                     formIndex: forms.length + dIdx,
//                                     formId: df.formId,
//                                     action: 'N/A (div-based)',
//                                     method: 'N/A',
//                                     fields: df.fields,
//                                     hasSubmitButton: df.hasSubmitButton,
//                                     submitButtonText: df.submitButtonText,
//                                     totalFields: df.fields.length,
//                                     isDivForm: true,
//                                     divSelector: selector,
//                                 });
//                             });
//                         }

//                         return results;
//                     });

//                     console.log(`   📝 [Page ${pageIndex + 1}] Found ${formsMetadata.length} form sections (${formsMetadata.filter(f => !f.isDivForm).length} <form>, ${formsMetadata.filter(f => f.isDivForm).length} <div>-based)`);

//                     const formResults = [];

//                     // ═══════════════════════════════════════════════════════════════
//                     // HELPER: Build a lookup map from userDetails for form filling
//                     // userDetails = [{ type: "log", pairs: [{ key: "email", value: "x@y.com" }, ...] }, ...]
//                     // ═══════════════════════════════════════════════════════════════
//                     const userDetailsMap = new Map();
//                     if (userDetails && Array.isArray(userDetails)) {
//                         for (const row of userDetails) {
//                             if (row.pairs && Array.isArray(row.pairs)) {
//                                 for (const pair of row.pairs) {
//                                     if (pair.key && pair.value) {
//                                         userDetailsMap.set(pair.key.toLowerCase().trim(), pair.value.trim());
//                                     }
//                                 }
//                             }
//                         }
//                     }

//                     if (userDetailsMap.size > 0) {
//                         console.log(`   👤 [Page ${pageIndex + 1}] User details loaded: ${userDetailsMap.size} fields →`, Object.fromEntries(userDetailsMap));
//                     } else {
//                         console.log(`   👤 [Page ${pageIndex + 1}] No user details provided, using default test data`);
//                     }

//                     // ═══════════════════════════════════════════════════════════════
//                     // REUSABLE HELPER: Generate valid & invalid test data per type
//                     // Uses userDetails if a matching key is found, else defaults.
//                     // ═══════════════════════════════════════════════════════════════
//                     const getTestData = (field) => {
//                         const t = field.type;
//                         const nameLC = (field.name || '').toLowerCase();
//                         const labelLC = (field.label || '').toLowerCase();

//                         // Check if userDetails has a value for this field
//                         const userValue = userDetailsMap.get(nameLC)
//                             || userDetailsMap.get(labelLC)
//                             || userDetailsMap.get((field.placeholder || '').toLowerCase().trim())
//                             || null;

//                         if (field.isConfirmPassword) {
//                             const pwVal = userDetailsMap.get('password') || userDetailsMap.get('confirm_password') || userDetailsMap.get('confirmpassword') || 'ValidPassword123!';
//                             return { valid: userValue || pwVal, invalid: 'Mismatch99' };
//                         }

//                         if (field.isPhoneWidget || t === 'tel' || nameLC.includes('phone') || nameLC.includes('mobile') || labelLC.includes('phone') || labelLC.includes('mobile')) {
//                             return { valid: userValue || '9876543210', invalid: 'abc' };
//                         }

//                         switch (t) {
//                             case 'email':
//                                 return { valid: userValue || 'testuser@example.com', invalid: 'invalid-email' };
//                             case 'password':
//                                 return { valid: userValue || 'ValidPassword123!', invalid: '' };
//                             case 'url':
//                                 return { valid: userValue || 'https://example.com', invalid: 'not-a-url' };
//                             case 'number':
//                                 return { valid: userValue || '42', invalid: 'abc' };
//                             case 'date':
//                                 return { valid: userValue || '2025-06-15', invalid: '' };
//                             case 'datetime-local':
//                                 return { valid: userValue || '2025-06-15T10:30', invalid: '' };
//                             case 'time':
//                                 return { valid: userValue || '10:30', invalid: '' };
//                             case 'textarea':
//                                 return { valid: userValue || 'This is a test message for the textarea field.', invalid: '' };
//                             default: {
//                                 if (userValue) return { valid: userValue, invalid: '' };
//                                 if (nameLC.includes('email') || labelLC.includes('email') || nameLC.includes('login') || labelLC.includes('login'))
//                                     return { valid: 'testuser@example.com', invalid: 'invalid-email' };
//                                 if (nameLC.includes('user') || labelLC.includes('user') || labelLC.includes('username'))
//                                     return { valid: 'testuser123', invalid: '' };
//                                 if (nameLC.includes('first') || labelLC.includes('first'))
//                                     return { valid: 'John', invalid: '' };
//                                 if (nameLC.includes('last') || labelLC.includes('last'))
//                                     return { valid: 'Doe', invalid: '' };
//                                 if (nameLC.includes('company') || nameLC.includes('org') || labelLC.includes('company'))
//                                     return { valid: 'Test Corp', invalid: '' };
//                                 if (nameLC.includes('website') || labelLC.includes('website'))
//                                     return { valid: 'https://example.com', invalid: '' };
//                                 if (nameLC.includes('address') || labelLC.includes('address'))
//                                     return { valid: '123 Test Street', invalid: '' };
//                                 if (nameLC.includes('aadhar') || labelLC.includes('aadhar'))
//                                     return { valid: '123456789012', invalid: 'abc' };
//                                 if (nameLC.includes('salary') || labelLC.includes('salary'))
//                                     return { valid: '50000', invalid: '' };
//                                 if (nameLC.includes('hour') || labelLC.includes('hour') || nameLC.includes('hh:mm'))
//                                     return { valid: '08:00', invalid: '' };
//                                 return { valid: 'Test Input', invalid: '' };
//                             }
//                         }
//                     };

//                     // ═══════════════════════════════════════════════════════════════
//                     // REUSABLE HELPER: Capture field errors from multiple sources
//                     // Fixed: Narrower parent scope, avoids cross-field contamination
//                     // ═══════════════════════════════════════════════════════════════
//                     const captureFieldErrors = async (loc) => {
//                         const errorInfo = await loc.evaluate(el => {
//                             const valMsg = el.validationMessage || '';
//                             let isInvalid = false;
//                             try { isInvalid = el.matches(':invalid'); } catch (e) { }
//                             const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
//                             const hasInvalidClass = el.classList.contains('is-invalid') ||
//                                 el.classList.contains('error') ||
//                                 el.classList.contains('has-error') ||
//                                 el.classList.contains('invalid') ||
//                                 el.classList.contains('ng-invalid');

//                             let errorText = '';
//                             const errorSelectors = [
//                                 '.invalid-feedback', '.text-danger',
//                                 '.field-error', '.form-error', '.error-message',
//                                 '.help-block.error', '.validation-error', '.err-msg'
//                             ];

//                             // Check immediate next sibling first (most reliable)
//                             const next = el.nextElementSibling;
//                             if (next) {
//                                 for (const sel of errorSelectors) {
//                                     try {
//                                         if (next.matches(sel)) {
//                                             const txt = next.textContent?.trim() || '';
//                                             if (txt) { errorText = txt; break; }
//                                         }
//                                     } catch (e) { }
//                                 }
//                                 // Also check if next sibling has .error class specifically
//                                 if (!errorText && next.classList && next.classList.contains('error')) {
//                                     const txt = next.textContent?.trim() || '';
//                                     if (txt) errorText = txt;
//                                 }
//                             }

//                             // Walk up to nearest form-group/field wrapper (max 3 levels)
//                             if (!errorText) {
//                                 let parent = el.parentElement;
//                                 for (let depth = 0; depth < 3 && parent; depth++) {
//                                     for (const sel of errorSelectors) {
//                                         try {
//                                             const errEl = parent.querySelector(sel);
//                                             if (errEl && errEl !== el && !errEl.querySelector('input, textarea, select')) {
//                                                 const txt = errEl.textContent?.trim();
//                                                 if (txt) { errorText = txt; break; }
//                                             }
//                                         } catch (e) { }
//                                     }
//                                     if (errorText) break;
//                                     // Stop at form-group boundary
//                                     if (parent.classList && (
//                                         parent.classList.contains('form-group') ||
//                                         parent.classList.contains('form-field') ||
//                                         parent.classList.contains('mb-3') ||
//                                         parent.classList.contains('form-row')
//                                     )) break;
//                                     parent = parent.parentElement;
//                                 }
//                             }

//                             return {
//                                 valMsg,
//                                 isInvalid,
//                                 ariaInvalid,
//                                 hasInvalidClass,
//                                 errorText,
//                             };
//                         }).catch(() => ({ valMsg: '', isInvalid: false, ariaInvalid: false, hasInvalidClass: false, errorText: '' }));

//                         const msgs = [];
//                         if (errorInfo.valMsg) msgs.push(errorInfo.valMsg);
//                         if (errorInfo.errorText) msgs.push(errorInfo.errorText);
//                         if (msgs.length === 0 && (errorInfo.isInvalid || errorInfo.ariaInvalid)) msgs.push('Field marked invalid');
//                         if (msgs.length === 0 && errorInfo.hasInvalidClass) msgs.push('Invalid CSS class applied');

//                         return msgs.join(' | ') || '';
//                     };

//                     // ═══════════════════════════════════════════════════════════════
//                     // REUSABLE HELPER: Build stable locator for a field
//                     // Fixed: Proper regex escaping, safe CSS selectors, count checks
//                     // ═══════════════════════════════════════════════════════════════
//                     const escapeRegex = (str) => str.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');

//                     const getFieldLocator = async (field, formLocator) => {
//                         let loc = null;

//                         // Phone widget special handling
//                         if (field.isPhoneWidget) {
//                             try {
//                                 const phoneInput = formLocator.locator('.iti input[type="tel"], .intl-tel-input input[type="tel"], [class*="phone-input"] input[type="tel"], [class*="tel-input"] input[type="tel"]').first();
//                                 if (await phoneInput.count().catch(() => 0) > 0) return phoneInput;
//                             } catch (e) { }
//                         }

//                         // Try by label (not for checkbox/radio)
//                         if (field.label && field.label.length < 50 && !['checkbox', 'radio'].includes(field.type)) {
//                             try {
//                                 const escapedLabel = escapeRegex(field.label);
//                                 const l = formLocator.getByLabel(new RegExp(escapedLabel, 'i')).first();
//                                 if (await l.count().catch(() => 0) > 0) loc = l;
//                             } catch (e) { }
//                         }

//                         // Try by placeholder
//                         if (!loc && field.placeholder) {
//                             try {
//                                 const p = formLocator.getByPlaceholder(field.placeholder, { exact: false }).first();
//                                 if (await p.count().catch(() => 0) > 0) loc = p;
//                             } catch (e) { }
//                         }

//                         // Select: use name attribute only (avoid unsafe #id)
//                         if (!loc && (field.type === 'select')) {
//                             try {
//                                 const s = formLocator.locator(`select[name="${field.name}"]`).first();
//                                 if (await s.count().catch(() => 0) > 0) loc = s;
//                             } catch (e) { }
//                             // Fallback: try by id attribute selector (safe)
//                             if (!loc && field.name) {
//                                 try {
//                                     const s2 = formLocator.locator(`select[id="${field.name}"]`).first();
//                                     if (await s2.count().catch(() => 0) > 0) loc = s2;
//                                 } catch (e) { }
//                             }
//                         }

//                         // Checkbox
//                         if (!loc && (field.type === 'checkbox')) {
//                             try {
//                                 const cleanName = field.name.replace('[]', '');
//                                 const c = formLocator.locator(`input[type="checkbox"][name="${field.name}"], input[type="checkbox"][name="${cleanName}"], input[type="checkbox"][name="${cleanName}[]"]`).first();
//                                 if (await c.count().catch(() => 0) > 0) loc = c;
//                             } catch (e) { }
//                         }

//                         // Radio
//                         if (!loc && (field.type === 'radio')) {
//                             try {
//                                 const r = formLocator.locator(`input[type="radio"][name="${field.name}"]`).first();
//                                 if (await r.count().catch(() => 0) > 0) loc = r;
//                             } catch (e) { }
//                         }

//                         // Fallback: by name attribute (safest), then by id attribute selector
//                         if (!loc) {
//                             try {
//                                 const byName = formLocator.locator(`[name="${field.name}"]`).first();
//                                 if (await byName.count().catch(() => 0) > 0) {
//                                     loc = byName;
//                                 } else if (field.name && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(field.name)) {
//                                     const byId = formLocator.locator(`[id="${field.name}"]`).first();
//                                     if (await byId.count().catch(() => 0) > 0) loc = byId;
//                                 }
//                             } catch (e) { }
//                         }

//                         // Last resort: return a locator by name even if count is 0
//                         if (!loc) {
//                             loc = formLocator.locator(`[name="${field.name}"]`).first();
//                         }

//                         return loc;
//                     };

//                     // ═══════════════════════════════════════════════════════════════
//                     // REUSABLE FUNCTION: Test a single form field
//                     // ═══════════════════════════════════════════════════════════════
//                     const testSingleField = async (field, formLocator) => {
//                         const fieldTest = {
//                             name: field.name,
//                             label: field.label || field.placeholder || field.name,
//                             type: field.type,
//                             required: field.required || false,
//                             visible: false,
//                             enabled: false,
//                             invalidTest: { status: 'SKIPPED', error: '' },
//                             validTest: { status: 'SKIPPED', error: '' },
//                         };

//                         const loc = await getFieldLocator(field, formLocator);

//                         const isVisible = await loc.isVisible().catch(() => false);
//                         const isEnabled = await loc.isEnabled().catch(() => false);
//                         fieldTest.visible = isVisible;
//                         fieldTest.enabled = isEnabled;

//                         if (!isVisible || !isEnabled) {
//                             fieldTest.invalidTest = {
//                                 status: 'SKIPPED',
//                                 error: !isVisible ? 'Field not visible' : 'Field is disabled'
//                             };
//                             fieldTest.validTest = { ...fieldTest.invalidTest };
//                             return fieldTest;
//                         }

//                         await loc.scrollIntoViewIfNeeded().catch(() => { });

//                         const testData = getTestData(field);

//                         // TEXT-LIKE FIELDS
//                         const textTypes = ['text', 'email', 'password', 'tel', 'url', 'number', 'textarea', 'date', 'datetime-local', 'time'];
//                         if (textTypes.includes(field.type)) {

//                             // INVALID INPUT TEST
//                             if (field.required || testData.invalid) {
//                                 try {
//                                     await loc.fill('').catch(() => { });
//                                     if (testData.invalid) {
//                                         await loc.fill(testData.invalid).catch(() => { });
//                                     }
//                                     await loc.evaluate(el => {
//                                         el.dispatchEvent(new Event('input', { bubbles: true }));
//                                         el.dispatchEvent(new Event('change', { bubbles: true }));
//                                         el.blur();
//                                     }).catch(() => { });

//                                     // Wait for validation feedback (use loc directly, safer than elementHandle)
//                                     await page.waitForTimeout(500);
//                                     try {
//                                         await page.waitForFunction((selector) => {
//                                             const el = document.querySelector(selector);
//                                             if (!el) return false;
//                                             return el.validationMessage ||
//                                                 el.classList.contains('is-invalid') ||
//                                                 el.classList.contains('error') ||
//                                                 el.getAttribute('aria-invalid') === 'true' ||
//                                                 el.matches(':invalid') ||
//                                                 (el.nextElementSibling && (
//                                                     el.nextElementSibling.classList.contains('error') ||
//                                                     el.nextElementSibling.classList.contains('invalid-feedback') ||
//                                                     el.nextElementSibling.classList.contains('text-danger')
//                                                 ));
//                                         }, `[name="${field.name}"], #${/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(field.name) ? field.name : '__none__'}`,
//                                             { timeout: 1500 }).catch(() => { });
//                                     } catch (e) { }

//                                     const invalidError = await captureFieldErrors(loc);
//                                     fieldTest.invalidTest = {
//                                         status: invalidError ? 'PASS' : 'FAIL',
//                                         error: invalidError || 'No error shown for invalid/empty input'
//                                     };
//                                 } catch (e) {
//                                     fieldTest.invalidTest = { status: 'ERROR', error: `Invalid test error: ${e.message}` };
//                                 }
//                             }

//                             // VALID INPUT TEST
//                             // Clear stale error state first
//                             try {
//                                 await loc.fill('').catch(() => { });
//                                 await loc.evaluate(el => {
//                                     // Remove error classes/attributes from previous invalid test
//                                     el.classList.remove('is-invalid', 'error', 'has-error', 'invalid');
//                                     el.removeAttribute('aria-invalid');
//                                     // Clear adjacent error messages
//                                     const next = el.nextElementSibling;
//                                     if (next && (next.classList.contains('error') || next.classList.contains('invalid-feedback') || next.classList.contains('text-danger'))) {
//                                         next.textContent = '';
//                                         next.style.display = 'none';
//                                     }
//                                     el.dispatchEvent(new Event('input', { bubbles: true }));
//                                     el.dispatchEvent(new Event('change', { bubbles: true }));
//                                 }).catch(() => { });
//                                 await page.waitForTimeout(300);

//                                 await loc.fill(testData.valid).catch(() => { });
//                                 await loc.evaluate(el => {
//                                     el.dispatchEvent(new Event('input', { bubbles: true }));
//                                     el.dispatchEvent(new Event('change', { bubbles: true }));
//                                     el.blur();
//                                 }).catch(() => { });

//                                 // Wait for framework to process valid input
//                                 await page.waitForTimeout(500);

//                                 const validError = await captureFieldErrors(loc);
//                                 fieldTest.validTest = {
//                                     status: validError ? 'FAIL' : 'PASS',
//                                     error: validError || ''
//                                 };
//                             } catch (e) {
//                                 fieldTest.validTest = { status: 'ERROR', error: `Valid test error: ${e.message}` };
//                             }
//                         }

//                         // CHECKBOX
//                         else if (field.type === 'checkbox') {
//                             try {
//                                 await loc.check({ force: true }).catch(() => { });
//                                 const isChecked = await loc.isChecked().catch(() => false);
//                                 fieldTest.validTest = {
//                                     status: isChecked ? 'PASS' : 'FAIL',
//                                     error: isChecked ? '' : 'Failed to check checkbox'
//                                 };
//                                 if (isChecked) {
//                                     await loc.uncheck({ force: true }).catch(() => { });
//                                     const isUnchecked = !(await loc.isChecked().catch(() => true));
//                                     if (!isUnchecked) {
//                                         fieldTest.validTest.error = 'Checked but could not uncheck';
//                                     }
//                                     await loc.check({ force: true }).catch(() => { });
//                                 }
//                             } catch (e) {
//                                 fieldTest.validTest = { status: 'ERROR', error: `Checkbox test error: ${e.message}` };
//                             }
//                         }

//                         // RADIO
//                         else if (field.type === 'radio') {
//                             try {
//                                 await loc.check({ force: true }).catch(() => { });
//                                 const isChecked = await loc.isChecked().catch(() => false);
//                                 fieldTest.validTest = {
//                                     status: isChecked ? 'PASS' : 'FAIL',
//                                     error: isChecked ? '' : 'Failed to select radio option'
//                                 };
//                             } catch (e) {
//                                 fieldTest.validTest = { status: 'ERROR', error: `Radio test error: ${e.message}` };
//                             }
//                         }

//                         // SELECT (DROPDOWN)
//                         else if (field.type === 'select') {
//                             try {
//                                 const optionCount = await loc.evaluate(el => {
//                                     const opts = Array.from(el.options || []);
//                                     return opts.filter(o => o.value && o.value !== '' && !o.disabled).length;
//                                 }).catch(() => 0);

//                                 if (optionCount > 0) {
//                                     const selectedVal = await loc.evaluate(el => {
//                                         const validOpts = Array.from(el.options).filter(o => o.value && o.value !== '' && !o.disabled);
//                                         if (validOpts.length > 0) {
//                                             el.value = validOpts[0].value;
//                                             el.dispatchEvent(new Event('change', { bubbles: true }));
//                                             return validOpts[0].value;
//                                         }
//                                         return '';
//                                     }).catch(() => '');

//                                     if (selectedVal) {
//                                         const currentVal = await loc.inputValue().catch(() => '');
//                                         fieldTest.validTest = {
//                                             status: currentVal === selectedVal ? 'PASS' : 'FAIL',
//                                             error: currentVal === selectedVal ? '' : `Expected "${selectedVal}" but got "${currentVal}"`
//                                         };
//                                     } else {
//                                         fieldTest.validTest = { status: 'FAIL', error: 'No valid option to select' };
//                                     }
//                                 } else {
//                                     fieldTest.validTest = { status: 'SKIPPED', error: 'No selectable options available' };
//                                 }

//                                 if (field.required) {
//                                     await loc.evaluate(el => {
//                                         el.value = '';
//                                         el.dispatchEvent(new Event('change', { bubbles: true }));
//                                         el.blur();
//                                     }).catch(() => { });
//                                     const dropdownError = await captureFieldErrors(loc);
//                                     fieldTest.invalidTest = {
//                                         status: dropdownError ? 'PASS' : 'FAIL',
//                                         error: dropdownError || 'No error for empty required dropdown'
//                                     };
//                                     await loc.evaluate(el => {
//                                         const validOpts = Array.from(el.options).filter(o => o.value && o.value !== '' && !o.disabled);
//                                         if (validOpts.length > 0) {
//                                             el.value = validOpts[0].value;
//                                             el.dispatchEvent(new Event('change', { bubbles: true }));
//                                         }
//                                     }).catch(() => { });
//                                 }
//                             } catch (e) {
//                                 fieldTest.validTest = { status: 'ERROR', error: `Select test error: ${e.message}` };
//                             }
//                         }

//                         return fieldTest;
//                     };

//                     // ═══════════════════════════════════════════════════════════════
//                     // REUSABLE HELPER: Fill all fields with valid data before submit
//                     // ═══════════════════════════════════════════════════════════════
//                     const fillFormWithValidData = async (fields, formLocator) => {
//                         for (const field of fields) {
//                             try {
//                                 const loc = await getFieldLocator(field, formLocator);
//                                 const isVisible = await loc.isVisible().catch(() => false);
//                                 const isEnabled = await loc.isEnabled().catch(() => false);
//                                 if (!isVisible || !isEnabled) continue;

//                                 const testData = getTestData(field);

//                                 if (['text', 'email', 'password', 'tel', 'url', 'number', 'textarea', 'date', 'datetime-local', 'time'].includes(field.type)) {
//                                     await loc.fill('').catch(() => { });
//                                     await loc.fill(testData.valid).catch(() => { });
//                                     // Dispatch events so frameworks (React/Vue/Angular) process the value
//                                     await loc.evaluate(el => {
//                                         el.dispatchEvent(new Event('input', { bubbles: true }));
//                                         el.dispatchEvent(new Event('change', { bubbles: true }));
//                                         el.blur();
//                                     }).catch(() => { });
//                                 } else if (field.type === 'checkbox') {
//                                     await loc.check({ force: true }).catch(() => { });
//                                 } else if (field.type === 'radio') {
//                                     await loc.check({ force: true }).catch(() => { });
//                                 } else if (field.type === 'select') {
//                                     await loc.evaluate(el => {
//                                         const validOpts = Array.from(el.options).filter(o => o.value && o.value !== '' && !o.disabled);
//                                         if (validOpts.length > 0) {
//                                             el.value = validOpts[0].value;
//                                             el.dispatchEvent(new Event('change', { bubbles: true }));
//                                         }
//                                     }).catch(() => { });
//                                 }
//                             } catch (e) { /* Skip failed fields */ }
//                         }
//                         // Small delay for frameworks to process all field values
//                         await page.waitForTimeout(300);
//                     };

//                     // Helper: Clear all fields in a div-based section (no form.reset())
//                     // Fixed: Added radio button handling
//                     const clearAllFields = async (fields, containerLocator) => {
//                         for (const field of fields) {
//                             try {
//                                 const loc = await getFieldLocator(field, containerLocator);
//                                 const isVisible = await loc.isVisible().catch(() => false);
//                                 if (!isVisible) continue;

//                                 if (['text', 'email', 'password', 'tel', 'url', 'number', 'textarea', 'date', 'datetime-local', 'time'].includes(field.type)) {
//                                     await loc.fill('').catch(() => { });
//                                     // Also clear error states
//                                     await loc.evaluate(el => {
//                                         el.classList.remove('is-invalid', 'error', 'has-error', 'invalid');
//                                         el.removeAttribute('aria-invalid');
//                                     }).catch(() => { });
//                                 } else if (field.type === 'checkbox') {
//                                     await loc.uncheck({ force: true }).catch(() => { });
//                                 } else if (field.type === 'radio') {
//                                     // Radios can't be unchecked normally; deselect via JS
//                                     await loc.evaluate(el => {
//                                         const name = el.getAttribute('name');
//                                         if (name) {
//                                             const radios = document.querySelectorAll(`input[type="radio"][name="${name}"]`);
//                                             radios.forEach(r => { r.checked = false; });
//                                         }
//                                     }).catch(() => { });
//                                 } else if (field.type === 'select') {
//                                     await loc.evaluate(el => {
//                                         el.selectedIndex = 0;
//                                         el.dispatchEvent(new Event('change', { bubbles: true }));
//                                     }).catch(() => { });
//                                 }
//                             } catch (e) { /* skip */ }
//                         }
//                     };

//                     // ═══════════════════════════════════════════════════════════════
//                     // Test each form section (max 5 per page)
//                     // ═══════════════════════════════════════════════════════════════
//                     for (let f = 0; f < Math.min(formsMetadata.length, 5); f++) {
//                         const formMeta = formsMetadata[f];
//                         const formResult = {
//                             ...formMeta,
//                             fieldTests: [],
//                             invalidSubmitTest: { status: 'SKIPPED', result: '' },
//                             validSubmitTest: { status: 'SKIPPED', result: '' },
//                         };

//                         // Build container locator
//                         let formLocator;
//                         if (formMeta.isDivForm) {
//                             if (formMeta.divSelector) {
//                                 formLocator = page.locator(formMeta.divSelector).first();
//                             } else {
//                                 formLocator = page.locator(`#${formMeta.formId}, [class*="${formMeta.formId}"]`).first();
//                             }
//                         } else {
//                             const formIndex = formMeta.formIndex;
//                             formLocator = formMeta.formId && formMeta.formId !== `form-${formIndex}`
//                                 ? page.locator(`form#${formMeta.formId}, form[name="${formMeta.formId}"]`).first()
//                                 : page.locator('form').nth(formIndex);
//                         }

//                         const formVisible = await formLocator.isVisible().catch(() => false);
//                         if (!formVisible) {
//                             formResult.validSubmitTest = { status: 'SKIPPED', result: `${formMeta.isDivForm ? 'Div section' : 'Form'} not visible` };
//                             formResults.push(formResult);
//                             continue;
//                         }

//                         await formLocator.scrollIntoViewIfNeeded().catch(() => { });

//                         // PHASE 1: Test each field individually
//                         if (formMeta.isDivForm) {
//                             await clearAllFields(formMeta.fields, formLocator);
//                         } else {
//                             await formLocator.evaluate(form => {
//                                 if (typeof form.reset === 'function') form.reset();
//                             }).catch(() => { });
//                         }

//                         for (const field of formMeta.fields) {
//                             const fieldRes = await testSingleField(field, formLocator);
//                             formResult.fieldTests.push(fieldRes);
//                         }

//                         // PHASE 2: Submit with empty form (invalid submit test)
//                         if (formMeta.hasSubmitButton) {
//                             if (formMeta.isDivForm) {
//                                 await clearAllFields(formMeta.fields, formLocator);
//                             } else {
//                                 await formLocator.evaluate(form => {
//                                     if (typeof form.reset === 'function') form.reset();
//                                 }).catch(() => { });
//                             }

//                             let submitBtnLocator;
//                             if (formMeta.isDivForm) {
//                                 const escapedText = escapeRegex(formMeta.submitButtonText);
//                                 submitBtnLocator = formLocator.getByRole('button', { name: new RegExp(escapedText, 'i') })
//                                     .or(formLocator.locator('button, input[type="button"], input[type="submit"], a.btn, a.button, [role="button"], i[class*="search"], i[class*="submit"], span[class*="submit"], span[class*="search-btn"], div[class*="submit"], svg'))
//                                     .first();
//                             } else {
//                                 const escapedText = escapeRegex(formMeta.submitButtonText);
//                                 submitBtnLocator = formLocator.getByRole('button', { name: new RegExp(escapedText, 'i') })
//                                     .or(formLocator.locator('button[type="submit"], input[type="submit"], button:not([type])'))
//                                     .first();
//                             }

//                             const submitVisible = await submitBtnLocator.isVisible().catch(() => false);
//                             const submitEnabled = await submitBtnLocator.isEnabled().catch(() => false);

//                             if (submitVisible && submitEnabled) {
//                                 try {
//                                     await submitBtnLocator.click({ timeout: 2000 }).catch(() => { });

//                                     await page.waitForFunction(() => {
//                                         return document.querySelector('.error, .is-invalid, .invalid-feedback, .text-danger, .field-error, :invalid, [aria-invalid="true"]');
//                                     }, { timeout: 2000 }).catch(() => { });

//                                     const errorsFound = await page.evaluate(() => {
//                                         const errEls = document.querySelectorAll('.error, .is-invalid, .invalid-feedback, .text-danger, .field-error, [aria-invalid="true"]');
//                                         const invalidFields = document.querySelectorAll(':invalid');
//                                         return {
//                                             errorElements: errEls.length,
//                                             invalidFields: invalidFields.length,
//                                         };
//                                     }).catch(() => ({ errorElements: 0, invalidFields: 0 }));

//                                     if (errorsFound.errorElements > 0 || errorsFound.invalidFields > 0) {
//                                         formResult.invalidSubmitTest = {
//                                             status: 'PASS',
//                                             result: `Validation blocked submit (${errorsFound.errorElements} errors, ${errorsFound.invalidFields} invalid fields)`
//                                         };
//                                     } else {
//                                         formResult.invalidSubmitTest = {
//                                             status: 'FAIL',
//                                             result: 'Empty form submitted without validation errors'
//                                         };
//                                     }
//                                 } catch (e) {
//                                     formResult.invalidSubmitTest = { status: 'ERROR', result: `Invalid submit test error: ${e.message}` };
//                                 }
//                             }

//                             // PHASE 3: Submit with valid data
//                             if (formMeta.isDivForm) {
//                                 await clearAllFields(formMeta.fields, formLocator);
//                             } else {
//                                 await formLocator.evaluate(form => {
//                                     if (typeof form.reset === 'function') form.reset();
//                                 }).catch(() => { });
//                             }

//                             await fillFormWithValidData(formMeta.fields, formLocator);

//                             if (submitVisible && submitEnabled) {
//                                 const urlBefore = page.url();

//                                 const pagePromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);

//                                 try {
//                                     await submitBtnLocator.click({ timeout: 3000, force: true });

//                                     await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => { });

//                                     const newPage = await pagePromise;
//                                     const urlAfter = page.url();

//                                     let successMsgFound = false;
//                                     let errorAfterSubmit = false;

//                                     if (!newPage && urlAfter === urlBefore) {
//                                         successMsgFound = await page.locator(
//                                             '.success, .success-message, .alert-success, .toast-success, ' +
//                                             '[role="status"], .thank-you, .thankyou, .confirmation, ' +
//                                             '.swal2-success, .toast-body, .Toastify__toast--success, ' +
//                                             '[class*="success"], [class*="thank"]'
//                                         ).first()
//                                             .waitFor({ state: 'visible', timeout: 4000 })
//                                             .then(() => true)
//                                             .catch(() => false);

//                                         if (!successMsgFound) {
//                                             errorAfterSubmit = await page.evaluate(() => {
//                                                 const errEls = document.querySelectorAll('.error:not(:empty), .is-invalid, .invalid-feedback:not(:empty), .text-danger:not(:empty), [aria-invalid="true"]');
//                                                 return errEls.length > 0;
//                                             }).catch(() => false);
//                                         }
//                                     }

//                                     if (newPage) {
//                                         formResult.validSubmitTest = { status: 'PASS', result: 'Opened new tab on submit' };
//                                         await newPage.close().catch(() => { });
//                                     } else if (urlAfter !== urlBefore) {
//                                         formResult.validSubmitTest = { status: 'PASS', result: `Navigated to: ${urlAfter.substring(0, 100)}` };
//                                         await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {
//                                             return page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
//                                         });
//                                     } else if (successMsgFound) {
//                                         formResult.validSubmitTest = { status: 'PASS', result: 'Success message displayed after submit' };
//                                     } else if (errorAfterSubmit) {
//                                         formResult.validSubmitTest = { status: 'FAIL', result: 'Validation errors still present after valid data submit' };
//                                     } else {
//                                         formResult.validSubmitTest = { status: 'FAIL', result: 'No navigation, success message, or visible change after submit' };
//                                     }
//                                 } catch (e) {
//                                     formResult.validSubmitTest = { status: 'ERROR', result: `Submit click failed: ${e.message}` };
//                                 }
//                             } else {
//                                 formResult.validSubmitTest = {
//                                     status: 'FAIL',
//                                     result: submitVisible ? 'Submit button is disabled' : 'Submit button not visible'
//                                 };
//                             }
//                         } else {
//                             formResult.validSubmitTest = { status: 'SKIPPED', result: `No submit button found in this ${formMeta.isDivForm ? 'div section' : 'form'}` };
//                         }

//                         formResults.push(formResult);
//                     }

//                     pageResult.formTestResults = formResults;
//                     console.log(`   📝 [Page ${pageIndex + 1}] Tested ${formResults.length} forms with ${formResults.reduce((s, f) => s + f.fieldTests.length, 0)} fields`);

//                 } catch (formErr) {
//                     console.log('Form testing error:', formErr.message);
//                     pageResult.formTestResults = [];
//                 }

//                 // PHASE 3: TEST FOOTER BUTTONS (after form testing is complete)
//                 sendUpdate({
//                     type: 'status',
//                     message: `Testing footer buttons on page ${pageIndex + 1}...`,
//                     step: 'footer-button-testing',
//                 });

//                 try {
//                     const footerTested = await testButtonsByRegion('footer', 20);
//                     console.log(`   🔻 [Page ${pageIndex + 1}] Tested ${footerTested} footer buttons`);
//                 } catch (footerBtnErr) {
//                     console.log('Footer button testing error:', footerBtnErr.message);
//                 }

//                 sendUpdate({
//                     type: 'ai-analyzing',
//                     pageIndex,
//                     url: pageInfo.href,
//                     message: `Analyzing page ${pageIndex + 1}/${allPages.length} with Gemini AI...`,
//                 });

//                 const aiAnalysis = await analyzeScreenshot(screenshotPath, pageInfo.href, pageResult.title);
//                 pageResult.aiAnalysis = aiAnalysis;

//                 sendUpdate({
//                     type: 'ai-complete',
//                     pageIndex,
//                     url: pageInfo.href,
//                     analysis: aiAnalysis,
//                     screenshotUrl: pageResult.screenshotUrl,
//                     title: pageResult.title,
//                 });

//                 // GROQ AI ANALYSIS
//                 try {
//                     sendUpdate({
//                         type: 'status',
//                         message: `🧠 Groq AI analyzing page ${pageIndex + 1}/${allPages.length}...`,
//                         step: 'groq-analysis',
//                     });

//                     const groqResult = await runGroqAnalysisPipeline(
//                         screenshotPath, pageInfo.href, pageResult.title,
//                         userDetails, sendUpdate
//                     );

//                     if (groqResult.playwrightCode && groqResult.playwrightCode.success && groqResult.playwrightCode.testCode) {
//                         sendUpdate({
//                             type: 'status',
//                             message: `🧪 Running Groq AI test cases for page ${pageIndex + 1}...`,
//                             step: 'groq-test-execution',
//                         });

//                         const executionResults = await executeGroqTests(
//                             groqResult.playwrightCode.testCode,
//                             pageInfo.href,
//                             groqResult.playwrightCode.testFileName || 'groq_test.spec.js',
//                             sendUpdate
//                         );
//                         groqResult.executionResults = executionResults;
//                     }

//                     pageResult.groqAnalysis = groqResult;

//                     sendUpdate({
//                         type: 'groq-page-complete',
//                         pageIndex,
//                         url: pageInfo.href,
//                         groqAnalysis: groqResult,
//                     });

//                     console.log(`   🧠 [Page ${pageIndex + 1}] Groq AI analysis complete`);
//                 } catch (groqErr) {
//                     console.log(`   ⚠️ [Page ${pageIndex + 1}] Groq analysis error:`, groqErr.message);
//                     pageResult.groqAnalysis = { status: 'error', error: groqErr.message };
//                 }

//             } catch (pageError) {
//                 pageResult.loadStatus = 'ERROR';
//                 pageResult.error = pageError.message;
//                 sendUpdate({
//                     type: 'page-error',
//                     pageIndex,
//                     url: pageInfo.href,
//                     error: pageError.message,
//                 });
//             } finally {
//                 page.off('console', consoleHandler);
//                 page.off('requestfailed', requestFailedHandler);
//                 page.off('response', responseHandler);
//                 page.off('request', requestHandler);
//                 page.off('response', responseLogHandler);
//             }

//             report.pages.push(pageResult);
//             report.pagesCompleted = i + 1;

//             sendUpdate({
//                 type: 'page-complete',
//                 pageIndex,
//                 totalPages: allPages.length,
//                 progress: Math.round(((i + 1) / allPages.length) * 100),
//                 result: {
//                     url: pageResult.url,
//                     title: pageResult.title,
//                     loadStatus: pageResult.loadStatus,
//                     score: pageResult.aiAnalysis?.overallScore || 0,
//                     screenshotUrl: pageResult.screenshotUrl,
//                     elementsInfo: pageResult.elementsInfo,
//                     consoleErrors: pageResult.consoleErrors,
//                     networkErrors: pageResult.networkErrors,
//                     networkLog: pageResult.networkLog,
//                     brokenLinksCheck: pageResult.brokenLinksCheck,
//                     formTestResults: pageResult.formTestResults,
//                     imageCheckResults: pageResult.imageCheckResults,
//                     videoCheckResults: pageResult.videoCheckResults,
//                     aiAnalysis: pageResult.aiAnalysis,
//                     groqAnalysis: pageResult.groqAnalysis,
//                 },
//             });
//         }

//         // STEP 7: Generate Final Summary and Suggested Fixes
//         report.globalSummary.totalErrors = report.pages.reduce((sum, p) => sum + p.consoleErrors.length + p.networkErrors.length, 0);

//         report.pages.forEach(p => {
//             if (p.elementsInfo && p.elementsInfo.seo) {
//                 const seo = p.elementsInfo.seo;
//                 if (!seo.hasMetaDescription && !seo.hasOgDescription) {
//                     report.globalSummary.seoIssues.push({ url: p.url, issue: 'Missing meta description (standard & OG)' });
//                 }
//                 if (!seo.hasOgType) {
//                     report.globalSummary.seoIssues.push({ url: p.url, issue: 'Missing og:type tag' });
//                 }
//                 if (p.elementsInfo.counts.h1 === 0) {
//                     report.globalSummary.seoIssues.push({ url: p.url, issue: 'No H1 tag found' });
//                 } else if (p.elementsInfo.counts.h1 > 1) {
//                     report.globalSummary.seoIssues.push({ url: p.url, issue: 'Multiple H1 tags found' });
//                 }
//             }
//         });

//         const fixes = new Set();
//         if (report.globalSummary.brokenLinks.length > 0) fixes.add('Fix "href=#" and empty links by pointing them to valid endpoints or removing placeholders.');
//         if (report.globalSummary.missingResources.some(r => r.type === 'IMAGE')) fixes.add('Ensure all image src paths are correct and images are present on the server.');
//         if (report.globalSummary.missingResources.some(r => r.status === 404)) fixes.add('Resolve 404 errors by checking if resources (scripts, styles, images) were moved or renamed.');
//         if (report.globalSummary.missingResources.some(r => r.status === 500)) fixes.add('Check backend server logs for "Internal Server Error" details on failing API calls.');
//         if (report.globalSummary.totalErrors > 0) fixes.add('Review browser console for JavaScript type errors or unhandled promise rejections.');
//         if (report.globalSummary.seoIssues.length > 0) fixes.add('Update <head> section with unique meta descriptions and OpenGraph tags for better SEO/Social sharing.');

//         report.globalSummary.suggestedFixes = Array.from(fixes);

//         const scores = report.pages
//             .filter((p) => p.aiAnalysis && p.aiAnalysis.overallScore > 0)
//             .map((p) => p.aiAnalysis.overallScore);

//         report.overallScore = scores.length > 0
//             ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
//             : 0;

//         report.status = 'complete';
//         report.testDurationMs = Date.now() - testStartTime;

//         const reportPath = path.join(testDir, 'report.json');
//         fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

//         sendUpdate({
//             type: 'test-complete',
//             report: {
//                 testId: report.testId,
//                 frontendUrl: report.frontendUrl,
//                 backendUrl: report.backendUrl,
//                 testDate: report.testDate,
//                 totalPages: report.totalPages,
//                 pagesCompleted: report.pagesCompleted,
//                 overallScore: report.overallScore,
//                 status: report.status,
//                 testDurationMs: report.testDurationMs,
//                 headerLinks: report.headerLinks.length,
//                 footerLinks: report.footerLinks.length,
//                 globalSummary: report.globalSummary,
//                 pages: report.pages.map((p) => ({
//                     index: p.index,
//                     url: p.url,
//                     title: p.title,
//                     text: p.text,
//                     source: p.source,
//                     loadStatus: p.loadStatus,
//                     loadTimeMs: p.loadTimeMs,
//                     httpStatus: p.httpStatus,
//                     screenshotUrl: p.screenshotUrl,
//                     consoleErrors: p.consoleErrors,
//                     networkErrors: p.networkErrors,
//                     elementsInfo: p.elementsInfo,
//                     brokenLinksCheck: p.brokenLinksCheck || [],
//                     formTestResults: p.formTestResults || [],
//                     imageCheckResults: p.imageCheckResults || [],
//                     videoCheckResults: p.videoCheckResults || [],
//                     aiAnalysis: p.aiAnalysis,
//                     groqAnalysis: p.groqAnalysis,
//                     error: p.error,
//                 })),
//             },
//         });
//         return report;
//     } catch (error) {
//         report.status = 'error';
//         report.errorMessage = error.message;
//         report.testDurationMs = Date.now() - testStartTime;

//         sendUpdate({
//             type: 'test-error',
//             error: error.message,
//             report,
//         });

//         return report;
//     } finally {
//         if (browser) {
//             await browser.close();
//             console.log(`🔒 [${testId}] Browser closed`);
//         }
//     }
// }

// module.exports = { runWebsiteTest };




/**
 * ============================================================
 * playwrightTester.js - Multi-Page Playwright Automation
 * ============================================================
 * Crawls entire website: extracts header/footer nav links,
 * visits each page, takes screenshots, sends to Gemini AI,
 * and broadcasts live progress via WebSocket callbacks.
 * ============================================================
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { analyzeScreenshot } = require('./geminiAnalyzer');
const { runGroqAnalysisPipeline } = require('./groqAnalyzer');
const { executeGroqTests } = require('./groqTestRunner');
const fetch = require('node-fetch');

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Main multi-page website test
 * @param {string} testId - Unique test identifier
 * @param {string} frontendUrl - Frontend domain to test
 * @param {string} backendUrl - Backend domain (optional)
 * @param {string} scanType - 'domain' or 'url'
 * @param {object[]} userDetails - Key-value pair configs for testing
 * @param {function} sendUpdate - Callback to send live updates
 * @returns {object} Complete test report
 */
async function runWebsiteTest(testId, frontendUrl, backendUrl, scanType, userDetails, sendUpdate) {
    const testStartTime = Date.now();
    const testDir = path.join(REPORTS_DIR, testId);
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    const report = {
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
        errorMessage: null,
        testDurationMs: 0,
        globalSummary: {
            totalErrors: 0,
            brokenLinks: [],
            missingResources: [],
            seoIssues: [],
            elementStats: {
                totalImages: 0,
                totalLinks: 0,
                totalButtons: 0,
                totalMissingAlt: 0,
                totalMissingSrc: 0,
                totalDuplicateImages: 0
            },
            suggestedFixes: []
        }
    };

    let browser = null;

    try {
        // STEP 1: Launch Browser
        sendUpdate({
            type: 'status',
            message: 'Launching browser...',
            step: 'browser-launch',
        });

        browser = await chromium.launch({
            headless: false,
            slowMo: 300,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--start-maximized',
                '--disable-infobars',
            ],
        });

        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        // STEP 2: Open Homepage
        sendUpdate({
            type: 'status',
            message: `Opening homepage: ${frontendUrl}`,
            step: 'opening-homepage',
        });

        const loadStart = Date.now();
        let response;
        try {
            response = await page.goto(frontendUrl, {
                waitUntil: 'load',
                timeout: 45000,
            });
        } catch (err) {
            console.log(`⚠️ Initial load with 'load' failed, trying 'domcontentloaded'...`);
            response = await page.goto(frontendUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        }
        await page.waitForTimeout(2000);

        // Scroll the page to the bottom (or simulate scrolling)
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
        const loadTime = Date.now() - loadStart;
        const homeTitle = await page.title();

        sendUpdate({
            type: 'status',
            message: `Homepage loaded in ${loadTime}ms - "${homeTitle}"`,
            step: 'homepage-loaded',
        });

        let headerLinks = [];
        let footerLinks = [];
        let bodyLinks = [];

        let baseDomain = '';
        try {
            baseDomain = new URL(frontendUrl).hostname.replace(/^www\./, '');
        } catch (e) { }

        const isSameDomain = (href) => {
            try {
                const linkDomain = new URL(href).hostname.replace(/^www\./, '');
                return linkDomain === baseDomain;
            } catch (e) { return false; }
        };

        const isValidPageLink = (href) => {
            return href &&
                href.startsWith('http') &&
                !href.includes('#') &&
                !href.startsWith('javascript:') &&
                !href.startsWith('mailto:') &&
                !href.startsWith('tel:') &&
                !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3|doc|docx|xls|xlsx|ppt|css|js|json|xml|woff|woff2|ttf|eot)$/i) &&
                isSameDomain(href);
        };

        if (scanType !== 'url') {
            // STEP 3: Extract Header Navigation Links
            sendUpdate({
                type: 'status',
                message: 'Extracting header navigation links...',
                step: 'extracting-header-links',
            });

            headerLinks = await page.evaluate((baseUrl) => {
                const links = [];
                const selectors = [
                    'header a[href]',
                    'nav a[href]',
                    '[role="navigation"] a[href]',
                    '.navbar a[href]',
                    '.nav a[href]',
                    '.header a[href]',
                    '.menu a[href]',
                    '.main-nav a[href]',
                    '.dropdown-menu a[href]',
                    '.sub-menu a[href]',
                    '.mega-menu a[href]',
                    '[class*="dropdown"] a[href]',
                    '[class*="submenu"] a[href]',
                ];
                const seen = new Set();

                for (const selector of selectors) {
                    document.querySelectorAll(selector).forEach((a) => {
                        const href = a.href;
                        const text = a.textContent.trim().substring(0, 100);
                        if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
                            seen.add(href);
                            links.push({ href, text: text || 'No Text', source: 'header' });
                        }
                    });
                }
                return links;
            }, frontendUrl);

            report.headerLinks = headerLinks;

            // STEP 4: Extract Footer Links
            sendUpdate({
                type: 'status',
                message: 'Extracting footer links...',
                step: 'extracting-footer-links',
            });

            footerLinks = await page.evaluate((baseUrl) => {
                const links = [];
                const selectors = [
                    'footer a[href]',
                    '.footer a[href]',
                    '#footer a[href]',
                    '.site-footer a[href]',
                ];
                const seen = new Set();

                for (const selector of selectors) {
                    document.querySelectorAll(selector).forEach((a) => {
                        const href = a.href;
                        const text = a.textContent.trim().substring(0, 100);
                        if (href && href.startsWith('http') && !seen.has(href) && !href.includes('#') && !href.startsWith('javascript:') && !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|mp4|mp3)$/i)) {
                            seen.add(href);
                            links.push({ href, text: text || 'No Text', source: 'footer' });
                        }
                    });
                }
                return links;
            }, frontendUrl);

            report.footerLinks = footerLinks;

            // STEP 4.5: Extract ALL Body/Content Links (Full Domain mode)
            sendUpdate({
                type: 'status',
                message: 'Extracting all page links from body content...',
                step: 'extracting-body-links',
            });

            bodyLinks = await page.evaluate(() => {
                const links = [];
                const seen = new Set();
                document.querySelectorAll('a[href]').forEach((a) => {
                    const href = a.href;
                    const text = a.textContent.trim().substring(0, 100);
                    if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                        // Skip pure anchor links on same page
                        try {
                            const url = new URL(href);
                            if (url.hash && url.origin + url.pathname === window.location.origin + window.location.pathname) return;
                        } catch (e) { }
                        seen.add(href);
                        links.push({ href, text: text || 'No Text', source: 'body' });
                    }
                });
                return links;
            });

            // Also expose hidden dropdown/mega-menu links by hovering nav items
            try {
                const navItems = await page.locator('nav li, .navbar li, .menu li, header li').all();
                for (const item of navItems.slice(0, 30)) {
                    try {
                        await item.hover({ timeout: 500 }).catch(() => { });
                        await page.waitForTimeout(200);
                    } catch (e) { }
                }
                // Re-extract after hovering to catch any newly visible dropdown links
                const dropdownLinks = await page.evaluate(() => {
                    const links = [];
                    const seen = new Set();
                    document.querySelectorAll('.dropdown-menu a[href], .sub-menu a[href], [class*="dropdown"] a[href], [class*="submenu"] a[href], .mega-menu a[href]').forEach((a) => {
                        const href = a.href;
                        const text = a.textContent.trim().substring(0, 100);
                        if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:')) {
                            seen.add(href);
                            links.push({ href, text: text || 'No Text', source: 'dropdown' });
                        }
                    });
                    return links;
                });
                bodyLinks = [...bodyLinks, ...dropdownLinks];
            } catch (e) {
                console.log('Dropdown hover extraction skipped:', e.message);
            }
        }

        // Combine all unique links (homepage + header + footer + body)
        const allLinksMap = new Map();
        allLinksMap.set(frontendUrl, { href: frontendUrl, text: homeTitle || 'Homepage', source: 'homepage' });

        if (scanType !== 'url') {
            [...headerLinks, ...footerLinks, ...bodyLinks].forEach((link) => {
                // Normalize URL: remove trailing slash and query params for dedup
                let normalizedHref = link.href;
                try {
                    const u = new URL(normalizedHref);
                    normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
                } catch (e) { }

                if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
                    allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
                }
            });
        }

        let allPages = Array.from(allLinksMap.values());

        // STEP 4.6: Deep crawl — visit discovered pages to find MORE links (depth 2)
        if (scanType !== 'url' && allPages.length > 1) {
            sendUpdate({
                type: 'status',
                message: `Deep crawling ${Math.min(allPages.length - 1, 15)} discovered pages for more links...`,
                step: 'deep-crawl',
            });

            const pagesToDeepCrawl = allPages.slice(1, 16); // skip homepage (already crawled), max 15 sub-pages
            let newLinksFound = 0;

            for (const pageInfo of pagesToDeepCrawl) {
                try {
                    await page.goto(pageInfo.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                    await page.waitForTimeout(500);

                    const subPageLinks = await page.evaluate(() => {
                        const links = [];
                        const seen = new Set();
                        document.querySelectorAll('a[href]').forEach((a) => {
                            const href = a.href;
                            const text = a.textContent.trim().substring(0, 100);
                            if (href && href.startsWith('http') && !seen.has(href) && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                                seen.add(href);
                                links.push({ href, text: text || 'No Text', source: 'deep-crawl' });
                            }
                        });
                        return links;
                    });

                    for (const link of subPageLinks) {
                        let normalizedHref = link.href;
                        try {
                            const u = new URL(normalizedHref);
                            normalizedHref = u.origin + u.pathname.replace(/\/+$/, '') + u.search;
                        } catch (e) { }

                        if (!allLinksMap.has(normalizedHref) && isValidPageLink(link.href)) {
                            allLinksMap.set(normalizedHref, { ...link, href: normalizedHref });
                            newLinksFound++;
                        }
                    }
                } catch (e) {
                    // Skip pages that fail to load
                }
            }

            if (newLinksFound > 0) {
                console.log(`   🔍 Deep crawl found ${newLinksFound} additional pages`);
                allPages = Array.from(allLinksMap.values());

                sendUpdate({
                    type: 'status',
                    message: `Deep crawl found ${newLinksFound} more pages. Total: ${allPages.length}`,
                    step: 'deep-crawl-complete',
                });
            }

            // Navigate back to homepage for testing
            await page.goto(frontendUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => { });
            await page.waitForTimeout(1000);
        }

        report.totalPages = allPages.length;

        sendUpdate({
            type: 'links-discovered',
            headerLinks: headerLinks.length,
            footerLinks: footerLinks.length,
            bodyLinks: bodyLinks.length,
            totalPages: allPages.length,
            pages: allPages.map((p) => ({ url: p.href, text: p.text, source: p.source })),
        });

        console.log(`\n📊 [${testId}] Full Domain Scan Summary:`);
        console.log(`   Header links: ${headerLinks.length}`);
        console.log(`   Footer links: ${footerLinks.length}`);
        console.log(`   Body links: ${bodyLinks.length}`);
        console.log(`   Total unique pages to test: ${allPages.length}\n`);

        // STEP 5: Visit Each Page
        for (let i = 0; i < allPages.length; i++) {
            const pageInfo = allPages[i];
            const pageIndex = i;

            sendUpdate({
                type: 'page-start',
                pageIndex,
                totalPages: allPages.length,
                url: pageInfo.href,
                text: pageInfo.text,
                progress: Math.round((i / allPages.length) * 100),
            });

            const pageResult = {
                index: pageIndex,
                url: pageInfo.href,
                text: pageInfo.text,
                source: pageInfo.source,
                title: '',
                loadStatus: 'UNKNOWN',
                loadTimeMs: 0,
                httpStatus: 0,
                screenshotPath: '',
                screenshotUrl: '',
                consoleErrors: [],
                networkErrors: [],
                networkLog: {
                    requests: [],
                    summary: {
                        totalRequests: 0,
                        totalSize: 0,
                        totalTransferred: 0,
                        domContentLoaded: 0,
                        loadTime: 0,
                        finishTime: 0,
                    }
                },
                brokenLinksCheck: [],
                elementsInfo: {},
                imageCheckResults: [],
                videoCheckResults: [],
                aiAnalysis: null,
                groqAnalysis: null,
                error: null,
            };

            // Global listeners for this page visit
            const consoleErrors = [];
            const consoleHandler = (msg) => {
                if (msg.type() === 'error') {
                    consoleErrors.push({
                        type: 'CONSOLE_ERROR',
                        text: msg.text(),
                        location: msg.location().url || pageInfo.href
                    });
                }
            };

            const networkErrors = [];
            const requestFailedHandler = (request) => {
                networkErrors.push({
                    type: 'REQUEST_FAILED',
                    url: request.url(),
                    errorText: request.failure() ? request.failure().errorText : 'Unknown Error'
                });
            };

            const responseHandler = (res) => {
                if (res.status() >= 400) {
                    networkErrors.push({
                        type: 'HTTP_ERROR',
                        url: res.url(),
                        status: res.status(),
                        statusText: res.statusText()
                    });
                }
            };

            // --- NETWORK LOG: Track all requests with timing ---
            const networkRequests = new Map();
            const requestHandler = (request) => {
                networkRequests.set(request.url() + '_' + request.resourceType(), {
                    url: request.url(),
                    name: request.url().split('/').pop()?.split('?')[0] || request.url(),
                    method: request.method(),
                    resourceType: request.resourceType(),
                    startTime: Date.now(),
                    status: 0,
                    size: 0,
                    time: 0,
                });
            };

            const responseLogHandler = async (response) => {
                const key = response.url() + '_' + response.request().resourceType();
                const entry = networkRequests.get(key);
                if (entry) {
                    entry.status = response.status();
                    entry.time = Date.now() - entry.startTime;
                    try {
                        const body = await response.body().catch(() => null);
                        entry.size = body ? body.length : 0;
                    } catch {
                        entry.size = 0;
                    }
                }
            };

            page.on('console', consoleHandler);
            page.on('requestfailed', requestFailedHandler);
            page.on('response', responseHandler);
            page.on('request', requestHandler);
            page.on('response', responseLogHandler);

            try {
                const pageLoadStart = Date.now();
                let pageResponse;
                try {
                    pageResponse = await page.goto(pageInfo.href, {
                        waitUntil: 'load',
                        timeout: 35000,
                    });
                } catch (gotoErr) {
                    console.log(`⚠️ Failed to load ${pageInfo.href} with 'load', falling back...`);
                    pageResponse = await page.goto(pageInfo.href, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000,
                    }).catch(e => null);
                }

                pageResult.loadTimeMs = Date.now() - pageLoadStart;
                pageResult.httpStatus = pageResponse ? pageResponse.status() : 0;
                pageResult.loadStatus = pageResponse && pageResponse.ok() ? 'SUCCESS' : 'FAILED';
                pageResult.title = await page.title();
                pageResult.consoleErrors = consoleErrors;
                pageResult.networkErrors = networkErrors;

                // Capture performance timing from the browser
                const perfTiming = await page.evaluate(() => {
                    const p = performance.timing;
                    return {
                        domContentLoaded: p.domContentLoadedEventEnd - p.navigationStart,
                        loadTime: p.loadEventEnd - p.navigationStart,
                        finishTime: Date.now() - p.navigationStart,
                    };
                }).catch(() => ({ domContentLoaded: 0, loadTime: 0, finishTime: 0 }));

                // Build network log from captured requests
                const allNetworkEntries = Array.from(networkRequests.values());
                const totalSize = allNetworkEntries.reduce((sum, r) => sum + (r.size || 0), 0);
                pageResult.networkLog = {
                    requests: allNetworkEntries.map(r => ({
                        name: r.name,
                        url: r.url,
                        method: r.method,
                        status: r.status,
                        type: r.resourceType,
                        size: r.size,
                        time: r.time,
                    })),
                    summary: {
                        totalRequests: allNetworkEntries.length,
                        totalSize: totalSize,
                        totalTransferred: totalSize,
                        domContentLoaded: perfTiming.domContentLoaded,
                        loadTime: perfTiming.loadTime,
                        finishTime: perfTiming.finishTime,
                    }
                };

                // Wait for content to settle
                await page.waitForTimeout(1000);

                // Send live screenshot
                const liveBuffer = await page.screenshot({ type: 'png' });
                sendUpdate({
                    type: 'live-screenshot',
                    image: liveBuffer.toString('base64'),
                    url: pageInfo.href,
                    pageIndex,
                });

                // Gather deep page element info (SEO, element counts, broken items)
                pageResult.elementsInfo = await page.evaluate(async () => {
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

                    // Image Analysis: Total, Missing Src/Alt, Duplicates
                    const images = Array.from(document.querySelectorAll('img'));
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

                    const brokenLinks = [];
                    const links = Array.from(document.querySelectorAll('a'));
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

                    return {
                        seo: {
                            title: document.title,
                            description,
                            keywords,
                            ogType,
                            ogTitle,
                            hasMetaDescription: !!getMetaContent(['description']),
                            hasOgDescription: !!getMetaContent(['og:description']),
                            hasOgType: !!getMetaContent(['og:type']),
                            hasViewport: !!document.querySelector('meta[name="viewport" i]')
                        },
                        counts: {
                            images: images.length,
                            links: links.length,
                            h1: document.querySelectorAll('h1').length,
                            forms: document.querySelectorAll('form').length,
                            duplicateImages: totalDuplicateImages,
                            duplicateLinks: totalDuplicateLinks,
                            missingSrc: exactMissingSrc,
                            missingAlt: exactMissingAlt
                        },
                        broken: {
                            images: badImages.filter(img => img.isBroken || img.missingSrc),
                            links: brokenLinks
                        },
                        badImages,
                    };
                });

                // Update global summary stats
                report.globalSummary.elementStats.totalImages += pageResult.elementsInfo.counts.images;
                report.globalSummary.elementStats.totalLinks += pageResult.elementsInfo.counts.links;

                const missingAltCount = pageResult.elementsInfo.counts.missingAlt;
                const missingSrcCount = pageResult.elementsInfo.counts.missingSrc;

                report.globalSummary.elementStats.totalMissingAlt += missingAltCount;
                report.globalSummary.elementStats.totalMissingSrc += missingSrcCount;
                report.globalSummary.elementStats.totalDuplicateImages += pageResult.elementsInfo.counts.duplicateImages;

                pageResult.elementsInfo.broken.links.forEach(bl => {
                    report.globalSummary.brokenLinks.push({ url: pageResult.url, ...bl });
                });

                pageResult.elementsInfo.badImages.filter(img => img.issue === 'Broken Image' || img.issue === 'Missing SRC').forEach(bi => {
                    report.globalSummary.missingResources.push({ url: pageResult.url, type: 'IMAGE', ...bi });
                });

                networkErrors.forEach(ne => {
                    report.globalSummary.missingResources.push({ url: pageResult.url, type: 'NETWORK', ...ne });
                });

                // IMAGE CHECK: Visibility + Load Status (complete & width > 0)
                sendUpdate({
                    type: 'status',
                    message: `🖼️ Checking images on page ${pageIndex + 1}...`,
                    step: 'image-check',
                });

                try {
                    const imageCheckResults = await page.evaluate(() => {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        return imgs.map((img, idx) => {
                            const rawSrc = img.getAttribute('src');
                            const rawAlt = img.getAttribute('alt');
                            const src = rawSrc !== null ? String(rawSrc).trim() : null;
                            const alt = rawAlt !== null ? String(rawAlt).trim() : null;

                            // 1. Visibility check
                            const rect = img.getBoundingClientRect();
                            const style = window.getComputedStyle(img);
                            const isVisible = (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0 &&
                                img.offsetParent !== null
                            );

                            // 2. Load check: complete + naturalWidth > 0
                            const isComplete = img.complete;
                            const naturalWidth = img.naturalWidth || 0;
                            const naturalHeight = img.naturalHeight || 0;
                            const isLoaded = isComplete && naturalWidth > 0;
                            const isBroken = isComplete && naturalWidth === 0 && src && src !== '' && src !== '#';

                            // Determine overall status
                            let status = 'OK';
                            let reason = '';
                            if (!src || src === '' || src === '#') {
                                status = 'MISSING_SRC';
                                reason = 'Image has no valid src attribute';
                            } else if (!isVisible) {
                                status = 'HIDDEN';
                                reason = 'Image is not visible on screen (display:none, hidden, or zero size)';
                            } else if (isBroken) {
                                status = 'BROKEN';
                                reason = `Image failed to load (complete=true, naturalWidth=0). Src: ${src.substring(0, 100)}`;
                            } else if (!isComplete) {
                                status = 'LOADING';
                                reason = 'Image is still loading';
                            } else if (isLoaded && isVisible) {
                                status = 'OK';
                                reason = `Image loaded successfully (${naturalWidth}x${naturalHeight})`;
                            }

                            return {
                                index: idx,
                                src: src || 'MISSING',
                                alt: alt || 'MISSING',
                                isVisible,
                                isComplete,
                                naturalWidth,
                                naturalHeight,
                                isLoaded,
                                isBroken,
                                status,
                                reason,
                                displayWidth: Math.round(rect.width),
                                displayHeight: Math.round(rect.height),
                            };
                        });
                    });

                    pageResult.imageCheckResults = imageCheckResults;

                    const totalImages = imageCheckResults.length;
                    const okImages = imageCheckResults.filter(i => i.status === 'OK').length;
                    const brokenImages = imageCheckResults.filter(i => i.status === 'BROKEN').length;
                    const hiddenImages = imageCheckResults.filter(i => i.status === 'HIDDEN').length;
                    const missingSrcImages = imageCheckResults.filter(i => i.status === 'MISSING_SRC').length;

                    console.log(`   🖼️ [Page ${pageIndex + 1}] Image Check: ${totalImages} total | ${okImages} OK | ${brokenImages} Broken | ${hiddenImages} Hidden | ${missingSrcImages} Missing Src`);

                    sendUpdate({
                        type: 'image-check-complete',
                        pageIndex,
                        url: pageInfo.href,
                        summary: { totalImages, okImages, brokenImages, hiddenImages, missingSrcImages },
                        details: imageCheckResults,
                    });

                } catch (imgCheckErr) {
                    console.log('Image check error:', imgCheckErr.message);
                    pageResult.imageCheckResults = [];
                }

                // VIDEO CHECK: Visibility + readyState >= 3 (buffering complete)
                sendUpdate({
                    type: 'status',
                    message: `🎥 Checking videos on page ${pageIndex + 1}...`,
                    step: 'video-check',
                });

                try {
                    const videoCheckResults = await page.evaluate(() => {
                        const videos = Array.from(document.querySelectorAll('video'));
                        // Also check iframes for embedded videos (YouTube, Vimeo, etc.)
                        const iframeVideos = Array.from(document.querySelectorAll('iframe')).filter(iframe => {
                            const src = (iframe.getAttribute('src') || '').toLowerCase();
                            return src.includes('youtube') || src.includes('youtu.be') ||
                                src.includes('vimeo') || src.includes('dailymotion') ||
                                src.includes('wistia') || src.includes('player');
                        });

                        const results = [];

                        // Check native <video> elements
                        videos.forEach((video, idx) => {
                            const sources = Array.from(video.querySelectorAll('source'));
                            const videoSrc = video.getAttribute('src') || (sources.length > 0 ? sources[0].getAttribute('src') : null);
                            const poster = video.getAttribute('poster') || null;

                            // 1. Visibility check
                            const rect = video.getBoundingClientRect();
                            const style = window.getComputedStyle(video);
                            const isVisible = (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0
                            );

                            // 2. readyState check
                            const readyState = video.readyState;
                            const isReady = readyState >= 3;
                            const duration = video.duration || 0;
                            const paused = video.paused;
                            const muted = video.muted;
                            const autoplay = video.autoplay;
                            const networkState = video.networkState;
                            const errorCode = video.error ? video.error.code : null;

                            // Determine readyState label
                            const readyStateLabels = {
                                0: 'HAVE_NOTHING',
                                1: 'HAVE_METADATA',
                                2: 'HAVE_CURRENT_DATA',
                                3: 'HAVE_FUTURE_DATA',
                                4: 'HAVE_ENOUGH_DATA'
                            };

                            let status = 'OK';
                            let reason = '';

                            if (!videoSrc && sources.length === 0) {
                                status = 'MISSING_SRC';
                                reason = 'Video has no src or source elements';
                            } else if (!isVisible) {
                                status = 'HIDDEN';
                                reason = 'Video player is not visible on screen';
                            } else if (errorCode) {
                                status = 'ERROR';
                                const errorMessages = {
                                    1: 'MEDIA_ERR_ABORTED - Playback aborted by user',
                                    2: 'MEDIA_ERR_NETWORK - Network error while downloading',
                                    3: 'MEDIA_ERR_DECODE - Error decoding video',
                                    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - Video format not supported'
                                };
                                reason = errorMessages[errorCode] || `Unknown error code: ${errorCode}`;
                            } else if (readyState === 0) {
                                status = 'NOT_LOADED';
                                reason = 'Video has not started loading (readyState=0)';
                            } else if (readyState < 3) {
                                status = 'BUFFERING';
                                reason = `Video is buffering (readyState=${readyState}: ${readyStateLabels[readyState] || 'Unknown'})`;
                            } else {
                                status = 'OK';
                                reason = `Video ready to play (readyState=${readyState}: ${readyStateLabels[readyState] || 'Unknown'}, duration=${duration.toFixed(1)}s)`;
                            }

                            results.push({
                                index: idx,
                                type: 'native',
                                src: videoSrc || 'MISSING',
                                poster: poster || 'NONE',
                                isVisible,
                                readyState,
                                readyStateLabel: readyStateLabels[readyState] || 'Unknown',
                                isReady,
                                duration: Math.round(duration * 10) / 10,
                                paused,
                                muted,
                                autoplay,
                                errorCode,
                                status,
                                reason,
                                displayWidth: Math.round(rect.width),
                                displayHeight: Math.round(rect.height),
                            });
                        });

                        // Check embedded iframe videos
                        iframeVideos.forEach((iframe, idx) => {
                            const src = iframe.getAttribute('src') || '';
                            const rect = iframe.getBoundingClientRect();
                            const style = window.getComputedStyle(iframe);
                            const isVisible = (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0
                            );

                            let platform = 'unknown';
                            if (src.includes('youtube') || src.includes('youtu.be')) platform = 'YouTube';
                            else if (src.includes('vimeo')) platform = 'Vimeo';
                            else if (src.includes('dailymotion')) platform = 'Dailymotion';
                            else if (src.includes('wistia')) platform = 'Wistia';
                            else platform = 'Embedded Player';

                            results.push({
                                index: videos.length + idx,
                                type: 'iframe',
                                src: src.substring(0, 200),
                                platform,
                                isVisible,
                                readyState: isVisible ? 4 : 0,
                                readyStateLabel: isVisible ? 'EMBEDDED_VISIBLE' : 'EMBEDDED_HIDDEN',
                                isReady: isVisible,
                                duration: 0,
                                paused: false,
                                muted: false,
                                autoplay: false,
                                errorCode: null,
                                status: isVisible ? 'OK' : 'HIDDEN',
                                reason: isVisible
                                    ? `${platform} embed is visible and loaded`
                                    : `${platform} embed is not visible on screen`,
                                displayWidth: Math.round(rect.width),
                                displayHeight: Math.round(rect.height),
                            });
                        });

                        return results;
                    });

                    pageResult.videoCheckResults = videoCheckResults;

                    const totalVideos = videoCheckResults.length;
                    const nativeVideos = videoCheckResults.filter(v => v.type === 'native').length;
                    const iframeVideos = videoCheckResults.filter(v => v.type === 'iframe').length;
                    const readyVideos = videoCheckResults.filter(v => v.status === 'OK').length;
                    const brokenVideos = videoCheckResults.filter(v => ['ERROR', 'NOT_LOADED', 'MISSING_SRC'].includes(v.status)).length;
                    const bufferingVideos = videoCheckResults.filter(v => v.status === 'BUFFERING').length;

                    console.log(`   🎥 [Page ${pageIndex + 1}] Video Check: ${totalVideos} total (${nativeVideos} native, ${iframeVideos} iframe) | ${readyVideos} Ready | ${brokenVideos} Broken | ${bufferingVideos} Buffering`);

                    sendUpdate({
                        type: 'video-check-complete',
                        pageIndex,
                        url: pageInfo.href,
                        summary: { totalVideos, nativeVideos, iframeVideos, readyVideos, brokenVideos, bufferingVideos },
                        details: videoCheckResults,
                    });

                } catch (vidCheckErr) {
                    console.log('Video check error:', vidCheckErr.message);
                    pageResult.videoCheckResults = [];
                }

                // --- BROKEN LINK VERIFICATION (actual HTTP checks) ---
                sendUpdate({
                    type: 'status',
                    message: `Checking links on page ${pageIndex + 1} for broken URLs...`,
                    step: 'broken-link-check',
                });

                try {
                    const allPageLinks = await page.evaluate(() => {
                        const anchors = Array.from(document.querySelectorAll('a'));
                        const results = [];
                        const seen = new Set();

                        anchors.forEach(a => {
                            const href = a.getAttribute('href');
                            const text = (a.textContent || '').trim().substring(0, 60) || 'No Text Found';

                            let finalUrl = href || 'MISSING';
                            if (href && href.trim() !== '' && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:') && href !== '#') {
                                try {
                                    finalUrl = new URL(href.trim(), document.baseURI).href;
                                } catch {
                                    finalUrl = href;
                                }
                            }

                            let isDuplicate = false;
                            let normalizedForDup = finalUrl.split('#')[0];
                            if (normalizedForDup.endsWith('/')) {
                                normalizedForDup = normalizedForDup.slice(0, -1);
                            }

                            if (normalizedForDup !== 'MISSING' && normalizedForDup !== '') {
                                if (seen.has(normalizedForDup)) {
                                    isDuplicate = true;
                                } else {
                                    seen.add(normalizedForDup);
                                }
                            }

                            results.push({ text, href: finalUrl, isDuplicate });
                        });
                        return results;
                    });

                    const linksToCheck = allPageLinks;
                    const allLinksList = [];

                    for (const link of linksToCheck) {
                        allLinksList.push({
                            text: link.text || 'No Text Found',
                            href: link.href,
                            isDuplicate: link.isDuplicate,
                            status: 200,
                            reason: link.isDuplicate ? 'Duplicate Link' : 'Link Discovered'
                        });
                    }

                    pageResult.brokenLinksCheck = allLinksList;

                    if (pageResult.elementsInfo && pageResult.elementsInfo.counts) {
                        pageResult.elementsInfo.counts.brokenLinks = 0;
                        pageResult.elementsInfo.counts.linksChecked = allLinksList.length;
                    }

                    console.log(`   🔗 [Page ${pageIndex + 1}] Found ${allLinksList.length} links to display.`);
                } catch (blErr) {
                    console.log('List links error:', blErr.message);
                    pageResult.brokenLinksCheck = [];
                }

                // Take full-page screenshot
                const screenshotName = `page_${pageIndex}_${Date.now()}.png`;
                const screenshotPath = path.join(testDir, screenshotName);
                await page.screenshot({
                    path: screenshotPath,
                    fullPage: true,
                });
                pageResult.screenshotPath = screenshotPath;
                pageResult.screenshotUrl = `/api/screenshots/${testId}/${screenshotName}`;

                sendUpdate({
                    type: 'ai-analyzing',
                    pageIndex,
                    url: pageInfo.href,
                    message: `Analyzing page ${pageIndex + 1}/${allPages.length} with Gemini AI...`,
                });

                const aiAnalysis = await analyzeScreenshot(screenshotPath, pageInfo.href, pageResult.title);
                pageResult.aiAnalysis = aiAnalysis;

                sendUpdate({
                    type: 'ai-complete',
                    pageIndex,
                    url: pageInfo.href,
                    analysis: aiAnalysis,
                    screenshotUrl: pageResult.screenshotUrl,
                    title: pageResult.title,
                });

                // GROQ AI ANALYSIS
                try {
                    sendUpdate({
                        type: 'status',
                        message: `🧠 Groq AI analyzing page ${pageIndex + 1}/${allPages.length}...`,
                        step: 'groq-analysis',
                    });

                    const groqResult = await runGroqAnalysisPipeline(
                        screenshotPath, pageInfo.href, pageResult.title,
                        userDetails, sendUpdate
                    );

                    if (groqResult.playwrightCode && groqResult.playwrightCode.success && groqResult.playwrightCode.testCode) {
                        sendUpdate({
                            type: 'status',
                            message: `🧪 Running Groq AI test cases for page ${pageIndex + 1}...`,
                            step: 'groq-test-execution',
                        });

                        const executionResults = await executeGroqTests(
                            groqResult.playwrightCode.testCode,
                            pageInfo.href,
                            groqResult.playwrightCode.testFileName || 'groq_test.spec.js',
                            sendUpdate
                        );
                        groqResult.executionResults = executionResults;
                    }

                    pageResult.groqAnalysis = groqResult;

                    sendUpdate({
                        type: 'groq-page-complete',
                        pageIndex,
                        url: pageInfo.href,
                        groqAnalysis: groqResult,
                    });

                    console.log(`   🧠 [Page ${pageIndex + 1}] Groq AI analysis complete`);
                } catch (groqErr) {
                    console.log(`   ⚠️ [Page ${pageIndex + 1}] Groq analysis error:`, groqErr.message);
                    pageResult.groqAnalysis = { status: 'error', error: groqErr.message };
                }

            } catch (pageError) {
                pageResult.loadStatus = 'ERROR';
                pageResult.error = pageError.message;
                sendUpdate({
                    type: 'page-error',
                    pageIndex,
                    url: pageInfo.href,
                    error: pageError.message,
                });
            } finally {
                page.off('console', consoleHandler);
                page.off('requestfailed', requestFailedHandler);
                page.off('response', responseHandler);
                page.off('request', requestHandler);
                page.off('response', responseLogHandler);
            }

            report.pages.push(pageResult);
            report.pagesCompleted = i + 1;

            sendUpdate({
                type: 'page-complete',
                pageIndex,
                totalPages: allPages.length,
                progress: Math.round(((i + 1) / allPages.length) * 100),
                result: {
                    url: pageResult.url,
                    title: pageResult.title,
                    loadStatus: pageResult.loadStatus,
                    score: pageResult.aiAnalysis?.overallScore || 0,
                    screenshotUrl: pageResult.screenshotUrl,
                    elementsInfo: pageResult.elementsInfo,
                    consoleErrors: pageResult.consoleErrors,
                    networkErrors: pageResult.networkErrors,
                    networkLog: pageResult.networkLog,
                    brokenLinksCheck: pageResult.brokenLinksCheck,
                    imageCheckResults: pageResult.imageCheckResults,
                    videoCheckResults: pageResult.videoCheckResults,
                    aiAnalysis: pageResult.aiAnalysis,
                    groqAnalysis: pageResult.groqAnalysis,
                },
            });
        }

        // STEP 7: Generate Final Summary and Suggested Fixes
        report.globalSummary.totalErrors = report.pages.reduce((sum, p) => sum + p.consoleErrors.length + p.networkErrors.length, 0);

        report.pages.forEach(p => {
            if (p.elementsInfo && p.elementsInfo.seo) {
                const seo = p.elementsInfo.seo;
                if (!seo.hasMetaDescription && !seo.hasOgDescription) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'Missing meta description (standard & OG)' });
                }
                if (!seo.hasOgType) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'Missing og:type tag' });
                }
                if (p.elementsInfo.counts.h1 === 0) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'No H1 tag found' });
                } else if (p.elementsInfo.counts.h1 > 1) {
                    report.globalSummary.seoIssues.push({ url: p.url, issue: 'Multiple H1 tags found' });
                }
            }
        });

        const fixes = new Set();
        if (report.globalSummary.brokenLinks.length > 0) fixes.add('Fix "href=#" and empty links by pointing them to valid endpoints or removing placeholders.');
        if (report.globalSummary.missingResources.some(r => r.type === 'IMAGE')) fixes.add('Ensure all image src paths are correct and images are present on the server.');
        if (report.globalSummary.missingResources.some(r => r.status === 404)) fixes.add('Resolve 404 errors by checking if resources (scripts, styles, images) were moved or renamed.');
        if (report.globalSummary.missingResources.some(r => r.status === 500)) fixes.add('Check backend server logs for "Internal Server Error" details on failing API calls.');
        if (report.globalSummary.totalErrors > 0) fixes.add('Review browser console for JavaScript type errors or unhandled promise rejections.');
        if (report.globalSummary.seoIssues.length > 0) fixes.add('Update <head> section with unique meta descriptions and OpenGraph tags for better SEO/Social sharing.');

        report.globalSummary.suggestedFixes = Array.from(fixes);

        const scores = report.pages
            .filter((p) => p.aiAnalysis && p.aiAnalysis.overallScore > 0)
            .map((p) => p.aiAnalysis.overallScore);

        report.overallScore = scores.length > 0
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : 0;

        report.status = 'complete';
        report.testDurationMs = Date.now() - testStartTime;

        const reportPath = path.join(testDir, 'report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

        sendUpdate({
            type: 'test-complete',
            report: {
                testId: report.testId,
                frontendUrl: report.frontendUrl,
                backendUrl: report.backendUrl,
                testDate: report.testDate,
                totalPages: report.totalPages,
                pagesCompleted: report.pagesCompleted,
                overallScore: report.overallScore,
                status: report.status,
                testDurationMs: report.testDurationMs,
                headerLinks: report.headerLinks.length,
                footerLinks: report.footerLinks.length,
                globalSummary: report.globalSummary,
                pages: report.pages.map((p) => ({
                    index: p.index,
                    url: p.url,
                    title: p.title,
                    text: p.text,
                    source: p.source,
                    loadStatus: p.loadStatus,
                    loadTimeMs: p.loadTimeMs,
                    httpStatus: p.httpStatus,
                    screenshotUrl: p.screenshotUrl,
                    consoleErrors: p.consoleErrors,
                    networkErrors: p.networkErrors,
                    elementsInfo: p.elementsInfo,
                    brokenLinksCheck: p.brokenLinksCheck || [],
                    imageCheckResults: p.imageCheckResults || [],
                    videoCheckResults: p.videoCheckResults || [],
                    aiAnalysis: p.aiAnalysis,
                    groqAnalysis: p.groqAnalysis,
                    error: p.error,
                })),
            },
        });
        return report;
    } catch (error) {
        report.status = 'error';
        report.errorMessage = error.message;
        report.testDurationMs = Date.now() - testStartTime;

        sendUpdate({
            type: 'test-error',
            error: error.message,
            report,
        });

        return report;
    } finally {
        if (browser) {
            await browser.close();
            console.log(`🔒 [${testId}] Browser closed`);
        }
    }
}

module.exports = { runWebsiteTest };