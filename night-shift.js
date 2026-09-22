// Calendar dates stay local: no UTC conversion or DST-sensitive 24-hour jumps.
export function nextShiftDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(year, month - 1, day + 1, 12);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function morningShift(row, parseTime) {
  const minutes = parseTime(row.shiftStart);
  return minutes != null && minutes >= 0 && minutes <= 360;
}

export function nightShiftRows(dayRows, nextDayRows, parseTime) {
  // Keep the canonical row objects so all saves use their original dates.
  return [...dayRows, ...nextDayRows.filter(row => morningShift(row, parseTime))];
}

export function shortShiftDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : '';
}
