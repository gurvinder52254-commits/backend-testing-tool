/**
 * ============================================================
 * testRoutes.js - API Routes for Website Testing Platform
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { verifyGoogleToken } = require('../middleware/authMiddleware');
const {
  getHealth,
  getLiveTestStatus,
  startTest,
  getReports,
  getReport,
  testLegacy,
  groqAnalyze
} = require('../controllers/reportController');

// REST API Endpoints
router.get('/health', getHealth);
router.get('/test/:testId', getLiveTestStatus);
router.post('/login', verifyGoogleToken, (req, res) => {
  res.json({
    success: true,
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
router.get('/reports/:testId', verifyGoogleToken, getReport);

// Legacy/Auxiliary routes
router.post('/test', testLegacy);
router.post('/groq-analyze', groqAnalyze);

module.exports = router;
