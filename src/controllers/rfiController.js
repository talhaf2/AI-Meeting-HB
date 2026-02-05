const twilio = require('twilio');

let _sendSlackMessageToChannel = null;
async function sendRfiSlackAlert(text) {
  const pmChannel = process.env.PM_SLACK_CHANNEL;
  if (!pmChannel) {
    console.warn('[RFI Slack] PM_SLACK_CHANNEL is not set; skipping Slack alert');
    return;
  }

  if (!_sendSlackMessageToChannel) {
    ({ sendSlackMessageToChannel: _sendSlackMessageToChannel } = await import('../services/slackService.js'));
  }

  return _sendSlackMessageToChannel(text, pmChannel);
}

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

function isTrueish(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function sendRfiSms(toE164) {
  const from = process.env.TWILIO_NUMBER;
  if (!from) {
    throw new Error('TWILIO_NUMBER is not configured');
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN is not configured');
  }

  const client = twilio(accountSid, authToken);
  const body = 'Prostruct Engineering RFI support link: https://rfi.prostructengineering.com';
  return client.messages.create({ to: toE164, from, body });
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

    const msg = await sendRfiSms(to);

    console.log('[RFI SMS] sent', { to, from: process.env.TWILIO_NUMBER, sid: msg.sid });
    return res.json({ ok: true, sid: msg.sid, to, from: process.env.TWILIO_NUMBER });
  } catch (e) {
    console.error('[RFI SMS] send error', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Failed to send SMS' });
  }
};

/**
 * Retell webhook for RFI support calls.
 * POST /api/rfi/webhook-retell
 *
 * Dynamic var: `message_sent`
 * - If true: do NOT send SMS again
 * - If false: send SMS to caller
 *
 * Slack alert is sent from this webhook (PM channel) instead of /send-sms route.
 */
exports.webhookRetellRfi = async (req, res) => {
  try {
    if (!req.body?.event || req.body.event !== 'call_analyzed') {
      return res.json({ message: `Event ${req.body?.event || 'unknown'} received but not processed` });
    }

    const callData = req.body.call;
    if (!callData) {
      return res.json({ message: 'No call data found' });
    }

    const dynamicVars = callData.collected_dynamic_variables || {};
    const messageSentVar = dynamicVars.message_sent ?? dynamicVars.messageSent;
    const alreadySent = isTrueish(messageSentVar);

    const phoneRaw = callData.from_number || dynamicVars.phone || dynamicVars.to || '';
    const toE164 = normalizeToE164US(phoneRaw);

    const summary = callData.call_analysis?.call_summary || callData.transcript || '';
    const recordingUrl = callData.recording_url || '';

    let smsAttempted = false;
    let smsSent = false;
    let smsSid = null;
    let smsError = null;

    if (!alreadySent) {
      smsAttempted = true;
      try {
        if (!toE164) {
          throw new Error('Missing/invalid caller phone');
        }
        const msg = await sendRfiSms(toE164);
        smsSent = true;
        smsSid = msg?.sid || null;
      } catch (e) {
        smsError = e?.message || String(e);
      }
    }

    // Slack alert to PM channel (tag channel)
    try {
      const slackMsg =
        `<!channel>\n` +
        `🧾 *RFI Support Call*\n` +
 
        `*Call Summary:* ${summary || 'n/a'}\n` +
        `*Caller:* ${toE164 || phoneRaw || 'n/a'}\n`;
  

      await sendRfiSlackAlert(slackMsg);
    } catch (e) {
      console.error('[RFI webhook] Slack post error', e?.message || e);
    }

    return res.json({
      ok: true,
      message_sent: alreadySent,
      smsAttempted,
      smsSent,
      smsSid,
      to: toE164 || null,
    });
  } catch (e) {
    console.error('[RFI webhook] error', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Internal server error' });
  }
};

