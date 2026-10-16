/*
 * Browser sandbox: the Delaware BOL request, end to end on the real page.
 *
 * scripts/delaware-bol-alert.test.mjs pins WHO is eligible and WHEN. That is
 * arithmetic and jsdom is fine for it. What jsdom cannot tell you is whether
 * a dispatcher can actually send the thing: the alert has to survive
 * alerts.js's own redraw of the widget it lives in, the click has to beat the
 * widget's jump-to-row handler, the modal has to come up prefilled with every
 * driver on shift, and the column behind it has to be written when the text
 * goes out. Each of those is a different file; only a browser runs all four.
 *
 * The one that bit us before is the third-and-a-half: an alert whose Text
 * button also triggers the row jump, so the board scrolls away underneath the
 * modal. stopImmediatePropagation() is what prevents it and nothing in
 * scripts/ exercises it.
 *
 * Run: node sandbox/serve.mjs . 8787 &
 *      node sandbox/delaware-bol-alert.spec.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const FAKE = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.SANDBOX_URL || 'http://127.0.0.1:8787';
const CHROME = process.env.SANDBOX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LATENCY = Number(process.env.SANDBOX_LATENCY_MS || 120);

const MESSAGE = 'Please send a photo of your BOL(s)-with the Route number it is for this shift (e.g.: 1st Route, 2nd route, 3rd Load) to this text thread OR text it in, also confirm how many stops, and total miles for the route w/ photo of each BOL.';

/*
 * Fixture times are offsets from the CURRENT New York clock, and an offset
 * that crosses midnight moves the shift's DATE with it.
 *
 * The first version wrapped the hour mod 24 and left every row dated today,
 * so run at 00:30 ET a "two hours ago" shift became 22:00 of the same date --
 * which the board correctly reads as not yet started. The whole spec failed
 * between midnight and 02:00 ET, and failed looking exactly like a product
 * bug in the night-dispatch window this feature was built for.
 *
 * Carrying the date across midnight also means that in the small hours this
 * spec exercises the yesterday-carryover path for real rather than by
 * construction.
 */
const now = new Date();
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
const nyMinutes = (Number(nyParts.find((p) => p.type === 'hour').value) % 24) * 60
  + Number(nyParts.find((p) => p.type === 'minute').value);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const dayShift = (key, days) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// `offset` is minutes from now: negative started, positive still to come.
function at(offset, { colon = false } = {}) {
  const raw = nyMinutes + offset;
  const days = Math.floor(raw / 1440);
  const mins = ((raw % 1440) + 1440) % 1440;
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return { date: dayShift(today, days), start: colon ? `${h}:${m}` : `${h}${m}` };
}

// Two drivers whose shift has started -- one stored bare, one with a colon,
// because that is how Delaware actually stores them and the pair is the
// regression that blanked whole days.
const STARTED = [
  { id: 8101, name: 'Marcus Webb', phone: '3025551001', ...at(-120) },
  { id: 8102, name: 'Dana Ruiz', phone: '3025551002', ...at(-60, { colon: true }) },
];
const NOT_STARTED = { id: 8103, name: 'Later Start', phone: '3025551003', ...at(240) };

const shiftRow = (s) => ({
  id: s.id, location: 'delaware', shift_date: s.date, shift_start: s.start,
  driver_id: null, driver_name_text: s.name, driver_cell_snapshot: s.phone,
  pro_number: `PRO${s.id}`, shift_complete: false, tonu: false, called_off: false,
  load_cancelled: false, bol_text_sent_at: null, pre_shift_text_sent_at: null,
});

const ROWS = {
  loads_shifts: [...STARTED.map(shiftRow), shiftRow(NOT_STARTED)],
  loads_trips: [], trip_stops: [], atlanta_drivers: [],
  location_notes: [], board_rate_tiers: [], loads_accounting: [],
};

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.route('**/supabase.min.js', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
// The real send path, answered. Without this the fetch fails, the modal falls
// back to its Outlook draft controls, and the spec would be testing the
// fallback rather than the send -- and onSent (which writes the column) is
// reached by both, so a green fallback would hide a broken send.
await ctx.route('**/functions/v1/send-text', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sent: 2 }) }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.addInitScript(([rows, ms]) => {
  window.__SANDBOX_ROWS = rows;
  window.__SANDBOX_LATENCY_MS = ms;
}, [ROWS, LATENCY]);

await page.goto(`${BASE}/dalaware.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

check('the Delaware board loaded with no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

// The widget starts collapsed; the alert is in the body either way.
const bol = page.locator('.dispatch-extra-alert', { hasText: 'BOL photos' });
await bol.first().waitFor({ timeout: 8000 }).catch(() => {});
check('the BOL alert is on the board', await bol.count() === 1, `${await bol.count()} found`);

const text = (await bol.first().textContent().catch(() => '')) || '';
check('both drivers whose shift has started are named', /Marcus Webb/.test(text) && /Dana Ruiz/.test(text), text.trim().slice(0, 140));
check('the bare-digit and colon formats are treated the same', /2 drivers on shift/.test(text), text.trim().slice(0, 140));
check('a shift that has not started yet is left out', !/Later Start/.test(text));

// The redraw. alerts.js wipes this body on its own scan; the ask must not
// blink out with it.
await page.evaluate(() => {
  const body = document.getElementById('alert-widget-body');
  if (body) body.innerHTML = '<div class="alert-empty">Nothing needs attention right now.</div>';
});
await page.waitForTimeout(400);
check('it survives an alerts.js redraw of the widget', await page.locator('.dispatch-extra-alert', { hasText: 'BOL photos' }).count() === 1);

// Open the widget and send it, the way a dispatcher does.
await page.evaluate(() => document.getElementById('alert-widget')?.classList.add('expanded'));
const scrollBefore = await page.evaluate(() => document.querySelector('.grid-scroll')?.scrollTop ?? 0);
await page.locator('[data-delaware-bol-shifts]').first().click();
await page.waitForTimeout(1200);

const modal = page.locator('#modal-send-text');
check('the send-text modal opens', await modal.isVisible().catch(() => false));

const prefilled = await page.locator('#send-text-message').inputValue().catch(() => '');
check('the message is the exact wording, unaltered', prefilled === MESSAGE,
  prefilled === MESSAGE ? '' : `got ${JSON.stringify(prefilled.slice(0, 80))}…`);

const to = (await page.locator('#send-text-phone-display').textContent().catch(() => '')) || '';
check('both drivers are addressed in one text', /Marcus Webb/.test(to) && /Dana Ruiz/.test(to), to.trim());
// The fake answers from() without honouring the WHERE, so the handler's
// re-read by id comes back with every Delaware row and the recipient list here
// cannot prove who was excluded. What this page CAN prove is the id list the
// alert handed the button; the WHERE itself is pinned in
// scripts/delaware-bol-alert.test.mjs, which records the filters.
const buttonIds = await page.locator('[data-delaware-bol-shifts]').first().getAttribute('data-delaware-bol-shifts');
check('the Text button carries only the two shifts that have started',
  buttonIds === `${STARTED[0].id},${STARTED[1].id}`, String(buttonIds));

const scrollAfter = await page.evaluate(() => document.querySelector('.grid-scroll')?.scrollTop ?? 0);
check('clicking Text did not also jump the board underneath the modal', Math.abs(scrollAfter - scrollBefore) <= 2,
  `${scrollBefore} -> ${scrollAfter}`);

// Nothing may be marked sent while the modal is merely open.
const earlyWrites = await page.evaluate(() => window.__sandboxWrites('loads_shifts').filter((w) => w.op === 'update' && w.values && 'bol_text_sent_at' in w.values).length);
check('nothing is marked sent just for opening the modal', earlyWrites === 0, `${earlyWrites} writes`);

// Send it. The Outlook-draft path ends in the same finishSendTextModalAsSent()
// as the automatic send, which is what fires onSent.
await page.locator('#send-text-submit').click();
await page.waitForTimeout(1500);
// These are the ids textDraftControlsHtml('send-text-draft') actually emits.
// This check was written against '#send-text-draft-outlook', which exists
// nowhere in the app, so it was vacuously true -- the spec would have gone
// green with the gateway send broken and the Outlook fallback firing instead,
// which is the one thing its own comment above says it exists to catch.
check('the send reported success rather than falling back to an email draft',
  await page.locator('#send-text-draft-open-web, #send-text-draft-open').count() === 0);
const writes = await page.evaluate(() => window.__sandboxWrites('loads_shifts').filter((w) => w.op === 'update' && w.values && 'bol_text_sent_at' in w.values));
check('sending writes bol_text_sent_at', writes.length >= 1, `${writes.length} writes`);
check('and it does not touch the ETA reminder\'s column', !writes.some((w) => 'pre_shift_text_sent' in w.values || 'pre_shift_text_sent_at' in w.values));

check('no page errors through the whole flow', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
