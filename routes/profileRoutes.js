const express = require('express');
const router = express.Router();
const { verifyGoogleToken } = require('../middleware/authMiddleware');
const controller = require('../controllers/profileController');

// All profile endpoints require authenticating Google Token
router.use(verifyGoogleToken);

router.get('/info', controller.getProfileInfo);
router.get('/credits-history', controller.getCreditsHistory);
router.post('/credits/mock-add', controller.addCreditsMock);

module.exports = router;
