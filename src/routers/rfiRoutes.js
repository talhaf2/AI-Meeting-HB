const express = require('express');
const router = express.Router();
const rfiController = require('../controllers/rfiController');

// Retell tools sometimes send JSON with text/plain or missing Content-Type.
// This parser will treat those as JSON for this route only.
const retellJsonParser = express.json({
  type: (req) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    return !ct || ct.includes('application/json') || ct.includes('+json') || ct.includes('text/plain');
  }
});

// Retell -> API -> Twilio (JSON)
router.post('/send-sms', retellJsonParser, rfiController.sendSms);

// Retell webhook for RFI support calls (Slack + conditional SMS)
router.post('/webhook-retell-rfi', retellJsonParser, rfiController.webhookRetellRfi);

router.get('/health', (req, res) => res.json({ ok: true }));

module.exports = router;

