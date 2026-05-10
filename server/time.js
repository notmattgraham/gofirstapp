// Date helpers that respect each user's local timezone AND their custom
// day-end deadline. "Today" is the YYYY-MM-DD label of the user's
// current logical day.
//
// Mental model: lockTime is the DEADLINE for finishing today's tasks.
// A day named "X" runs from the previous deadline to deadline X. The
// day's name is the calendar date of ITS deadline — i.e., whichever
// calendar day the period mostly occupies:
//
//   lockTime "23:00" (evening deadline):
//     "May 10" runs 23:00 May 9 → 22:59:59.999 May 10
//     At 9 AM May 10 → today = May 10 (deadline tonight at 23:00 May 10)
//     At 23:01 May 10 → today = May 11 (rolled; May 10's incomplete
//                        tasks now count as missed)
//
//   lockTime "03:00" (early-morning deadline; "up late"):
//     "May 10" runs 03:00 May 10 → 02:59:59.999 May 11
//     At 1 AM May 10 → today = May 9 (still finishing yesterday's day,
//                       which extends until 3 AM May 10)
//     At 4 AM May 10 → today = May 10
//
//   lockTime "00:00" (midnight; standard calendar day):
//     "May 10" runs 00:00 May 10 → 23:59:59.999 May 10
//
// Implementation: pick start-date or end-date naming based on which
// calendar day the 24h period mostly occupies. Cutoff is noon — any
// lockTime past noon is treated as "this evening" (end-date naming);
// noon-or-earlier is "tomorrow morning extension" (start-date).

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

// Returns the ms-offset to apply to "now" before reading the calendar
// date in the user's TZ. The sign of the offset chooses start-date vs
// end-date naming:
//   lockMin <= 720 (noon or earlier) → shift backwards by lockMin (the
//      day mostly sits on the start calendar date, so subtract the
//      morning extension to land on it)
//   lockMin >  720 (evening)         → shift forward by (1440 - lockMin),
//      then back 1ms (to avoid the midnight-boundary date flip), so we
//      land on the calendar date the deadline falls on
function refOffsetMs(user) {
  const lockMin = lockMinutes(user);
  if (lockMin > 720) return (1440 - lockMin) * 60_000 - 1;
  return -(lockMin * 60_000);
}

function userToday(user) {
  const tz = (user && user.timezone) || 'UTC';
  const ref = new Date(Date.now() + refOffsetMs(user));
  return dateInTz(ref, tz);
}

function userDateOffset(user, days) {
  const tz = (user && user.timezone) || 'UTC';
  const ref = new Date(Date.now() + refOffsetMs(user) + days * 86_400_000);
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
