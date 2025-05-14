const express = require('express');
const router = express.Router();
const meetingController = require('../controllers/meetingController');

// Make sure these are all functions!
router.get('/availability', meetingController.getAvailability);
router.post('/book', meetingController.bookMeeting);
router.post('/update-contact', meetingController.updateContactAndCreateDeal);
router.post('/webhook', meetingController.webhookTest);

router.post('/sendmail', meetingController.notifyPMExistingClient);




module.exports = router;
