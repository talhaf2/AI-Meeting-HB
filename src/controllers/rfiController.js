const twilio = require('twilio');

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeToE164US(value) {
  const d = digitsOnly(value);
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(value || '').startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
}

/**
 * POST /api/rfi/send-sms
 * Body: { to: "+1..." } (JSON)
 * Protected by header: x-rfi-secret == process.env.RFI_API_SECRET
 */
exports.sendSms = async (req, res) => {
  try {
    const requiredSecret = process.env.RFI_API_SECRET;
    if (requiredSecret) {
      const provided = String(req.header('x-rfi-secret') || '');
      if (provided !== requiredSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const toRaw =
      req?.body?.to ??
      req?.body?.phone ??
      req?.body?.args?.to ??
      req?.body?.args?.phone ??
      req?.body?.variables?.to ??
      req?.body?.variables?.phone;
    const to = normalizeToE164US(toRaw);
    if (!to) {
      return res.status(400).json({ error: 'Valid "to" phone is required' });
    }

    const from = process.env.TWILIO_NUMBER_RFI;
    if (!from) {
      return res.status(500).json({ error: 'TWILIO_NUMBER_RFI is not configured' });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const body = 'Prostruct Engineering RFI support link: https://rfi.prostructengineering.com';

    const msg = await client.messages.create({ to, from, body });

    console.log('[RFI SMS] sent', { to, from, sid: msg.sid });
    return res.json({ ok: true, sid: msg.sid, to, from });
  } catch (e) {
    console.error('[RFI SMS] send error', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Failed to send SMS' });
  }
};

