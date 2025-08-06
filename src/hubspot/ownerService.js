const axios = require('axios');
const logger = require('../utils/logger');
const { HUB_URL, headers } = require('../../config/constants');

// 🧠 Get meeting host (owner ID) from recent engagement
async function getMeetingHostId(contactId) {
  try {
    const { data } = await axios.get(
      `https://api.hubapi.com/engagements/v1/engagements/associated/contact/${contactId}/paged?limit=100`,
      {
        headers
      }
    );

    const meetings = data.results
      .filter(e => e.engagement?.type === 'MEETING')
      .sort((a, b) => b.engagement.timestamp - a.engagement.timestamp);

    const latest = meetings[0];

    if (!latest) {
      logger.warn(`No meeting engagement found for contact ${contactId}`);
      return null;
    }

    const { ownerId } = latest.engagement;
    logger.info(`Found meeting owner for contact ${contactId}: ${ownerId}`);
    return ownerId;
  } catch (error) {
    logger.error(`Error getting meeting host ID for contact ${contactId}`, error.response?.data || error.message);
    return null;
  }
}

// 🧠 Fetch CSM name (first + last) from owner ID
async function fetchCSMName(userId) {
  if (!userId) return "Unknown PM";

  try {
    const { data } = await axios.get(
      `https://api.hubapi.com/crm/v3/owners/${userId}`,
      {
        headers
      }
    );

    const fullName = `${data.firstName || ''} ${data.lastName || ''}`.trim();
    logger.info(`Resolved CSM name for user ${userId}: ${fullName}`);
    return fullName || "Unknown PM";
  } catch (error) {
    logger.error(`Failed to fetch CSM for user ${userId}`, error.response?.data || error.message);
    return "Unknown PM";
  }
}

module.exports = { getMeetingHostId, fetchCSMName };
