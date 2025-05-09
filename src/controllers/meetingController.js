const axios = require('axios');
const { DateTime } = require('luxon');

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

async function getMeetingtHostId(contactId) {
    try {
        const response = await axios.get(
            `https://api.hubapi.com/engagements/v1/engagements/associated/contact/${contactId}/paged?limit=10`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.results[0].engagement.ownerId || null;
    } catch (error) {
        console.error('Error fetching hubspot_owner_id:', error.response?.data || error.message);
        return null;
    }
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
        if (userRole == 0 || userRole == "0"){
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

        res.json({data: response.data, message: 1});
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

        // Validate input
        if (!contactId || !project_role__sales_rep || !phone || !appointment_set_) {
            return res.status(400).json({ error: 'contactId, projectRole, dealName, and appointmentDate are required.' });
        }

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

// Get all meeting links (for admin or listing)
exports.getAllMeetingLinks = async (req, res) => {
    try {
        const url = 'https://api.hubapi.com/scheduler/v3/meetings/meeting-links';
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${HUBSPOT_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
};


exports.getSlug = async (req, res) => {
    try {
        let { userRole, userNeed } = req.body;

        userRole = parseInt(userRole, 10);
        userNeed = parseInt(userNeed, 10);

        if (isNaN(userRole) || isNaN(userNeed)) {
            return res.status(400).json({ error: 'Invalid input. Expecting numeric role and intent.' });
        }

        const slug = getSlugFromSelection(userRole, userNeed);
        return res.json({ slug });

    } catch (error) {
        console.error(error);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
};


exports.webhookTest = async (req, res) => {
    try {
        let {Name, Email, Location, userRoleValue, project_type} = req.body.variables;
        let {summary, from} = req.body

        console.log("webhook: ", {Name, Email, Location});
        
        return res.json( {Name, Email, userRoleValue, from, project_type, Location, summary} )

    } catch (error) {
        console.error(error);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
};