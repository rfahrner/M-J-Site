import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('location-analytics.js', 'utf8');
const executable = source.replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '').replace(/export /g, '');
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const out = new Date(d); out.setDate(out.getDate() + n); return out; };
const escapeHtml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const elements = {
  '#sr-preview': { innerHTML: '' },
  '#sr-to': { value: 'recipient@example.com' },
  '#sr-subject': { value: 'Atlanta report' },
  '#sr-status': { textContent: '' },
};
// A stand-in for the browser clipboard. `written` captures what the report
// actually puts on it; `refuse` plays the browsers and contexts that say no.
const clipboard = { written: null, refuse: false };
class ClipboardItem {
  constructor(parts) { this.parts = parts; }
}
const window = {
  location: { href: '' },
  ClipboardItem,
  crypto: { randomUUID: () => "test-boundary" },
};
const navigator = {
  clipboard: {
    write: async (items) => {
      if (clipboard.refuse) throw new Error('clipboard blocked');
      clipboard.written = items[0].parts;
    },
  },
};
const api = new Function('dateKey', 'addDays', '$', 'escapeHtml', 'window', 'navigator', 'Blob', `${executable}; return { state: laState, setReportData, buildRecapText, buildReportText, renderRecapPreview, copyReportPreview, buildReportEmailDraft, previousReportWeek, buildReportEmailHtml };`)(dateKey, addDays, (selector) => elements[selector] || null, escapeHtml, window, navigator, Blob);
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
assert.match(text, /Weekly Recap \(2026-09-27 to 2026-09-28\)\t\t4\t380.9\t4\t8\t1.00\t\$2,050.00/);
// The owner's call (2026-10-06): the customer gets what they SPEND, right of
// Turn, and nothing else financial. Revenue under its own name, our carrier
// cost, our margin and GM% all stay internal.
assert.ok(text.includes('Spend'), 'the breakdown carries Spend');
assert.ok(!text.includes('Revenue'), 'and never the internal name for it');
for (const internal of ['Cost', 'Margin', 'GM%']) {
  assert.ok(!text.includes(internal), `${internal} is ours, not the customer's`);
}
api.renderRecapPreview();
const html = elements['#sr-preview'].innerHTML;
assert.equal((html.match(/scope="col"/g) || []).length, 8, 'Date, Day and six metrics');
assert.ok(html.includes('Spend') && html.includes('$1,250.00'), 'the preview shows Spend too');
assert.ok(!html.includes('Revenue'), 'and not under its internal name');
for (const internal of ['Cost', 'Margin', 'GM%']) {
  assert.ok(!html.includes(internal), `${internal} stays off the customer's copy`);
}
assert.equal((html.match(/scope="row"/g) || []).length, 2);
assert.ok(html.indexOf('<table') > html.indexOf('Backhauls: 1'));
assert.match(html, /border-bottom:3px solid #000/);
// Clipboard and draft carry the same HTML as the rendered preview.
await api.copyReportPreview();
const parts = clipboard.written;
assert.equal(await parts['text/html'].text(), html);
assert.equal(await parts['text/plain'].text(), text);
assert.match(elements['#sr-status'].textContent, /Ctrl\+V/);
const draft = api.buildReportEmailDraft('recipient@example.com', 'Atlanta report — test');
assert.match(draft, /X-Unsent: 1/);
assert.match(draft, /To: recipient@example.com/);
const encodedSubject = draft.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
assert.equal(Buffer.from(encodedSubject, 'base64').toString(), 'Atlanta report — test');
const bodies = [...draft.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--report-/g)]
  .map((match) => Buffer.from(match[1].replaceAll('\r\n', ''), 'base64').toString());
assert.equal(bodies[0], text);
assert.ok(bodies[1].includes(`<body>${html}</body>`));
assert.ok(!api.buildReportEmailDraft('x@example.com\r\nBcc: bad@example.com', 'x\r\nInjected: y').includes('\r\nBcc:'));
// A refused rich copy is reported without silently substituting plain text.
clipboard.written = null;
clipboard.refuse = true;
const realError = console.error;
console.error = () => {};
await api.copyReportPreview();
console.error = realError;
assert.equal(clipboard.written, null);
assert.match(elements['#sr-status'].textContent, /Allow clipboard/);
clipboard.refuse = false;
// Every day of the current week returns the same completed Sun–Sat week.
for (let day = 4; day <= 10; day++) {
  assert.deepEqual(api.previousReportWeek(new Date(2026, 9, day)), { start: '2026-09-27', end: '2026-10-03' });
}
assert.deepEqual(api.previousReportWeek(new Date(2027, 0, 1)), { start: '2026-12-20', end: '2026-12-26' });
assert.deepEqual(api.previousReportWeek(new Date(2026, 2, 8)), { start: '2026-03-01', end: '2026-03-07' });
api.state.reportRange = { start: '2026-09-30', end: '2026-10-04' };
api.setReportData({ shifts: [], trips: [], accountingRows: [] });
assert.equal(api.state.reportRows.filter((r) => r.rowType === 'day').length, 5, 'includes quiet days');
assert.ok(!api.buildReportText().includes('09/27/2026'), 'changing range replaces previous breakdown');
assert.ok(api.state.reportRows.every((r) => r.drivers === 0 && r.turn === 0));
assert.deepEqual(api.state.reportRows.filter((r) => r.rowType === 'weekRecap').map((r) => [r.rangeStart, r.rangeEnd]), [['2026-09-30', '2026-10-03'], ['2026-10-04', '2026-10-04']]);

// The reported week must remain whole across September/Q3 and October/Q4.
const example = [
  ['2026-09-27', 16, 2860.8, 31, 61],
  ['2026-09-28', 0, 0, 0, 0],
  ['2026-09-29', 26, 5923.2, 42, 92],
  ['2026-09-30', 14, 2608.3, 20, 41],
  ['2026-10-01', 1, 154.9, 2, 3],
  ['2026-10-02', 1, 626, 1, 3],
  ['2026-10-03', 13, 4129.5, 31, 61],
];
const fullWeek = { shifts: [], trips: [], accountingRows: [] };
for (const [date, drivers, mileage, routes, stops] of example) {
  for (let driver = 0; driver < drivers; driver++) fullWeek.shifts.push({ id: `${date}:${driver}`, shift_date: date, driver_id: driver });
  for (let route = 0; route < routes; route++) fullWeek.trips.push({ shift_id: `${date}:0`, route_id: `${date}:${route}`, route_miles: route ? 0 : mileage, stop_count: route ? 0 : stops });
}
api.state.reportRange = { start: '2026-09-27', end: '2026-10-03' };
api.setReportData(fullWeek);
const fullRecaps = api.state.reportRows.filter((r) => r.rowType === 'weekRecap');
assert.equal(fullRecaps.length, 1);
assert.deepEqual([fullRecaps[0].rangeStart, fullRecaps[0].rangeEnd], ['2026-09-27', '2026-10-03']);
assert.equal(api.state.reportRows.at(-1), fullRecaps[0], 'recap appears after Saturday');
assert.equal(fullRecaps[0].drivers, 71);
assert.ok(Math.abs(fullRecaps[0].mileage - 16302.7) < 0.0001);
assert.equal(fullRecaps[0].routes, 127);
assert.equal(fullRecaps[0].stops, 261);
assert.equal(fullRecaps[0].turn, 127 / 71);
assert.match(api.buildReportText(), /Weekly Recap \(2026-09-27 to 2026-10-03\)\t\t71\t16,302.7\t127\t261\t1.79/);
assert.equal((source.match(/setReportData\(rangeData\);/g) || []).length, 3, 'weekly, custom and main Generate Report paths refresh the breakdown');
console.log('Report summary, daily rows with Spend (and no other money), TONUs, partial weeks, range changes and email body passed.');
