const axios = require('axios');
const { DateTime } = require('luxon');
const { sendEmail } = require('../utils/email');
const twilio = require('twilio');
const { json } = require('express');

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles'; // Pacific Time

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

};

const hasMinusSevenOffset = (timeStr) => {
  return timeStr.endsWith('-07:00');
};

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
    const { userRole, userNeed } = req.query;
    if (!userRole || !userNeed) {
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
      startTime,
      endTime,
      firstName,
      lastName,
      email,
      Issue,
      Location,
      phone
    } = req.body;

    if (userRole === undefined || userRole === null ||
      userNeed === undefined || userNeed === null ||
      !startTime || !endTime || !firstName || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let slug = getSlugFromSelection(userRole, userNeed)

    let userRoleValue = ""
    if (userRole == 0 || userRole == "0") {
      userRoleValue = "HomeOwner"
    } else {
      userRoleValue = "AEC Professional"
    }

    // Append "-07:00" only if no timezone offset present
    const formattedStartTime = hasMinusSevenOffset(startTime)
      ? startTime
      : startTime + '-07:00';

    const formattedEndTime = hasMinusSevenOffset(endTime)
      ? endTime
      : endTime + '-07:00';

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
          name: "Please include a phone number so I can contact you.",
          value: phone
        },
        {
          name: "Please provide any details to help prepare for our meeting, such as the site address.",
          value: Issue + " and the project location is: " + Location
        }
      ]
    };

    const url = 'https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book';
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({ data: response.data, message: 1 });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
  }
};

///WEBHOOK POST CALL FOR LOGGING CONTACT AND DEAL INTO HUBSPOT...
// Create new contact and deal
async function createOrUpdateContactAndDeal(variables, from, preferred_appointment_start_time, project_type, Issue) {
  // 1. Search for contact by email
  let contactId = null;
  let contactResp = null;

  console.log("in");


  try {
    let searchResp;
    if (variables.Email !== undefined) {
      searchResp = await axios.post(

        'https://api.hubapi.com/crm/v3/objects/contacts/search',
        {
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: variables.Email
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
      )
    }
    console.log(variables.cleanUserRole);
    if (searchResp.data.results && searchResp.data.results.length > 0) {
      // Contact exists, update it
      contactId = searchResp.data.results[0].id;
      contactResp = await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
        {
          properties: {
            firstname: variables.Name,
            phone: from,
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
          email: variables.Email,
          phone: from,
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
      project_description: Issue
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

async function createNoteForContact(contactId, noteContent, recording_url) {
  const notePayload = {
    engagement: {
      active: true,
      type: "NOTE"
    },
    associations: {
      contactIds: [contactId],
      companyIds: [],
      dealIds: [],
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


// canonical list (exact spellings)
const ALLOWED_PROJECT_TYPES = [
  'Load Bearing Wall',
  'Addition',
  'Remodel',
  'Foundation',
  'OSE (Structural)',
  'ADU',
  'New Home',
  'Retaining Wall',
  'Outdoor Living Space (Decks/Patio)',
  'T24',
  'Civil Engineering',
  'Deck/Patio/Patch',
  'LBW/R',
  'Legalization',
  'New Custom Home',
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
  'Ground Up Construction'
];

const ALLOWED_USER_ROLES = [
  'Homeowner',
  'Architect',
  'Designer',
  'Contractor',
  'Developer',
  'Realtor/Property Manager',
  'Others'
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
      await createNoteForContact(result.contact.id, summary, recording_url);
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


const HUB_URL = 'https://api.hubapi.com/crm/v3/objects';
const headers = {
  Authorization: `Bearer ${HUBSPOT_API_KEY}`,
  'Content-Type': 'application/json',
};

exports.webapge = async (req, res) => {
  try {
    const {
      email,
      firstname,
      lastname,
      hs_object_id, // HubSpot Contact ID
      engagements_last_meeting_booked,
      address,
      type_of_project,
      your_phone_number,
      project_role_meeting, // homeowner/ AEC professional
      project_role_hs_meeting // when user select AEC as a project role, other option after selection
    } = req.body;




    // Validate required input
    if (!email && !hs_object_id) {
      return res.status(400).json({ error: "Missing 'email' or 'hs_object_id'" });
    }

    // 1. Ensure contact exists or retrieve via hs_object_id
    let contactId = hs_object_id;
    let contactData;

    if (!contactId && email) {
      const search = await axios.post(
        `${HUB_URL}/contacts/search`,
        {
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
          properties: ['firstname', 'lastname', 'email'],
        },
        { headers }
      );
      const found = search.data.results?.[0];
      if (found) {
        contactId = found.id;
      }
    }

    let project_role;

    if (project_role_meeting === "Homeowner") {
      project_role = "Homeowner"
    } else {
      project_role = project_role_hs_meeting
    }

    if (!contactId) {
      const create = await axios.post(
        `${HUB_URL}/contacts`,
        { properties: { email, firstname, lastname, address, phone: your_phone_number, project_role__sales_rep: project_role } },
        { headers }
      );
      contactId = create.data.id;
      contactData = create.data;
    } else {
      console.log('in');

      const update = await axios.patch(
        `${HUB_URL}/contacts/${contactId}`,
        { properties: { firstname, lastname, email, address, phone: your_phone_number, project_role__sales_rep: project_role } },
        { headers }
      );
      contactData = update.data;
    }


    // 2. Fetch associated deals
    const assoc = await axios.get(
      `${HUB_URL}/contacts/${contactId}/associations/deals`,
      { headers }
    );

    const dealIds = assoc.data.results.map(r => r.id);

    console.log("dealIds: ", dealIds);

    // 3. Pick the most recent deal
    let latestDealId = null;
    let latestDealData = null;

    if (dealIds.length) {
      const deals = await Promise.all(
        dealIds.map(id =>
          axios.get(`${HUB_URL}/deals/${id}?properties=createdate,appointment_set_,customer_success_manager,project_type,deal_address__if_different_from_contact_address_`, { headers })
        )
      );
      deals.sort((a, b) =>
        new Date(b.data.properties.createdate) - new Date(a.data.properties.createdate)
      );
      latestDealId = deals[0].data.id;
      latestDealData = deals[0].data.properties;
    }

    console.log("latestDealId: ", latestDealId);

    // Get ownerId for deal assignment
    const OwnerId = await getMeetingHostId(contactId);
    console.log("OwnerId", OwnerId);

    // Build properties to update (only if current value is empty)
    const dealProps = {};

    if (latestDealData?.appointment_set_ === null || latestDealData?.appointment_set_ === undefined) {
      dealProps.appointment_set_ = new Date(Number(engagements_last_meeting_booked)).toISOString();
    }
    if (!latestDealData?.customer_success_manager) {
      dealProps.customer_success_manager = OwnerId;
    }
    if (!latestDealData?.project_type) {
      dealProps.project_type = type_of_project;
    }
    if (!latestDealData?.deal_address__if_different_from_contact_address_) {
      dealProps.deal_address__if_different_from_contact_address_ = address;
    }
    console.log("OwnerId");
    

    let dealResult;

    if (latestDealId && Object.keys(dealProps).length > 0) {
      console.log("in first");
      const updatedDeal = await axios.patch(
        `${HUB_URL}/deals/${latestDealId}`,
        { properties: dealProps },
        { headers }
      );
      dealResult = updatedDeal.data;
    } else if (!latestDealId) {
      console.log("in second");
      
      const createdDeal = await axios.post(
        `${HUB_URL}/deals`,
        {
          properties: {
            dealname: `Webpage deal - ${email}`,
            pipeline: "default",
            dealstage: "contractsent",
            appointment_set_: new Date(Number(engagements_last_meeting_booked)).toISOString(),
            customer_success_manager: OwnerId,
            project_type: type_of_project,
            deal_address__if_different_from_contact_address_: address
          },
          associations: [
            {
              to: { id: contactId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
            },
          ],
        },
        { headers }
      );
      dealResult = createdDeal.data;
    } else {
       console.log("Nothing updated, deal was not blank");
      // No update needed
      dealResult = { message: 'No deal properties were empty. No update performed.' };
    }


    return res.json({ contact: contactData, deal: dealResult });
  } catch (err) {
    console.error('Webhook error', err.response?.data || err);
    res.status(500).json({ error: err.message });
  }
};

