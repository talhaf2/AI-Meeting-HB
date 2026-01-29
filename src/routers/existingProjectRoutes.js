const express = require('express');
const router = express.Router();
const existingProjectController = require('../controllers/existingProjectController');

// Existing project tool endpoints (for Retell agent)
router.get('/pms', existingProjectController.listPms);
router.get('/pms/live', existingProjectController.listHubspotPms);
router.get('/availability', existingProjectController.getPmAvailability);
router.post('/book', existingProjectController.bookPmMeeting);

// HubSpot lookup to prefill caller details
router.get('/contact/lookup', existingProjectController.lookupContact);

// Retell webhook for existing project calls
router.post('/webhook-retell', existingProjectController.webhookRetellExisting);

module.exports = router;

