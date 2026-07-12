/**
 * ============================================================
 * controllers/aiAuditController.js — AI Page Audit System
 * ============================================================
 * Provides 4 handlers:
 *   runAiAudit      — POST /api/ai-audit
 *   getAiIssues     — GET  /api/ai-issues/:testId
 *   updateIssueStatus — PATCH /api/ai-issues/:issueId
 *   verifyIssue     — POST /api/ai-verify/:issueId
 *
 * Uses Groq Vision (llama-3.2-11b-vision-preview) to analyze
 * a Playwright screenshot and surface structured UI/UX issues.
 * ============================================================
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const fetch  = require('node-fetch');
const { chromium } = require('playwright');
const { pool }     = require('../config/db');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const { auditPageIssues } = require('../groqAnalyzer');

// ── Groq helper ───────────────────────────────────────────────
async function callGroqVision(base64Image, systemPrompt, userPrompt, maxTokens = 4096) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_groq_api_key_here') {
    throw new Error('GROQ_API_KEY is not configured.');
  }

  const body = {
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64Image}`, detail: 'high' },
          },
          { type: 'text', text: userPrompt },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
  };

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── JSON extractor ────────────────────────────────────────────
function extractJson(raw) {
  if (!raw) return null;
  let text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const m = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!m) return null;
  text = m[0].replace(/,\s*([\}\]])/g, '$1');
  try { return JSON.parse(text); } catch { return null; }
}

// ── Field normalizers (shared by audit + seeding) ─────────────
function normalizeSeverity(s) {
  return ['Critical', 'High', 'Medium', 'Low'].includes(s) ? s : 'Medium';
}
function normalizeCategory(c) {
  if (!c) return 'UI/UX';
  return String(c).replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}
function formatSteps(steps) {
  if (Array.isArray(steps)) return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return steps ? String(steps) : '';
}

// ── Screenshot helper ─────────────────────────────────────────
async function takeScreenshot(pageUrl, outputPath) {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
      page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    );
    await page.waitForTimeout(2000);
    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Audit prompt ──────────────────────────────────────────────
const AUDIT_SYSTEM_PROMPT = `You are an expert UI/UX auditor and web accessibility consultant.
Analyze the provided screenshot of a web page and identify all issues across these 7 categories:
1. DESIGN — Missing design elements, incomplete sections, placeholder content
2. LAYOUT — Misaligned elements, broken grid, overlapping content, whitespace issues
3. GRAMMAR — Spelling mistakes, grammatical errors, keyword stuffing, poor copy
4. RENDERING — Text overlap, clipping, cut-off content, overflow, z-index conflicts
5. HEADER_FOOTER — Navigation design, logo placement, footer completeness
6. BUTTONS — Inconsistent button styles, sizes, colors, spacing, missing hover states
7. UI_UX — Overall consistency, responsiveness indicators, accessibility, contrast

Return ONLY a valid JSON object with this exact structure:
{
  "issues": [
    {
      "title": "Brief issue title (max 80 chars)",
      "description": "Detailed description of what was observed and why it's a problem",
      "recommendedFix": "Specific, actionable fix the developer should implement",
      "priority": "High|Medium|Low",
      "category": "design|layout|grammar|rendering|header_footer|buttons|ui_ux"
    }
  ]
}

Rules:
- Include ALL real issues you see. Do not invent issues that don't exist.
- If the page looks good in a category, do not include fake issues.
- priority: High = broken/unusable, Medium = significant problem, Low = minor improvement
- Be specific: reference actual text, colors, element positions you see in the screenshot.`;

const AUDIT_USER_PROMPT = `Perform a comprehensive audit of this web page screenshot.
Identify every UI/UX, design, layout, grammar, and rendering issue you can see.
Return the JSON issues array as instructed.`;

// ── Verification prompt ───────────────────────────────────────
function buildVerifyPrompt(issue) {
  return `You previously flagged this issue on a web page:

ISSUE TITLE: ${issue.title}
DESCRIPTION: ${issue.description}
RECOMMENDED FIX: ${issue.recommended_fix}
CATEGORY: ${issue.category}

I am now showing you a fresh screenshot of the same page after the developer attempted a fix.

Determine carefully: Is this specific issue STILL present in the current screenshot, or has it been RESOLVED?

Return ONLY valid JSON:
{
  "resolved": true | false,
  "confidence": "high|medium|low",
  "reason": "Explanation of what you see in the current screenshot regarding this issue"
}`;
}

// ═══════════════════════════════════════════════════════════════
// HANDLER 1 — POST /api/ai-audit
// Body: { testId, pageUrl }
// ═══════════════════════════════════════════════════════════════
async function runAiAudit(req, res) {
  const userId = req.userId;
  try {
    const { testId, pageUrl } = req.body;

    if (!testId || !pageUrl) {
      return res.status(400).json({ success: false, error: 'testId and pageUrl are required.' });
    }

    let url = pageUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    try { new URL(url); } catch {
      return res.status(400).json({ success: false, error: 'Invalid pageUrl format.' });
    }

    // Take screenshot
    const screenshotDir = path.join(__dirname, '..', 'reports', `ai_${testId}`);
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `${Date.now()}.png`);

    console.log(`🤖 [AI Audit] Taking screenshot of ${url}`);
    await takeScreenshot(url, screenshotPath);

    // Call Groq Vision Page Audit
    const auditRes = await auditPageIssues(screenshotPath, url, 'Audited Page');

    if (!auditRes.success) {
      return res.status(500).json({ success: false, error: auditRes.error || 'AI Audit failed' });
    }

    const issues = auditRes.issues.filter(i => i.title && i.description);
    console.log(`🤖 [AI Audit] Found ${issues.length} issues for ${url}`);

    // Delete existing issues for this page in this test run to prevent duplication
    await pool.query(
      'DELETE FROM ai_issues WHERE test_id = $1 AND user_id = $2 AND page_url = $3',
      [testId, userId, url]
    );

    // Insert ONE task per detected issue, with structured test-case fields.
    const inserted = [];
    for (const issue of issues) {
      const dbRes = await pool.query(
        `INSERT INTO ai_issues
           (test_id, user_id, page_url, title, description, recommended_fix, priority, status,
            category, affected_element, confidence_score, expected_behavior, actual_behavior, reproduction_steps, ai_raw_response)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          testId, userId, url,
          String(issue.title || 'UI Issue').slice(0, 250),
          issue.description || '',
          issue.recommendedFix || issue.recommended_fix || '',
          normalizeSeverity(issue.severity),
          normalizeCategory(issue.category),
          issue.affectedElement || issue.affected_element || 'Page element',
          String(issue.confidenceScore || issue.confidence_score || '90%'),
          issue.expectedBehavior || issue.expected_behavior || '',
          issue.actualBehavior || issue.actual_behavior || '',
          formatSteps(issue.reproductionSteps || issue.reproduction_steps),
          JSON.stringify(issue),
        ]
      );
      inserted.push(dbRes.rows[0]);
    }

    return res.json({ success: true, count: inserted.length, issues: inserted });
  } catch (err) {
    console.error('❌ [AI Audit] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════
// HANDLER 2 — GET /api/ai-issues/:testId
// ═══════════════════════════════════════════════════════════════
async function getAiIssues(req, res) {
  const { testId } = req.params;
  const userId = req.userId;
  try {
    // 1. Fetch user subscription details
    const userRes = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
    const tier = userRes.rows[0]?.subscription_tier || 'Free';

    // Free plan users do not have access to AI features
    if (tier === 'Free') {
      return res.status(403).json({
        success: false,
        error: 'AI Issues Locked: Free Trial users do not have access to AI-based UI audits. Please upgrade to unlock.',
        code: 'AI_LOCKED'
      });
    }

    const taskLimits = {
      'Basic': 50,
      'Pro': 200,
      'Business': 999999
    };
    const maxTasks = taskLimits[tier] || 50;

    // 2. Fetch current issues for this test
    let r = await pool.query(
      `SELECT * FROM ai_issues WHERE test_id = $1 AND user_id = $2 ORDER BY
         CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END,
         created_at ASC LIMIT $3`,
      [testId, userId, maxTasks]
    );

    // 3. If no issues exist, try to parse/seed them from the report_data
    if (r.rows.length === 0) {
      console.log(`🤖 [getAiIssues] No issues in database for test ${testId}. Checking reports fallback...`);
      const reportRes = await pool.query(
        'SELECT report_data FROM reports WHERE test_id = $1 AND user_id = $2',
        [testId, userId]
      );
      if (reportRes.rows.length > 0) {
        const reportData = reportRes.rows[0].report_data;
        const pages = reportData.pages || [];
        const toInsert = [];

        for (const page of pages) {
          if (!page.groqAnalysis) continue;

          // Case A: Step 4 auditResult issues (new structured test-case schema)
          if (page.groqAnalysis.auditResult && Array.isArray(page.groqAnalysis.auditResult.issues)) {
            for (const issue of page.groqAnalysis.auditResult.issues) {
              toInsert.push({
                title: issue.title,
                description: issue.description,
                recommended_fix: issue.recommendedFix || issue.recommended_fix || 'Fix this visual or rendering issue.',
                priority: normalizeSeverity(issue.severity),
                category: normalizeCategory(issue.category),
                affected_element: issue.affectedElement || issue.affected_element || 'Page element',
                confidence_score: String(issue.confidenceScore || issue.confidence_score || '90%'),
                expected_behavior: issue.expectedBehavior || issue.expected_behavior || '',
                actual_behavior: issue.actualBehavior || issue.actual_behavior || '',
                reproduction_steps: formatSteps(issue.reproductionSteps || issue.reproduction_steps),
                raw: issue,
                page_url: page.url
              });
            }
          }
          // Case B: Fallback to elementAnalysis errors
          else if (page.groqAnalysis.elementAnalysis && Array.isArray(page.groqAnalysis.elementAnalysis.errors)) {
            for (const err of page.groqAnalysis.elementAnalysis.errors) {
              const priority = err.severity === 'high' ? 'High' : (err.severity === 'medium' ? 'Medium' : (err.severity === 'low' ? 'Low' : 'Medium'));
              const category = err.type === 'validation-error' ? 'UX' : (err.type === 'layout-issue' ? 'Layout' : 'UI');
              toInsert.push({
                title: err.description || 'Visual elements issue',
                description: err.description || 'A UI error was detected by AI.',
                recommended_fix: `Investigate and resolve this ${err.type || 'visual'} issue.`,
                priority,
                category,
                affected_element: 'Visual Element',
                confidence_score: '95%',
                expected_behavior: '',
                actual_behavior: err.description || '',
                reproduction_steps: '',
                raw: err,
                page_url: page.url
              });
            }
          }
        }

        // Insert extracted issues as individual task rows (one per issue), up to the plan limit
        if (toInsert.length > 0) {
          const countRes = await pool.query('SELECT COUNT(*)::int as count FROM ai_issues WHERE user_id = $1', [userId]);
          const currentCount = countRes.rows[0].count || 0;
          const allowedToSeed = Math.max(0, maxTasks - currentCount);

          console.log(`🤖 [getAiIssues] Seeding ${Math.min(toInsert.length, allowedToSeed)} / ${toInsert.length} fallback issue task(s) from report_data (Max limit: ${maxTasks}, Current count: ${currentCount})...`);

          const slicedInsert = toInsert.slice(0, allowedToSeed);

          for (const item of slicedInsert) {
            await pool.query(
              `INSERT INTO ai_issues
                 (test_id, user_id, page_url, title, description, recommended_fix, priority, status,
                  category, affected_element, confidence_score, expected_behavior, actual_behavior, reproduction_steps, ai_raw_response)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$13,$14)
               ON CONFLICT DO NOTHING`,
              [
                testId, userId, item.page_url,
                String(item.title || 'UI Issue').slice(0, 250),
                item.description || '',
                item.recommended_fix || '',
                item.priority,
                item.category,
                item.affected_element,
                item.confidence_score,
                item.expected_behavior,
                item.actual_behavior,
                item.reproduction_steps,
                JSON.stringify(item.raw || item),
              ]
            );
          }

          // Fetch again from seeded table
          r = await pool.query(
            `SELECT * FROM ai_issues WHERE test_id = $1 AND user_id = $2 ORDER BY
               CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END,
               created_at ASC LIMIT $3`,
            [testId, userId, maxTasks]
          );
        }
      }
    }

    return res.json({ success: true, issues: r.rows });
  } catch (err) {
    console.error('❌ [AI Issues] getAiIssues error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// HANDLER 3 — PATCH /api/ai-issues/:issueId
// Body: { status }  — one of: open | in_progress | done | dismissed | pending
// ═══════════════════════════════════════════════════════════════
async function updateIssueStatus(req, res) {
  const { issueId } = req.params;
  const userId = req.userId;
  const { status } = req.body;

  const VALID_STATUSES = ['open', 'in_progress', 'done', 'dismissed', 'pending', 'cancelled'];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const userRes = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
    const tier = userRes.rows[0]?.subscription_tier || 'Free';
    if (tier === 'Free') {
      return res.status(403).json({ success: false, error: 'Access Denied: Please upgrade your subscription to modify tasks.' });
    }

    const r = await pool.query(
      `UPDATE ai_issues SET status = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [status, issueId, userId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Issue not found or access denied.' });
    }
    return res.json({ success: true, issue: r.rows[0] });
  } catch (err) {
    console.error('❌ [AI Issues] updateIssueStatus error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// HANDLER 4 — POST /api/ai-verify/:issueId
// Re-screenshots the page and asks Groq if the issue is resolved
// ═══════════════════════════════════════════════════════════════
async function verifyIssue(req, res) {
  const { issueId } = req.params;
  const userId = req.userId;

  try {
    const userRes = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
    const tier = userRes.rows[0]?.subscription_tier || 'Free';
    if (tier === 'Free') {
      return res.status(403).json({ success: false, error: 'Access Denied: Please upgrade your subscription to run AI verification.' });
    }

    // Fetch the issue
    const issueRes = await pool.query(
      'SELECT * FROM ai_issues WHERE id = $1 AND user_id = $2',
      [issueId, userId]
    );
    if (issueRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Issue not found or access denied.' });
    }
    const issue = issueRes.rows[0];

    // Mark as verifying
    await pool.query(
      "UPDATE ai_issues SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
      [issueId]
    );

    // Take fresh screenshot
    const screenshotDir = path.join(__dirname, '..', 'reports', `ai_verify_${issueId}`);
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `verify_${Date.now()}.png`);

    console.log(`🔍 [AI Verify] Re-screenshotting ${issue.page_url} for issue #${issueId}`);
    await takeScreenshot(issue.page_url, screenshotPath);

    const imgBase64 = fs.readFileSync(screenshotPath).toString('base64');

    const VERIFY_SYSTEM = `You are an expert UI/UX quality assurance engineer verifying whether a previously reported issue has been fixed.
Analyze the screenshot carefully and return ONLY valid JSON as instructed. No markdown, no explanation.`;

    console.log(`🔍 [AI Verify] Calling Groq Vision for verification...`);
    const rawResponse = await callGroqVision(imgBase64, VERIFY_SYSTEM, buildVerifyPrompt(issue), 1024);
    const parsed = extractJson(rawResponse);

    let newStatus, message;

    if (!parsed) {
      // Fallback — can't parse, stay pending
      newStatus = 'pending';
      message = 'AI verification response could not be parsed. Please try again.';
    } else if (parsed.resolved === true) {
      newStatus = 'done';
      message = `✅ Issue verified as resolved. ${parsed.reason || ''}`.trim();
    } else {
      newStatus = 'pending';
      message = `⚠️ This task is not completed yet. Please fix this issue and run the test again. ${parsed.reason || ''}`.trim();
    }

    // Update status in DB
    const updated = await pool.query(
      `UPDATE ai_issues SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [newStatus, issueId]
    );

    return res.json({
      success: true,
      resolved: newStatus === 'done',
      status: newStatus,
      message,
      confidence: parsed?.confidence || 'medium',
      issue: updated.rows[0],
    });
  } catch (err) {
    // On error, reset to 'open'
    await pool.query("UPDATE ai_issues SET status = 'open', updated_at = NOW() WHERE id = $1", [issueId]).catch(() => {});
    console.error('❌ [AI Verify] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { runAiAudit, getAiIssues, updateIssueStatus, verifyIssue };
