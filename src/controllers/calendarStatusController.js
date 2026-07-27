const {
  getCalendarMonitorLastKnownState,
  checkOnce,
  sendDisconnectAlert
} = require('../services/roundRobinCalendarMonitor');

// Returns the last known offline/online state for every round-robin member
// we've checked so far (populated by the background poller).
exports.status = (req, res) => {
  res.json({ members: getCalendarMonitorLastKnownState() });
};

// Triggers an immediate on-demand check (useful for testing / manual refresh)
// instead of waiting for the next scheduled poll.
exports.checkNow = async (req, res) => {
  try {
    await checkOnce();
    res.json({ ok: true, members: getCalendarMonitorLastKnownState() });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to run check' });
  }
};

// Fires a real disconnect alert to Slack using the exact same code path as
// production, without needing an actual HubSpot calendar disconnection.
// Body: { name?: string, email: string }
exports.testAlert = async (req, res) => {
  const { name, email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }
  try {
    await sendDisconnectAlert({ name, email });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to send test alert' });
  }
};
