const twilio = require('twilio');
const axios = require('axios');

let _sendSlackMessageToChannel = null;
let _mentionByEmail = null;
let _mentionsFromEmails = null;
async function sendRfiSlackAlert(text, blocks) {
  const pmChannel = process.env.PM_SLACK_CHANNEL;
  if (!pmChannel) {
    console.warn('[RFI Slack] PM_SLACK_CHANNEL is not set; skipping Slack alert');
    return;
  }

  if (!_sendSlackMessageToChannel) {
    ({ sendSlackMessageToChannel: _sendSlackMessageToChannel, mentionByEmail: _mentionByEmail } =
      await import('../services/slackService.js'));
  }

  return _sendSlackMessageToChannel(text, pmChannel, blocks);
}

async function getCsaMentions() {
  const emails = ['angela@prostructengineering.com', 'von@prostructengineering.com', 'jeff@prostructengineering.com'];
  try {
    if (!_mentionsFromEmails) {
      ({ mentionsFromEmails: _mentionsFromEmails } = await import('../services/slackService.js'));
    }
    return await _mentionsFromEmails(emails);
  } catch {
    return '';
  }
}

function trimSummary(text, maxLen = 220) {
  const s = String(text || '').trim();
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '45924609';
function hsContactUrl(contactId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`;
}
function hsDealUrl(dealId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildPhoneSearchTokens(rawPhone) {
  const d = digitsOnly(rawPhone);
  if (!d) return [];
  const last10 = d.length >= 10 ? d.slice(-10) : d;
  const tokens = new Set();
  if (d.length === 11 && d.startsWith('1')) tokens.add(d);
  if (last10.length === 10) {
    tokens.add(last10);
    tokens.add(`1${last10}`);
  } else {
    tokens.add(d);
  }
  return [...tokens].filter(Boolean);
}

async function lookupContactByPhone(rawPhone) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return null;

  const tokens = buildPhoneSearchTokens(rawPhone);
  if (!tokens.length) return null;

  const filterGroups = tokens.map((t) => ({
    filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: t }]
  }));

  const { data } = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts/search',
    {
      filterGroups,
      properties: ['firstname', 'lastname', 'email', 'phone'],
      limit: 10
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const results = data?.results || [];
  if (!results.length) return null;

  const wantedLast10 = digitsOnly(rawPhone).slice(-10);
  const best =
    results.find((r) => digitsOnly(r?.properties?.phone).slice(-10) === wantedLast10) || results[0];

  return best?.id ? best.id : null;
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
  const body =
    'Please fill out this short form to open direct channel with the project team for RFI support\n' +
    'https://rfi.prostructengineering.com';
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
      const contactIdFromVars =
        dynamicVars.contactId || dynamicVars.contact_id || dynamicVars.hs_object_id || '';
      let contactId = contactIdFromVars;
      if (!contactId) {
        try {
          contactId = await lookupContactByPhone(phoneRaw);
        } catch (e) {
          console.warn('[RFI webhook] contact lookup failed:', e?.response?.data || e?.message || e);
        }
      }

      const caller = toE164 || phoneRaw || 'n/a';
      const contactLine = contactId
        ? `*HubSpot Contact:* <${hsContactUrl(contactId)}|View Contact>`
        : '';
      const notFoundLine = !contactId
        ? `${(await getCsaMentions()) || '<!channel>'}\n⚠️ *Contact not found by phone* — it might be a new contact.`
        : '';

      const slackMsg =
        `🧾 RFI Support Call\n` +
        `Caller: ${caller}\n` +
        `Next steps: Be on the lookout for the RFI support chat email and/or call back the caller.`;

      const headerText = [
        notFoundLine,
        '<!channel>',
        '🧾 *RFI Support Call*',
        `*Caller:* ${caller}`,
        contactLine
      ].filter(Boolean).join('\n');

      const blocks = [
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `${headerText}\n\n` +
              `*Next steps:* Be on the lookout for the RFI support chat email and/or call back the caller.`
          }
        },
        { type: 'divider' }
      ];

      await sendRfiSlackAlert(slackMsg, blocks);
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

