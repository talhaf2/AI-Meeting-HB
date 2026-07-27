const express = require('express');
const router = express.Router();
const calendarStatusController = require('../controllers/calendarStatusController');

router.get('/status', calendarStatusController.status);
router.post('/check-now', calendarStatusController.checkNow);
router.post('/test-alert', calendarStatusController.testAlert);

module.exports = router;
