/*
 * Browser sandbox: typing in a blank row must survive a redraw.
 *
 * From Ron's screen recording (2026-10-06): he is typing a driver name into a
 * BLANK row; 250ms later the editor is in the row ABOVE, with that row's
 * existing driver name ("Ewan") sitting in an open edit box and its own
 * suggestion list. He never clicked there.
 *
 * This is the failure CLAUDE.md already describes -- "the cursor jumping to
 * the row above after a redraw" -- in a shape the data-trip fix did not
 * cover. A redraw lands (realtime echo, the driver pool arriving, a
 * neighbouring save), captureFocusForRerender() tries to put the cursor back,
 * and it lands on the wrong row.
 *
 * Run: node sandbox/focus-jump.spec.mjs   (needs sandbox/serve.mjs running)
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
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 160)));

const fixture = boardFixture({ shifts: 12, drivers: 40 });
await page.addInitScript(({ rows }) => { window.__SANDBOX_ROWS = rows; }, { rows: fixture });
await page.route('**/supabase.min.js', (route) =>
  route.fulfill({ contentType: 'text/javascript', body: FAKE }));
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// Find a BLANK driver cell (the "Type driver name…" placeholder) that has a
// FILLED row above it -- the exact shape in the recording.
const picked = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('#board-table tbody td.pin-driver input[data-driver-ac]')];
  for (let i = 1; i < inputs.length; i++) {
    if (!inputs[i].value.trim() && inputs[i - 1].value.trim()) {
      return { index: i, myRow: inputs[i].dataset.row, rowAbove: inputs[i - 1].dataset.row,
               nameAbove: inputs[i - 1].value };
    }
  }
  return null;
});
check('found a blank row under a filled one', !!picked, picked ? `blank=${picked.myRow}, above=${picked.nameAbove}` : '');

if (picked) {
  const input = page.locator('#board-table tbody td.pin-driver input[data-driver-ac]').nth(picked.index);
  await input.click();
  await page.keyboard.type('Driv', { delay: 40 });
  await page.waitForTimeout(300);

  const whereBefore = await page.evaluate(() => ({
    row: document.activeElement?.dataset?.row,
    value: document.activeElement?.value,
  }));
  check('the cursor starts in the blank row', whereBefore.row === picked.myRow,
    `in ${whereBefore.row}, typed "${whereBefore.value}"`);

  // A redraw lands mid-edit. In production this is a coworker's save echoing
  // back, the driver pool arriving, or this row's own debounced write.
  await page.evaluate(() => {
    window.__sandboxEmit('loads_shifts', {
      eventType: 'UPDATE',
      new: { id: 1003, location: 'atlanta', shift_date: new Date().toISOString().slice(0, 10),
             pro_number: 'PRO9003-edited', driver_name_text: 'Someone Else' },
      old: { id: 1003 },
    });
  });
  await page.waitForTimeout(900);

  const whereAfter = await page.evaluate(() => ({
    row: document.activeElement?.dataset?.row,
    value: document.activeElement?.value,
    tag: document.activeElement?.tagName,
  }));

  check('the cursor is still in the SAME row after the redraw',
    whereAfter.row === picked.myRow,
    `was ${picked.myRow}, now ${whereAfter.row} (${whereAfter.tag}, value "${whereAfter.value}")`);
  check('it did not land in the row above',
    whereAfter.row !== picked.rowAbove,
    whereAfter.row === picked.rowAbove ? `jumped into "${picked.nameAbove}"` : 'ok');
  check('what was typed survived', (whereAfter.value || '').startsWith('Driv'),
    `value "${whereAfter.value}"`);

  // And the same with the pool landing, which every board does on load.
  await page.evaluate(() => document.dispatchEvent(new Event('drivers:loaded')));
  await page.waitForTimeout(700);
  const afterPool = await page.evaluate(() => ({ row: document.activeElement?.dataset?.row, value: document.activeElement?.value }));
  check('the cursor survives the driver pool landing', afterPool.row === picked.myRow,
    `now ${afterPool.row}, value "${afterPool.value}"`);
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
