/*
 * Browser sandbox: Generate Invoice, end to end on the real page.
 *
 * scripts/ pins which loads are billed and where every word lands on the
 * page. What it cannot show is whether an invoice can actually be obtained:
 * the button has to reach the dialog, the dialog has to read the week and
 * fill the PRO from Accounting, and the browser has to hand over a real .pdf
 * under the right name. The download in particular is only observable here --
 * the blob URL, the anchor click and the file name are browser behaviour, and
 * a revoke that fires too early produces a zero-byte file that every unit
 * test in the repo would call fine.
 *
 * It also checks the button follows the location tab, because an Atlanta
 * invoice generated while Delaware is on screen would bill the wrong board
 * with a document that looks entirely correct.
 *
 * Run: node sandbox/invoice-button.spec.mjs    (serves itself)
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const server = spawn(process.execPath, ['sandbox/serve.mjs', '.', '8787']);
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
};

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  // A fixed "last completed week" so the spec says the same thing whenever it
  // runs: Monday 2026-08-17 to Sunday 2026-08-23, asked on the Tuesday after.
  const WEEK = { start: '2026-08-17', end: '2026-08-23' };
  // The compat layer redirects these tables to the analytics views, so the
  // fixture is keyed on the VIEW names -- exactly what the page will ask for.
  const rows = {
    analytics_accounting_all: [
      { id: 1, location: 'atlanta', shift_date: '2026-08-17', source_shift_id: 101, total_cost: 420, total_revenue: 582.27, status: 'active', driver_name_text: 'Atiba Ward', aljex_load_number: '1958081' },
      { id: 2, location: 'atlanta', shift_date: '2026-08-17', source_shift_id: 102, total_cost: 900, total_revenue: 2296.24, status: 'active', driver_name_text: 'James Terrell', aljex_load_number: '1958082' },
      { id: 3, location: 'atlanta', shift_date: '2026-08-18', source_shift_id: 103, total_cost: 0, total_revenue: 250, status: 'active', driver_name_text: 'Marcus Smith-Mag', aljex_load_number: '1961803' },
      { id: 4, location: 'atlanta', shift_date: '2026-08-18', source_shift_id: 104, total_cost: 0, total_revenue: 0, status: 'active', driver_name_text: 'Norman Allen-Pick Up', aljex_load_number: null },
    ],
    analytics_shifts_all: [
      { id: 101, location: 'atlanta', shift_date: '2026-08-17', driver_id: 1, driver_name_text: 'Atiba Ward', tonu: false, called_off: false, load_cancelled: false },
      { id: 102, location: 'atlanta', shift_date: '2026-08-17', driver_id: 2, driver_name_text: 'James Terrell', tonu: false, called_off: false, load_cancelled: false },
      { id: 103, location: 'atlanta', shift_date: '2026-08-18', driver_id: 3, driver_name_text: 'Marcus Smith-Mag', tonu: true, called_off: false, load_cancelled: false },
      { id: 104, location: 'atlanta', shift_date: '2026-08-18', driver_id: 4, driver_name_text: 'Norman Allen-Pick Up', tonu: false, called_off: false, load_cancelled: false },
    ],
    analytics_trips_all: [
      { id: 11, shift_id: 101, route_id: 'PA1', trip_id: '1274441', trip_number: 1 },
      { id: 12, shift_id: 102, route_id: 'PA2', trip_id: '1274950', trip_number: 2 },
      { id: 13, shift_id: 102, route_id: 'PA3', trip_id: '1274895', trip_number: 1 },
    ],
    location_analytics_daily_notes: [],
    user_roles: [{ user_id: 'sandbox-user', role: 'admin' }],
  };
  await page.addInitScript((r) => { window.__SANDBOX_ROWS = r; }, rows);

  let fake = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
  fake = fake.replaceAll("email: 'sandbox@dltransport.com'", "email: 'sandbox@dltransport.com', user_metadata: { role: 'admin' }");
  fake = fake.replace('rpc: async () => ({ data: null, error: null }),',
    "rpc: async (name) => ({ data: name === 'current_app_role' ? 'admin' : null, error: null }),");
  await page.route('**/supabase.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fake }));

  await page.goto('http://127.0.0.1:8787/location-analytics.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  check('Location Analytics loaded with no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  const button = page.locator('#btn-generate-invoice');
  check('the Generate Invoice button is on the page', await button.count() === 1);
  check('and it is visible on Atlanta', await button.isVisible());

  // It must not offer an Atlanta invoice while another board is on screen.
  await page.locator('#la-location-tabs [data-la-tab="delaware"]').click();
  await page.waitForTimeout(800);
  check('it hides on Delaware, which has no invoice format', !(await button.isVisible()));
  await page.locator('#la-location-tabs [data-la-tab="atlanta"]').click();
  await page.waitForTimeout(800);
  check('and comes back on Atlanta', await button.isVisible());

  await button.click();
  await page.waitForTimeout(1200);
  check('the dialog opens', await page.locator('#modal-invoice').isVisible());

  /*
   * The CARD, not just the overlay.
   *
   * This check started life as the isVisible() above and nothing else, which
   * passed while the dialog was unusable: the markup used .modal-card,
   * .modal-head and .modal-foot, none of which exist in loadboard.css. The
   * overlay still showed -- it has its own background and centres its child --
   * so the assertion was green while the box inside it had no width, no
   * background and no padding. Reported as "button is there but nothing
   * happens when i click it".
   *
   * An invented class name is invisible to a DOM assertion, so this asks the
   * browser what it actually computed: a real width, and a background that is
   * not transparent.
   */
  const card = await page.evaluate(() => {
    const el = document.querySelector('#modal-invoice > div');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { cls: el.className, width: Math.round(rect.width), height: Math.round(rect.height), bg: style.backgroundColor };
  });
  check('the dialog card has a real width', card && card.width >= 300, JSON.stringify(card));
  check('and a solid background, so it is styled by loadboard.css',
    card && card.bg !== 'rgba(0, 0, 0, 0)' && card.bg !== 'transparent', card?.bg);
  // Every class the dialog uses has to exist in the stylesheet it relies on.
  const css = readFileSync(new URL('../loadboard.css', import.meta.url), 'utf8');
  const onPage = await page.evaluate(() => [...document.querySelectorAll('#modal-invoice, #modal-invoice *')]
    .flatMap((el) => [...el.classList]));
  const used = [...new Set(onPage)];
  const missing = used.filter((c) => !new RegExp(`\\.${c}[\\s,{:.]`).test(css));
  check('no invented class names', missing.length === 0, missing.join(', '));

  // The dialog defaults to the last completed Monday-Sunday week.
  const startValue = await page.locator('#inv-start').inputValue();
  const endValue = await page.locator('#inv-end').inputValue();
  const startDay = new Date(`${startValue}T00:00:00Z`).getUTCDay();
  const endDay = new Date(`${endValue}T00:00:00Z`).getUTCDay();
  check('it defaults to a Monday-Sunday week', startDay === 1 && endDay === 0, `${startValue} (${startDay}) .. ${endValue} (${endDay})`);

  // Ask for the week the fixture covers.
  await page.locator('#inv-start').fill(WEEK.start);
  await page.locator('#inv-start').dispatchEvent('change');
  await page.waitForTimeout(1200);
  check('picking a Monday fills the Sunday', await page.locator('#inv-end').inputValue() === WEEK.end,
    await page.locator('#inv-end').inputValue());

  const pro = await page.locator('#inv-pro').inputValue();
  check('the PRO # is pulled from the Accounting Aljex #', pro === '1958081', pro);

  const note = (await page.locator('#inv-week-note').textContent()) || '';
  // 3 billable lines: the $0.00 row is not one of them, and $0.00 is not billed.
  check('it reports what it will bill, with the $0.00 load excluded',
    /2 operating days/.test(note) && /3 driver lines/.test(note) && /3128\.51/.test(note), note.trim());

  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#inv-build').click();
  const download = await downloadPromise;
  check('the file is named the way the approved one is',
    download.suggestedFilename() === '8-17-26_to_8-23-26_Kroger_Invoice.pdf', download.suggestedFilename());

  const saved = join(tmpdir(), `invoice-spec-${Date.now()}.pdf`);
  await download.saveAs(saved);
  const bytes = readFileSync(saved);
  check('it is a real PDF with content', bytes.length > 10000 && bytes.subarray(0, 8).toString() === '%PDF-1.4', `${bytes.length} bytes`);
  const asText = bytes.toString('latin1');
  check('a cover and one page per operating day', (asText.match(/\/Type \/Page[^s]/g) || []).length, 3);
  check('the PRO is on it', asText.includes('(PRO # 1958081)'));
  check('the total is the billable one', asText.includes('3,128.51'));
  check('the $0.00 driver is not on it', !asText.includes('Norman'));
  check('the TONU prints as TONU', asText.includes('(TONU)'));
  check('the dialog closed after generating', !(await page.locator('#modal-invoice').isVisible()));

  check('still no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
