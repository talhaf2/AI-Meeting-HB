const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');

// Make sure these are all functions!
router.get('/availability', meetingController.getAvailability);
router.post('/book', meetingController.bookMeeting);
router.post('/webhook', meetingController.webhookBland);


router.post('/webpage', meetingController.webapge);


module.exports = router;
