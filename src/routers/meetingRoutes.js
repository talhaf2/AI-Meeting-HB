const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');

// Make sure these are all functions!
router.get('/availability', meetingController.getAvailability);
router.post('/book', meetingController.bookMeeting);
router.get('/links', meetingController.getAllMeetingLinks);
router.get('/generate-slug', meetingController.getSlug);



module.exports = router;
