const axios = require('axios');
const { HUB_URL, headers } = require('../../config/constants');
const logger = require('../utils/logger');

exports.getOrCreateContact = async ({ email, firstname, lastname, phone, role, hs_object_id }) => {
  try {
    if (hs_object_id) {
      return { contactId: hs_object_id, contactData: null, isNew: false };
    }

    const search = await axios.post(`${HUB_URL}/contacts/search`, {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['firstname', 'lastname', 'email']
    }, { headers });

    const existing = search.data.results?.[0];
    if (existing) {
      return { contactId: existing.id, contactData: existing, isNew: false };
    }

    const { data } = await axios.post(`${HUB_URL}/contacts`, {
      properties: { email, firstname, lastname, phone, project_role__sales_rep: role }
    }, { headers });

    return { contactId: data.id, contactData: data, isNew: true };
  } catch (err) {
    logger.error('Error getting or creating contact', err.response?.data || err);
    throw err;
  }
};

exports.updateContact = async (contactId, properties) => {
  try {
    await axios.patch(`${HUB_URL}/contacts/${contactId}`, { properties }, { headers });
  } catch (err) {
    logger.error(`Failed to update contact ${contactId}`, err.response?.data || err);
    throw err;
  }
};
