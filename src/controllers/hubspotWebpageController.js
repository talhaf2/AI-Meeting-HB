const { DateTime } = require('luxon');
const { getOrCreateContact, updateContact } = require('../hubspot/contactService');
const { getAssociatedDeals, getLatestDeal, createOrUpdateDeal } = require('../hubspot/dealService');
const { getMeetingHostId, fetchCSMName } = require('../hubspot/ownerService');
const { sendSlackMessage } = require('../services/slackService');
const { formatAppointmentTime } = require('../utils/time');
const logger = require('../utils/logger');

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
        } = req.body;

        if (!email && !hs_object_id) {
            return res.status(400).json({ error: "Missing 'email' or 'hs_object_id'" });
        }

        const contactRole = project_role_meeting === "Homeowner" ? "Homeowner" : project_role_hs_meeting;

        const { contactId, contactData, isNew } = await getOrCreateContact({
            email,
            firstname,
            lastname,
            phone: your_phone_number,
            role: contactRole,
            hs_object_id
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

        const dealIds = await getAssociatedDeals(contactId);
        const { latestDealId, latestDealData, shouldUpdateExistingDeal } = await getLatestDeal(dealIds);

        const OwnerId = await getMeetingHostId(contactId);
        const CSMname = await fetchCSMName(OwnerId);

        const contactName = `${firstname} ${lastname}`;
        // const role = project_role_meeting === 'AEC professional' && project_role_hs_meeting
        //     ? `${project_role_meeting} (${project_role_hs_meeting})`
        //     : project_role_meeting;
        const formattedTime = formatAppointmentTime(engagements_last_meeting_booked);

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
            appointment_set_: new Date(Number(engagements_last_meeting_booked)).toISOString(),
            customer_success_manager: OwnerId,
            project_type: type_of_project,
            deal_address__if_different_from_contact_address_: full_project_address_webpage_meeting
        };

        const dealResult = await createOrUpdateDeal({
            shouldUpdate: shouldUpdateExistingDeal,
            latestDealId,
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
