const axios = require('axios');
const { HUB_URL, headers } = require('../../config/constants');
const logger = require('../utils/logger');

let _withRetry = null;
async function withRetry(fn, retries, delayMs) {
  if (!_withRetry) {
    ({ withRetry: _withRetry } = await import('../utils/retry.js'));
  }
  return _withRetry(fn, retries, delayMs);
}

exports.getAssociatedDeals = async (contactId) => {
  try {
    const { data } = await withRetry(() =>
      axios.get(`${HUB_URL}/contacts/${contactId}/associations/deals`, { headers })
    );
    return data.results.map(r => r.id);
  } catch (err) {
    logger.error(`Failed to fetch deals for contact ${contactId}`, err.response?.data || err);
    return [];
  }
};

exports.getLatestDeal = async (dealIds = []) => {
  try {
    if (!dealIds.length) return { latestDealId: null, latestDealData: null, shouldUpdateExistingDeal: false };

    const deals = await Promise.all(
      dealIds.map(id =>
        withRetry(() => axios.get(`${HUB_URL}/deals/${id}?properties=dealname,createdate,appointment_set_`, { headers }))
      )
    );

    deals.sort((a, b) => Number(b.data.id) - Number(a.data.id));
    const latest = deals[0].data;

    const createdDate = new Date(latest.properties.createdate);
    const isRecent = createdDate > new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const hasInquiry = latest.properties.dealname?.toLowerCase().includes("inquiry");

    return {
      latestDealId: latest.id,
      latestDealData: latest.properties,
      shouldUpdateExistingDeal: hasInquiry && isRecent
    };
  } catch (err) {
    logger.error('Failed to get latest deal', err.response?.data || err);
    return { latestDealId: null, latestDealData: null, shouldUpdateExistingDeal: false };
  }
};

// Deal service: keep shouldUpdate, add Twilio-first behavior
exports.createOrUpdateDeal = async ({
  retell_appointment_source,
  twilioDealId,          // ← prefer this if present
  latestDealId,          // hs_object_id_deal (HubSpot's "latest")
  shouldUpdate,          // keep existing behavior
  email,
  dealProps,
  contactId,
}) => {
  try {
    // A) Twilio deal present → ALWAYS UPDATE it (no create paths) missed call.
    if (twilioDealId) {
      const { data } = await withRetry(() =>
        axios.patch(
          `${HUB_URL}/deals/${twilioDealId}`,
          { properties: dealProps },
          { headers }
        )
      );

      return data;
    }

    // B) No Twilio deal → respect shouldUpdate semantics on latestDealId
    // if (shouldUpdate && latestDealId) {
    //   const { data } = await axios.patch(
    //     `${HUB_URL}/deals/${latestDealId}`,
    //     { properties: dealProps },
    //     { headers }
    //   );
    //   return data;
    // }

    let dealname =  `Webpage deal - ${email || 'no-email'}`;
    if ((retell_appointment_source || retell_appointment_source === "true") && !twilioDealId) {
      logger.info(`Retell appointment source detected but no Twilio deal ID. Creating new deal for contact ${contactId}.`);
      dealname = `AI agent deal - ${email || 'no-email'}`;
    }

    // C) Neither Twilio nor updatable latest → CREATE new
    const { data } = await withRetry(() =>
      axios.post(
        `${HUB_URL}/deals`,
        {
          properties: { dealname: dealname, ...dealProps },
          associations: [
            {
              to: { id: contactId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
            }
          ]
        },
        { headers }
      )
    );
    return data;
  } catch (err) {
    logger.error('Failed to create/update deal', err?.response?.data || err);
    throw err;
  }
};

/**
 * Directly update properties on an existing, known deal ID.
 *
 * Unlike `createOrUpdateDeal`, this NEVER creates a new deal and NEVER
 * touches associations. Use this whenever you already know the exact
 * deal ID you want to update (e.g. reschedule/cancel flows), so this
 * stays fully isolated from the create/update-or-create logic above.
 */
exports.updateDealProperties = async (dealId, properties) => {
  if (!dealId) {
    throw new Error('updateDealProperties: dealId is required');
  }

  try {
    const { data } = await withRetry(() =>
      axios.patch(
        `${HUB_URL}/deals/${dealId}`,
        { properties },
        { headers }
      )
    );
    return data;
  } catch (err) {
    logger.error(
      `[updateDealProperties] Failed to update deal ${dealId}`,
      err?.response?.data || err?.message || err
    );
    throw err;
  }
};
