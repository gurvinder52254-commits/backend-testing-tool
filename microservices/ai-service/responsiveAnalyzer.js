/**
 * ============================================================
 * microservices/ai-service/responsiveAnalyzer.js
 * ============================================================
 * Sends BOTH the desktop and the mobile screenshot of the same
 * page to Gemini in a SINGLE multimodal request and returns a
 * responsive-design analysis (one call, two images — cheaper and
 * more consistent than two separate calls).
 *
 * Self-contained (own Gemini client) so the monolith's
 * geminiAnalyzer.js stays untouched. Uses the same SDK pattern:
 *   model.generateContent([prompt, {inlineData}, {inlineData}])
 * ============================================================
 */

const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createLogger } = require('../shared/logger');

const log = createLogger('responsive-ai');

let model = null;
let initialized = false;

function initResponsiveAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    log.warn('GEMINI_API_KEY not configured — responsive analysis returns defaults.');
    return false;
  }
  try {
    model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-2.0-flash' });
    initialized = true;
    log.ok('Responsive Gemini model ready.');
    return true;
  } catch (err) {
    log.error('Init failed:', err.message);
    return false;
  }
}

function getDefaultResponsive(reason) {
  return {
    overallScore: 0,
    error: reason,
    desktop: { score: 0, issues: [] },
    mobile: { score: 0, usability: 'unknown', issues: [] },
    responsive: {
      score: 0,
      consistent: false,
      overflow: [],
      tapTargetIssues: [],
      hiddenContent: [],
      layoutShiftIssues: [],
    },
    summary: `Responsive analysis unavailable: ${reason}`,
  };
}

function imagePart(p) {
  return { inlineData: { data: fs.readFileSync(p).toString('base64'), mimeType: 'image/png' } };
}

/**
 * @param {string} desktopPath  desktop screenshot file path
 * @param {string} mobilePath   mobile screenshot file path
 * @param {string} pageUrl
 * @param {string} pageTitle
 */
async function analyzeResponsive(desktopPath, mobilePath, pageUrl, pageTitle) {
  if (!initialized && !initResponsiveAI()) {
    return getDefaultResponsive('Gemini API key not configured.');
  }
  if (!desktopPath || !fs.existsSync(desktopPath) || !mobilePath || !fs.existsSync(mobilePath)) {
    return getDefaultResponsive('Missing one or both screenshots.');
  }

  try {
    const prompt = `You are a senior responsive-design & UX analyst. The FIRST image is the DESKTOP (1920x1080) view and the SECOND image is the MOBILE view of the SAME page "${pageUrl}" (title: "${pageTitle}"). Compare the two views.

Return ONLY valid JSON (no markdown, no extra text) in EXACTLY this shape:
{
  "overallScore": <number 0-100>,
  "desktop": { "score": <0-100>, "issues": ["<issue>"] },
  "mobile": { "score": <0-100>, "usability": "good|fair|poor", "issues": ["<issue>"] },
  "responsive": {
    "score": <0-100>,
    "consistent": <boolean>,
    "overflow": ["<horizontal overflow / cut-off element>"],
    "tapTargetIssues": ["<too-small or crowded tap target on mobile>"],
    "hiddenContent": ["<content present on desktop but missing/hidden on mobile>"],
    "layoutShiftIssues": ["<broken stacking / misalignment when switching layouts>"]
  },
  "summary": "<2-3 sentence professional summary + top recommendation>"
}`;

    const result = await model.generateContent([
      prompt,
      imagePart(desktopPath),
      imagePart(mobilePath),
    ]);
    const clean = result.response
      .text()
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(clean);
  } catch (err) {
    log.error(`analyzeResponsive error for ${pageUrl}:`, err.message);
    return getDefaultResponsive(err.message);
  }
}

module.exports = { analyzeResponsive, initResponsiveAI, getDefaultResponsive };
