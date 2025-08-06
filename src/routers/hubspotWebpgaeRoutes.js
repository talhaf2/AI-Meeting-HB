const express = require('express');
const router = express.Router();
const hubspotWebpageController = require('../controllers/hubspotWebpageController');

router.post('/', hubspotWebpageController.webapge);

module.exports = router;
