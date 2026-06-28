/**
 * ============================================================
 * testRoutes.js - API Routes for Website Testing Platform
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { verifyGoogleToken, generateSessionToken } = require('../middleware/authMiddleware');
const {
  getHealth,
  getLiveTestStatus,
  startTest,
  getReports,
  getReport,
  getReportPages,
  testLegacy,
  groqAnalyze
} = require('../controllers/reportController');

// REST API Endpoints
router.get('/health', getHealth);
router.get('/test/:testId', getLiveTestStatus);
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
router.post('/start-test', verifyGoogleToken, startTest);
router.get('/reports', verifyGoogleToken, getReports);
router.get('/reports/:testId/pages', verifyGoogleToken, getReportPages);
router.get('/reports/:testId', verifyGoogleToken, getReport);

// Legacy/Auxiliary routes
router.post('/test', testLegacy);
router.post('/groq-analyze', groqAnalyze);

module.exports = router;
