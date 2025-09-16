const { getOrCreateContact, updateContact } = require('../hubspot/contactService');
const { getAssociatedDeals, getLatestDeal, createOrUpdateDeal } = require('../hubspot/dealService');
const { getMeetingHostId, fetchCSMName } = require('../hubspot/ownerService');
const { sendSlackMessage } = require('../services/slackService');
const { formatAppointmentTime } = require('../utils/time');
const logger = require('../utils/logger');
const { mergeContacts } = require('../hubspot/contactService');

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
            hs_object_id_deal,
            dealname,
            // Twillio created contact and deal.
            twillio_contact,
            twillio_deal

        } = req.body;

        if (!email && !hs_object_id) {
            return res.status(400).json({ error: "Missing 'email' or 'hs_object_id'" });
        }

        const contactRole = project_role_meeting === "Homeowner" ? "Homeowner" : project_role_hs_meeting;

        // 🟢 For Twillio Missed call: If both Twilio contact and a new form contact exist → merge
        if (twillio_contact && hs_object_id && twillio_contact !== hs_object_id) {
            try {
                await mergeContacts(twillio_contact, hs_object_id);
                logger.info(
                    `Form contact ${hs_object_id} merged into Twilio contact ${twillio_contact}`
                );
            } catch (err) {
                logger.warn("Merge step failed, continuing with fallback:", err.message);
            }
        }


        const { contactId, contactData, isNew } = await getOrCreateContact({
            email,
            firstname,
            lastname,
            phone: your_phone_number,
            role: contactRole,
            hs_object_id: twillio_contact || hs_object_id // prefer Twilio ID if present
        });

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

        const OwnerId = await getMeetingHostId(contactId);
        const CSMname = await fetchCSMName(OwnerId);

        const contactName = `${firstname} ${lastname}`;

        const formattedTime = formatAppointmentTime(hs_meeting_start_time);

        const msg =
            `<https://app.hubspot.com/contacts/45924609/record/0-1/${contactId}>\n\n` +
            `From Huspot Appointments\n` +
            `Appointment set for *${CSMname}*\n` +
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

        const dealResult = await createOrUpdateDeal({
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

        const contactName = `${firstname} ${lastname}`;
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