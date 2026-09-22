/*
 * Night Shift: show one operating night, not one calendar day.
 *
 * A night dispatcher's shift runs past midnight, so the work they are looking
 * after is split across two `shift_date` values. Night Shift keeps the day on
 * screen and adds the next morning's early starts to it, up to 06:00.
 *
 * Every board uses the same 06:00 cutoff. The boards do not agree on what the
 * start-time field is called -- the standard boards have `shiftStart`, Houston
 * has `time`, Mondelez has `startTime` -- so the field is a parameter rather
 * than three copies of this logic.
 *
 * The rows handed back are the CANONICAL row objects from each day's cache, so
 * a carried-over row still saves under its own date. Never copy them.
 */

// 06:00. The same on every board, deliberately: a dispatcher who works two of
// them should not have to remember two rules.
export const NIGHT_SHIFT_END_MINUTES = 6 * 60;

// Calendar dates stay local: no UTC conversion or DST-sensitive 24-hour jumps.
export function nextShiftDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(year, month - 1, day + 1, 12);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function morningShift(row, parseTime, field = 'shiftStart') {
  const minutes = parseTime(row[field]);
  return minutes != null && minutes >= 0 && minutes <= NIGHT_SHIFT_END_MINUTES;
}

export function nightShiftRows(dayRows, nextDayRows, parseTime, field = 'shiftStart') {
  // Keep the canonical row objects so all saves use their original dates.
  return [...dayRows, ...nextDayRows.filter(row => morningShift(row, parseTime, field))];
}

export function shortShiftDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : '';
}
