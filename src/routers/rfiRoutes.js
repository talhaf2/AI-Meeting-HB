const express = require('express');
const router = express.Router();
const rfiController = require('../controllers/rfiController');

// Retell -> API -> Twilio (JSON)
router.post('/send-sms', rfiController.sendSms);

router.get('/health', (req, res) => res.json({ ok: true }));

module.exports = router;

