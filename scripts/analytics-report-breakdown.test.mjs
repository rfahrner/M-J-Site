import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('location-analytics.js', 'utf8');
const executable = source.replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '').replace(/export /g, '');
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const out = new Date(d); out.setDate(out.getDate() + n); return out; };
const escapeHtml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const elements = { '#sr-preview': { innerHTML: '' }, '#sr-to': { value: 'recipient@example.com' }, '#sr-subject': { value: 'Atlanta report' } };
const window = { location: { href: '' } };
const api = new Function('dateKey', 'addDays', '$', 'escapeHtml', 'window', `${executable}; return { state: laState, setReportData, buildRecapText, buildReportText, renderRecapPreview, openReportInEmail };`)(dateKey, addDays, (selector) => elements[selector] || null, escapeHtml, window);
const shifts = [
  { id: 1, shift_date: '2026-09-26', driver_id: 1 },
  { id: 2, shift_date: '2026-09-27', driver_id: 1 },
  { id: 3, shift_date: '2026-09-27', driver_id: 1 }, // same driver/day
  { id: 4, shift_date: '2026-09-27', driver_id: 2, tonu: true, called_off: true },
  { id: 5, shift_date: '2026-09-28', driver_id: 1 },
  { id: 6, shift_date: '2026-09-28', driver_id: 3 },
  { id: 7, shift_date: '2026-09-28', driver_id: 4, load_cancelled: true },
];
const trips = [
  { shift_id: 1, route_id: 'A', route_miles: 120, stop_count: 2 },
  { shift_id: 2, trip_id: 'B', route_miles: 140.9, stop_count: 3, salvage: true },
  { shift_id: 3, route_id: 'C', route_miles: 60, stop_count: 1, backhaul: true },
  { shift_id: 5, route_id: 'D', route_miles: 100, stop_count: 2 },
  { shift_id: 6, route_id: 'E', route_miles: 80, stop_count: 2 },
  { shift_id: 6, route_id: '', trip_id: '', route_miles: 999, stop_count: 999 },
];
const accountingRows = [
  { shift_date: '2026-09-26', total_revenue: 500.25, total_cost: 325 },
  { shift_date: '2026-09-27', total_revenue: 1000, total_cost: 700 },
  { shift_date: '2026-09-27', total_revenue: 250, total_cost: 150 },
  { shift_date: '2026-09-28', total_revenue: 800, total_cost: 600 },
];
const data = { shifts, trips, accountingRows };
api.state.reportRange = { start: '2026-09-26', end: '2026-09-28' };
api.state.recap = { drivers: 999 }; // sheet totals must not be replaced
api.setReportData(data);
assert.equal(api.state.recap.drivers, 999);
assert.equal(api.state.reportRecap.drivers, 5);
assert.equal(api.state.reportRecap.mileage, 500.9);
assert.equal(api.state.reportRecap.revenue, 2550.25);
const daily = api.state.reportRows.filter((r) => r.rowType === 'day');
const weeks = api.state.reportRows.filter((r) => r.rowType === 'weekRecap');
assert.deepEqual(daily.map((r) => r.drivers), [1, 2, 2]);
assert.deepEqual(weeks.map((r) => [r.rangeStart, r.rangeEnd]), [['2026-09-26', '2026-09-26'], ['2026-09-27', '2026-09-28']]);
for (const key of ['drivers', 'mileage', 'routes', 'stops', 'revenue']) {
  assert.equal(weeks.reduce((total, r) => total + r[key], 0), api.state.reportRecap[key], key);
}
assert.equal(weeks[1].turn, 1, 'weekly turn uses totals');
const summary = api.buildRecapText();
assert.match(summary, /Drivers: 5/);
assert.match(summary, /Salvage: 1\nBackhauls: 1$/);
assert.ok(!summary.includes('Revenue:'), 'existing default summary is preserved');
const text = api.buildReportText();
assert.ok(text.startsWith(`${summary}\n\nDaily Breakdown\n`));
assert.match(text, /09\/27\/2026\tSUNDAY\t2\t200.9\t2\t4\t1.00\t\$1,250.00/);
assert.match(text, /Weekly Recap \(2026-09-27 to 2026-09-28\).*\$2,050.00/);
api.renderRecapPreview();
const html = elements['#sr-preview'].innerHTML;
assert.equal((html.match(/scope="col"/g) || []).length, 8);
assert.equal((html.match(/scope="row"/g) || []).length, 2);
assert.ok(html.indexOf('<table') > html.indexOf('Backhauls: 1'));
assert.match(html, /border-bottom:3px solid #000/);
api.openReportInEmail();
const url = new URL(window.location.href);
assert.equal(url.searchParams.get('body'), text, 'email includes the same daily figures and recaps');
api.state.reportRange = { start: '2026-09-30', end: '2026-10-04' };
api.setReportData({ shifts: [], trips: [], accountingRows: [] });
assert.equal(api.state.reportRows.filter((r) => r.rowType === 'day').length, 5, 'includes quiet days');
assert.ok(!api.buildReportText().includes('09/27/2026'), 'changing range replaces previous breakdown');
assert.ok(api.state.reportRows.every((r) => r.drivers === 0 && r.turn === 0));
assert.deepEqual(api.state.reportRows.filter((r) => r.rowType === 'weekRecap').map((r) => [r.rangeStart, r.rangeEnd]), [['2026-09-30', '2026-09-30'], ['2026-10-01', '2026-10-03'], ['2026-10-04', '2026-10-04']]);
assert.equal((source.match(/setReportData\(rangeData\);/g) || []).length, 3, 'weekly, custom and main Generate Report paths refresh the breakdown');
console.log('Report summary, daily rows, accounting revenue, TONUs, partial weeks, range changes and email body passed.');
