/**
 * ============================================================
 * testRoutes.js - API Routes for Website Testing Platform
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { verifyGoogleToken, generateSessionToken, checkCredits } = require('../middleware/authMiddleware');
const {
  getHealth,
  getLiveTestStatus,
  startTest,
  getReports,
  getReport,
  getReportPages,
  testLegacy,
  groqAnalyze,
  scanDomain,
  getScanStatus,
  deleteReport
} = require('../controllers/reportController');

const {
  runAiAudit,
  getAiIssues,
  updateIssueStatus,
  verifyIssue
} = require('../controllers/aiAuditController');

// REST API Endpoints
router.get('/health', getHealth);
router.get('/test/:testId', verifyGoogleToken, getLiveTestStatus);
router.post('/login', verifyGoogleToken, (req, res) => {
  const sessionToken = generateSessionToken({
    id: req.userId,
    email: req.userEmail,
    name: req.userName,
    picture: req.userPicture
  });

  res.json({
    success: true,
    token: sessionToken,
    user: {
      id: req.userId,
      email: req.userEmail,
      name: req.userName,
      picture: req.userPicture
    }
  });
});
router.post('/start-test', verifyGoogleToken, checkCredits, startTest);
router.post('/scan-domain', verifyGoogleToken, scanDomain);
router.get('/scan-status/:jobId', verifyGoogleToken, getScanStatus);
router.get('/reports', verifyGoogleToken, getReports);
router.get('/reports/:testId/pages', verifyGoogleToken, getReportPages);
router.get('/reports/:testId', verifyGoogleToken, getReport);
router.delete('/reports/:testId', verifyGoogleToken, deleteReport);

// Legacy/Auxiliary routes
router.post('/test', verifyGoogleToken, testLegacy);
router.post('/groq-analyze', verifyGoogleToken, groqAnalyze);

// ── AI Audit routes (new — modular, backward-compatible) ──────
router.post('/ai-audit', verifyGoogleToken, runAiAudit);
router.get('/ai-issues/:testId', verifyGoogleToken, getAiIssues);
router.patch('/ai-issues/:issueId', verifyGoogleToken, updateIssueStatus);
router.post('/ai-verify/:issueId', verifyGoogleToken, verifyIssue);

module.exports = router;

