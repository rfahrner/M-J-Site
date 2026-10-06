/*
 * Browser sandbox: the board must hold its place when you click a cell.
 *
 * "the load board keeps moving on its own. literally I try to click on a
 * driver name and it moves up 2 spaces."
 *
 * Nothing in scripts/ can catch this. Every test there runs in jsdom, which
 * has no layout engine: scrollTop is always 0, every bounding box is zero, and
 * a page that jumps looks identical to one that does not. This runs the real
 * pages in real Chromium against a fake Supabase, so geometry means something.
 *
 * The board scrolls inside `.grid-scroll`, NOT the window -- the window barely
 * moves at all, which is why this reads as "the board moved on its own"
 * rather than "the page scrolled".
 *
 * Run: node sandbox/board-scroll.spec.mjs   (needs sandbox/serve.mjs running)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { boardFixture } from './fixtures.mjs';

const FAKE = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.SANDBOX_URL || 'http://127.0.0.1:8787';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.addInitScript(({ rows }) => { window.__SANDBOX_ROWS = rows; },
  { rows: boardFixture({ shifts: 40, drivers: 40 }) });
await page.route('**/supabase.min.js', (route) =>
  route.fulfill({ contentType: 'text/javascript', body: FAKE }));

await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const rowCount = await page.locator('#board-table tbody tr').count();
check('the board rendered rows', rowCount > 10, `${rowCount} rows`);
check('no page errors while loading', errors.length === 0, errors.slice(0, 2).join(' | '));

const scroller = page.locator('.grid-scroll');
const rowHeight = await page.evaluate(() => {
  const tr = document.querySelector('#board-table tbody tr');
  return tr ? tr.getBoundingClientRect().height : 0;
});
check('rows have real height (layout is live)', rowHeight > 5, `${Math.round(rowHeight)}px per row`);

// Scroll the board down so a jump has somewhere to show.
await scroller.evaluate((el) => { el.scrollTop = 400; });
await page.waitForTimeout(250);

const inputs = page.locator('#board-table tbody td.pin-driver input[data-driver-ac]');
const n = await inputs.count();
check('driver cells are reachable', n > 0, `${n} driver inputs`);

async function scrollTop() { return scroller.evaluate((el) => el.scrollTop); }

if (n > 0) {
  // A cell currently visible inside the scrolled viewport.
  const idx = await page.evaluate(() => {
    const sc = document.querySelector('.grid-scroll');
    const box = sc.getBoundingClientRect();
    const all = [...document.querySelectorAll('#board-table tbody td.pin-driver input[data-driver-ac]')];
    return all.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.top > box.top + 40 && r.bottom < box.bottom - 40;
    });
  });
  const target = inputs.nth(idx < 0 ? 0 : idx);

  // ---- 1. clicking ----
  const before = await scrollTop();
  const yBefore = (await target.boundingBox())?.y ?? 0;
  await target.click();
  await page.waitForTimeout(700);
  const after = await scrollTop();
  const yAfter = (await target.boundingBox())?.y ?? 0;

  const rowsMoved = rowHeight ? Math.abs(after - before) / rowHeight : 0;
  check('the board does not scroll when a driver cell is clicked',
    Math.abs(after - before) <= 2,
    `scrollTop ${Math.round(before)} -> ${Math.round(after)} (${rowsMoved.toFixed(1)} rows)`);
  check('the clicked cell stays put on screen', Math.abs(yAfter - yBefore) <= 2,
    `y ${Math.round(yBefore)} -> ${Math.round(yAfter)}`);

  // ---- 2. typing ----
  const beforeType = await scrollTop();
  await page.keyboard.type('Driver 1', { delay: 25 });
  await page.waitForTimeout(500);
  const afterType = await scrollTop();
  check('the board does not scroll while a driver name is typed',
    Math.abs(afterType - beforeType) <= 2,
    `scrollTop ${Math.round(beforeType)} -> ${Math.round(afterType)}`);

  // ---- 3. arrowing the suggestions (where scrollIntoView lives) ----
  const beforeArrow = await scrollTop();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(350);
  const afterArrow = await scrollTop();
  check('the board does not scroll when arrowing the suggestions',
    Math.abs(afterArrow - beforeArrow) <= 2,
    `scrollTop ${Math.round(beforeArrow)} -> ${Math.round(afterArrow)}`);

  // ---- 4. committing the pick ----
  const beforeEnter = await scrollTop();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const afterEnter = await scrollTop();
  check('the board does not scroll when a driver is picked',
    Math.abs(afterEnter - beforeEnter) <= 2,
    `scrollTop ${Math.round(beforeEnter)} -> ${Math.round(afterEnter)}`);
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
