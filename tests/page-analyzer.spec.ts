/**
 * ============================================================
 * PAGE ANALYZER — Full Diagnostic Test Suite
 * ============================================================
 *
 * A comprehensive Playwright test that performs a full
 * diagnostic scan of any given URL.
 *
 * Configure via: PAGE_URL env variable (fallback: https://example.com)
 *
 * MODULES:
 *   1. Image Audit         — total <img>, missing src, missing alt, both missing
 *   2. Duplicate Images    — normalized URL grouping, duplicate src detection
 *   3. Link Inspector      — total <a>, valid/empty/hash hrefs, duplicate hrefs
 *   4. Button Interaction  — click every button, detect errors/nav/crashes
 *   5. Network Finish Time — DOM-ready, full-load, network-idle timing
 *   6. Final Report        — consolidated summary printed to stdout
 *
 * Run:
 *   set PAGE_URL=https://apple.com && npx playwright test tests/page-analyzer.spec.ts --headed --project=chromium
 *
 * ============================================================
 */

import { test } from '@playwright/test';

const PAGE_URL = process.env.PAGE_URL || 'https://example.com';

/* ─── Result Interfaces ───────────────────────────────────── */

interface ImageAuditResult {
    total: number;
    missingSrc: number;
    missingAlt: number;
    bothMissing: number;
}

interface DuplicateImageResult {
    uniqueUrls: number;
    duplicateCount: number;
    duplicates: { src: string; count: number }[];
}

interface LinkInspectorResult {
    total: number;
    validHref: number;
    emptyHash: number;
    duplicateCount: number;
    duplicates: { href: string; count: number }[];
}

interface ButtonResult {
    text: string;
    status: 'PASS' | 'WARN' | 'NAV' | 'FAIL' | 'SKIP';
    reason: string;
}

interface ButtonSummary {
    tested: number;
    pass: number;
    warn: number;
    nav: number;
    fail: number;
    skip: number;
    results: ButtonResult[];
}

interface PerformanceResult {
    domContentLoaded: number;
    pageLoad: number;
    networkIdle: boolean;
}

/* ─── Helpers ─────────────────────────────────────────────── */

function pad(val: string | number, width: number): string {
    return String(val).padStart(width);
}

function truncate(str: string, max: number): string {
    return str.length > max ? str.substring(0, max - 3) + '...' : str;
}

/* ═══════════════════════════════════════════════════════════
   MAIN TEST
   ═══════════════════════════════════════════════════════════ */

test('Page Analyzer — Full Diagnostic Scan', async ({ page }) => {

    // ─── Shared result buckets (populated by each module) ───
    let imageAudit: ImageAuditResult = { total: 0, missingSrc: 0, missingAlt: 0, bothMissing: 0 };
    let duplicateImages: DuplicateImageResult = { uniqueUrls: 0, duplicateCount: 0, duplicates: [] };
    let linkInspector: LinkInspectorResult = { total: 0, validHref: 0, emptyHash: 0, duplicateCount: 0, duplicates: [] };
    let buttonSummary: ButtonSummary = { tested: 0, pass: 0, warn: 0, nav: 0, fail: 0, skip: 0, results: [] };
    let perfResult: PerformanceResult = { domContentLoaded: 0, pageLoad: 0, networkIdle: false };

    /* ─── Navigate to target URL ──────────────────────────── */
    console.log(`\n🌐 Navigating to: ${PAGE_URL}\n`);

    let networkIdle = false;
    try {
        await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 45_000 });
        networkIdle = true;
    } catch {
        console.log('⚠️  networkidle timed out — falling back to domcontentloaded');
        try {
            await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {
            await page.goto(PAGE_URL, { waitUntil: 'commit', timeout: 30_000 });
        }
    }

    // Scroll entire page to trigger lazy-loaded images / content
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    window.scrollTo(0, 0);   // back to top
                    resolve();
                }
            }, 80);
        });
    });
    // Let lazy content settle
    await page.waitForTimeout(2000);


    /* ═════════════════════════════════════════════════════════
       MODULE 5 — NETWORK FINISH TIME  (captured first)
       ═════════════════════════════════════════════════════════ */
    await test.step('Module 5 — Network Finish Time', async () => {
        try {
            const timing = await page.evaluate(() => {
                const p = performance.timing;
                return {
                    domContentLoaded: p.domContentLoadedEventEnd - p.navigationStart,
                    pageLoad: p.loadEventEnd - p.navigationStart,
                };
            });

            perfResult = {
                domContentLoaded: timing.domContentLoaded,
                pageLoad: timing.pageLoad,
                networkIdle,
            };

            console.log('\n══════════════════════════════════════════════');
            console.log('  MODULE 5 — NETWORK FINISH TIME');
            console.log('══════════════════════════════════════════════');
            console.log(`  DOM Content Loaded : ${perfResult.domContentLoaded} ms`);
            console.log(`  Page Load          : ${perfResult.pageLoad} ms`);
            console.log(`  Network idle       : ${networkIdle ? '✓' : '✗ (timed out)'}`);
            console.log('══════════════════════════════════════════════\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MODULE 5 ERROR]: ${msg}`);
        }
    });


    /* ═════════════════════════════════════════════════════════
       MODULE 1 — IMAGE AUDIT
       ═════════════════════════════════════════════════════════ */
    await test.step('Module 1 — Image Audit', async () => {
        try {
            imageAudit = await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll('img'));
                let missingSrc = 0;
                let missingAlt = 0;
                let bothMissing = 0;

                imgs.forEach((img) => {
                    const rawSrc = img.getAttribute('src');
                    const rawAlt = img.getAttribute('alt');

                    // Missing src: absent, empty string, or whitespace-only
                    const srcMissing = rawSrc === null || rawSrc.trim() === '';
                    // Missing alt: absent or empty string
                    const altMissing = rawAlt === null || rawAlt === '';

                    if (srcMissing) missingSrc++;
                    if (altMissing) missingAlt++;
                    if (srcMissing && altMissing) bothMissing++;
                });

                return { total: imgs.length, missingSrc, missingAlt, bothMissing };
            });

            console.log('\n══════════════════════════════════════════════');
            console.log('  MODULE 1 — IMAGE AUDIT');
            console.log('══════════════════════════════════════════════');
            console.log('  ┌─────────────────────────┬───────┐');
            console.log('  │ Metric                  │ Count │');
            console.log('  ├─────────────────────────┼───────┤');
            console.log(`  │ Total images            │ ${pad(imageAudit.total, 5)} │`);
            console.log(`  │ Missing src             │ ${pad(imageAudit.missingSrc, 5)} │`);
            console.log(`  │ Missing alt             │ ${pad(imageAudit.missingAlt, 5)} │`);
            console.log(`  │ Both src + alt missing  │ ${pad(imageAudit.bothMissing, 5)} │`);
            console.log('  └─────────────────────────┴───────┘\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MODULE 1 ERROR]: ${msg}`);
        }
    });


    /* ═════════════════════════════════════════════════════════
       MODULE 2 — DUPLICATE IMAGE DETECTION
       ═════════════════════════════════════════════════════════ */
    await test.step('Module 2 — Duplicate Image Detection', async () => {
        try {
            const baseUrl = page.url();

            duplicateImages = await page.evaluate((base: string) => {
                const imgs = Array.from(document.querySelectorAll('img'));
                const srcMap: Record<string, number> = {};

                imgs.forEach((img) => {
                    const rawSrc = img.getAttribute('src');
                    if (rawSrc !== null && rawSrc.trim() !== '') {
                        let normalized: string;
                        try {
                            normalized = new URL(rawSrc.trim(), base).href;
                        } catch {
                            normalized = rawSrc.trim();
                        }
                        srcMap[normalized] = (srcMap[normalized] || 0) + 1;
                    }
                });

                const duplicates: { src: string; count: number }[] = [];
                const keys = Object.keys(srcMap);
                keys.forEach((src) => {
                    if (srcMap[src] > 1) {
                        duplicates.push({ src, count: srcMap[src] });
                    }
                });
                duplicates.sort((a, b) => b.count - a.count);

                return {
                    uniqueUrls: keys.length,
                    duplicateCount: duplicates.length,
                    duplicates,
                };
            }, baseUrl);

            console.log('\n══════════════════════════════════════════════');
            console.log('  MODULE 2 — DUPLICATE IMAGE DETECTION');
            console.log('══════════════════════════════════════════════');
            console.log(`  Unique image URLs     : ${duplicateImages.uniqueUrls}`);
            console.log(`  Duplicate URLs found  : ${duplicateImages.duplicateCount}`);
            if (duplicateImages.duplicates.length > 0) {
                duplicateImages.duplicates.forEach((d) => {
                    console.log(`    - ${truncate(d.src, 70)} → used ${d.count} times`);
                });
            } else {
                console.log('  No duplicates found ✓');
            }
            console.log('══════════════════════════════════════════════\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MODULE 2 ERROR]: ${msg}`);
        }
    });


    /* ═════════════════════════════════════════════════════════
       MODULE 3 — LINK INSPECTOR
       ═════════════════════════════════════════════════════════ */
    await test.step('Module 3 — Link Inspector', async () => {
        try {
            linkInspector = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a'));
                let validHref = 0;
                let emptyHash = 0;
                const hrefMap: Record<string, number> = {};

                anchors.forEach((a) => {
                    const href = a.getAttribute('href');

                    if (
                        href === null ||
                        href.trim() === '' ||
                        href.trim() === '#' ||
                        href.trim().startsWith('javascript:')
                    ) {
                        emptyHash++;
                    } else {
                        validHref++;
                    }

                    // Duplicate tracking — only for real hrefs
                    if (
                        href !== null &&
                        href.trim() !== '' &&
                        href.trim() !== '#' &&
                        !href.trim().startsWith('javascript:')
                    ) {
                        const normalized = href.trim().split('#')[0]; // strip fragment
                        hrefMap[normalized] = (hrefMap[normalized] || 0) + 1;
                    }
                });

                const duplicates: { href: string; count: number }[] = [];
                Object.keys(hrefMap).forEach((href) => {
                    if (hrefMap[href] > 1) {
                        duplicates.push({ href, count: hrefMap[href] });
                    }
                });
                duplicates.sort((a, b) => b.count - a.count);

                return {
                    total: anchors.length,
                    validHref,
                    emptyHash,
                    duplicateCount: duplicates.length,
                    duplicates,
                };
            });

            console.log('\n══════════════════════════════════════════════');
            console.log('  MODULE 3 — LINK INSPECTOR');
            console.log('══════════════════════════════════════════════');
            console.log('  ┌──────────────────────────┬───────┐');
            console.log('  │ Metric                   │ Count │');
            console.log('  ├──────────────────────────┼───────┤');
            console.log(`  │ Total links              │ ${pad(linkInspector.total, 5)} │`);
            console.log(`  │ Valid href               │ ${pad(linkInspector.validHref, 5)} │`);
            console.log(`  │ Empty / hash-only        │ ${pad(linkInspector.emptyHash, 5)} │`);
            console.log(`  │ Duplicate hrefs          │ ${pad(linkInspector.duplicateCount, 5)} │`);
            console.log('  └──────────────────────────┴───────┘');
            if (linkInspector.duplicates.length > 0) {
                console.log('  Duplicate href list:');
                linkInspector.duplicates.slice(0, 20).forEach((d) => {
                    console.log(`    - ${truncate(d.href, 65)} → ${d.count} times`);
                });
                if (linkInspector.duplicates.length > 20) {
                    console.log(`    ... and ${linkInspector.duplicates.length - 20} more`);
                }
            }
            console.log('══════════════════════════════════════════════\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MODULE 3 ERROR]: ${msg}`);
        }
    });


    /* ═════════════════════════════════════════════════════════
       MODULE 4 — BUTTON INTERACTION TESTER
       ═════════════════════════════════════════════════════════ */
    await test.step('Module 4 — Button Interaction Tester', async () => {
        try {
            const consoleErrors: string[] = [];
            let crashed = false;

            // Attach listeners BEFORE the loop
            page.on('console', (msg) => {
                if (msg.type() === 'error') {
                    consoleErrors.push(msg.text());
                }
            });
            page.on('crash', () => {
                crashed = true;
            });

            const btnSelector = 'button, [role="button"], input[type="submit"], input[type="button"]';
            const buttonCount = await page.locator(btnSelector).count();

            console.log('\n══════════════════════════════════════════════');
            console.log('  MODULE 4 — BUTTON INTERACTION TESTER');
            console.log('══════════════════════════════════════════════');
            console.log(`  Found ${buttonCount} button(s) to test\n`);

            const originBefore = new URL(page.url()).origin;
            const results: ButtonResult[] = [];

            for (let i = 0; i < buttonCount; i++) {
                const btn = page.locator(btnSelector).nth(i);

                // Get button text for logging
                const btnText = await btn.evaluate((el) => {
                    const text =
                        (el as HTMLElement).textContent?.trim() ||
                        (el as HTMLInputElement).value ||
                        el.getAttribute('aria-label') ||
                        '';
                    return text.substring(0, 40) || `[Button ${el.tagName}]`;
                }).catch(() => `[Button #${i}]`);

                // Check visibility
                const isVisible = await btn.isVisible().catch(() => false);
                if (!isVisible) {
                    results.push({ text: btnText, status: 'SKIP', reason: 'Not visible' });
                    console.log(`  [SKIP]  "${btnText}" — not visible`);
                    continue;
                }

                // Check disabled
                const isDisabled = await btn.isDisabled().catch(() => false);
                if (isDisabled) {
                    results.push({ text: btnText, status: 'SKIP', reason: 'Disabled' });
                    console.log(`  [SKIP]  "${btnText}" — disabled`);
                    continue;
                }

                // Clear error buffer for this click
                const errCountBefore = consoleErrors.length;
                const urlBefore = page.url();

                try {
                    await btn.click({ force: false, timeout: 3000 });
                    await page.waitForTimeout(800);

                    if (crashed) {
                        results.push({ text: btnText, status: 'FAIL', reason: 'Page crashed' });
                        console.log(`  [FAIL]  "${btnText}" — page crashed!`);
                        crashed = false;
                        continue;
                    }

                    const urlAfter = page.url();
                    let originAfter: string;
                    try {
                        originAfter = new URL(urlAfter).origin;
                    } catch {
                        originAfter = urlAfter;
                    }

                    // Check navigation
                    if (urlAfter !== urlBefore) {
                        results.push({ text: btnText, status: 'NAV', reason: `Navigated to ${truncate(urlAfter, 50)}` });
                        console.log(`  [NAV]   "${btnText}" — navigated to ${truncate(urlAfter, 50)}`);
                        // Recover: go back
                        try {
                            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
                        } catch {
                            await page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
                        }
                        await page.waitForTimeout(500);
                        continue;
                    }

                    // Check for new console errors since click
                    if (consoleErrors.length > errCountBefore) {
                        const newErrs = consoleErrors.slice(errCountBefore);
                        results.push({ text: btnText, status: 'WARN', reason: `Console error: ${truncate(newErrs[0], 60)}` });
                        console.log(`  [WARN]  "${btnText}" — console error after click`);
                        continue;
                    }

                    // All good
                    results.push({ text: btnText, status: 'PASS', reason: 'Clicked, no errors' });
                    console.log(`  [PASS]  "${btnText}"`);
                } catch (clickErr: unknown) {
                    const reason = clickErr instanceof Error ? clickErr.message : String(clickErr);
                    results.push({ text: btnText, status: 'FAIL', reason: truncate(reason, 80) });
                    console.log(`  [FAIL]  "${btnText}" — ${truncate(reason, 60)}`);
                }
            }

            // Summarize
            buttonSummary = {
                tested: results.length,
                pass: results.filter((r) => r.status === 'PASS').length,
                warn: results.filter((r) => r.status === 'WARN').length,
                nav: results.filter((r) => r.status === 'NAV').length,
                fail: results.filter((r) => r.status === 'FAIL').length,
                skip: results.filter((r) => r.status === 'SKIP').length,
                results,
            };

            console.log('');
            console.log(`  Buttons tested: ${buttonSummary.tested}  |  ` +
                `Pass: ${buttonSummary.pass}  |  ` +
                `Warn: ${buttonSummary.warn}  |  ` +
                `Nav: ${buttonSummary.nav}  |  ` +
                `Fail: ${buttonSummary.fail}  |  ` +
                `Skip: ${buttonSummary.skip}`);
            console.log('══════════════════════════════════════════════\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MODULE 4 ERROR]: ${msg}`);
        }
    });


    /* ═════════════════════════════════════════════════════════
       MODULE 6 — FINAL REPORT
       ═════════════════════════════════════════════════════════ */
    await test.step('Module 6 — Final Report', async () => {
        try {
            const scanDate = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const W = 48; // inner width

            const line = (label: string, value: string | number) => {
                const content = `  ${label.padEnd(18)}: ${String(value)}`;
                return `║${content.padEnd(W)}║`;
            };

            const divider = `╠${'═'.repeat(W)}╣`;
            const topLine = `╔${'═'.repeat(W)}╝`;
            const topClose = `╔${'═'.repeat(W)}╗`;
            const bottomLine = `╚${'═'.repeat(W)}╝`;

            console.log('\n');
            console.log(topClose);
            console.log(`║${'PAGE ANALYZER — FINAL REPORT'.padStart(38).padEnd(W)}║`);
            console.log(divider);
            console.log(line('URL scanned', truncate(PAGE_URL, 26)));
            console.log(line('Scan date', scanDate));
            console.log(divider);
            console.log(`║${'  IMAGES'.padEnd(W)}║`);
            console.log(line('Total', imageAudit.total));
            console.log(line('Missing src', imageAudit.missingSrc));
            console.log(line('Missing alt', imageAudit.missingAlt));
            console.log(line('Both missing', imageAudit.bothMissing));
            console.log(line('Duplicates', duplicateImages.duplicateCount));
            console.log(divider);
            console.log(`║${'  LINKS'.padEnd(W)}║`);
            console.log(line('Total', linkInspector.total));
            console.log(line('Valid', linkInspector.validHref));
            console.log(line('Empty/hash', linkInspector.emptyHash));
            console.log(line('Duplicates', linkInspector.duplicateCount));
            console.log(divider);
            console.log(`║${'  BUTTONS'.padEnd(W)}║`);
            console.log(`║${'  Tested: '.padEnd(1)}${pad(buttonSummary.tested, 3)}   Pass: ${pad(buttonSummary.pass, 3)}   Fail: ${pad(buttonSummary.fail, 3)}   Skip: ${pad(buttonSummary.skip, 3)}${''.padEnd(5)}║`);
            console.log(`║${'  Warn  : '.padEnd(1)}${pad(buttonSummary.warn, 3)}   Nav : ${pad(buttonSummary.nav, 3)}${''.padEnd(22)}║`);
            console.log(divider);
            console.log(`║${'  PERFORMANCE'.padEnd(W)}║`);
            console.log(line('DOM Ready', `${perfResult.domContentLoaded} ms`));
            console.log(line('Full Load', `${perfResult.pageLoad} ms`));
            console.log(line('Network Idle', perfResult.networkIdle ? '✓' : '✗'));
            console.log(bottomLine);
            console.log('\n');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MODULE 6 ERROR]: ${msg}`);
        }
    });
});
