const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');

// Make sure these are all functions!
router.post('/availability', meetingController.getAvailability);
router.post('/book', meetingController.bookMeeting);

router.post('/webhook-retell', meetingController.webhookRetell);
router.post('/webhook', meetingController.webhookBland);


router.post('/test', meetingController.test);

router.post('/slug', meetingController.getSlug);


module.exports = router;
