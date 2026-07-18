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

    // 1. Remove markdown code blocks and reasoning thinking blocks
    let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // 2. Extract only the first valid { ... } or [ ... ] block using bracket counting
    let startChar = '';
    let endChar = '';
    let startIndex = -1;

    for (let i = 0; i < clean.length; i++) {
        if (clean[i] === '{') {
            startChar = '{';
            endChar = '}';
            startIndex = i;
            break;
        } else if (clean[i] === '[') {
            startChar = '[';
            endChar = ']';
            startIndex = i;
            break;
        }
    }

    if (startIndex !== -1) {
        let bracketCount = 0;
        let inString = false;
        let escape = false;

        for (let i = startIndex; i < clean.length; i++) {
            const char = clean[i];

            if (escape) {
                escape = false;
                continue;
            }
            if (char === '\\') {
                escape = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === startChar) {
                    bracketCount++;
                } else if (char === endChar) {
                    bracketCount--;
                    if (bracketCount === 0) {
                        clean = clean.substring(startIndex, i + 1);
                        break;
                    }
                }
            }
        }
    }

    // 3. Fix unescaped backslashes: 
    clean = clean.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');

    // 4. Remove trailing commas in objects/arrays
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
                model: 'qwen/qwen3.6-27b',
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
            timeout: 30000, // 30 seconds timeout to prevent indefinite hang
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
        if (retryCount < MAX_RETRIES && (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNRESET') || error.message.toLowerCase().includes('timeout'))) {
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

        const responseText = await callGroqVision(base64Image, prompt, 1500);

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

        const responseText = await callGroqVision(base64Image, prompt, 2048);

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

        // Add small delay to prevent rapid token usage
        await sleep(2000);

        // STEP 4: Comprehensive AI Audit (new requirement)
        if (sendUpdate) {
            sendUpdate({
                type: 'groq-status',
                step: 'ai-audit',
                message: `🤖 Groq AI performing complete page audit for ${pageUrl}...`,
            });
        }

        result.auditResult = await auditPageIssues(screenshotPath, pageUrl, pageTitle);

        if (sendUpdate) {
            sendUpdate({
                type: 'groq-audit-complete',
                url: pageUrl,
                audit: result.auditResult,
                message: `✅ AI page audit complete: found ${result.auditResult?.issues?.length || 0} issues`,
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
 * Normalized dedupe key for an audit issue (category + first ~60 chars of title).
 */
function auditIssueKey(issue) {
    const t = String(issue.title || issue.description || '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    const c = String(issue.category || '').toLowerCase();
    return `${c}::${t}`;
}

/**
 * Merge two independent audit passes on the SAME screenshot.
 * Union of issues (nothing missed) + dedupe. Issues found in BOTH passes are
 * marked verifiedInBothPasses (higher confidence).
 */
function mergeAuditIssues(passA, passB) {
    const map = new Map();
    const add = (issue, passNo) => {
        if (!issue || (!issue.title && !issue.description)) return;
        const key = auditIssueKey(issue);
        if (map.has(key)) {
            map.get(key)._passes.add(passNo);
        } else {
            map.set(key, { ...issue, _passes: new Set([passNo]) });
        }
    };
    (Array.isArray(passA) ? passA : []).forEach((i) => add(i, 1));
    (Array.isArray(passB) ? passB : []).forEach((i) => add(i, 2));

    const sev = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    return Array.from(map.values())
        .map((issue) => {
            const confirmed = issue._passes.size >= 2;
            const { _passes, ...rest } = issue;
            const steps = Array.isArray(rest.reproductionSteps)
                ? rest.reproductionSteps
                : (rest.reproductionSteps ? [String(rest.reproductionSteps)] : []);
            return {
                ...rest,
                reproductionSteps: steps,
                verifiedInBothPasses: confirmed,
                confidenceScore: confirmed ? '95%' : (rest.confidenceScore || '80%'),
            };
        })
        .sort((x, y) => {
            if (x.verifiedInBothPasses !== y.verifiedInBothPasses) return x.verifiedInBothPasses ? -1 : 1;
            return (sev[x.severity] ?? 2) - (sev[y.severity] ?? 2);
        });
}

/**
 * STEP 4 Helper: Comprehensive page audit using Groq Vision.
 * Sends the SAME screenshot to the model in TWO identical requests
 * (cross-verification) and merges the results into structured UI test cases,
 * each with expected behavior, actual behavior, and reproduction steps.
 */
async function auditPageIssues(screenshotPath, pageUrl, pageTitle) {
    if (!isInitialized && !initializeGroq()) {
        return { success: false, error: 'Groq API key not configured', issues: [] };
    }

    try {
        const imageBuffer = fs.readFileSync(screenshotPath);
        const base64Image = imageBuffer.toString('base64');

        const systemPrompt = `You are a professional website QA engineer, UX designer, and accessibility auditor.
Analyze the provided webpage screenshot and produce a list of concrete UI/UX TEST CASES (issues).
Run all of these checks:
1. UI/UX consistency, visual hierarchy, branding, icon/font/color consistency.
2. Grammar, spelling, punctuation, copy quality, keyword stuffing.
3. Design & structure: missing/incomplete sections, placeholder content, outline.
4. Layout & rendering: text overlap, misalignment, spacing/padding, overflow, clipping, z-index.
5. Header/footer & navigation: completeness, alignment, logo placement.
6. Buttons & interactive elements: MISSING or BLANK buttons/labels, inconsistent styles/sizes/colors, missing states.
7. Inputs & forms: structure, fields, validation UI feedback.
8. Accessibility: contrast, alt text, labels, focus indicators.
9. Rendering performance: layout shift, unoptimized/blank images.

Return ONLY valid JSON (no markdown, no extra text) in EXACTLY this shape:
{
  "issues": [
    {
      "title": "Short issue title (max 80 chars)",
      "category": "ui_ux|layout|grammar|rendering|design|buttons|header_footer|accessibility|forms",
      "severity": "Critical|High|Medium|Low",
      "affectedElement": "Specific element/section affected (e.g. 'Hero secondary CTA button')",
      "description": "What is wrong and why it is a problem",
      "expectedBehavior": "What the correct/expected UI or behavior should be",
      "actualBehavior": "What is actually observed in this screenshot",
      "reproductionSteps": ["Open the page", "Look at ...", "Observe ..."],
      "recommendedFix": "Specific, actionable fix",
      "confidenceScore": "0-100%"
    }
  ]
}

Rules:
- Report ONLY real issues visible in the screenshot. Do not invent issues. If a category is fine, omit it.
- Be specific: reference actual text, colors, positions, and elements you can see.
- severity: Critical=broken/unusable, High=significant, Medium=notable, Low=minor.
- reproductionSteps must be concrete and start from opening the page.`;

        const userPrompt = `Audit this webpage screenshot: "${pageUrl}" (Title: "${pageTitle}"). Return the JSON test-case list.`;
        const prompt = systemPrompt + "\n\n" + userPrompt;

        const parsePass = (settled) => {
            if (settled.status !== 'fulfilled' || !settled.value) return [];
            try {
                const parsed = JSON.parse(sanitizeJsonString(settled.value));
                if (Array.isArray(parsed)) return parsed;
                return Array.isArray(parsed.issues) ? parsed.issues : [];
            } catch {
                return [];
            }
        };

        // Send the SAME image in two identical requests for cross-verification.
        const [rA, rB] = await Promise.allSettled([
            callGroqVision(base64Image, prompt, 1500),
            callGroqVision(base64Image, prompt, 1500),
        ]);

        const issuesA = parsePass(rA);
        const issuesB = parsePass(rB);

        if (issuesA.length === 0 && issuesB.length === 0) {
            if (rA.status === 'rejected' && rB.status === 'rejected') {
                return { success: false, error: rA.reason?.message || rB.reason?.message || 'AI audit failed', issues: [] };
            }
            return { success: true, issues: [], passes: { a: 0, b: 0 } };
        }

        const merged = mergeAuditIssues(issuesA, issuesB);
        return { success: true, issues: merged, passes: { a: issuesA.length, b: issuesB.length } };
    } catch (error) {
        console.error(`❌ Groq page audit error for ${pageUrl}:`, error.message);
        return { success: false, error: error.message, issues: [] };
    }
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
    auditPageIssues,
};
