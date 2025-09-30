const axios = require('axios');
const { HUB_URL, headers } = require('../../config/constants');
const logger = require('../utils/logger');

exports.getAssociatedDeals = async (contactId) => {
  try {
    const { data } = await axios.get(`${HUB_URL}/contacts/${contactId}/associations/deals`, { headers });
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
        axios.get(`${HUB_URL}/deals/${id}?properties=dealname,createdate,appointment_set_`, { headers })
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
    // A) Twilio deal present → ALWAYS UPDATE it (no create paths)
    if (twilioDealId) {
      const { data } = await axios.patch(
        `${HUB_URL}/deals/${twilioDealId}`,
        { properties: dealProps },
        { headers }
      );

      return data;
    }

    // B) No Twilio deal → respect shouldUpdate semantics on latestDealId
    if (shouldUpdate && latestDealId) {
      const { data } = await axios.patch(
        `${HUB_URL}/deals/${latestDealId}`,
        { properties: dealProps },
        { headers }
      );
      return data;
    }
    let dealname =  `Webpage deal - ${email || 'no-email'}`;
    if ((retell_appointment_source || retell_appointment_source === "true") && !twilioDealId) {
      logger.info(`Retell appointment source detected but no Twilio deal ID. Creating new deal for contact ${contactId}.`);
      dealname = `AI agent deal - ${email || 'no-email'}`;
    }

    // C) Neither Twilio nor updatable latest → CREATE new
    const { data } = await axios.post(
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
    );
    return data;
  } catch (err) {
    logger.error('Failed to create/update deal', err?.response?.data || err);
    throw err;
  }
};
