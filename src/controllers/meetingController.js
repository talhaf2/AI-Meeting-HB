const axios = require('axios');
const { DateTime } = require('luxon');
const { sendEmail } = require('../utils/email');
const twilio = require('twilio')

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles'; // Pacific Time

// Helper: Convert milliseconds (UTC) to ISO 8601 string in Pacific Time
function msToPacificISO(ms) {
  return DateTime.fromMillis(ms, { zone: DEFAULT_TIMEZONE }).toISO({ includeOffset: true, suppressMilliseconds: true });
}

// Helper function to get meeting link slug based on role and intent
const getSlugFromSelection = (role, intent) => {
  // Clean and convert to numbers
  const parsedRole = Number(String(role).trim());
  const parsedIntent = Number(String(intent).trim());

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
      projDesc,
      issue,
      ProjLoc,
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
          value: issue + " and the project location is: " + ProjLoc
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

exports.updateContactAndCreateDeal = async (req, res) => {
  try {

    const {
      contactId,
      Location,
      userRoleValue,
      phone,         // e.g. "New Project Deal"
      preferred_appointment_start_time,     // e.g. "2025-05-20" (YYYY-MM-DD)
      project_type
    } = req.body;

    // 1. Update the contact's project role, phone, and address
    const contactUpdateResp = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        properties: {
          project_role__sales_rep: userRoleValue, // Use the exact internal name of your property
          phone: phone,
          address: Location
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // 2. Get HubSpot owner ID for the contact
    const OwnerId = await getMeetingtHostId(contactId);

    console.log(OwnerId);


    // 3. Create the deal and associate with the contact
    const dealPayload = {
      properties: {
        dealname: "AI Voice Agent - " + phone,
        pipeline: "default",             // Replace with your pipeline ID if different
        dealstage: "contractsent", // Replace with your actual stage ID
        appointment_set_: preferred_appointment_start_time, // Use the internal name of your property
        customer_success_manager: OwnerId,
        project_type: project_type
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
          Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      contact: contactUpdateResp.data,
      deal: dealCreateResp.data,
      message: 'Project role updated and deal created/associated successfully.'
    });

  } catch (error) {
    console.error('HubSpot error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message
    });
  }
};


///WEBHOOK POST CALL FOR LOGGING CONTACT AND DEAL INTO HUBSPOT...
// Create new contact and deal
async function createOrUpdateContactAndDeal(variables, from, preferred_appointment_start_time, project_type, accessToken) {
  // 1. Search for contact by email
  let contactId = null;
  let contactResp = null;

  console.log("Variables: ", variables.Email);

  try {
    // let searchResp;
    // if (variables.Email !== undefined) {
    //   searchResp = await axios.post(
    //     'https://api.hubapi.com/crm/v3/objects/contacts/search',
    //     {
    //       filterGroups: [{
    //         filters: [{
    //           propertyName: 'email',
    //           operator: 'EQ',
    //           value: variables.Email
    //         }]
    //       }],
    //       properties: ['firstname', 'email', 'phone', 'address', 'project_role__sales_rep']
    //     },
    //     {
    //       headers: {
    //         Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    //         'Content-Type': 'application/json'
    //       }
    //     }
    //   )
    // }
    // else {
    //   searchResp = await axios.post(
    //     'https://api.hubapi.com/crm/v3/objects/contacts/search',
    //     {
    //       filterGroups: [{
    //         filters: [{
    //           propertyName: 'firstname',
    //           operator: 'EQ',
    //           value: from  // if phone number already there in contact means contact exsit
    //         }]
    //       }],
    //       properties: ['firstname', 'email', 'phone', 'address', 'project_role__sales_rep']
    //     },
    //     {
    //       headers: {
    //         Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    //         'Content-Type': 'application/json'
    //       }
    //     }
    //   );
    // }
if (variables.Email !== undefined){
    const searchResp = await axios.post(
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
            project_role__sales_rep: variables.userRoleValue,
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
          project_role__sales_rep: variables.userRoleValue,
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
  // 2. Create deal associated with the contact
  const dealPayload = {
    properties: {
      dealname: "AI Voice Agent - " + from,
      pipeline: "default",
      dealstage: "appointmentscheduled", //Raw Lead
      appointment_set_: "",
      customer_success_manager: "", // meeting not scheduled
      project_type: project_type
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
    return response.data.results.at(-1)?.engagement.ownerId ?? null;
  } catch (error) {
    console.error('Error fetching hubspot_owner_id:', error.response?.data || error.message);
    return null;
  }
}

// Update existing contact and create deal
async function updateContactAndCreateDeal(contactId, variables, from, preferred_appointment_start_time, project_type) {
  // 1. Update contact
  const contactUpdateResp = await axios.patch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    {
      properties: {
        project_role__sales_rep: variables.userRoleValue,
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

  // 3. Create deal associated with existing contact
  const dealPayload = {
    properties: {
      dealname: "AI Voice Agent - " + from,
      pipeline: "default",
      dealstage: "contractsent",
      appointment_set_: preferred_appointment_start_time,
      customer_success_manager: OwnerId,
      project_type: project_type
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

async function createNoteForContact(contactId, noteContent) {
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
      body: noteContent
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

// Main webhook handler
exports.webhookTest = async (req, res) => {
  try {
    const {
      Name,
      Email,
      Location,
      userRoleValue,
      preferred_appointment_start_time,
      contactId,
      project_type,
      existing_project
    } = req.body.variables;

    const { from, summary } = req.body;

    console.log({
      Name,
      Email,
      Location,
      userRoleValue,
      preferred_appointment_start_time,
      contactId,
      project_type,
      existing_project
    });

    console.log({ from, summary });

    if (existing_project) {
      return
    }
    let result;

    if (!contactId) {
      // Contact not present, create new contact and deal
      result = await createOrUpdateContactAndDeal(
        { Name, Email, Location, userRoleValue },
        from,
        preferred_appointment_start_time,
        project_type
      );

      let body = `Hi, it looks like your call got disconnected before we could schedule your free consultation with one of our top project managers. You can use the link below to book a time that works for you:
      https://prostructengineering.com/schedule-consultation/`

      // await sendTwilioSMS(from, body, process.env.TWILIO_NUMBER, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)

    } else {
      // Contact exists, update and create deal
      result = await updateContactAndCreateDeal(
        contactId,
        { Name, Email, Location, userRoleValue },
        from,
        preferred_appointment_start_time,
        project_type
      );
    }

    // Create note for the contact using summary
    if (summary && result.contact?.id) {
      await createNoteForContact(result.contact.id, summary);
    }

    console.log({
      contact: result.contact,
      deal: result.deal,
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

exports.notifyPMExistingClient = async (req, res) => {
  try {
    const fields = req.body; // All fields collected by AI Voice Agent
    const emailId = fields.Email || 'Unknown';

    // Build email body with all collected fields
    const fieldLines = Object.entries(fields)
      .map(([key, value]) => `<b>${key}:</b> ${value}`)
      .join('<br>');

    const subject = `[For PM] Existing Client reached out on the main line - ${emailId}`;
    const html = `
      <p><b>NEW</b></p>
      <p>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <p>${fieldLines}</p>
    `;
    const text = `NEW\n${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n` +
      Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');

    await sendEmail({
      to: 'projects@prostructengineering.us',
      // to: 'talha.kh58@gmail.com',
      subject,
      text,
      html,
    });

    res.status(200).json({ message: 'Notification email sent to PM.' });
  } catch (error) {
    console.error('Error sending PM notification:', error);
    res.status(500).json({ error: 'Failed to send notification email.', details: error.message });
  }
};