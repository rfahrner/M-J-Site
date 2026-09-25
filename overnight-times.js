// Compare operational clock entries on a shift-relative timeline. A clock
// that moves backwards after dispatch belongs to the following calendar day.
const DAY = 1440;
export function clockMinutes(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,2}):?(\d{2})(?::\d{2})?$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
export function clockAfter(value, anchor) {
  const clock = clockMinutes(value);
  if (clock == null) return null;
  if (anchor == null) return clock;
  return clock + Math.max(0, Math.ceil((anchor - clock) / DAY)) * DAY;
}
export function boardDateKey(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function offsetDate(key, days) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function shiftRelativeNow(dateKey, at = new Date()) {
  if (!dateKey || !Number.isFinite(new Date(at).getTime())) return null;
  const date = new Date(at);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date);
  const clock = Number(parts.find(p => p.type === 'hour').value) % 24 * 60 + Number(parts.find(p => p.type === 'minute').value);
  return (Date.parse(`${boardDateKey(date)}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 60000 + clock;
}
export function tripTimeline(shiftStart, trips) {
  const times = new Map();
  let previousDispatch = null;
  const start = clockMinutes(shiftStart);
  for (const trip of trips) {
    const dispatchValue = trip.dispatch_time ?? trip.dispatchTime;
    let dispatch = clockAfter(dispatchValue, previousDispatch);
    // Allow an early departure before the scheduled start; a large backwards
    // jump (23:00 shift, 00:15 dispatch) is instead an overnight dispatch.
    if (previousDispatch == null && dispatch != null && start != null && start - dispatch > 720) dispatch += DAY;
    if (dispatch != null) previousDispatch = dispatch;
    const anchor = dispatch ?? previousDispatch ?? start;
    const lastStop = clockAfter(trip.last_stop_depart ?? trip.lastStopDepart, anchor);
    const returnEta = clockAfter(trip.return_eta_to_dc ?? trip.returnEtaToDc, lastStop ?? anchor);
    const returnToDC = clockAfter(trip.return_to_dc ?? trip.returnToDC, lastStop ?? anchor);
    times.set(trip, { dispatch, lastStop, returnEta, returnToDC });
  }
  return times;
}
