const express = require('express');
const router = express.Router();
const dispositioningController = require('../controllers/dispositioningController');

// Read-only endpoint to list deals stuck in "Appointment Set" past a threshold
router.get('/stale-appointment-set-deals', dispositioningController.getStaleAppointmentSetDeals);

module.exports = router;

