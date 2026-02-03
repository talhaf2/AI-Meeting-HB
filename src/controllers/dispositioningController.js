const axios = require('axios');
const { HUB_URL, headers } = require('../../config/constants');
const { fetchCSMName } = require('../hubspot/ownerService');

let _withRetry = null;
async function withRetry(fn, retries, delayMs) {
  if (!_withRetry) {
    // `src/utils/retry.js` is ESM; load it lazily from this CJS module.
    ({ withRetry: _withRetry } = await import('../utils/retry.js'));
  }
  return _withRetry(fn, retries, delayMs);
}

function parseToMs(value) {
  if (value === undefined || value === null || value === '') return null;

  // HubSpot date properties often come back as epoch-ms strings.
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;

  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * GET /api/dispositioning/stale-appointment-set-deals
 *
 * Returns deals that are still in "Appointment Set" stage (currently `contractsent`)
 * and whose `appointment_set_` time is at least `thresholdMinutes` in the past.
 *
 * Query params:
 * - thresholdMinutes (default 60)
 * - stage (default "contractsent")
 * - pipeline (default "default")
 * - maxPages (default 10)  // HubSpot search pagination safety cap
 * - pageSize (default 100) // HubSpot max is 100
 */
exports.getStaleAppointmentSetDeals = async (req, res) => {
  try {
    const thresholdMinutesRaw = req.query.thresholdMinutes;
    const thresholdMinutes = Math.max(1, Number(thresholdMinutesRaw ?? 60) || 60);

    const stage = String(req.query.stage || 'contractsent').trim();
    const pipeline = String(req.query.pipeline || 'default').trim();

    const maxPages = Math.max(1, Math.min(50, Number(req.query.maxPages ?? 10) || 10));
    const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize ?? 100) || 100));

    const nowMs = Date.now();
    const cutoffMs = nowMs - thresholdMinutes * 60 * 1000;

    const deals = [];
    let after = undefined;

    for (let page = 0; page < maxPages; page++) {
      const { data } = await withRetry(() =>
        axios.post(
          `${HUB_URL}/deals/search`,
          {
            filterGroups: [
              {
                filters: [
                  { propertyName: 'pipeline', operator: 'EQ', value: pipeline },
                  { propertyName: 'dealstage', operator: 'EQ', value: stage },
                  { propertyName: 'appointment_set_', operator: 'HAS_PROPERTY' }
                ]
              }
            ],
            properties: [
              'dealname',
              'dealstage',
              'pipeline',
              'appointment_set_',
              'customer_success_manager',
              'hs_lastmodifieddate',
              'createdate'
            ],
            limit: pageSize,
            ...(after ? { after } : {})
          },
          { headers }
        )
      );

      const results = data?.results || [];
      for (const d of results) {
        const apptMs = parseToMs(d?.properties?.appointment_set_);
        if (!apptMs) continue;
        if (apptMs <= cutoffMs) {
          const minutesPastDue = Math.floor((nowMs - apptMs) / (60 * 1000));
          deals.push({
            id: d.id,
            properties: d.properties || {},
            appointment_set_ms: apptMs,
            minutesPastDue
          });
        }
      }

      after = data?.paging?.next?.after;
      if (!after) break;
    }

    // Resolve customer_success_manager (ownerId) -> owner name for response readability
    // (HubSpot stores this as an ID; we keep the ID in `customer_success_manager_id` too.)
    const ownerIds = [
      ...new Set(
        deals
          .map(d => d?.properties?.customer_success_manager)
          .filter(Boolean)
          .map(v => String(v).trim())
          .filter(Boolean)
      )
    ];

    const ownerNameById = new Map();
    for (const ownerId of ownerIds) {
      const name = await fetchCSMName(ownerId);
      ownerNameById.set(ownerId, name || 'Unknown PM');
    }

    for (const d of deals) {
      const ownerId = d?.properties?.customer_success_manager;
      if (!ownerId) continue;
      const key = String(ownerId).trim();
      if (!key) continue;

      // preserve original id, but return name in the "customer_success_manager" field
      d.properties.customer_success_manager_id = key;
      d.properties.customer_success_manager = ownerNameById.get(key) || 'Unknown PM';
    }

    // sort most overdue first
    deals.sort((a, b) => (b.minutesPastDue || 0) - (a.minutesPastDue || 0));

    return res.json({
      generatedAt: new Date(nowMs).toISOString(),
      criteria: {
        pipeline,
        stage,
        thresholdMinutes
      },
      count: deals.length,
      deals
    });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message
    });
  }
};

