const { getOrCreateContact, updateContact } = require('../hubspot/contactService');
const { getAssociatedDeals, getLatestDeal, createOrUpdateDeal } = require('../hubspot/dealService');
const { getMeetingHostId, fetchCSMName, fetchCSMEmail } = require('../hubspot/ownerService');
const { sendSlackMessage, mentionByEmail } = require('../services/slackService');
const { formatAppointmentTime } = require('../utils/time');
const logger = require('../utils/logger');
const { mergeContacts } = require('../hubspot/contactService');
const axios = require('axios');
const { HUB_URL, headers } = require('../../config/constants');

let _withRetry = null;
async function withRetry(fn, retries, delayMs) {
    if (!_withRetry) {
        ({ withRetry: _withRetry } = await import('../utils/retry.js'));
    }
    return _withRetry(fn, retries, delayMs);
}

// Helper function to get deal stage
async function getDealStage(dealId) {
    try {
        const { data } = await withRetry(() =>
            axios.get(`${HUB_URL}/deals/${dealId}?properties=dealstage`, { headers })
        );
        return data.properties?.dealstage || null;
    } catch (err) {
        logger.error(`Failed to fetch deal stage for deal ${dealId}`, err.response?.data || err);
        return null;
    }
}

exports.webapge = async (req, res) => {
    try {
        const {
            email,
            firstname,
            lastname,
            hs_object_id,
            engagements_last_meeting_booked,
            full_project_address_webpage_meeting,
            type_of_project,
            your_phone_number,
            project_role_meeting,
            project_role_hs_meeting,
            project_description_webpage_meeting,
            hs_meeting_start_time,
            hs_object_id_deal, //not used now...
            dealname,
            // JustCAll webhook created contact and deal.
            twillio_contact,
            twillio_deal,
            //for Retell - to check if it is booked via retell or not
            retell_appointment_source

        } = req.body;

        console.log('req.body', req.body);
        

        if (!email && !hs_object_id) {
            return res.status(400).json({ error: "Missing 'email' or 'hs_object_id'" });
        }

        const contactRole = project_role_meeting === "Homeowner" ? "Homeowner" : project_role_hs_meeting;
        const OwnerId = await getMeetingHostId(hs_object_id || contactId);
        // 🟢 For Twillio Missed call: If both Twilio contact and a new form contact exist → merge
        // if (twillio_contact && hs_object_id && twillio_contact !== hs_object_id) {
        //     try {
        //         await mergeContacts(hs_object_id, twillio_contact);
        //         logger.info(
        //             `Form contact ${hs_object_id} merged into Twilio contact ${twillio_contact}`
        //         );


        //     } catch (err) {
        //         logger.warn("Merge step failed, continuing with fallback:", err.message);
        //     }
        // }


        const { contactId, contactData, isNew } = await getOrCreateContact({
            email,
            firstname,
            lastname,
            phone: your_phone_number,
            role: contactRole,
            hs_object_id: twillio_contact || hs_object_id // prefer Twilio ID if present
        });

        console.log({ contactId, isNew, contactData });
        

        if (!isNew) {
            await updateContact(contactId, {
                firstname,
                lastname,
                email,
                phone: your_phone_number,
                project_role__sales_rep: contactRole
            });
        }

        // const dealIds = await getAssociatedDeals(contactId);
        //const { latestDealId, latestDealData, shouldUpdateExistingDeal } = await getLatestDeal(dealIds);

        const hasInquiry = dealname?.toLowerCase().includes("inquiry");

        // const OwnerId = await getMeetingHostId(hs_object_id || contactId);
        // const CSMname = await fetchCSMName(OwnerId);
        const CSMemail = await fetchCSMEmail(OwnerId);
        const CSMmention = CSMemail ? await mentionByEmail(CSMemail) : '';

        const contactName = `${firstname} ${lastname || ""}`;

        const formattedTime = formatAppointmentTime(hs_meeting_start_time);

        const msg =
            `<https://app.hubspot.com/contacts/45924609/record/0-1/${contactId}>\n\n` +
            `From Huspot Appointments\n` +
            `Appointment set for ${CSMmention ? `${CSMmention}\n` : CSMemail ? CSMemail : ''}\n` +
            `Date/time: *${formattedTime}*\n\n` +
            `Scope of Work: ${project_description_webpage_meeting || 'N/A'}\n\n` +
            `Name: ${contactName}\n` +
            `Number: ${your_phone_number || 'N/A'}\n` +
            `Email: ${email || 'N/A'}\n` +
            `Address: ${full_project_address_webpage_meeting || 'N/A'}`;


        await sendSlackMessage(msg);

        const dealProps = {
            pipeline: "default",
            deal_association_type: "Primary Deal",
            project_description: project_description_webpage_meeting,
            dealstage: "contractsent",
            appointment_set_: new Date(Number(hs_meeting_start_time)).toISOString(),
            customer_success_manager: OwnerId,
            project_type: type_of_project,
            deal_address__if_different_from_contact_address_: full_project_address_webpage_meeting
        };

        // const dealResult = await createOrUpdateDeal({
        //     shouldUpdate: hasInquiry,
        //     latestDealId: hs_object_id_deal, 
        //     email,
        //     dealProps,
        //     contactId
        // });

        // Check if deal should be updated - skip if current dealstage is "199684762"
        const dealIdToCheck = twillio_deal || hs_object_id_deal;
        let dealResult = null;

        if (dealIdToCheck) {
            const currentDealStage = await getDealStage(dealIdToCheck);
            if (currentDealStage === "199684762") {
                logger.info(`Skipping deal update for deal ${dealIdToCheck} - current stage is "199684762"`);
                // Return early without updating the deal
                return res.json({ 
                    contact: contactData, 
                    deal: { id: dealIdToCheck, message: 'Deal update skipped - stage is "199684762"' }
                });
            }
        }

        dealResult = await createOrUpdateDeal({
            retell_appointment_source,
            shouldUpdate: hasInquiry,
            twilioDealId: twillio_deal || null,    // 👈 authoritative if present
            latestDealId: hs_object_id_deal || null,
            email,
            dealProps,
            contactId
        });


        res.json({ contact: contactData, deal: dealResult });
    } catch (err) {
        logger.error('Webhook processing error', err.response?.data || err);
        res.status(500).json({ error: err.message });
    }
};

exports.webapgeOutcomeChange = async (req, res) => {
    try {
        const {
            email,
            firstname,
            lastname,
            hs_object_id,
            full_project_address_webpage_meeting,
            your_phone_number,
            project_description_webpage_meeting,
            hs_object_id_deal,
            dealname,
            hs_meeting_outcome,
            hs_meeting_start_time,
            current_dealstage
        } = req.body;

        if (current_dealstage !== "contractsent") { return res.json({ message: "Appointment not set" }); }

        const contactName = `${firstname} ${lastname || ""}`;
        const formattedTime = formatAppointmentTime(hs_meeting_start_time);

        let title = ''
        let d_t = ''
        let dealstage;

        if (hs_meeting_outcome === "CANCELED") {
            title = 'From Huspot Appointments - Meeting Canceled\n\n'
            dealstage = "closedlost"
        } else {
            title = 'From Huspot Appointments - Meeting Rescheduled\n'
            d_t = `Date/time: *${formattedTime}*\n\n`
            dealstage = "contractsent"
        }

        const msg =
            `<https://app.hubspot.com/contacts/45924609/record/0-1/${hs_object_id}>\n\n` +
            `${title}` +

            `${d_t}` +
            `Scope of Work: ${project_description_webpage_meeting || 'N/A'}\n\n` +
            `Name: ${contactName}\n` +
            `Number: ${your_phone_number || 'N/A'}\n` +
            `Email: ${email || 'N/A'}\n` +
            `Address: ${full_project_address_webpage_meeting || 'N/A'}`;


        await sendSlackMessage(msg);

        // Check if deal should be updated - skip if current dealstage is "199684762"
        if (hs_object_id_deal) {
            const currentDealStage = await getDealStage(hs_object_id_deal);
            if (currentDealStage === "199684762") {
                logger.info(`Skipping deal update for deal ${hs_object_id_deal} - current stage is "199684762"`);
                // Return early without updating the deal
                return res.json({ 
                    deal: { id: hs_object_id_deal, message: 'Deal update skipped - stage is "199684762"' }
                });
            }
        }

        const dealProps = {
            dealstage: dealstage,
            appointment_set_: new Date(Number(hs_meeting_start_time)).toISOString(),
        };

        const dealResult = await createOrUpdateDeal({
            shouldUpdate: true,
            latestDealId: hs_object_id_deal,
            email,
            dealProps,
            hs_object_id
        });

        res.json({ deal: dealResult });
    } catch (err) {
        logger.error('Webhook processing error', err.response?.data || err);
        res.status(500).json({ error: err.message });
    }
};