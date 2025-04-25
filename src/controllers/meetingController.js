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
    if (role === 1) {
      return 'tfarooq/aec-professional';
    }
    if (role === 0 && intent === 0) {
      return 'tfarooq/homeowner';
    }
    return 'tfarooq/aec-professional';
  };

  const hasMinusSevenOffset = (timeStr) => {
    return timeStr.endsWith('-07:00');
  };
  

exports.getAvailability = async (req, res) => {
    try {
        const { userRole, userNeed } = req.query;

        if (!userRole || !userNeed) {
            return res.status(400).json({ error: 'userRole. userNeed is required' });
        }

        let slug = getSlugFromSelection(userRole, userNeed)



        const encodedSlug = encodeURIComponent(slug);
        const url = `https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book/availability-page/${encodedSlug}?timezone=${encodeURIComponent(DEFAULT_TIMEZONE)}`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${HUBSPOT_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const availabilities = response.data?.linkAvailability?.linkAvailabilityByDuration?.['900000']?.availabilities || [];
        if (availabilities.length === 0) {
            return res.json({ message: 'No available slots found.' });
        }
        

        const slotsByDay = {};
        availabilities.forEach(slot => {
            const date = DateTime.fromMillis(slot.startMillisUtc).setZone(DEFAULT_TIMEZONE).toISODate();
            if (!slotsByDay[date]) slotsByDay[date] = [];
            slotsByDay[date].push(slot);
        });


        const firstDay = Object.keys(slotsByDay).sort().shift();
        const firstSlots = slotsByDay[firstDay];


        const readableSlots = firstSlots.map(slot => ({
            start: msToPacificISO(slot.startMillisUtc),
            end: msToPacificISO(slot.endMillisUtc),
            startMillisUtc: slot.startMillisUtc,
            endMillisUtc: slot.endMillisUtc
        }));
        
        res.json({
            date: firstDay,
            slots: readableSlots,
            timezone: DEFAULT_TIMEZONE
        });
        
    } catch (error) {
        console.error(error);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
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
                    value: "User Role: " + userRoleValue + "\n" +  
                    issue + " and the project location is: " + ProjLoc
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
