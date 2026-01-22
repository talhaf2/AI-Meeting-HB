const axios = require('axios');
const { DateTime } = require('luxon');
const { sendCallSlackMessage } = require('../services/slackService');
const fs = require('fs');
const path = require('path');

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles';

// HubSpot portal id only used for hyperlinking in Slack (optional)
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '45924609';
function hsContactUrl(contactId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`;
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
 * Returns: { found, contactId?, properties?, projects: [{address, pmName, pmId}] }
 */
exports.lookupContact = async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    const email = String(req.query.email || '').trim();
    const phoneDigits = digits(phone);

    // Privacy requirement: do NOT reveal contact details unless caller provides an email to verify.
    if (!email) {
      return res.status(400).json({ error: 'Email is required to verify the existing project contact.' });
    }

    const headers = {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json'
    };

    let searchResp = null;

    // Phone first (if provided): find the contact, then verify email matches exactly (case-insensitive)
    // if (phoneDigits) {
    //   searchResp = await axios.post(
    //     'https://api.hubapi.com/crm/v3/objects/contacts/search',
    //     {
    //       filterGroups: [
    //         {
    //           filters: [
    //             {
    //               propertyName: 'phone',
    //               operator: 'CONTAINS_TOKEN',
    //               value: phoneDigits
    //             }
    //           ]
    //         }
    //       ],
    //       properties: ['firstname', 'lastname', 'email', 'phone', 'address'],
    //       limit: 1
    //     },
    //     { headers }
    //   );
    // }

    // Email fallback: if no phone match, search by email directly
    if ((!searchResp || (searchResp.data?.results || []).length === 0)) {
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
    }

    const contact = searchResp?.data?.results?.[0];
    if (!contact) {
      return res.json({ found: false });
    }

    // Verify email matches the record before returning any PII
    const recordEmail = String(contact?.properties?.email || '').trim().toLowerCase();
    const providedEmail = String(email).trim().toLowerCase();
    if (!recordEmail || recordEmail !== providedEmail) {
      return res.json({ found: false, verified: false });
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
      verified: true,
      properties: contact.properties || {},
      projects: projects
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
    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['firstName', 'lastName', 'email', 'phone'],
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
      timezone: DEFAULT_TIMEZONE,
    };

    const url = 'https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book';
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    // Slack notify (no CRM creation here)
    try {
      const when = DateTime.fromISO(formattedStartTime)
        .setZone(DEFAULT_TIMEZONE)
        .toLocaleString(DateTime.DATETIME_FULL);

      const contactLink = contactId ? `<${hsContactUrl(contactId)}|Contact>` : 'n/a';
      const msg =
        `📅 *Existing Project — PM meeting booked*\n` +
        `*PM:* ${pm}\n` +
        `*When:* ${when}\n` +
        `*Client:* ${((firstName || '') + ' ' + (lastName || '')).trim() || 'n/a'}\n` +
        `*Phone:* ${phone || 'n/a'}\n` +
        `*Email:* ${email || 'n/a'}\n` +
        `*Address:* ${address || 'n/a'}\n` +
        `*Description:* ${description || 'n/a'}\n` +
        `*HubSpot Contact:* ${contactLink}`;

      await sendCallSlackMessage(msg);
    } catch (e) {
      console.error('Slack PM booking notify failed:', e?.response?.data || e?.message || e);
    }

    return res.json({ data: response.data });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

