/**
 * ============================================================
 * groqAnalyzer.js - Groq AI Screenshot Analysis & Test Generator
 * ============================================================
 * Analyzes website screenshots using Groq's vision model to:
 * 1. Identify UI elements (buttons, inputs, errors, links)
 * 2. Suggest test cases for the page
 * 3. Generate executable Playwright test code
 * ============================================================
 */

const fs = require('fs');
const fetch = require('node-fetch');

/**
 * Helper to wait for a specified time
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sanitizes a string that is expected to be JSON.
 * Fixes common issues like unescaped backslashes and control characters.
 */
function sanitizeJsonString(raw) {
    if (!raw) return '';

    // 1. Remove markdown code blocks
    let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // 2. Extract only the first { ... } or [ ... ] block
    const jsonMatch = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!jsonMatch) return clean;
    clean = jsonMatch[0];

    // 3. Fix unescaped backslashes: 
    // A backslash is invalid in JSON unless followed by " \ / b f n r t uXXXX
    // We look for backslashes NOT followed by one of those and escape them.
    // This is tricky; a simpler approach is to fix common "bad" escapes like \( \) \. \* 
    // which the AI often includes when writing selectors or regex.
    clean = clean.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');

    // 4. Remove trailing commas in objects/arrays (some parsers hate this)
    clean = clean.replace(/,\s*([\}\]])/g, '$1');

    return clean;
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
let GROQ_API_KEY = null;
let isInitialized = false;
let authFailed = false; // Cache 401 failures to skip subsequent calls

/**
 * Initialize Groq with API key
 */
function initializeGroq() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey || apiKey === 'your_groq_api_key_here') {
        console.warn('⚠️  GROQ_API_KEY not configured. Groq AI analysis will be disabled.');
        return false;
    }
    GROQ_API_KEY = apiKey;
    isInitialized = true;
    console.log('✅ Groq AI initialized successfully');
    return true;
}

/**
 * Send a request to Groq API with vision model (with retry logic)
 */
async function callGroqVision(base64Image, prompt, maxTokens = 4096, retryCount = 0) {
    const MAX_RETRIES = 3;

    if (authFailed) {
        throw new Error('Groq API key previously failed authentication (401). Skipping.');
    }

    if (!isInitialized) {
        if (!initializeGroq()) {
            throw new Error('Groq API key not configured');
        }
    }

    try {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: prompt,
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/png;base64,${base64Image}`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: maxTokens,
                temperature: 0.3,
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();

            // Handle Rate Limit (429)
            if (response.status === 429 && retryCount < MAX_RETRIES) {
                let waitTime = 5000; // Default 5s

                // Try to parse error message for suggested wait time
                try {
                    const errJson = JSON.parse(errBody);
                    const msg = errJson.error?.message || "";
                    const match = msg.match(/try again in ([\d.]+)s/i);
                    if (match && match[1]) {
                        waitTime = (parseFloat(match[1]) + 1) * 1000;
                    }
                } catch (e) {
                    // Fallback to exponential backoff
                    waitTime = Math.pow(2, retryCount) * 5000;
                }

                console.warn(`⏳ Rate limit reached. Retrying in ${Math.round(waitTime / 1000)}s... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
                await sleep(waitTime);
                return callGroqVision(base64Image, prompt, maxTokens, retryCount + 1);
            }

            // Cache 401 auth failures to skip all future calls
            if (response.status === 401 || response.status === 403) {
                authFailed = true;
            }
            throw new Error(`Groq API error (${response.status}): ${errBody}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || '';
    } catch (error) {
        if (retryCount < MAX_RETRIES && (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNRESET'))) {
            console.warn(`🔌 Connection issues. Retrying... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await sleep(2000);
            return callGroqVision(base64Image, prompt, maxTokens, retryCount + 1);
        }
        throw error;
    }
}

/**
 * STEP 1: Analyze screenshot to identify all UI elements
 * Returns structured JSON of buttons, inputs, errors, links, etc.
 */
async function analyzePageElements(screenshotPath, pageUrl, pageTitle) {
    if (!isInitialized && !initializeGroq()) {
        return getDefaultElementAnalysis('Groq API key not configured');
    }

    try {
        const imageBuffer = fs.readFileSync(screenshotPath);
        const base64Image = imageBuffer.toString('base64');

        const prompt = `You are an expert QA engineer analyzing a webpage screenshot. The page URL is "${pageUrl}" and title is "${pageTitle}".

CAREFULLY examine this screenshot and identify ALL visible UI elements. Return ONLY valid JSON (no markdown, no code blocks, no extra text).

{
    "pageOverview": "<1-2 sentence description of what this page is about>",
    "buttons": [
        {
            "text": "<button text>",
            "location": "<header/body/footer/sidebar>",
            "type": "<navigation/submit/action/social/dropdown/cta>",
            "visibleState": "<enabled/disabled/hidden>"
        }
    ],
    "inputFields": [
        {
            "label": "<field label or placeholder>",
            "type": "<text/email/password/phone/search/textarea/select/checkbox/radio/date/file>",
            "required": <true/false>,
            "location": "<header/body/footer/modal/form-name>"
        }
    ],
    "forms": [
        {
            "name": "<form name or purpose>",
            "fields": <number of fields>,
            "hasSubmitButton": <true/false>,
            "submitButtonText": "<text>"
        }
    ],
    "errors": [
        {
            "type": "<validation-error/console-error/404/broken-image/layout-issue/missing-content>",
            "description": "<what the error is>",
            "severity": "<critical/warning/info>"
        }
    ],
    "links": [
        {
            "text": "<link text>",
            "location": "<header/body/footer/sidebar>",
            "type": "<navigation/external/social/anchor>"
        }
    ],
    "images": {
        "total": <number>,
        "brokenOrMissing": <number>,
        "missingAlt": <number>
    },
    "navigation": {
        "hasHeader": <true/false>,
        "hasFooter": <true/false>,
        "hasSidebar": <true/false>,
        "menuItems": ["<menu item 1>", "<menu item 2>"]
    },
    "visualIssues": [
        "<any overlap, misalignment, broken layout, cut-off text, etc.>"
    ]
}`;

        const responseText = await callGroqVision(base64Image, prompt, 4096);

        // Clean and parse JSON
        const cleanJson = sanitizeJsonString(responseText);

        const analysis = JSON.parse(cleanJson);
        return { success: true, ...analysis };
    } catch (error) {
        console.error(`❌ Groq element analysis error for ${pageUrl}:`, error.message);
        return getDefaultElementAnalysis(error.message);
    }
}

/**
 * STEP 2: Generate test case suggestions based on element analysis
 */
async function suggestTestCases(screenshotPath, pageUrl, pageTitle, elementsAnalysis) {
    if (!isInitialized && !initializeGroq()) {
        return getDefaultTestSuggestions('Groq API key not configured');
    }

    try {
        const imageBuffer = fs.readFileSync(screenshotPath);
        const base64Image = imageBuffer.toString('base64');

        const elementsContext = JSON.stringify(elementsAnalysis, null, 2);

        const prompt = `You are a senior QA automation engineer. Based on this webpage screenshot and the element analysis below, suggest comprehensive test cases.

Page URL: "${pageUrl}"
Page Title: "${pageTitle}"

Already discovered elements:
${elementsContext}

Generate test cases that cover all critical functionality. Return ONLY valid JSON (no markdown, no code blocks):

{
    "testSuite": "${pageTitle} - Automated Tests",
    "totalTests": <number>,
    "testCategories": [
        {
            "category": "<Navigation/Forms/Buttons/Links/Visual/Responsive/Error Handling/SEO>",
            "tests": [
                {
                    "id": "TC_<number>",
                    "name": "<descriptive test name>",
                    "description": "<what this test verifies>",
                    "priority": "<P0/P1/P2/P3>",
                    "type": "<functional/visual/negative/boundary/accessibility>",
                    "steps": [
                        "<step 1>",
                        "<step 2>"
                    ],
                    "expectedResult": "<what should happen>",
                    "automatable": <true/false>
                }
            ]
        }
    ],
    "summary": "<1-2 sentence summary of test coverage>"
}`;

        const responseText = await callGroqVision(base64Image, prompt, 6000);

        const cleanJson = sanitizeJsonString(responseText);

        const suggestions = JSON.parse(cleanJson);
        return { success: true, ...suggestions };
    } catch (error) {
        console.error(`❌ Groq test suggestion error for ${pageUrl}:`, error.message);
        return getDefaultTestSuggestions(error.message);
    }
}

/**
 * STEP 3: Generate executable Playwright test code
 */
async function generatePlaywrightCode(screenshotPath, pageUrl, pageTitle, elementsAnalysis, testSuggestions, userDetails) {
    if (!isInitialized && !initializeGroq()) {
        return getDefaultPlaywrightCode('Groq API key not configured');
    }

    try {
        const imageBuffer = fs.readFileSync(screenshotPath);
        const base64Image = imageBuffer.toString('base64');

        const prompt = `You are a Playwright automation expert. Based on this webpage screenshot, generate executable Playwright test code in JavaScript (CommonJS format).

Page URL: "${pageUrl}"
Page Title: "${pageTitle}"

Known elements on page:
${JSON.stringify(elementsAnalysis, null, 2)}

User Provided Details / Credentials for testing:
${userDetails ? JSON.stringify(userDetails, null, 2) : "None provided"}

IMPORTANT RULES:
1. Use CommonJS require syntax (const { test, expect } = require('@playwright/test'))
2. Each test should be independent and self-contained
3. Use data-testid, role, text content, or CSS selectors as locators
4. Include proper assertions (toBeVisible, toHaveText, toHaveURL, etc.)
5. Handle timeouts gracefully
6. Add descriptive test names
7. Group tests logically with test.describe blocks
8. Include both positive and negative test scenarios
9. For form tests, fill with valid test data then verify submission
10. For navigation, verify page loads and content appears

Return ONLY valid JSON (no markdown, no code blocks):

{
    "testFileName": "<descriptive-file-name>.spec.js",
    "testCode": "<complete executable playwright test code as a single string>",
    "totalTestCases": <number>,
    "testList": [
        {
            "name": "<test name>",
            "type": "<navigation/form/button/visual/error>",
            "description": "<what it tests>"
        }
    ]
}`;

        const responseText = await callGroqVision(base64Image, prompt, 8000);

        const cleanJson = sanitizeJsonString(responseText);

        const codeResult = JSON.parse(cleanJson);
        return { success: true, ...codeResult };
    } catch (error) {
        console.error(`❌ Groq code generation error for ${pageUrl}:`, error.message);
        return getDefaultPlaywrightCode(error.message);
    }
}

/**
 * COMPLETE PIPELINE: Run all 3 steps in sequence
 * 1. Analyze elements → 2. Suggest tests → 3. Generate code
 */
async function runGroqAnalysisPipeline(screenshotPath, pageUrl, pageTitle, userDetails, sendUpdate) {
    const result = {
        elementAnalysis: null,
        testSuggestions: null,
        playwrightCode: null,
        executionResults: null,
        status: 'pending',
        error: null,
    };

    try {
        // EARLY EXIT: Skip entire pipeline if auth already failed
        if (authFailed) {
            result.status = 'skipped';
            result.error = 'Groq API key invalid (401). Pipeline skipped.';
            result.elementAnalysis = getDefaultElementAnalysis('API key invalid');
            result.testSuggestions = getDefaultTestSuggestions('API key invalid');
            result.playwrightCode = getDefaultPlaywrightCode('API key invalid');
            return result;
        }

        // STEP 1: Analyze page elements
        if (sendUpdate) {
            sendUpdate({
                type: 'groq-status',
                step: 'element-analysis',
                message: `🧠 Groq AI analyzing page elements: ${pageUrl}`,
            });
        }

        result.elementAnalysis = await analyzePageElements(screenshotPath, pageUrl, pageTitle);

        // If element analysis failed (e.g. auth error), skip remaining steps
        if (!result.elementAnalysis.success) {
            result.status = 'error';
            result.error = result.elementAnalysis.error || 'Element analysis failed';
            result.testSuggestions = getDefaultTestSuggestions(result.error);
            result.playwrightCode = getDefaultPlaywrightCode(result.error);
            return result;
        }

        if (sendUpdate) {
            sendUpdate({
                type: 'groq-element-analysis',
                url: pageUrl,
                analysis: result.elementAnalysis,
                message: `✅ Elements identified: ${result.elementAnalysis.buttons?.length || 0} buttons, ${result.elementAnalysis.inputFields?.length || 0} inputs, ${result.elementAnalysis.forms?.length || 0} forms`,
            });
        }

        // Add small delay to prevent rapid token usage
        await sleep(2000);

        // STEP 2: Suggest test cases
        if (sendUpdate) {
            sendUpdate({
                type: 'groq-status',
                step: 'test-suggestions',
                message: `📋 Groq AI generating test case suggestions...`,
            });
        }

        result.testSuggestions = await suggestTestCases(screenshotPath, pageUrl, pageTitle, result.elementAnalysis);

        if (sendUpdate) {
            sendUpdate({
                type: 'groq-test-suggestions',
                url: pageUrl,
                suggestions: result.testSuggestions,
                message: `✅ ${result.testSuggestions.totalTests || 0} test cases suggested`,
            });
        }

        // Add small delay to prevent rapid token usage
        await sleep(2000);

        // STEP 3: Generate Playwright code
        if (sendUpdate) {
            sendUpdate({
                type: 'groq-status',
                step: 'code-generation',
                message: `💻 Groq AI generating Playwright test code...`,
            });
        }

        result.playwrightCode = await generatePlaywrightCode(
            screenshotPath, pageUrl, pageTitle,
            result.elementAnalysis, result.testSuggestions, userDetails
        );

        if (sendUpdate) {
            sendUpdate({
                type: 'groq-code-generated',
                url: pageUrl,
                code: result.playwrightCode,
                message: `✅ Playwright code generated: ${result.playwrightCode.totalTestCases || 0} test cases`,
            });
        }

        result.status = 'complete';
    } catch (error) {
        result.status = 'error';
        result.error = error.message;
        console.error('❌ Groq pipeline error:', error.message);
    }

    return result;
}

/**
 * Default fallback when Groq is unavailable
 */
function getDefaultElementAnalysis(reason) {
    return {
        success: false,
        error: reason,
        pageOverview: 'Analysis unavailable',
        buttons: [],
        inputFields: [],
        forms: [],
        errors: [],
        links: [],
        images: { total: 0, brokenOrMissing: 0, missingAlt: 0 },
        navigation: { hasHeader: false, hasFooter: false, hasSidebar: false, menuItems: [] },
        visualIssues: [],
    };
}

function getDefaultTestSuggestions(reason) {
    return {
        success: false,
        error: reason,
        testSuite: 'N/A',
        totalTests: 0,
        testCategories: [],
        summary: `Test suggestions unavailable: ${reason}`,
    };
}

function getDefaultPlaywrightCode(reason) {
    return {
        success: false,
        error: reason,
        testFileName: 'unavailable.spec.js',
        testCode: `// Playwright code generation unavailable: ${reason}`,
        totalTestCases: 0,
        testList: [],
    };
}

module.exports = {
    initializeGroq,
    analyzePageElements,
    suggestTestCases,
    generatePlaywrightCode,
    runGroqAnalysisPipeline,
};
