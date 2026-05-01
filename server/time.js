// Date helpers that respect each user's local timezone.
// Today/tomorrow are returned as YYYY-MM-DD strings keyed off the user's IANA TZ.

function dateInTz(date, tz) {
  // 'en-CA' formats as YYYY-MM-DD by default.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(date);
}

function userToday(user) {
  return dateInTz(new Date(), user && user.timezone ? user.timezone : 'UTC');
}

function userDateOffset(user, days) {
  const d = new Date(Date.now() + days * 86400000);
  return dateInTz(d, user && user.timezone ? user.timezone : 'UTC');
}

function userTomorrow(user) {
  return userDateOffset(user, 1);
}

function isOverrideActive(user) {
  if (!user || !user.overrideActiveDate) return false;
  return user.overrideActiveDate === userToday(user);
}

// Returns true if today (in the user's timezone) is the same calendar day
// the account was created. Used to give new users a free pass on day one
// so they don't have to burn a mulligan just to enter their first task list.
function isFirstDay(user) {
  if (!user || !user.createdAt) return false;
  const tz = user.timezone || 'UTC';
  return dateInTz(new Date(user.createdAt), tz) === userToday(user);
}

module.exports = {
  dateInTz,
  userToday,
  userTomorrow,
  userDateOffset,
  isOverrideActive,
  isFirstDay,
};
