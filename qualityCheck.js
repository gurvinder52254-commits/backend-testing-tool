const { chromium } = require('playwright');

async function performQualityCheck(url) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    const failedRequests = [];
    
    // Listen for console errors
    page.on('console', msg => {
        if (msg.type() === 'error') {
            consoleErrors.push(msg.text());
        }
    });

    // Listen for failed network requests
    page.on('requestfailed', request => {
        failedRequests.push({
            url: request.url(),
            errorText: request.failure().errorText
        });
    });

    page.on('response', response => {
        if (response.status() >= 400) {
            failedRequests.push({
                url: response.url(),
                status: response.status(),
                statusText: response.statusText()
            });
        }
    });

    console.log(`Scanning ${url}...`);

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Element counts and broken element check
        const qualityData = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            const links = Array.from(document.querySelectorAll('a'));
            const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));

            const brokenImages = images.filter(img => !img.complete || img.naturalWidth === 0).map(img => img.src);
            const brokenLinks = links.filter(a => {
                const href = a.getAttribute('href');
                return !href || href === '#' || href === '';
            }).map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }));

            const meta = {
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.content || 'Missing',
                ogDescription: document.querySelector('meta[property="og:description"]')?.content || 'Missing',
                ogType: document.querySelector('meta[property="og:type"]')?.content || 'Missing'
            };

            return {
                counts: {
                    images: images.length,
                    links: links.length,
                    buttons: buttons.length
                },
                broken: {
                    images: brokenImages,
                    links: brokenLinks
                },
                meta,
                html: document.documentElement.outerHTML.substring(0, 1000) // snippet
            };
        });

        const report = {
            url,
            consoleErrors,
            failedRequests,
            qualityData,
            timestamp: new Date().toISOString()
        };

        console.log(JSON.stringify(report, null, 2));

    } catch (error) {
        console.error('Error during scan:', error.message);
    } finally {
        await browser.close();
    }
}

const urlToTest = process.argv[2] || 'http://localhost:5173/';
performQualityCheck(urlToTest);
