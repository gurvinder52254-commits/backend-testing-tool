/**
 * ============================================================
 * microservices/ai-service — AI Analysis Service
 * ============================================================
 * A small HTTP service that is the ONLY place the Gemini/Groq
 * API keys live (secret isolation — a compromise of any other
 * service does not leak AI keys).
 *
 * Reuses the monolith's battle-tested analyzers as-is:
 *   - geminiAnalyzer.analyzeScreenshot  → quality score
 *   - groqAnalyzer.runGroqAnalysisPipeline → element inventory
 * Gemini and Groq run in PARALLEL (the monolith ran them
 * sequentially). Every call is best-effort: a failure returns a
 * safe default instead of throwing, so a page test never dies
 * because AI was unavailable.
 *
 * SAFETY: AI is only invoked when MS_AI_ENABLED=true. Otherwise
 * /analyze returns defaults WITHOUT calling any paid API. This
 * keeps local runs / smoke tests from triggering charges.
 * ============================================================
 */

const express = require('express');
const fs = require('fs');
const config = require('../shared/config');
const { createLogger } = require('../shared/logger');

const log = createLogger('ai-service');

const { analyzeScreenshot, initializeGemini } = require('../../geminiAnalyzer');
const { runGroqAnalysisPipeline, initializeGroq } = require('../../groqAnalyzer');

const DEFAULT_ANALYSIS = {
  overallScore: 0,
  summary: 'AI analysis not available.',
  uiUx: {},
  structure: {},
  content: {},
  accessibility: {},
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function runGemini(screenshotPath, url, title) {
  try {
    return await withTimeout(
      analyzeScreenshot(screenshotPath, url, title),
      config.limits.aiTimeoutMs,
      'Gemini'
    );
  } catch (err) {
    log.warn('Gemini failed:', err.message);
    return { ...DEFAULT_ANALYSIS };
  }
}

async function runGroq(screenshotPath, url, title, userDetails) {
  try {
    return await withTimeout(
      runGroqAnalysisPipeline(screenshotPath, url, title, userDetails, () => {}),
      config.limits.aiTimeoutMs,
      'Groq'
    );
  } catch (err) {
    log.warn('Groq failed:', err.message);
    return null;
  }
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'ai-service', aiEnabled: config.aiEnabled });
});

/**
 * POST /analyze
 * body: { screenshotPath, url, title, userDetails }
 * returns: { aiAnalysis, groqAnalysis }
 */
app.post('/analyze', async (req, res) => {
  const { screenshotPath, url, title, userDetails } = req.body || {};

  if (!config.aiEnabled) {
    // Explicitly disabled — return defaults, do NOT call paid APIs.
    return res.json({
      aiAnalysis: { ...DEFAULT_ANALYSIS, summary: 'AI disabled (MS_AI_ENABLED!=true).' },
      groqAnalysis: null,
      skipped: true,
    });
  }

  if (!screenshotPath || !fs.existsSync(screenshotPath)) {
    return res.status(400).json({ success: false, error: 'Valid screenshotPath is required.' });
  }

  // Run both providers concurrently; neither can fail the request.
  const [aiAnalysis, groqAnalysis] = await Promise.all([
    runGemini(screenshotPath, url, title),
    runGroq(screenshotPath, url, title, userDetails),
  ]);

  res.json({ aiAnalysis, groqAnalysis });
});

function start() {
  if (config.aiEnabled) {
    initializeGemini();
    initializeGroq();
    log.info('AI providers initialized (MS_AI_ENABLED=true).');
  } else {
    log.warn('MS_AI_ENABLED is not "true" — /analyze returns defaults, no paid API calls.');
  }

  const server = app.listen(config.ports.ai, () => {
    log.ok(`AI service listening on http://127.0.0.1:${config.ports.ai}`);
  });

  const shutdown = () => {
    log.info('Shutting down AI service...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = { app };
