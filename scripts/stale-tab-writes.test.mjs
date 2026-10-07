/*
 * Regression test: a tab left open across a deploy stops writing.
 *
 * Dispatchers leave the board up overnight, so after a deploy the site runs in
 * two versions at once on the same data. On 2026-09-22 an old tab and a new
 * one disagreed about a load's rate and wrote their two answers at each other
 * about twice a second for an hour -- 9,443 rows of carrier_rate churn -- and
 * the tab doing the damage is by definition the one nobody is sitting at, so
 * "everyone refresh" is not a control.
 *
 * The stale tab has to remove itself: stop calculated writes, say so, and
 * reload itself if nobody is using it. What it must NOT do is interrupt
 * someone mid-shift -- manual saves keep working and an in-use tab is never
 * reloaded out from under them.
 *
 * Run: npm i --no-save jsdom && node scripts/stale-tab-writes.test.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// No package.json, so a bare .js is CommonJS to node; copy both out as .mjs.
const dir = mkdtempSync(join(tmpdir(), 'mj-stale-'));
writeFileSync(join(dir, 'rate-write-limiter.mjs'), read('rate-write-limiter.js'));
writeFileSync(join(dir, 'long-task-guard.mjs'), read('long-task-guard.js'));
// The watcher now asks whether the tab is busy before reloading it. Copied out
// alongside, because a leaf it imports has to resolve from the same tmpdir.
const asWatcher = (name) => writeFileSync(join(dir, name), read('site-version-watch.js')
  .replace("'./rate-write-limiter.js'", "'./rate-write-limiter.mjs'")
  .replace("'./long-task-guard.js'", "'./long-task-guard.mjs'"));
asWatcher('site-version-watch.mjs');

const dom = new JSDOM(`<!doctype html><body>
  <div class="overlay hidden" id="modal-load-details"></div>
  <input id="a-cell">
</body>`, { url: 'https://rfahrner.github.io/M-J-Site/' });
const { window } = dom;
global.document = window.document;

// jsdom's window.location cannot be redefined, and its reload() is a stub that
// throws. The module only reaches for window.location.reload, so the global it
// resolves is a plain object -- which also makes the reload observable.
let reloads = 0;
global.window = { location: { reload: () => { reloads += 1; } } };

let etag = '"v1"';
let headRequests = 0;
global.fetch = async (url, opts) => {
  headRequests += 1;
  check.lastUrl = String(url);
  check.lastOpts = opts;
  return { ok: true, headers: new dom.window.Headers({ etag }) };
};

const quiet = console.warn;
console.warn = () => {};
const limiter = await import(join(dir, 'rate-write-limiter.mjs'));
const watcher = await import(join(dir, 'site-version-watch.mjs'));
await new Promise((r) => setTimeout(r, 10)); // its own bootstrap runs on import
console.warn = quiet;

// ---------------------------------------------------------------------------
console.log('\n1. it watches the right thing, uncached');
check('it asks about loadboard.js', /loadboard\.js$/.test(check.lastUrl || ''), true);
check('with HEAD, so it is cheap', check.lastOpts?.method, 'HEAD');
check('bypassing the cache, or it would never see a change', check.lastOpts?.cache, 'no-store');
check('it recorded the version it is running', watcher.__state().deployedVersion, '"v1"');

console.log('\n2. an unchanged deploy changes nothing');
console.warn = () => {}; await watcher.checkForNewDeploy(); console.warn = quiet;
check('not stale', watcher.__state().stale, false);
check('writes still allowed', limiter.allowRateWrite(16141), true);
check('no banner', !!window.document.getElementById('site-version-stale-banner'), false);
check('and it did not reload', reloads, 0);

// ---------------------------------------------------------------------------
console.log('\n3. a deploy lands while a dispatcher is typing');
// Focused input, active seconds ago: this tab is in use and must be left alone.
window.document.getElementById('a-cell').focus();
window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true }));
etag = '"v2"';
console.warn = () => {}; await watcher.checkForNewDeploy(); console.warn = quiet;

check('the tab knows it is stale', watcher.__state().stale, true);
check('it did NOT reload under them', reloads, 0);
check('it says so, with a way out', !!window.document.getElementById('site-version-stale-banner'), true);
check('the banner offers a reload',
  window.document.querySelector('#site-version-stale-banner button')?.textContent, 'Reload now');

console.log('\n4. and it stops arguing about rates');
check('calculated writes are refused', limiter.allowRateWrite(16141), false);
check('for every load, not just the noisy one', limiter.allowRateWrite(16133), false);
check('and it reports why', typeof limiter.automaticWritesBlocked(), 'string');
// The whole point of blocking only the automatic path: someone mid-shift keeps
// working. A typed rate does not come through the limiter at all.
const BOARD = read('loadboard.js');
check('a typed rate saves without asking the limiter',
  /commitRateOverride[\s\S]{0,700}await saveShiftNow\(row\)/.test(BOARD), true);
check('only recomputeRowRate is gated', (BOARD.match(/allowRateWrite\(/g) || []).length, 1);

// ---------------------------------------------------------------------------
console.log('\n5. the tab nobody is sitting at reloads itself');
// A fresh module, so the reload decision is made from a clean state.
const dom2 = new JSDOM('<!doctype html><body></body>', { url: 'https://rfahrner.github.io/M-J-Site/' });
// The overnight tab: minimised, or on a laptop that was closed.
Object.defineProperty(dom2.window.document, 'visibilityState', { value: 'hidden', configurable: true });
global.document = dom2.window.document;
let reloads2 = 0;
global.window = { location: { reload: () => { reloads2 += 1; } } };
etag = '"v1"';
asWatcher('watch2.mjs');
console.warn = () => {};
const watcher2 = await import(join(dir, 'watch2.mjs'));
await new Promise((r) => setTimeout(r, 10));
etag = '"v2"';
await watcher2.checkForNewDeploy();
console.warn = quiet;
check('a hidden tab picks the update up by itself', reloads2 > 0, true);

// And the visible-but-abandoned one: no focus, no modal, no input for hours.
const dom3 = new JSDOM('<!doctype html><body></body>', { url: 'https://rfahrner.github.io/M-J-Site/' });
global.document = dom3.window.document;
let reloads3 = 0;
global.window = { location: { reload: () => { reloads3 += 1; } } };
etag = '"v1"';
asWatcher('watch3.mjs');
console.warn = () => {};
const watcher3 = await import(join(dir, 'watch3.mjs'));
await new Promise((r) => setTimeout(r, 10));
const realNow = Date.now;
Date.now = () => realNow() + 10 * 60 * 1000; // ten minutes of nobody touching it
etag = '"v2"';
await watcher3.checkForNewDeploy();
Date.now = realNow;
console.warn = quiet;
check('so does one left sitting untouched', reloads3 > 0, true);

console.log('\n6. the source says what it will not do');
const WATCH = read('site-version-watch.js');
check('a hidden tab counts as unattended', /visibilityState === 'hidden'\) return true/.test(WATCH), true);
check('an open modal blocks a reload', /\.overlay:not\(\.hidden\)/.test(WATCH), true);
check('a focused field blocks a reload', /INPUT\|TEXTAREA\|SELECT/.test(WATCH), true);
check('it keeps checking on its own', /setInterval\(checkForNewDeploy, POLL_MS\)/.test(WATCH), true);
// It loads through the toolbar chain while loadboard.js is still evaluating.
check('it does not import loadboard.js', /from '\.\/loadboard\.js'/.test(WATCH), false);
check('it is wired into every board page',
  /import '\.\/site-version-watch\.js';/.test(read('loadboard-toolbar-controls.js')), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
