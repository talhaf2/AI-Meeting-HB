const axios = require('axios');
const { DateTime } = require('luxon');
const logger = require('../utils/logger');

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBSPOT_SCHEDULER_BASE = 'https://api.hubapi.com/scheduler/2026-03/meetings';

const TIMEZONE = process.env.CALENDAR_MONITOR_TIMEZONE || 'America/Los_Angeles';
const ALERT_CHANNEL = process.env.SLACK_CHANNEL_ID;

// Runs once per day at this local time (24h "HH:mm") in TIMEZONE, instead of a
// fixed interval - an interval would drift on every server restart/deploy,
// whereas this always targets the same wall-clock time regardless of restarts.
const DAILY_TIME = '08:00';

// Optional: comma-separated list of specific round-robin slugs to watch
// (e.g. "tfarooq/aec-professional,tfarooq/homeowner"). If unset, we
// auto-discover every meeting link that has more than one member - i.e.
// a real round-robin "call queue" - and watch all of them.
const SLUG_OVERRIDE = String(process.env.CALENDAR_MONITOR_SLUGS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Always tagged on a disconnect alert, in addition to the affected person.
const ALWAYS_TAG_EMAILS = [
  'angela@prostructengineering.com',
  'jeff@prostructengineering.com',
  'talha@prostructengineering.com'
];

let _sendSlackMessageToChannel = null;
let _mentionByEmail = null;
async function getMention(email) {
  if (!email) return '';
  try {
    if (!_mentionByEmail) {
      ({ mentionByEmail: _mentionByEmail } = await import('./slackService.js'));
    }
    return await _mentionByEmail(email);
  } catch {
    return '';
  }
}

async function postAlert(text, blocks) {
  if (!ALERT_CHANNEL) {
    logger.warn('[calendar-monitor] SLACK_CHANNEL_ID is not set; skipping Slack alert');
    return;
  }
  try {
    if (!_sendSlackMessageToChannel) {
      ({ sendSlackMessageToChannel: _sendSlackMessageToChannel } = await import('./slackService.js'));
    }
    await _sendSlackMessageToChannel(text, ALERT_CHANNEL, blocks);
  } catch (err) {
    logger.error('[calendar-monitor] Failed to post Slack alert', err?.response?.data || err?.message || err);
  }
}

function hubspotHeaders() {
  return { Authorization: `Bearer ${HUBSPOT_API_KEY}`, Accept: 'application/json' };
}

// Encode each path segment separately so slugs like "tfarooq/aec-professional"
// (which contain a literal "/") are sent correctly as %2F, not as an extra path segment.
function encodeSlug(slug) {
  return slug.split('/').map(encodeURIComponent).join('%2F');
}

async function fetchRoundRobinLinks() {
  if (SLUG_OVERRIDE.length) {
    return SLUG_OVERRIDE.map((slug) => ({ slug, name: slug }));
  }

  const { data } = await axios.get(`${HUBSPOT_SCHEDULER_BASE}/meeting-links`, {
    headers: hubspotHeaders()
  });

  // Only watch real round-robin queues (more than one member). Single-owner
  // links are skipped - there's no queue/fallback at risk if that one person
  // is offline.
  const results = data?.results || [];
  return results
    .filter((r) => Array.isArray(r.userIdsOfLinkMembers) && r.userIdsOfLinkMembers.length > 1)
    .map((r) => ({ slug: r.slug, name: r.name }));
}

async function fetchAvailability(slug) {
  const url = `${HUBSPOT_SCHEDULER_BASE}/meeting-links/book/availability-page/${encodeSlug(slug)}`;
  const { data } = await axios.get(url, {
    headers: hubspotHeaders(),
    params: { timezone: TIMEZONE, monthOffset: 0 }
  });
  return data?.allUsersBusyTimes || [];
}

// Last known state per (slug, userId) - kept for the /status endpoint and for
// logging reconnects, but no longer used to suppress alerts. Since this only
// runs once/day, we intentionally alert on EVERY check where someone is still
// offline, not just on the first transition - so a still-disconnected calendar
// keeps getting flagged daily until it's actually fixed.
const lastKnownOfflineState = new Map();

async function checkOnce() {
  let links = [];
  try {
    links = await fetchRoundRobinLinks();
  } catch (err) {
    logger.error('[calendar-monitor] Failed to fetch meeting links', err?.response?.data || err?.message || err);
    return;
  }

  if (!links.length) {
    logger.warn('[calendar-monitor] No round-robin meeting links found to monitor');
    return;
  }

  // Collect everyone currently offline per person across ALL queues first, so
  // a person in multiple queues gets ONE consolidated Slack message instead
  // of one per queue.
  const offlineNow = new Map(); // userId -> { name, email, queues: [{ name, slug }] }

  for (const link of links) {
    let members = [];
    try {
      members = await fetchAvailability(link.slug);
    } catch (err) {
      logger.error(`[calendar-monitor] Failed to fetch availability for "${link.slug}"`, err?.response?.data || err?.message || err);
      continue;
    }

    for (const member of members) {
      const userId = member?.meetingsUser?.userId;
      const email = member?.meetingsUser?.userProfile?.email;
      const name = member?.meetingsUser?.userProfile?.fullName;
      const isOffline = !!member?.isOffline;
      if (!userId) continue;

      const key = `${link.slug}::${userId}`;
      const wasOffline = lastKnownOfflineState.get(key) || false;

      if (isOffline) {
        logger.warn(`[calendar-monitor] ${email || userId} is OFFLINE on "${link.slug}" (${link.name})`);
        if (!offlineNow.has(userId)) offlineNow.set(userId, { name, email, queues: [] });
        offlineNow.get(userId).queues.push({ name: link.name, slug: link.slug });
      } else if (wasOffline) {
        logger.info(`[calendar-monitor] ${email || userId} back ONLINE on "${link.slug}"`);
      }

      lastKnownOfflineState.set(key, isOffline);
    }
  }

  for (const { name, email } of offlineNow.values()) {
    await sendDisconnectAlert({ name, email });
  }
}

// Builds and sends the disconnect alert for one person. Shared by the real
// checkOnce() flow and the on-demand /test-alert route, so a manual test
// exercises the exact same code path (mentions, wording, channel) as production.
async function sendDisconnectAlert({ name, email }) {
  const personMention = (await getMention(email)) || name || email || 'there';
  const otherMentions = (
    await Promise.all(ALWAYS_TAG_EMAILS.map((e) => getMention(e)))
  ).filter(Boolean);

  const tagLine = [personMention, ...otherMentions].join(' ');
  const displayName = name || 'Hi';

  const fallbackText =
    `⚠️ Calendar disconnected in HubSpot\n` +
    `${displayName}, your calendar isn't syncing with HubSpot right now.`;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${tagLine}\n` +
          `⚠️ *Calendar disconnected in HubSpot*\n` +
          `${displayName}, your calendar isn't syncing with HubSpot right now, so meetings may get booked on your queues without actually landing on your calendar.`
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*How to reconnect:*\n` +
          `1. In HubSpot, go to Settings → General → Calendar\n` +
          `2. Under Calendar sync, reconnect your calendar`
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `React with :+1: so others know it's handled.`
      }
    }
  ];

  await postAlert(fallbackText, blocks);
}

let _timeoutHandle = null;

// Computes the delay (ms) until the next occurrence of DAILY_TIME in TIMEZONE.
// If that time already passed today, targets tomorrow instead.
function msUntilNextRun() {
  const [hour, minute] = DAILY_TIME.split(':').map(Number);
  const now = DateTime.now().setZone(TIMEZONE);
  let next = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (next <= now) {
    next = next.plus({ days: 1 });
  }
  return next.diff(now).as('milliseconds');
}

function scheduleNextRun() {
  const delayMs = msUntilNextRun();
  const nextRunAt = DateTime.now().setZone(TIMEZONE).plus({ milliseconds: delayMs });
  logger.info(`[calendar-monitor] Next check scheduled for ${nextRunAt.toFormat('yyyy-MM-dd HH:mm ZZZZ')}`);

  _timeoutHandle = setTimeout(async () => {
    try {
      await checkOnce();
    } catch (err) {
      logger.error('[calendar-monitor] Scheduled check failed', err?.message || err);
    }
    scheduleNextRun(); // always reschedule, even if the check above failed
  }, delayMs);
}

function startCalendarStatusMonitor() {
  if (!HUBSPOT_API_KEY) {
    logger.warn('[calendar-monitor] HUBSPOT_API_KEY is not set; monitor not started');
    return;
  }
  if (_timeoutHandle) return; // already running

  logger.info(`[calendar-monitor] Starting - runs once daily at ${DAILY_TIME} (timezone: ${TIMEZONE})`);

  // Run once immediately on boot so we have fresh data right away, then
  // settle into the fixed daily schedule.
  checkOnce().catch((err) => logger.error('[calendar-monitor] Initial check failed', err?.message || err));

  scheduleNextRun();
}

function stopCalendarStatusMonitor() {
  if (_timeoutHandle) {
    clearTimeout(_timeoutHandle);
    _timeoutHandle = null;
  }
}

// Returns the last known state for every (slug, userId) pair we've checked -
// used by the manual /status endpoint.
function getCalendarMonitorLastKnownState() {
  return Array.from(lastKnownOfflineState.entries()).map(([key, isOffline]) => {
    const [slug, userId] = key.split('::');
    return { slug, userId, isOffline };
  });
}

module.exports = {
  startCalendarStatusMonitor,
  sendDisconnectAlert,
  stopCalendarStatusMonitor,
  getCalendarMonitorLastKnownState,
  checkOnce // exported for manual/on-demand triggering (e.g. from a route)
};
