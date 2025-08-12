const express = require('express');
const router = express.Router();
const hubspotWebpageController = require('../controllers/hubspotWebpageController');

router.post('/', hubspotWebpageController.webapge);
router.post('/outcome-changed', hubspotWebpageController.webapgeOutcomeChange);

module.exports = router;
