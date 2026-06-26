/**
 * ============================================================
 * geminiAnalyzer.js - Gemini AI Screenshot Analysis Module
 * ============================================================
 * Sends page screenshots to Google Gemini AI for detailed
 * UI/UX analysis, design feedback, and quality scoring.
 * ============================================================
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

let genAI = null;
let model = null;
let isInitialized = false;

/**
 * Initialize Gemini AI with API key
 */
function initializeGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
        console.warn('⚠️  GEMINI_API_KEY not configured. AI analysis will return default results.');
        return false;
    }
    try {
        genAI = new GoogleGenerativeAI(apiKey);
        model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        isInitialized = true;
        console.log('✅ Gemini AI initialized successfully');
        return true;
    } catch (err) {
        console.error('❌ Gemini AI initialization failed:', err.message);
        return false;
    }
}

/**
 * Analyze a screenshot using Gemini AI
 * @param {string} screenshotPath - Path to screenshot file
 * @param {string} pageUrl - URL of the page
 * @param {string} pageTitle - Title of the page
 * @returns {object} Analysis result
 */
async function analyzeScreenshot(screenshotPath, pageUrl, pageTitle) {
    if (!isInitialized) {
        if (!initializeGemini()) {
            return getDefaultAnalysis('Gemini API key not configured. Add GEMINI_API_KEY to .env file.');
        }
    }

    try {
        const imageBuffer = fs.readFileSync(screenshotPath);
        const base64Image = imageBuffer.toString('base64');

        const prompt = `You are a senior UI/UX designer and web quality analyst. Analyze this webpage screenshot from "${pageUrl}" (Page Title: "${pageTitle}").

Provide a thorough, professional analysis. Return ONLY valid JSON (no markdown code blocks, no extra text). Use this exact structure:

{
    "overallScore": <number 0-100>,
    "uiDesignFeedback": {
        "score": <number 0-100>,
        "strengths": ["<specific strength>", "<specific strength>"],
        "issues": ["<specific issue>", "<specific issue>"],
        "suggestions": ["<actionable suggestion>", "<actionable suggestion>"]
    },
    "pageStructure": {
        "score": <number 0-100>,
        "hasHeader": <boolean>,
        "hasFooter": <boolean>,
        "hasNavigation": <boolean>,
        "hasCTA": <boolean>,
        "layoutType": "<grid/flexbox/single-column/multi-column/etc>",
        "observations": ["<observation>", "<observation>"]
    },
    "contentAnalysis": {
        "score": <number 0-100>,
        "keywordErrors": ["<error if any>"],
        "spellingIssues": ["<issue if any>"],
        "readabilityScore": <number 0-100>,
        "observations": ["<observation>"]
    },
    "layoutIssues": {
        "score": <number 0-100>,
        "issues": ["<issue if any>"],
        "alignmentProblems": ["<problem if any>"],
        "spacingIssues": ["<issue if any>"],
        "responsiveness": "<good/fair/poor>"
    },
    "accessibilityNotes": ["<note>", "<note>"],
    "summary": "<2-3 sentence professional summary of the page quality and key recommendations>"
}`;

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64Image,
                    mimeType: 'image/png',
                },
            },
        ]);

        const responseText = result.response.text();
        // Clean markdown code blocks if present
        let cleanJson = responseText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();

        const analysis = JSON.parse(cleanJson);
        return analysis;
    } catch (error) {
        console.error(`❌ Gemini analysis error for ${pageUrl}:`, error.message);
        return getDefaultAnalysis(error.message);
    }
}

/**
 * Returns a default analysis structure when AI is unavailable
 */
function getDefaultAnalysis(reason) {
    return {
        overallScore: 0,
        error: reason,
        uiDesignFeedback: {
            score: 0,
            strengths: [],
            issues: ['AI analysis unavailable'],
            suggestions: ['Configure GEMINI_API_KEY for AI-powered analysis'],
        },
        pageStructure: {
            score: 0,
            hasHeader: false,
            hasFooter: false,
            hasNavigation: false,
            hasCTA: false,
            layoutType: 'unknown',
            observations: ['Analysis not performed'],
        },
        contentAnalysis: {
            score: 0,
            keywordErrors: [],
            spellingIssues: [],
            readabilityScore: 0,
            observations: ['Analysis not performed'],
        },
        layoutIssues: {
            score: 0,
            issues: [],
            alignmentProblems: [],
            spacingIssues: [],
            responsiveness: 'unknown',
        },
        accessibilityNotes: [],
        summary: `Analysis could not be completed: ${reason}`,
    };
}

module.exports = { analyzeScreenshot, initializeGemini };
