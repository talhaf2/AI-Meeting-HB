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

exports.createOrUpdateDeal = async ({ shouldUpdate, latestDealId, email, dealProps, contactId }) => {
  try {
    if (shouldUpdate && latestDealId) {
      const { data } = await axios.patch(`${HUB_URL}/deals/${latestDealId}`, { properties: dealProps }, { headers });
      return data;
    }

    const { data } = await axios.post(`${HUB_URL}/deals`, {
      properties: { dealname: `Webpage deal - ${email}`, ...dealProps },
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
      }]
    }, { headers });

    return data;
  } catch (err) {
    logger.error('Failed to create/update deal', err.response?.data || err);
    throw err;
  }
};
