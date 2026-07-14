const { getOrCreateContact, updateContact } = require('../hubspot/contactService');
const { getAssociatedDeals, getLatestDeal, createOrUpdateDeal, updateDealProperties } = require('../hubspot/dealService');
const { getMeetingHostId, fetchCSMName, fetchCSMEmail } = require('../hubspot/ownerService');
const { sendSlackMessage, mentionByEmail } = require('../services/slackService');
const { formatAppointmentTime } = require('../utils/time');
const logger = require('../utils/logger');
const { mergeContacts } = require('../hubspot/contactService');
const axios = require('axios');
const { DateTime } = require('luxon');
const { HUB_URL, headers } = require('../../config/constants');

let _withRetry = null;
async function withRetry(fn, retries, delayMs) {
    if (!_withRetry) {
        ({ withRetry: _withRetry } = await import('../utils/retry.js'));
    }
    return _withRetry(fn, retries, delayMs);
}

function isBusinessHoursPacific(now = DateTime.now().setZone('America/Los_Angeles')) {
    // Business hours: Mon–Fri, 8:30am–5:00pm Pacific (end is exclusive)
    const weekday = now.weekday; // 1=Mon ... 7=Sun
    if (weekday < 1 || weekday > 5) return false;
    const minutes = now.hour * 60 + now.minute;
    return minutes >= (8 * 60 + 30) && minutes < 17 * 60;
}

function isTrueish(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

async function postErrorAlert(text) {
    const channel = process.env.ERROR_AND_ALERTS_CHANNEL;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!channel || !token) return;
    try {
        await axios.post(
            'https://slack.com/api/chat.postMessage',
            { channel, text, mrkdwn: true },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
    } catch (e) {
        console.warn('[ERROR_AND_ALERTS_CHANNEL] Slack post failed:', e?.response?.data || e?.message || e);
    }
}

async function findContactIdByEmail(email) {
    const value = String(email || '').trim().toLowerCase();
    if (!value) return null;
    try {
        const { data } = await withRetry(() =>
            axios.post(
                `${HUB_URL}/contacts/search`,
                {
                    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value }] }],
                    properties: ['email'],
                    limit: 5
                },
                { headers }
            )
        );
        const results = data?.results || [];
        return results?.[0]?.id || null;
    } catch {
        return null;
    }
}

async function clearContactEmail(contactId) {
    if (!contactId) return;
    await withRetry(() =>
        axios.patch(
            `${HUB_URL}/contacts/${contactId}`,
            { properties: { email: '' } },
            { headers }
        )
    );
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

// Same as getDealStage, but also returns appointment_set_ - used by the
// reschedule/cancel flow to detect duplicate webhook fires (idempotency),
// since HubSpot workflows can re-send the same webhook action more than once.
async function getDealStageAndAppointmentTime(dealId) {
    try {
        const { data } = await withRetry(() =>
            axios.get(`${HUB_URL}/deals/${dealId}?properties=dealstage,appointment_set_`, { headers })
        );
        return {
            dealstage: data.properties?.dealstage || null,
            appointment_set_: data.properties?.appointment_set_ || null
        };
    } catch (err) {
        logger.error(`[outcome-changed] Failed to fetch deal stage/appointment time for deal ${dealId}`, err.response?.data || err);
        return { dealstage: null, appointment_set_: null };
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
        

        /**
         * This webhook can be triggered by:
         * - Retell AI booked meeting (retell_appointment_source=true; twillio_* usually null)
         * - Thinlink / HubSpot booking flow (twillio_* null)
         * - Booking for an already-created contact/deal (twillio_contact/twillio_deal present)
         *
         * Requirements:
         * - If `twillio_deal` is present, we must update that deal (unless it's already "signed").
         * - Contact merge is best-effort; if it fails we continue and alert.
         */

        const preferredContactId = twillio_contact || hs_object_id;
        const preferredDealId = twillio_deal;

        if (!email && !preferredContactId) {
            return res.status(400).json({ error: "Missing 'email' or contact id" });
        }

        const contactRole = project_role_meeting === "Homeowner" ? "Homeowner" : project_role_hs_meeting;
        const OwnerId = await getMeetingHostId(hs_object_id);

        let mergeFailed = false;
        if (twillio_contact && hs_object_id && twillio_contact !== hs_object_id) {
            try {
                // Merge booking-form contact INTO canonical (twillio_contact)
                await mergeContacts(twillio_contact, hs_object_id);
                logger.info(`Merged form contact ${hs_object_id} into canonical contact ${twillio_contact}`);
            } catch (err) {
                mergeFailed = true;
                logger.warn("Merge step failed, continuing with fallback:", err?.message || err);
                await postErrorAlert(
                    `🚨 *HubSpot merge failed (webpage webhook)*\n` +
                    `*canonical contact:* ${twillio_contact}\n` +
                    `*form contact:* ${hs_object_id}\n` +
                    `*error:* ${err?.response?.data?.message || err?.message || 'unknown'}`
                );
            }
        }


        const { contactId, contactData, isNew } = await getOrCreateContact({
            email,
            firstname,
            lastname,
            phone: your_phone_number,
            role: contactRole,
            hs_object_id: preferredContactId
        });

        console.log({ contactId, isNew, contactData });
        

        // Contact update should never prevent deal update.
        try {
            if (!isNew) {
                await updateContact(contactId, {
                    firstname,
                    lastname,
                    email,
                    phone: your_phone_number,
                    project_role__sales_rep: contactRole
                });
            }
        } catch (err) {
            await postErrorAlert(
                `🚨 *HubSpot contact update failed (webpage webhook)*\n` +
                `*contactId:* ${contactId}\n` +
                `*email:* ${email || 'n/a'}\n` +
                `*error:* ${err?.response?.data?.message || err?.message || 'unknown'}`
            );

            // Fallback requested: if merge failed, try to clear the email-owner contact then update canonical.
            if (mergeFailed && twillio_contact && email) {
                try {
                    const emailOwnerId = await findContactIdByEmail(email);
                    if (emailOwnerId && String(emailOwnerId) !== String(twillio_contact)) {
                        await clearContactEmail(emailOwnerId);
                        await postErrorAlert(
                            `⚠️ *Fallback:* cleared email on contact ${emailOwnerId} to update canonical contact ${twillio_contact}\n` +
                            `*email:* ${email}`
                        );
                    }

                    await updateContact(twillio_contact, {
                        firstname,
                        lastname,
                        email,
                        phone: your_phone_number,
                        project_role__sales_rep: contactRole
                    });
                } catch (fallbackErr) {
                    await postErrorAlert(
                        `🚨 *Fallback failed (webpage webhook)*\n` +
                        `*canonical contact:* ${twillio_contact}\n` +
                        `*email:* ${email}\n` +
                        `*error:* ${fallbackErr?.response?.data?.message || fallbackErr?.message || 'unknown'}`
                    );
                }
            }
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

        const isRetellAppointment = isTrueish(retell_appointment_source);
        const callPickedBy = isBusinessHoursPacific() ? "AI" : "ai_after_business_hours";
        const callSid =
            String(
                req?.body?.call_sid ??
                req?.body?.callSid ??
                req?.body?.call_id ??
                req?.body?.callId ??
                ""
            ).trim();

        const dealProps = {
            pipeline: "default",
            deal_association_type: "Primary Deal",
            project_description: project_description_webpage_meeting,
            dealstage: "contractsent",
            appointment_set_: new Date(Number(hs_meeting_start_time)).toISOString(),
            customer_success_manager: OwnerId,
            project_type: type_of_project,
            deal_address__if_different_from_contact_address_: full_project_address_webpage_meeting,
            ...(isRetellAppointment
                ? {
                    call_status: "Ai",
                    call_sid: callSid || "",
                    call_picked_by: callPickedBy
                }
                : {})
        };

        // const dealResult = await createOrUpdateDeal({
        //     shouldUpdate: hasInquiry,
        //     latestDealId: hs_object_id_deal, 
        //     email,
        //     dealProps,
        //     contactId
        // });

        // Check if deal should be updated - skip if current dealstage is "199684762"
        const dealIdToCheck = preferredDealId;
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

        try {
            dealResult = await createOrUpdateDeal({
                retell_appointment_source,
                shouldUpdate: hasInquiry,
                // IMPORTANT: dealService will ALWAYS update twilioDealId if present.
                twilioDealId: twillio_deal || null,
                latestDealId: hs_object_id_deal || null,
                email,
                dealProps,
                contactId
            });
        } catch (err) {
            await postErrorAlert(
                `🚨 *HubSpot deal update/create failed (webpage webhook)*\n` +
                `*twillio_deal:* ${twillio_deal || 'n/a'}\n` +
                `*hs_object_id_deal:* ${hs_object_id_deal || 'n/a'}\n` +
                `*error:* ${err?.response?.data?.message || err?.message || 'unknown'}`
            );
            throw err;
        }


        res.json({ contact: contactData, deal: dealResult });
    } catch (err) {
        logger.error('Webhook processing error', err.response?.data || err);
        try {
            await postErrorAlert(
                `🚨 *Webhook processing error (webpage webhook)*\n` +
                `*error:* ${err?.response?.data?.message || err?.message || 'unknown'}`
            );
        } catch {}
        res.status(500).json({ error: err.message });
    }
};

// Stage IDs used specifically by the reschedule/cancel flow below.
const APPOINTMENT_SET_STAGE = "contractsent"; // "Appointment Set"
const SIGNED_STAGE = "199684762"; // "Signed" - never touched by this flow

/**
 * Handles HubSpot "meeting rescheduled/canceled" workflow webhook.
 *
 * This is intentionally isolated from `createOrUpdateDeal` (used by `webapge`)
 * because that helper's job is "create a new deal, or update the Twilio deal
 * if present" - it is NOT meant to update an arbitrary existing deal by ID.
 * Reusing it here was the root cause of reschedule/cancel events either
 * silently no-oping or creating duplicate/unassociated deals instead of
 * updating the deal the meeting actually belongs to.
 *
 * Flow:
 * 1. We know exactly which deal to update: `hs_object_id_deal` from the payload
 *    (this is the deal HubSpot fired the workflow off of).
 * 2. Before writing anything, we fetch the deal's LIVE stage from HubSpot
 *    (not the `current_dealstage` field from the payload, which can be stale -
 *    it reflects the stage at workflow enrollment time, not execution time).
 * 3. We only update dealstage + appointment_set_ time if that live stage is
 *    still "Appointment Set" (contractsent). If it's already "Signed", or if
 *    it has moved to some other stage, we skip and log why - so a late/duplicate
 *    workflow run can never overwrite a stage the team has since progressed.
 */
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
        } = req.body;

        console.log('[outcome-changed] req.body', req.body);

        if (!hs_object_id_deal) {
            logger.warn('[outcome-changed] Missing hs_object_id_deal in payload; nothing to update');
            return res.status(400).json({ message: "Missing hs_object_id_deal" });
        }

        // Live check: what stage (and appointment time) is this deal ACTUALLY in right now?
        const { dealstage: liveDealStage, appointment_set_: liveApptSetRaw } =
            await getDealStageAndAppointmentTime(hs_object_id_deal);

        if (liveDealStage === SIGNED_STAGE) {
            logger.info(`[outcome-changed] Skipping deal ${hs_object_id_deal} - live stage is "Signed" (${SIGNED_STAGE})`);
            return res.json({
                deal: { id: hs_object_id_deal, message: `Deal update skipped - stage is "${SIGNED_STAGE}" (Signed)` }
            });
        }

        if (liveDealStage !== APPOINTMENT_SET_STAGE) {
            logger.info(`[outcome-changed] Skipping deal ${hs_object_id_deal} - live stage is "${liveDealStage || 'unknown'}", expected "${APPOINTMENT_SET_STAGE}" (Appointment Set)`);
            return res.json({ message: `Appointment not set (live stage: ${liveDealStage || 'unknown'})` });
        }

        // Idempotency guard: HubSpot workflows can re-fire the same webhook action
        // more than once for the same run (retries, re-evaluation, etc). Cancel events
        // are naturally deduped above (stage moves off "contractsent" after the first
        // success), but reschedule events keep the deal in "contractsent" - so a
        // duplicate fire with the SAME meeting time must be caught explicitly here,
        // otherwise it would post to Slack and re-write HubSpot again every time.
        if (hs_meeting_outcome !== "CANCELED") {
            const newApptTimeMs = Number(hs_meeting_start_time);
            const currentApptTimeMs = liveApptSetRaw ? new Date(liveApptSetRaw).getTime() : null;
            if (newApptTimeMs && currentApptTimeMs === newApptTimeMs) {
                logger.info(`[outcome-changed] Skipping deal ${hs_object_id_deal} - duplicate webhook fire, appointment_set_ already equals ${new Date(newApptTimeMs).toISOString()}`);
                return res.json({
                    deal: { id: hs_object_id_deal, message: 'Deal update skipped - duplicate webhook, already up to date' }
                });
            }
        }

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
            dealstage = APPOINTMENT_SET_STAGE
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

        const dealProps = {
            dealstage: dealstage,
            // Only reached because we already confirmed live stage === APPOINTMENT_SET_STAGE above.
            appointment_set_: new Date(Number(hs_meeting_start_time)).toISOString(),
        };

        let dealResult;
        try {
            dealResult = await updateDealProperties(hs_object_id_deal, dealProps);
        } catch (err) {
            logger.error(`[outcome-changed] Failed to update deal ${hs_object_id_deal} (outcome=${hs_meeting_outcome || 'RESCHEDULED'})`, err?.response?.data || err?.message || err);
            await postErrorAlert(
                `🚨 *Outcome-changed: deal update failed*\n` +
                `*dealId:* ${hs_object_id_deal}\n` +
                `*outcome:* ${hs_meeting_outcome || 'RESCHEDULED'}\n` +
                `*error:* ${err?.response?.data?.message || err?.message || 'unknown'}`
            );
            return res.status(500).json({ error: err?.response?.data?.message || err?.message || 'Failed to update deal' });
        }

        // Only post to Slack AFTER a successful, non-duplicate update, so a failed
        // write or a re-fired webhook can never cause a duplicate/misleading message.
        try {
            await sendSlackMessage(msg);
        } catch (err) {
            logger.warn('[outcome-changed] Slack post failed (deal was still updated)', err?.response?.data || err?.message || err);
        }

        res.json({ deal: dealResult });
    } catch (err) {
        logger.error('[outcome-changed] Webhook processing error', err?.response?.data || err?.message || err);
        try {
            await postErrorAlert(
                `🚨 *Outcome-changed: unexpected webhook error*\n` +
                `*error:* ${err?.response?.data?.message || err?.message || 'unknown'}`
            );
        } catch {}
        res.status(500).json({ error: err.message });
    }
};