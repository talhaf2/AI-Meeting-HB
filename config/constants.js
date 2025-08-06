import { HUBSPOT_API_KEY } from './env.js';

export const HUB_URL = 'https://api.hubapi.com/crm/v3/objects';

export const headers = {
  Authorization: `Bearer ${HUBSPOT_API_KEY}`,
  'Content-Type': 'application/json',
};
