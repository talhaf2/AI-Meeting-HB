const axios = require('axios');
const { DateTime } = require('luxon');
const { sendCallSlackMessage, sendSlackMessageToChannel, mentionsFromEmails, mentionByEmail } = require('../services/slackService');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles';

// HubSpot portal id only used for hyperlinking in Slack (optional)
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '45924609';
function hsContactUrl(contactId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`;
}

function buildPhoneSearchTokens(rawPhone) {
  const d = digits(rawPhone);
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
  const tokens = buildPhoneSearchTokens(rawPhone);
  if (!tokens.length) return null;

  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    'Content-Type': 'application/json'
  };

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
    { headers }
  );

  const results = data?.results || [];
  if (!results.length) return null;

  const wantedLast10 = digits(rawPhone).slice(-10);
  const best =
    results.find((r) => digits(r?.properties?.phone).slice(-10) === wantedLast10) || results[0];

  return best?.id ? { id: best.id, properties: best.properties || {} } : null;
}

async function lookupContactByEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return null;

  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const { data } = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts/search',
    {
      filterGroups: [
        {
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }
      ],
      properties: ['firstname', 'lastname', 'email', 'phone'],
      limit: 1
    },
    { headers }
  );

  const best = data?.results?.[0];
  return best?.id ? { id: best.id, properties: best.properties || {} } : null;
}

async function csaMentions() {
  const emails = ['christine.m@prostructengineering.com', 'angela@prostructengineering.com', 'von@prostructengineering.com'];
  try {
    return await mentionsFromEmails(emails);
  } catch {
    return '';
  }
}

// ---- Owner email resolution (PM name -> email) ----
let _ownersCache = { fetchedAtMs: 0, owners: [] };
const OWNERS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeName(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function fetchHubspotOwners() {
  const now = Date.now();
  if (_ownersCache.owners.length && now - _ownersCache.fetchedAtMs < OWNERS_CACHE_TTL_MS) {
    return _ownersCache.owners;
  }

  const headers = {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const owners = [];
  let after = undefined;
  for (let i = 0; i < 20; i++) {
    const { data } = await axios.get('https://api.hubapi.com/crm/v3/owners', {
      headers,
      params: {
        limit: 500,
        ...(after ? { after } : {})
      }
    });

    const results = data?.results || [];
    for (const o of results) {
      const name = `${o.firstName || ''} ${o.lastName || ''}`.trim();
      owners.push({
        id: o.id,
        name,
        email: o.email || '',
        active: o.active !== false
      });
    }

    after = data?.paging?.next?.after;
    if (!after) break;
  }

  _ownersCache = { fetchedAtMs: now, owners };
  return owners;
}

async function resolveOwnerEmailByName(pmName) {
  const key = normalizeName(pmName);
  if (!key) return '';
  if (!HUBSPOT_API_KEY) return '';

  const owners = await fetchHubspotOwners();
  if (!owners.length) return '';

  // Prefer exact normalized full-name matches
  const exact = owners.find((o) => o.active && normalizeName(o.name) === key && o.email);
  if (exact) return exact.email;

  // Fallback: contains matching (handles "Jeff" vs "Jeff Smith", etc.)
  const contains = owners.find((o) => o.active && o.email && (normalizeName(o.name).includes(key) || key.includes(normalizeName(o.name))));
  return contains?.email || '';
}

// ---- PM meeting link mapping (pmKey -> slug) ----
let _pmSlugMapCache = null;
function getPmSlugMap() {
  if (_pmSlugMapCache) return _pmSlugMapCache;
  try {
    const filePath = path.join(__dirname, '../../config/pmMeetingLinks.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const normalized = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (!k || !v) continue;
      normalized[String(k).trim().toLowerCase()] = String(v).trim();
    }
    _pmSlugMapCache = normalized;
    return _pmSlugMapCache;
  } catch (e) {
    console.error('Failed to load PM mapping file config/pmMeetingLinks.json:', e?.message || e);
    _pmSlugMapCache = {};
    return _pmSlugMapCache;
  }
}

function resolvePmSlug(pmKey) {
  const map = getPmSlugMap();
  const key = String(pmKey || '').trim().toLowerCase();
  return map[key] || null;
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function normalizeToE164US(value) {
  const d = digits(value);
  if (!d) return null;
  if (String(value || '').trim().startsWith('+')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

async function sendTwilioSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_NUMBER; // Main number

  if (!accountSid || !authToken) {
    console.warn('[Existing Project SMS] Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN; skipping SMS');
    return null;
  }

  if (!from) {
    console.warn('[Existing Project SMS] Missing TWILIO_NUMBER; skipping SMS');
    return null;
  }

  const toE164 = normalizeToE164US(to);
  if (!toE164) {
    console.warn('[Existing Project SMS] Invalid "to" phone; skipping SMS', { to });
    return null;
  }

  const client = twilio(accountSid, authToken);
  return client.messages.create({ to: toE164, from, body });
}

// Helper: Convert milliseconds (UTC) to ISO 8601 string in DEFAULT_TIMEZONE
function msToLocalISO(ms) {
  return DateTime.fromMillis(ms, { zone: DEFAULT_TIMEZONE }).toISO({
    includeOffset: true,
    suppressMilliseconds: true
  });
}

async function fetchAvailability(slug, monthOffset) {
  const url = `https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book/availability-page/${encodeURIComponent(slug)}?timezone=${encodeURIComponent(DEFAULT_TIMEZONE)}&monthOffset=${monthOffset}`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data?.linkAvailability?.linkAvailabilityByDuration?.['900000']?.availabilities || [];
}

function toISOWithZone(input) {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input === 'number' || (typeof input === 'string' && /^\d+$/.test(input))) {
    const dt = DateTime.fromMillis(Number(input), { zone: DEFAULT_TIMEZONE });
    return dt.isValid ? dt.toISO({ includeOffset: true, suppressMilliseconds: true }) : undefined;
  }
  const dtParsed = DateTime.fromISO(String(input), { setZone: true });
  if (dtParsed.isValid) {
    const dtWithZone =
      dtParsed.offset === 0 && !/([Zz]|[+\-]\d{2}:?\d{2})$/.test(String(input))
        ? dtParsed.setZone(DEFAULT_TIMEZONE)
        : dtParsed;
    return dtWithZone.toISO({ includeOffset: true, suppressMilliseconds: true });
  }
  const dtLocal = DateTime.fromJSDate(new Date(String(input))).setZone(DEFAULT_TIMEZONE);
  return dtLocal.isValid ? dtLocal.toISO({ includeOffset: true, suppressMilliseconds: true }) : undefined;
}

// -------------------- Endpoints --------------------

// List PM keys configured via config/pmMeetingLinks.json
exports.listPms = async (req, res) => {
  const map = getPmSlugMap();
  return res.json({ pms: Object.keys(map).sort() });
};

/**
 * Fetch PMs (HubSpot owners) from HubSpot API.
 * GET /api/existing/pms/live
 *
 * Note: this returns owners from HubSpot; booking still requires the PM name to exist in pmMeetingLinks.json.
 */
exports.listHubspotPms = async (req, res) => {
  try {
    const headers = {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json'
    };

    const owners = [];
    let after = undefined;
    // cap to prevent accidental huge pulls
    for (let i = 0; i < 20; i++) {
      const { data } = await axios.get('https://api.hubapi.com/crm/v3/owners', {
        headers,
        params: {
          limit: 500,
          ...(after ? { after } : {})
        }
      });

      const results = data?.results || [];
      for (const o of results) {
        const name = `${o.firstName || ''} ${o.lastName || ''}`.trim();
        owners.push({
          id: o.id,
          email: o.email || '',
          name: name || o.email || String(o.id),
          active: o.active !== false
        });
      }

      after = data?.paging?.next?.after;
      if (!after) break;
    }

    // sort: active first, then name
    owners.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return res.json({ pms: owners });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

/**
 * Lookup an existing HubSpot contact by phone (preferred) and email (fallback)
 * Also fetches all associated Projects with their addresses and PM details
 * GET /api/existing/contact/lookup?phone=...&email=...
 * Returns: { found, contactId?, properties?, projects: [{address, pmName, pmId, projectId}] }
 * 
 * Flow:
 * 1. If phone provided → search by phone first
 *    - If found → return contact + projects (no email verification needed)
 *    - If not found → require email → search by email → verify email → return contact + projects
 * 2. If no phone but email provided → search by email → verify email → return contact + projects
 */
exports.lookupContact = async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    const email = String(req.query.email || '').trim();
    const phoneTokens = buildPhoneSearchTokens(phone);

    const headers = {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json'
    };

    let searchResp = null;
    let foundByPhone = false;

    // Phone first (if provided): search by phone
    if (phoneTokens.length) {
      try {
        searchResp = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/contacts/search',
          {
            // OR across all phone tokens (+1 / 1 / 10-digit variations)
            filterGroups: phoneTokens.map((t) => ({
              filters: [
                {
                  propertyName: 'phone',
                  operator: 'CONTAINS_TOKEN',
                  value: t
                }
              ]
            })),
            properties: ['firstname', 'lastname', 'email', 'phone', 'address'],
            limit: 10
          },
          { headers }
        );
        
        if (searchResp?.data?.results?.length > 0) foundByPhone = true;
      } catch (phoneError) {
        console.warn('Phone search failed:', phoneError?.response?.data || phoneError?.message);
      }
    }

    // Email fallback: if no phone match, search by email (email becomes required)
    if (!foundByPhone) {
      if (!email) {
        return res.status(400).json({ 
          found: false,
          error: 'Contact not found by phone. Email is required to search for existing project contact.' 
        });
      }

      try {
        searchResp = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/contacts/search',
          {
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: 'email',
                    operator: 'EQ',
                    value: email
                  }
                ]
              }
            ],
            properties: ['firstname', 'lastname', 'email', 'phone', 'address'],
            limit: 1
          },
          { headers }
        );
      } catch (emailError) {
        console.error('Email search failed:', emailError?.response?.data || emailError?.message);
        return res.status(emailError?.response?.status || 500).json({ 
          found: false,
          error: emailError?.response?.data || emailError?.message 
        });
      }
    }

    // If phone search returned multiple, prefer exact last-10 match
    let contact = null;
    const results = searchResp?.data?.results || [];
    if (results.length) {
      const wantedLast10 = digits(phone).slice(-10);
      contact =
        results.find((r) => digits(r?.properties?.phone).slice(-10) === wantedLast10) || results[0];
    }
    if (!contact) {
      return res.json({ found: false });
    }

    // If found by email (not phone), verify email matches the record
    if (!foundByPhone && email) {
      const recordEmail = String(contact?.properties?.email || '').trim().toLowerCase();
      const providedEmail = String(email).trim().toLowerCase();
      if (!recordEmail || recordEmail !== providedEmail) {
        return res.json({ found: false, verified: false });
      }
    }

    // Fetch associated Projects (custom object type 2-32346192)
    const projects = [];
    try {
      // Get associations: Contact -> Projects (custom object)
      const associationsResp = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}/associations/2-32346192`,
        { headers }
      );

      // Extract project IDs from associations response (handle different response formats)
      const associationResults = associationsResp?.data?.results || [];
      const projectIds = associationResults
        .map(r => r.toObjectId || r.id || r.to?.id)
        .filter(Boolean);

      if (projectIds.length > 0) {
        // Fetch project details in batch
        const projectsResp = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/2-32346192/batch/read',
          {
            inputs: projectIds.map(id => ({ id })),
            properties: ['property_address', 'pm_']
          },
          { headers }
        );

        const projectObjects = projectsResp?.data?.results || [];

        // Fetch PM names for each project (using pm_ owner ID)
        // Batch fetch owners to minimize API calls
        const pmIds = [...new Set(projectObjects.map(p => p.properties?.pm_).filter(Boolean))];
        const ownerMap = new Map();

        // Fetch all unique owners in parallel
        await Promise.all(
          pmIds.map(async (pmId) => {
            try {
              const ownerResp = await axios.get(
                `https://api.hubapi.com/crm/v3/owners/${pmId}`,
                { headers }
              );
              const owner = ownerResp?.data;
              const fullName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim();
              if (fullName) {
                ownerMap.set(pmId, fullName);
              }
            } catch (ownerError) {
              console.warn(`Failed to fetch owner ${pmId}:`, ownerError?.response?.data || ownerError?.message);
            }
          })
        );

        // Build projects array with PM names
        for (const project of projectObjects) {
          const pmId = project.properties?.pm_;
          const pmName = pmId ? ownerMap.get(pmId) || null : null;

          projects.push({
            projectId: project.id,
            address: project.properties?.property_address || '',
            pmName: pmName,
            pmId: pmId || null
          });
        }
      }
    } catch (projectsError) {
      console.error('Error fetching associated projects:', projectsError?.response?.data || projectsError?.message);
      // Continue even if projects fetch fails - return contact info anyway
    }

    return res.json({
      found: true,
      verified: foundByPhone ? true : true, // Phone match doesn't need email verification
      contactId: contact.id,
      properties: contact.properties || {},
      projects: projects,
      projectCount: projects.length
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

/**
 * Get availability for a specific PM key
 * GET /api/existing/availability?pm=<pmKey>
 */
exports.getPmAvailability = async (req, res) => {
  try {
    const pm = req.query.pm;
    const slug = resolvePmSlug(pm);
    if (!pm || !slug) {
      return res.status(400).json({ error: 'Unknown pm. Provide ?pm=<pmName> that exists in config/pmMeetingLinks.json.' });
    }

    const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
    const currentDay = now.day;
    const limitDate = now.plus({ days: 15 }).endOf('day');

    let slots = [];
    const currentMonthSlots = await fetchAvailability(slug, 0);
    slots = slots.concat(currentMonthSlots);
    if (currentDay > 20) {
      const nextMonthSlots = await fetchAvailability(slug, 1);
      slots = slots.concat(nextMonthSlots);
    }

    const filteredSlots = slots
      .map((slot) => ({
        start: msToLocalISO(slot.startMillisUtc),
        end: msToLocalISO(slot.endMillisUtc)
      }))
      .filter((slot) => {
        const slotDate = DateTime.fromISO(slot.start);
        return slotDate >= now && slotDate <= limitDate;
      });

    return res.json({ pm, slug, slots: filteredSlots, timezone: DEFAULT_TIMEZONE });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

/**
 * Book PM meeting WITHOUT formFields.
 * POST /api/existing/book
 * Accepts Retell style `{ args: {...} }` or plain body.
 * Required: pm, startTime, endTime
 *
 * Required fields (Retell must pass): firstName, lastName, email, phone
 * Allowed fields: address, description, contactId
 */
exports.bookPmMeeting = async (req, res) => {
  try {
    const args = req.body?.args || req.body || {};
    const {
      pm,
      startTime,
      endTime,
      firstName,
      lastName,
      email,
      phone,
      address,
      description,
      contactId, // optional if you want to pass the looked-up contactId through
    } = args;

    const slug = resolvePmSlug(pm);
    if (!pm || !slug) {
      return res.status(400).json({ error: 'Unknown pm. Provide pmName that exists in config/pmMeetingLinks.json.' });
    }

    // Require identity fields from Retell
    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['firstName', 'lastName', 'email'],
      });
    }

    const formattedStartTime = toISOWithZone(startTime);
    const formattedEndTime = toISOWithZone(endTime);
    if (!formattedStartTime || !formattedEndTime) {
      return res.status(400).json({ error: 'Invalid time format', details: { startTime, endTime } });
    }

    // IMPORTANT: no formFields (per your requirement)
    const payload = {
      slug,
      startTime: formattedStartTime,
      endTime: formattedEndTime,
      duration: 900000,
      firstName: firstName || ' ',
      lastName: lastName || ' ',
      email: email || '',
      phone: phone || '',
      address: address || '',
      timezone: DEFAULT_TIMEZONE,
    };

    const url = 'https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book';
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return res.json({ data: response.data });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

/**
 * Webhook handler for Retell existing project calls
 * POST /api/existing/webhook-retell
 * Handles call_analyzed events and sends Slack notification if meeting was NOT booked
 */
exports.webhookRetellExisting = async (req, res) => {
  try {
    console.log("Existing project webhook - req.body.event:", req.body.event);

    // Only process call_analyzed events as they contain the complete call data
    if (!req.body.event || req.body.event !== 'call_analyzed') {
      return res.json({ message: `Event ${req.body.event || 'unknown'} received but not processed` });
    }

    const callData = req.body.call;
    if (!callData) {
      return res.json({ message: 'No call data found' });
    }

    console.log("Existing project callData:", callData);

    // collected_dynamic_variables may be missing if the user hangs up early
    const dynamicVars = callData.collected_dynamic_variables || {};

    // Check if meeting was booked
    const meetingBooked = dynamicVars.meetingBooked;
    const isBooked = (meetingBooked || meetingBooked === true || meetingBooked === "true");

    // Extract data with fallbacks
    const firstName = dynamicVars.firstName || '';
    const lastName = dynamicVars.lastName || '';
    const email = dynamicVars.email || '';
    const phone = callData.from_number || '';
    const address = dynamicVars.address || dynamicVars.projectAddress || '';
    // PM name can be missing even when a meeting is booked; support fallbacks.
    const pmName =
    dynamicVars.pm ||
      dynamicVars.pmName ||
      dynamicVars.pmBooked ||
      '';
    const pmEmail =
      dynamicVars.pmEmail ||
      dynamicVars.pm_email ||
      dynamicVars.csmEmail ||
      dynamicVars.csm_email ||
      '';
    const description = dynamicVars.description || 'N/A';

    const clientName = `${firstName} ${lastName}`.trim() || (phone ? phone : 'Unknown');

    // Get call summary and recording
    const summary = callData.call_analysis?.call_summary || callData.transcript || '';
    const recordingUrl = callData.recording_url || '';

    let pmMention = '';
    try {
      const resolvedEmail = pmEmail || (pmName ? await resolveOwnerEmailByName(pmName) : '');
      if (resolvedEmail) pmMention = await mentionByEmail(resolvedEmail);
    } catch (e) {
      console.warn('[Existing Project] PM mention lookup failed:', e?.message || e);
    }

    // Try to find HubSpot contact by caller phone first (then email if provided)
    let contactInfo = null;
    try {
      contactInfo = await lookupContactByPhone(phone);
      if (!contactInfo?.id && email) {
        contactInfo = await lookupContactByEmail(email);
      }
    } catch (e) {
      console.warn('[Existing Project] contact lookup failed:', e?.response?.data || e?.message || e);
    }

    const contactLinkLine = contactInfo?.id ? `*HubSpot Contact:* <${hsContactUrl(contactInfo.id)}|View Contact>\n` : '';
    const notFoundPrefix = !contactInfo?.id
      ? `${(await csaMentions()) || '<!channel>'}\n⚠️ *Contact not found by phone/email* — it might be a new contact.\n\n`
      : '';

    // Base Slack message
    const baseSlackMsg =
      `📞 *Existing Project Call — AI Voice Agent*${pmMention ? ` ${pmMention}` : ''}\n` +
      `*Call Summary:* ${summary || "n/a"}\n` +
      `*Meeting Booked:* ${meetingBooked}\n\n` +
      `*Caller:* ${phone || 'N/A'}${clientName && clientName !== phone ? ` (${clientName})` : ''}\n` +
      (contactLinkLine ? contactLinkLine : '') +
      `*Email:* ${email || 'N/A'}\n` +
      `*Project Address:* ${address || 'N/A'}\n` +
      `*PM:* ${pmName || 'N/A'}\n` +
      `*Description:* ${description || 'N/A'}`;

    if (isBooked) {
      // Meeting was booked - send notification (booking endpoint already sends one, but this confirms)
      const msgBooked = `${notFoundPrefix}${baseSlackMsg}\n\n✅ *Meeting was successfully booked during the call.*`;
      try {
        const pmChannel = process.env.PM_SLACK_CHANNEL;
        if (pmChannel) {
          await sendSlackMessageToChannel(msgBooked, pmChannel);
        } else {
          await sendCallSlackMessage(msgBooked);
        }
      } catch (e) {
        console.error("Existing project: Slack booked notify failed:", e?.response?.data || e?.message || e);
      }
      console.log("Existing project: Meeting was booked, notification sent");
      return res.json({ message: 'Meeting was booked successfully, notification sent' });
    }

    // Meeting was NOT booked - send follow-up notification
    console.log("Existing project: Meeting was not booked, sending follow-up notification");

    const callerLine = `*Caller:* ${phone || 'N/A'}${clientName && clientName !== phone ? ` (${clientName})` : ''}`;
    const nextStepsText =
      `*Next Steps:* Contact the client to schedule a meeting with ${pmName || 'their PM'} for their project at ${address || 'the listed address'}.`;

    const followUpMsg =
      `⚠️ Existing Project Call — Meeting NOT Booked\n` +
      `Caller: ${phone || 'N/A'}\n` +
      `Please follow up with this existing client`;

    const headerParts = [
      notFoundPrefix.trim(),
      '<!channel>',
      '⚠️ *Existing Project Call — Meeting NOT Booked*',
      '*Please follow up with this existing client*',
      `_Whoever takes this, reply/react so others know it's handled._`
    ].filter(Boolean);

    const detailsText = [
      `📞 *Existing Project Call — AI Voice Agent*${pmMention ? ` ${pmMention}` : ''}`,
      `*Call Summary:* ${summary || 'n/a'}`,
      `*Meeting Booked:* ${meetingBooked}`,
      callerLine,
      contactLinkLine ? contactLinkLine.trim() : '',
      `*Email:* ${email || 'N/A'}`,
      `*Project Address:* ${address || 'N/A'}`,
      `*PM:* ${pmName || 'N/A'}`,
      `*Description:* ${description || 'N/A'}`
    ].filter(Boolean).join('\n');

    const followUpBlocks = [
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerParts.join('\n') }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: detailsText }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: nextStepsText }
      },
      { type: 'divider' }
    ];

    const pmChannel = process.env.PM_SLACK_CHANNEL;
    if (pmChannel) {
      await sendSlackMessageToChannel(followUpMsg, pmChannel, followUpBlocks);
    } else {
      await sendSlackMessageToChannel(followUpMsg, process.env.CALL_SLACK_CHANNEL_ID, followUpBlocks);
    }
    console.log("Existing project: Follow-up notification sent to Slack");

    // Client SMS fallback: tell them booking didn't complete
    try {
      if (phone) {
        const smsBody =
          `Hi${clientName && clientName !== phone ? ` ${clientName}` : ''}, ` +
          `it looks like we couldn't complete your booking during the call. ` +
          `Someone from our team will get back to you as soon as possible. ` ;

        const msg = await sendTwilioSMS(phone, smsBody);
        console.log('[Existing Project SMS] sent', { to: phone, sid: msg?.sid });
      } else {
        console.log('[Existing Project SMS] No caller number available; skipping SMS');
      }
    } catch (smsError) {
      console.error('[Existing Project SMS] send error', smsError?.message || smsError);
      // Continue even if SMS fails
    }

    return res.json({ message: 'Call processed, follow-up notification sent' });
  } catch (error) {
    console.error('Existing project webhook error:', error.response?.data || error.message || error);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data || error.message || 'Internal server error' 
    });
  }
};

