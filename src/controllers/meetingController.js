const axios = require('axios');
const { DateTime } = require('luxon');

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles'; // Pacific Time

// Helper: Convert milliseconds (UTC) to ISO 8601 string in Pacific Time
function msToPacificISO(ms) {
    return DateTime.fromMillis(ms, { zone: DEFAULT_TIMEZONE }).toISO({ includeOffset: true, suppressMilliseconds: true });
}

exports.getAvailability = async (req, res) => {
    try {
        const { slug } = req.query;
        if (!slug) {
            return res.status(400).json({ error: 'slug is required' });
        }

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
            slug,
            startTime,
            endTime,
            firstName,
            lastName,
            email,
            issue,
            projDesc,
            userRole,
            ProjLoc,
            phone
        } = req.body;

        if (!slug || !startTime || !endTime || !firstName || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Convert startTime and endTime to Pacific Time
        const startTimePacific = DateTime.fromISO(startTime, { zone: DEFAULT_TIMEZONE }).toMillis();
        const endTimePacific = DateTime.fromISO(endTime, { zone: DEFAULT_TIMEZONE }).toMillis();
        

        const payload = {
            slug,
            startTime: startTimePacific,
            endTime: endTimePacific,
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
                    value: "User Role: " + userRole + "\n" +  
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

        res.json(response.data);
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
