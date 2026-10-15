/*
 * Browser sandbox: every page must finish evaluating its modules.
 *
 * 2026-10-15. One realtime subscription was set up inside an init() that runs
 * while loadboard.js is STILL EVALUATING -- the two modules import each other
 * -- so reading `supabaseClient` hit its temporal dead zone:
 *
 *     Uncaught ReferenceError: Cannot access 'supabaseClient'
 *                              before initialization
 *
 * That throw aborted loadboard.js's own evaluation, so supabaseClient was
 * never initialized for ANYONE. The Atlanta board rendered no Dispatch table
 * at all and the date picker sat blank at mm/dd/yyyy. storage-compat.js then
 * threw the same error as a cascade. The whole site, from two lines.
 *
 * Nothing in scripts/ could see it: every module there is imported in
 * isolation under jsdom, which never reproduces the circular-import order
 * that a browser uses. The only honest test is to load the real pages in a
 * real browser and insist nothing throws.
 *
 * This deliberately asserts almost nothing about behaviour. It asserts the
 * page BOOTS -- the floor under every other test.
 *
 * Run: node sandbox/page-boots.spec.mjs   (needs sandbox/serve.mjs running)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { boardFixture } from './fixtures.mjs';

const FAKE = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.SANDBOX_URL || 'http://127.0.0.1:8787';
const CHROME = process.env.SANDBOX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const PAGES = [
  'index.html', 'dalaware.html', 'buildingc.html', 'houston.html',
  'mondelez.html', 'accounting.html', 'driverlist.html', 'megaboard.html',
  'location-analytics.html', 'archive.html', 'historics.html',
];

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME });
try {
  for (const page of PAGES) {
    const ctx = await browser.newContext();
    await ctx.route('**/supabase.min.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: FAKE }));
    const tab = await ctx.newPage();

    const fatal = [];
    tab.on('pageerror', (err) => fatal.push(String(err && err.message || err)));
    tab.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Only startup-fatal shapes. A failed fetch against the fake backend is
      // not what this spec is about.
      if (/before initialization|is not defined|is not a function|Failed to fetch dynamically imported/i.test(text)) fatal.push(text);
    });

    await tab.addInitScript(boardFixture ? `window.__fixture = ${JSON.stringify({})}` : '');
    await tab.goto(`${BASE}/${page}`, { waitUntil: 'load' }).catch(() => {});
    await tab.waitForTimeout(1200);

    check(`${page} boots with no fatal module error`, fatal.length === 0, fatal[0] || '');
    await ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pages booted`);
if (failed.length) {
  console.log('\nA page that does not boot shows an empty board and a blank date picker.');
  process.exit(1);
}
