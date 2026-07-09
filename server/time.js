// Date helpers that respect each user's local timezone. "Today" is the
// YYYY-MM-DD calendar date in the user's TZ. No lock time, no shift —
// midnight is midnight.

function dateInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(date);
}

function userToday(user) {
  return dateInTz(new Date(), (user && user.timezone) || 'UTC');
}

function userDateOffset(user, days) {
  return dateInTz(new Date(Date.now() + days * 86_400_000), (user && user.timezone) || 'UTC');
}

function userTomorrow(user) {
  return userDateOffset(user, 1);
}

// True if today (in the user's timezone) is the same calendar day the
// account was created. Used to give new users a free pass on day one.
function isFirstDay(user) {
  if (!user || !user.createdAt) return false;
  return dateInTz(new Date(user.createdAt), user.timezone || 'UTC') === userToday(user);
}

module.exports = {
  dateInTz,
  userToday,
  userTomorrow,
  userDateOffset,
  isFirstDay,
};
