/*
 * Browser sandbox: does the Text a Group modal still work, in a real browser,
 * with the pending dispatch-default change applied?
 *
 * The jsdom tests in scripts/ drive the functions directly. This loads the
 * actual driverlist.html page, opens the modal the way a dispatcher does, and
 * checks what is on screen.
 *
 * Run: node sandbox/text-group.spec.mjs   (needs sandbox/serve.mjs running)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { boardFixture } from './fixtures.mjs';

const FAKE = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.SANDBOX_URL || 'http://127.0.0.1:8787';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const fixture = boardFixture({ shifts: 10, drivers: 40 });
// one driver flagged, sharing a cell with a second unflagged profile
fixture.atlanta_drivers[0].do_not_text = true;
fixture.atlanta_drivers.push({ ...fixture.atlanta_drivers[0], id: 9999, do_not_text: false });
fixture.atlanta_drivers.forEach((d) => { d.location = 'preferred'; });

await page.addInitScript(({ rows }) => { window.__SANDBOX_ROWS = rows; }, { rows: fixture });
await page.route('**/supabase.min.js', (route) =>
  route.fulfill({ contentType: 'text/javascript', body: FAKE }));

await page.goto(`${BASE}/driverlist.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
check('the driver list page loaded without errors', errors.length === 0, errors.slice(0, 2).join(' | '));

const btn = page.locator('#btn-text-group');
check('the Text a Group button is there', await btn.count() === 1);

if (await btn.count() === 1) {
  await btn.click();
  await page.waitForTimeout(800);

  const modalVisible = await page.locator('#modal-text-group').isVisible();
  check('the modal opens', modalVisible);

  // The pending change: it must open CHECKED here.
  const dispatchChecked = await page.locator('#tg-dispatch-mode').isChecked();
  check('"Text dispatch where applicable" opens checked', dispatchChecked);

  // It must not come up with a group pre-selected.
  const pressed = await page.locator('#tg-rating-buttons [aria-pressed="true"]').count();
  check('no rating is preselected', pressed === 0, `${pressed} pressed`);

  const ratingButtons = await page.locator('#tg-rating-buttons .rate-rating-toggle').count();
  check('the rating buttons rendered', ratingButtons > 0, `${ratingButtons} buttons`);

  check('no dropdown left behind', await page.locator('#tg-rate-select').count() === 0);
  check('no error banner', !(await page.locator('#tg-error').isVisible()));

  // The modal must not resize as ratings are picked -- "we dont want it to
  // spazz out on us". Measure it, click a rating, measure again.
  const h1 = (await page.locator('#modal-text-group .modal-card, #modal-text-group').first().boundingBox())?.height ?? 0;
  await page.locator('#tg-rating-buttons .rate-rating-toggle').first().click();
  await page.waitForTimeout(600);
  const h2 = (await page.locator('#modal-text-group .modal-card, #modal-text-group').first().boundingBox())?.height ?? 0;
  check('the modal does not jump height when a rating is picked', Math.abs(h2 - h1) <= 4,
    `${Math.round(h1)}px -> ${Math.round(h2)}px`);

  check('still no page errors after interacting', errors.length === 0, errors.slice(0, 2).join(' | '));
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
