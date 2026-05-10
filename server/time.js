// Date helpers that respect each user's local timezone AND their custom
// day-end lock time. "Today" is the YYYY-MM-DD label of the user's
// current logical day — which, when lockTime != "00:00", may differ
// from the wall-clock calendar date.
//
// Mental model: a user's day runs from `lockTime` to `lockTime` 24h
// later. So if lockTime = "06:00":
//   - 5:00 AM May 9 → still in "May 8"'s logical day (haven't crossed lock)
//   - 6:00 AM May 9 → freshly into "May 9"'s logical day
// Implementation: shift `now` backwards by lockTime minutes, then take
// the calendar date in the user's TZ. The shifted clock crosses
// midnight at exactly the user's lock moment.

function dateInTz(date, tz) {
  // 'en-CA' formats as YYYY-MM-DD by default.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(date);
}

function lockMinutes(user) {
  const raw = user && user.lockTime;
  if (!raw || typeof raw !== 'string') return 0;
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10) || 0));
  const mm = Math.max(0, Math.min(59, parseInt(m[2], 10) || 0));
  return h * 60 + mm;
}

function userToday(user) {
  const tz = (user && user.timezone) || 'UTC';
  const shift = lockMinutes(user) * 60_000;
  const ref = new Date(Date.now() - shift);
  return dateInTz(ref, tz);
}

function userDateOffset(user, days) {
  const tz = (user && user.timezone) || 'UTC';
  const shift = lockMinutes(user) * 60_000;
  const ref = new Date(Date.now() - shift + days * 86_400_000);
  return dateInTz(ref, tz);
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

// ms until the user's NEXT lockTime (i.e., the moment "today" rolls over).
// Used by the SPA to render the "You crushed today, next tasks in HH:MM:SS"
// countdown without having to recompute lockTime math client-side.
function msUntilNextLock(user) {
  const tz = (user && user.timezone) || 'UTC';
  const lockMin = lockMinutes(user); // 0..1439
  // Compute "now" in user's TZ as minutes-since-midnight + the local date.
  const now = new Date();
  // Get the user-local hours/minutes/seconds via Intl
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const localMinutes = parseInt(lookup.hour, 10) * 60 + parseInt(lookup.minute, 10);
  const localSeconds = parseInt(lookup.second, 10);
  // Difference to lock in minutes (within 24h cycle).
  let diffMin = lockMin - localMinutes;
  if (diffMin <= 0 || (diffMin === 0 && localSeconds > 0)) diffMin += 1440;
  return Math.max(0, diffMin * 60_000 - localSeconds * 1000);
}

module.exports = {
  dateInTz,
  userToday,
  userTomorrow,
  userDateOffset,
  lockMinutes,
  msUntilNextLock,
  isOverrideActive,
  isFirstDay,
};
