const { DateTime } = require('luxon');

exports.formatAppointmentTime = (timestampMs) => {
  const start = DateTime.fromMillis(Number(timestampMs), { zone: 'America/Los_Angeles' });
  return `${start.toFormat('h:mma')}, ${start.toFormat('cccc, LLLL d, yyyy')}`;
};
