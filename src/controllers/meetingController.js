const axios = require('axios');
const { DateTime } = require('luxon');
const { sendEmail } = require('../utils/email');
const twilio = require('twilio');
const { json } = require('express');
const { sendCallSlackMessage, sendSlackMessageToChannel, mentionsFromEmails } = require('../services/slackService');

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles'; // Pacific Time
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '45924609';

function hsContactUrl(contactId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`;
}

function hsDealUrl(dealId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;
}

// Helper: Convert milliseconds (UTC) to ISO 8601 string in Pacific Time
function msToPacificISO(ms) {
  return DateTime.fromMillis(ms, { zone: DEFAULT_TIMEZONE }).toISO({ includeOffset: true, suppressMilliseconds: true });
}

// Helper function to get meeting link slug based on role and intent
const getSlugFromSelection = (role, intent) => {
  // Default intent to 2 if null, undefined, or empty string
  const safeIntent = intent == null || intent === '' ? 2 : intent;

  const parsedRole = Number(String(role).trim());
  const parsedIntent = Number(String(safeIntent).trim());

  console.log({ parsedRole, parsedIntent });
  

  // Role // 0 Homeowner, 1 AEC, 2 Realtor/Property Manager
  // Intent // 0 Structural inspection, 1 Need Qoute, 2 don't have plans (Others queries)

  if (parsedRole === 1) {
    return 'tfarooq/aec-professional';
  }
  if (parsedRole === 0 && parsedIntent === 0) {
    return 'tfarooq/homeowner';
  }
  if (parsedRole === 0 && parsedIntent === 1) {
    return 'tfarooq/homeowner-qoute';
  }
  if (parsedRole === 0 && parsedIntent === 2) {
    return 'tfarooq/homeowner-other';
  }
  if (parsedRole === 2 && parsedIntent === 0) {
    return 'tfarooq/homeowner';
  }
  if (parsedRole === 2) {
    return 'tfarooq/aec-professional';
  }

  // Fallback to a safe default slug to ensure meeting can still be booked
  return 'tfarooq/homeowner-other';
};

// POST /api/slug
// Body: { role: 0|1|2, intent: 0|1|2 }  (intent defaults to 2)
exports.getSlug = (req, res) => {
  try {
    const role = req?.body?.role;
    const intent = req?.body?.intent;

    const slug = getSlugFromSelection(role, intent);
    return res.json({ slug });
  } catch (e) {
    console.error('getSlug error:', e);
    return res.status(500).json({ error: 'Failed to compute slug' });
  }
};

const hasMinusSevenOffset = (timeStr) => {
  return timeStr.endsWith('-07:00');
};

async function sendTwilioSMS(to, body, from, accountSid, authToken) {
  // Import the twilio module inside the function

  // Create a client with the provided credentials
  const client = twilio(accountSid, authToken);

  console.log(`Message sent successfully!`);

  // Return the promise directly
  return client.messages
    .create({
      body: body,
      to: to,
      from: from,
    })
    .then((message) => {
      console.log(`Message sent successfully! SID: ${message.sid}`);
      return message;
    })
    .catch((error) => {
      console.error("Error sending message:", error);
      throw error;
    });
}

// Helper: Fetch availability for a given month offset
async function fetchAvailability(slug, monthoffset) {
  const url = `https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book/availability-page/${encodeURIComponent(slug)}?timezone=${encodeURIComponent(DEFAULT_TIMEZONE)}&monthOffset=${monthoffset}`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data?.linkAvailability?.linkAvailabilityByDuration?.['900000']?.availabilities || [];
}


exports.getAvailability = async (req, res) => {
  try {
    console.log('req.body', req.body);
    const userRole  = req.body.args.userRole;
    const userNeed  = req.body.args.userNeed;

    console.log("userRole: ", userRole);
    console.log("userNeed: ", userNeed);

    if (userRole === undefined || userRole === null || userNeed === undefined || userNeed === null) {
      return res.status(400).json({ error: 'userRole and userNeed are required' });
    }

    const slug = getSlugFromSelection(userRole, userNeed);
    console.log("slug: ", slug);

    const now = DateTime.now().setZone(DEFAULT_TIMEZONE);
    const currentDay = now.day;
    const limitDate = now.plus({ days: 15 }).endOf('day');

    let slots = [];

    // Always fetch current month
    const currentMonthSlots = await fetchAvailability(slug, 0);
    slots = slots.concat(currentMonthSlots);

    // If today is after the 20th, also fetch next month
    if (currentDay > 20) {
      const nextMonthSlots = await fetchAvailability(slug, 1);
      slots = slots.concat(nextMonthSlots);
    }

    if (!slots.length) {
      return res.json({ message: 'No available slots found.' });
    }

    // Filter and map slots to desired format
    const filteredSlots = slots
      .map(slot => ({
        start: msToPacificISO(slot.startMillisUtc),
        end: msToPacificISO(slot.endMillisUtc)
      }))
      .filter(slot => {
        const slotDate = DateTime.fromISO(slot.start);
        return slotDate >= now && slotDate <= limitDate;
      });

    if (!filteredSlots.length) {
      return res.json({ message: 'No available slots found in the next 15 days.' });
    }

    res.json({
      slots: filteredSlots,
      timezone: DEFAULT_TIMEZONE
    });

  } catch (error) {
    console.error(error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message
    });
  }
};

exports.bookMeeting = async (req, res) => {
  try {
    const {
      userRole,
      userNeed,
      project_type,
      userRoleValue,
      startTime,
      endTime,
      firstName,
      lastName,
      email,
      description,
      Location,
      phone,
      call_type
    } = req.body.args;

    console.log(req.body);
    

    let phone_fallback = req.body.call.from_number || phone // Fallback phone number if not provided
    if (call_type === "web_call" || phone_fallback === "" || phone_fallback === undefined || phone_fallback === null) {
      phone_fallback = "+16666666666"
    }

    let slug = getSlugFromSelection(userRole, userNeed)

    // Normalize provided times to ISO8601 with timezone offset
    const toISOWithZone = (input) => {
      if (input === undefined || input === null || input === '') return undefined;
      // If numeric-like (epoch ms)
      if (typeof input === 'number' || (typeof input === 'string' && /^\d+$/.test(input))) {
        const dt = DateTime.fromMillis(Number(input), { zone: DEFAULT_TIMEZONE });
        return dt.isValid ? dt.toISO({ includeOffset: true, suppressMilliseconds: true }) : undefined;
      }
      // If ISO-like string, parse and ensure zone
      const dtParsed = DateTime.fromISO(String(input), { setZone: true });
      if (dtParsed.isValid) {
        // If no offset in the string, apply DEFAULT_TIMEZONE
        const dtWithZone = dtParsed.offset === 0 && !/([Zz]|[+\-]\d{2}:?\d{2})$/.test(String(input))
          ? dtParsed.setZone(DEFAULT_TIMEZONE)
          : dtParsed;
        return dtWithZone.toISO({ includeOffset: true, suppressMilliseconds: true });
      }
      // Fallback: try parsing as local and set zone
      const dtLocal = DateTime.fromJSDate(new Date(String(input))).setZone(DEFAULT_TIMEZONE);
      return dtLocal.isValid ? dtLocal.toISO({ includeOffset: true, suppressMilliseconds: true }) : undefined;
    };

    const formattedStartTime = toISOWithZone(startTime);
    const formattedEndTime = toISOWithZone(endTime);

    // Normalize free-text fields to allowed lists, fall back to empty if not matched
    const cleanProjectType = normalizeInput(project_type || '', ALLOWED_PROJECT_TYPES);
    const cleanUserRole = normalizeInput(userRoleValue || '', ALLOWED_USER_ROLES);

    const payload = {
      slug,
      startTime: formattedStartTime,
      endTime: formattedEndTime,
      duration: 900000,
      firstName,
      lastName: lastName || " ",
      email,
      timezone: DEFAULT_TIMEZONE,
      formFields: [
        {
          name: "your_phone_number",
          value: phone_fallback
        },
        {
          name: "full_project_address_webpage_meeting",
          value: Location || " "
        },
        {
          name: "type_of_project",
          value: cleanProjectType || "Other"
        },
        { name: "project_role__sales_rep", value: cleanUserRole || "Unknown" },
        { name: "retell_appointment_source", value: "true" },
        { name: "project_description_webpage_meeting", value: description || "N/A" }

      ]
    };

    const url = 'https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book';
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    try {
      const resMessage = await sendTwilioSMS(phone_fallback, `Your meeting is booked for ${DateTime.fromISO(formattedStartTime).setZone(DEFAULT_TIMEZONE).toLocaleString(DateTime.DATETIME_FULL)}. A project manager will reach out to you to discuss your project.`, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      console.log("Twilio response: ", resMessage);
    } catch (twilioError) {
      console.error("Twilio SMS error: ", twilioError);
    }


    res.json({ data: response.data, message: 1 });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

///WEBHOOK POST CALL FOR LOGGING CONTACT AND DEAL INTO HUBSPOT...
// Create new contact and deal
async function createOrUpdateContactAndDeal(variables, from, preferred_appointment_start_time, project_type, Issue, extraDealProps = {}) {
  // 1. Search for contact by email
  let contactId = null;
  let contactResp = null;

  console.log("in");


  try {
    let searchResp;
    const email = (variables.Email || '').trim();
    const phoneDigits = String(from || '').replace(/\D/g, '');

    // A) Try phone first (if present)
    if (phoneDigits) {
      searchResp = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts/search',
        {
          filterGroups: [{
            filters: [{
              propertyName: 'phone',
              operator: 'CONTAINS_TOKEN',
              value: phoneDigits
            }]
          }],
          properties: ['firstname', 'email', 'phone', 'address', 'project_role__sales_rep']
        },
        {
          headers: {
            Authorization: `Bearer ${HUBSPOT_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    // B) If no phone match (or no phone provided), fallback to email search
    if ((!searchResp || !searchResp.data?.results || searchResp.data.results.length === 0) && email !== '') {
      searchResp = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts/search',
        {
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: email
            }]
          }],
          properties: ['firstname', 'email', 'phone', 'address', 'project_role__sales_rep']
        },
        {
          headers: {
            Authorization: `Bearer ${HUBSPOT_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
    }
    console.log(variables.cleanUserRole);
    if (searchResp.data.results && searchResp.data.results.length > 0) {
      // Contact exists — DO NOT update it. Just use it for deal association.
      contactId = searchResp.data.results[0].id;
      contactResp = { data: { id: contactId } };
    }
  } catch (err) {
    // If error is not "not found", throw
    if (err.response && err.response.status !== 404) {
      throw err;
    }
  }

  // If contact does not exist, create it
  if (!contactId) {
    contactResp = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        properties: {
          firstname: variables.Name || from,
          ...(variables.Email ? { email: variables.Email } : {}),
          ...(from ? { phone: from } : {}),
          address: variables.Location,
          project_role__sales_rep: variables.cleanUserRole,
        }
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    contactId = contactResp.data.id;
  }

  console.log("issue in deal: ", Issue);

  // 2. Create deal associated with the contact
  const dealPayload = {
    properties: {
      dealname: "AI Voice Agent - " + from,
      pipeline: "default",
      dealstage: "appointmentscheduled", //Raw Lead
      appointment_set_: "",
      customer_success_manager: "", // meeting not scheduled
      project_type: project_type,
      deal_address__if_different_from_contact_address_: variables.Location,
      project_description: Issue,
      ...extraDealProps
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 3 // Contact-to-deal association
          }
        ]
      }
    ]
  };

  const dealCreateResp = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/deals',
    dealPayload,
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return { contact: contactResp.data, deal: dealCreateResp.data };
}

//Get Meeting Host
async function getMeetingHostId(contactId) {
  try {
    const response = await axios.get(
      `https://api.hubapi.com/engagements/v1/engagements/associated/contact/${contactId}/paged?limit=100`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const meetings = response.data.results
      .filter(e => e.engagement?.type === 'MEETING')
      .sort((a, b) => b.engagement.timestamp - a.engagement.timestamp);

    const latest = meetings[0];

    if (!latest) {
      console.log('No meeting engagement found');
      return null;
    }

    const { engagement } = latest;

    console.log('Found Meeting:', { ownerId: engagement.ownerId });

    return engagement.ownerId;
  } catch (error) {
    console.error('Error getting meeting host ID:', error.response?.data || error.message);
    return null;
  }
}

async function fetchCSMName(userId) {
  if (!userId) return "Unknown PM";

  try {
    const { data } = await axios.get(
      `https://api.hubapi.com/crm/v3/owners/${userId}`,
      {
        headers
      }
    );

    logger.info("data", data);


    const fullName = `${data.firstName || ''} ${data.lastName || ''}`.trim();
    logger.info(`Resolved CSM name for user ${userId}: ${fullName}`);
    return fullName || "Unknown PM";
  } catch (error) {
    logger.error(`Failed to fetch CSM for user ${userId}`, error.response?.data || error.message);
    return "Unknown PM";
  }
}


// Update existing contact and create deal
async function updateContactAndCreateDeal(contactId, variables, from, preferred_appointment_start_time, project_type, Issue) {

  // 1. Update contact
  const contactUpdateResp = await axios.patch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    {
      properties: {
        project_role__sales_rep: variables.cleanUserRole,
        phone: from,
        address: variables.Location
      }
    },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  // 2. Get ownerId for deal assignment (your existing logic)
  const OwnerId = await getMeetingHostId(contactId);
  console.log("OwnerId", OwnerId);

  console.log("issue in deal, meeting was scheduled: ", Issue);


  // 3. Create deal associated with existing contact
  const dealPayload = {
    properties: {
      dealname: "AI Voice Agent - " + from,
      pipeline: "default",
      dealstage: "contractsent",
      appointment_set_: preferred_appointment_start_time,
      customer_success_manager: OwnerId,
      project_type: project_type,
      deal_address__if_different_from_contact_address_: variables.Location,
      project_description: Issue
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 3
          }
        ]
      }
    ]
  };

  const dealCreateResp = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/deals',
    dealPayload,
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return { contact: contactUpdateResp.data, deal: dealCreateResp.data };
}

async function createNoteForContact(contactId, dealId, noteContent, recording_url) {
  const notePayload = {
    engagement: {
      active: true,
      type: "NOTE"
    },
    associations: {
      contactIds: [contactId],
      companyIds: [],
      dealIds: [dealId],
      ownerIds: []
    },
    metadata: {
      body: noteContent + " \n\n You can also view the recording at: " + recording_url
    }
  };

  try {
    const response = await axios.post(
      'https://api.hubapi.com/engagements/v1/engagements',
      notePayload,
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error creating note:', error.response?.data || error.message);
    throw error;
  }
}



// canonical list (exact spellings)
// const ALLOWED_PROJECT_TYPES = [
//   'Load Bearing Wall',
//   'Addition',
//   'Remodel',
//   'Foundation',
//   'OSE (Structural)',
//   'ADU',
//   'New Home',
//   'Retaining Wall',
//   'Outdoor Living Space (Decks/Patio)',
//   'T24',
//   'Civil Engineering',
//   'Deck/Patio/Patch',
//   'LBW/R',
//   'Legalization',
//   'New Custom Home',
//   'Retrofit',
//   'Roof',
//   'Special Inspection',
//   'Anchorage',
//   'As-Builts',
//   'Redline and Calcs',
//   '[Upsell] On-Site Construction Admin.',
//   '[CO] Other Construction Admin.',
//   'PM As a Service',
//   'Pool',
//   'Ground Up Construction',
// ];

const ALLOWED_PROJECT_TYPES = [
  'OSE (Structural)',
  'New Custom Home',
  'New Home',
  'ADU',
  'Addition/Remodel',
  'Addition',
  'Remodel',
  'Load Bearing Wall',
  'Foundation',
  'Retaining Wall',
  'Outdoor Living Space (Decks/Patios/Pergolas etc.)',
  'T24',
  'Civil Engineering',
  'Deck/Patio/Patch',
  'LBWR',
  'Legalization',
  'Retrofit',
  'Roof',
  'Special Inspection',
  'Anchorage',
  'As-Builts',
  'Redline and Calcs',
  '[Upsell] On-Site Construction Admin.',
  '[CO] Other Construction Admin.',
  'PM As a Service',
  'Pool',
  'Ground Up Construction',
  'Commercial',
  'Other',
];

const ALLOWED_USER_ROLES = [
  'Homeowner',
  'Architect',
  'Designer',
  'Contractor',
  'Developer',
  'Realtor/Property Manager',
  'Unknown'
];

/**
 * Normalizes a string input to a canonical value if it exists in the list.
 * Returns "" if no match.
 *
 * @param {string} input
 * @param {string[]} allowedList
 * @returns {string}
 */
function normalizeInput(input = '', allowedList) {
  const text = input.trim().toLowerCase();
  for (const canonical of allowedList) {
    if (text === canonical.toLowerCase()) {
      return canonical; // return exact casing from allowed list
    }
  }
  return ''; // no match
}

// Main webhook handler for Retell AI
exports.webhookRetell = async (req, res) => {
  try {

    console.log("req.body: ", req.body.event);

    if (!req.body.event || req.body.event === 'call_analyzed') {
      console.log("req.body: ", req.body);
    }

    // Only process call_analyzed events as they contain the complete call data
    if (!req.body.event || req.body.event !== 'call_analyzed') {
      return res.json({ message: `Event ${req.body.event || 'unknown'} received but not processed` });
    }

    const callData = req.body.call;
    if (!callData) {
      return res.json({ message: 'No call data found' });
    }

    console.log("callData: ", callData);
    

    // collected_dynamic_variables may be missing if the user hangs up early
    const dynamicVars = callData.collected_dynamic_variables || {};

    // Check if meeting was booked
    const meetingBooked = dynamicVars.meetingBooked;

    const isBooked = (meetingBooked || meetingBooked === true || meetingBooked === "true");

    // Extract data with fallbacks for missing values (used for Slack + deal creation)
    const name = dynamicVars.name || '';
    const email = dynamicVars.email || '';
    const location = dynamicVars.Location || '';
    const userRoleValue = dynamicVars.userRoleValue;
    const projectType = dynamicVars.project_type;
    const description = dynamicVars.description || 'N/A';

    // Phone number may be missing for web_call; do not use a constant fallback for CRM identity
    const phone = callData.from_number || "";

    // Slack base message (same fields as before)
    const baseSlackMsg =
    `🤖 *Inbound call forwarded to AI*\n` +
      `*Recording URL:* ${callData.recording_url || "n/a"}` +
      `\n*Call Summary:* ${callData?.call_analysis?.call_summary || callData.transcript || "n/a"}` +
      `\n*Meeting Booked:* ${meetingBooked}` +
      `\n\n*From:* ${callData.from_number || 'N/A'}` +
      `\n*Name:* ${name || 'N/A'}` +
      `\n*Email:* ${email || 'N/A'}` +
      `\n*Location:* ${location || 'N/A'}` +
      `\n*User Role:* ${userRoleValue || 'N/A'}` +
      `\n*Project Type:* ${projectType || 'N/A'}` +
      `\n*Description:* ${description || 'N/A'}` +
      `\n\n*Call ID:* ${callData.call_id || "n/a"}`;

    const parseEmailList = (value) =>
      String(value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const cssFollowUpTagEmails = parseEmailList(process.env.CSS_FOLLOW_UP_TAG_EMAILS);
    const cssMentions = cssFollowUpTagEmails.length ? await mentionsFromEmails(cssFollowUpTagEmails) : "";

    if (isBooked) {
      // Keep original behavior: send Slack with base details, but do NOT create CRM records
      const msgBooked =
        `${baseSlackMsg}\n`;
      await sendCallSlackMessage(msgBooked);

      console.log("Meeting was booked, no action needed");
      return res.json({ message: 'Meeting was booked successfully, no action taken' });
    }

    // Meeting was not booked, proceed with SMS and contact/deal creation
    console.log("Meeting was not booked, proceeding with follow-up actions");

    // Use phone number as name if name is not available
    const contactName = name || (phone ? phone : `Web Call ${callData.call_id || ""}`.trim());

    // Get call summary and recording
    const summary = callData.call_analysis?.call_summary || callData.transcript || '';
    const recordingUrl = callData.recording_url || '';

    console.log("Extracted data:", {
      contactName,
      email,
      location,
      userRoleValue,
      projectType,
      description,
      phone,
      meetingBooked
    });

    // Normalize project type and user role
    const cleanProjectType = normalizeInput(projectType, ALLOWED_PROJECT_TYPES);
    const cleanUserRole = normalizeInput(userRoleValue, ALLOWED_USER_ROLES);

    // Create contact and deal
    let result;
    try {
      result = await createOrUpdateContactAndDeal(
        {
          Name: contactName,
          Email: email,
          Location: location,
          cleanUserRole
        },
        phone,
        null, // preferred_appointment_start_time (not available since meeting wasn't booked)
        cleanProjectType,
        description,
        {
          call_status: "Ai",
          call_sid: callData.call_id || "",
          call_picked_by: "AI"
        }
      );

      console.log("Contact and deal created successfully:", {
        contactId: result.contact.id,
        dealId: result.deal.id
      });

    } catch (contactError) {
      console.error("Error creating contact/deal:", contactError);
      return res.status(500).json({
        error: 'Failed to create contact/deal',
        details: contactError.message
      });
    }

    // Send Twilio SMS (include contact/deal ids so booking updates the same records)
    const bookingUrl = `https://prostructengineering.com/schedule-consultation1?c=${result?.contact?.id || ""}&d=${result?.deal?.id || ""}`;
    const smsBody = `Hi, it looks like your call got disconnected before we could schedule your free consultation with one of our top project managers. You can use the link below to book a time that works for you:\n${bookingUrl}`;

    try {
      if (phone) {
        await sendTwilioSMS(phone, smsBody, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        console.log("SMS sent successfully to:", phone);
      } else {
        console.log("No phone number on call; skipping SMS");
      }
    } catch (smsError) {
      console.error("Error sending SMS:", smsError);
      // Continue even if SMS fails
    }

    // Create note for the contact using summary
    if (summary && result.contact?.id) {
      try {
        await createNoteForContact(result.contact.id, result.deal.id, summary, recordingUrl);
        console.log("Note created successfully for contact:", result.contact.id);
      } catch (noteError) {
        console.error("Error creating note:", noteError);
        // Don't fail the entire request if note creation fails
      }
    }

    // Slack: same full details as before + add HubSpot created record links and booking link
    try {
      const bookingUrl = `https://prostructengineering.com/schedule-consultation1?c=${result?.contact?.id || ""}&d=${result?.deal?.id || ""}`;
      const bookingLinkHyper = bookingUrl ? `<${bookingUrl}|Book appointment>` : "n/a";
      const hsLinks =
        result?.contact?.id && result?.deal?.id
          ? `*HubSpot Created Records:* <${hsContactUrl(result.contact.id)}|Contact> | <${hsDealUrl(result.deal.id)}|Deal>`
          : `*HubSpot Created Records:* n/a`;

      // CALL_SLACK_CHANNEL_ID: keep the original "old" message as-is (base details + created record links)
      const fullMsg =
      `${baseSlackMsg}\n` +
      `🤖 *AI created Records in HubSpot*\n` +
        `${hsLinks}\n`;

      await sendCallSlackMessage(fullMsg);

      // CSS_channelid: new required wording + mentions (AI path is only booked vs not booked)
      const cssFollowUpMsg =
        `${cssMentions ? `${cssMentions}\n` : ""}` +
        `*AI voice agent could not schedule appointment*\n` +
        `*Please reach out ASAP to schedule*\n` +
        `_Whoever takes this, reply/react so others know it's handled._\n\n` +
        `\n*Captured details*\n` +
        `*Name:* ${name || contactName || "N/A"}\n` +
        `*Phone:* ${phone || "N/A"}\n` +
        `*Email:* ${email || "N/A"}\n` +
        `*Location:* ${location || "N/A"}\n` +
        `*User Role:* ${userRoleValue || "N/A"}\n` +
        `*Project Type:* ${projectType || "N/A"}\n` +
        `*Notes/Description:* ${description || "N/A"}\n` +

        `\n${hsLinks}\n` +
        `⚠️ *Note:* Use this Booking link: (if appointment is still not booked by client) ${bookingLinkHyper}\n\n` +
        `\n*Call ID:* ${callData.call_id || "n/a"}`;

      // For "not booked" (and missed) we post:
      // - CALL_SLACK_CHANNEL_ID: keep your existing call channel posting
      // - CSS_channelid: new dedicated css follow-up channel with required wording/tags
      const cssChannelId = process.env.CSS_CHANNEL_ID;
      if (cssChannelId) {
        await sendSlackMessageToChannel(cssFollowUpMsg, cssChannelId);
      } else {
        console.warn("CSS_channelid env var not set; skipping CSS follow-up channel post");
      }
    } catch (e) {
      console.error("Slack post failed:", e?.response?.data || e?.message || e);
    }

    res.json({
      contact: result.contact,
      deal: result.deal,
      message: 'Contact and deal processed successfully. SMS sent to user.'
    });

  } catch (error) {
    console.error("Error in webhookRetell:", error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message
    });
  }
};



async function notifyPMbyEmail(subject, Name, Email, from, Location) {
  try {

    if (Email) subject += ` - ${Email}`;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Determine if we have any user info
    const hasDetails = Name || Email || Location || from;

    let html = `<p><b>Details we fetched from the call: </b></p><p>${time}</p>`;
    let textParts = [`NEW`, `Time: ${time}`];

    if (hasDetails) {
      if (Name) {
        html += `<p><b>Name:</b> ${Name}</p>`;
        textParts.push(`Name: ${Name}`);
      }
      if (Location) {
        html += `<p><b>Location:</b> ${Location}</p>`;
        textParts.push(`Location: ${Location}`);
      }
      if (from) {
        html += `<p><b>From:</b> ${from}</p>`;
        textParts.push(`From: ${from}`);
      }
      if (Email) {
        html += `<p><b>Email:</b> ${Email}</p>`;
        textParts.push(`Email: ${Email}`);
      }
    } else {
      html += `<p><i>We were unable to get any details.</i></p>`;
      textParts.push(`We were unable to get any details.`);
    }

    const text = textParts.join('\n');

    await sendEmail({
      to: 'talha.kh58@gmail.com',
      subject,
      text,
      html,
    });

    console.log('Notification email sent to PM.');
  } catch (error) {
    console.error('Error sending PM notification:', error);
  }
}
// Main webhook handler
exports.webhookBland = async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      Email,
      Location,
      userRoleValue,
      preferred_appointment_start_time,
      contactId,
      project_type,
      existing_project,
      talkToHuman,
      incorrectEmail,
      Issue


    } = req.body.variables;

    const { from, summary, recording_url } = req.body;

    const cleanProjectType = normalizeInput(project_type, ALLOWED_PROJECT_TYPES);
    const cleanUserRole = normalizeInput(userRoleValue, ALLOWED_USER_ROLES);

    console.log({
      first_name,
      last_name,
      Email,
      Location,
      userRoleValue,
      cleanUserRole,
      preferred_appointment_start_time,
      contactId,
      project_type,
      cleanProjectType,
      existing_project,
      talkToHuman,
      incorrectEmail,
      Issue

    });

    console.log({ from, summary, recording_url });

    let Name = first_name + " " + last_name

    console.log("Name: ", Name);


    let body = `Hi, it looks like your call got disconnected before we could schedule your free consultation with one of our top project managers. You can use the link below to book a time that works for you:
      https://prostructengineering.com/schedule-consultation/`

    let bodyWhenIncorrectEmail = `Hi,
      We're sorry but the appointment was not booked as the email provided was incorrect. Please use the link below to schedule a free consultation:
      https://prostructengineering.com/schedule-consultation/`



    if (existing_project) {
      console.log("Notifiying PM");
      let subject = `[For PM] Existing Client reached out on the main line`
      notifyPMbyEmail(subject, Name, Email, from, Location)
      if (Email === undefined) {
        console.log("Email not gatehered");
        await sendTwilioSMS(from, body, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      }
      return res.json({
        contact: '',
        deal: '',
        message: 'Exsiting Project workFlow, Sent emal to PM'
      })
    }

    if (talkToHuman) {
      console.log("Notifiying PM");
      let subject = `[For PM] Client requested to talk with human.`
      notifyPMbyEmail(subject, Name, Email, from)
      //Talk to human path call disconnected before gathering all imformation
      if (Email === undefined) {
        console.log("Email not gatehered");
        await sendTwilioSMS(from, body, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      }
    }

    let result;


    if (!contactId) {

      //Meeting was not scheduled due to incorrect email address.
      if (incorrectEmail) {
        console.log("Meeting Not scheduled, created contact and sending mesaage to user for incorrect email. ");
        await sendTwilioSMS(from, bodyWhenIncorrectEmail, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      }

      // if talk to human is false and call is disconnected before then message will be sent
      if (!talkToHuman && !incorrectEmail) {
        console.log("Meeting Not scheduled, created contact and sending mesaage to user. ");
        await sendTwilioSMS(from, body, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      }


      // Contact not present, create new contact and deal
      result = await createOrUpdateContactAndDeal(
        { Name, Email, Location, cleanUserRole },
        from,
        preferred_appointment_start_time,
        cleanProjectType,
        Issue
      );

      console.log(result.contact.id);

    } else {

      // Contact exists, update and create deal
      result = await updateContactAndCreateDeal(
        contactId,
        { Name, Email, Location, cleanUserRole },
        from,
        preferred_appointment_start_time,
        cleanProjectType,
        Issue
      );
    }

    // Create note for the contact using summary
    if (summary && result.contact?.id) {
      await createNoteForContact(result.contact.id, result.deal.id, summary, recording_url);
    }

    console.log({
      contact: result.contact.id,
      deal: result.deal.id,
      message: 'Contact and deal processed successfully.'
    });

    res.json({
      contact: result.contact,
      deal: result.deal,
      message: 'Contact and deal processed successfully.'
    });

  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};


// Main webhook handler
exports.test = async (req, res) => {
  try {
    console.log("data: ", req.body);

    res.json({
      data: req.body,
      message: 'data recieved.'
    });

  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};


