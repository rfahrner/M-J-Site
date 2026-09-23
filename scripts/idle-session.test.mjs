/*
 * Regression test for what a tab does when nobody is using it.
 *
 * Boards get left up overnight. Two stages, because "away for twenty minutes"
 * and "gone home" want different answers: pause at 30 minutes (stop automatic
 * writes, drop realtime, dim the board but keep it readable), sign out at 12
 * hours so a dispatch board is not left authenticated on a shared machine.
 *
 * The things that would hurt if they broke:
 *   - a dispatcher who is still working is never paused;
 *   - a paused tab really is disconnected -- no writes, no channels -- rather
 *     than just dimmed, since a dimmed tab that keeps saving is the worst of
 *     both;
 *   - resuming reloads, because a paused tab missed everything and five
 *     renderers each cache their own days;
 *   - and the sign-out actually ends the session before leaving the page.
 *
 * Run: npm i --no-save jsdom && node scripts/idle-session.test.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'mj-idle-'));
const calls = { removeAllChannels: 0, signOut: 0 };
globalThis.__idleTestCalls = calls;

// Stand-in for loadboard.js, which idle-session.js reaches by dynamic import.
writeFileSync(join(dir, 'loadboard.mjs'), `
  const calls = globalThis.__idleTestCalls;
  export const supabaseClient = {
    removeAllChannels: async () => { calls.removeAllChannels += 1; },
    auth: { signOut: async () => { calls.signOut += 1; } },
  };
`);
writeFileSync(join(dir, 'rate-write-limiter.mjs'), read('rate-write-limiter.js'));
// Pausing now asks whether the tab is busy first -- see
// scripts/long-task-guard.test.mjs, which covers that side. Here nothing is
// ever running, so every threshold below is the plain idle case.
writeFileSync(join(dir, 'long-task-guard.mjs'), read('long-task-guard.js'));
writeFileSync(join(dir, 'idle-session.mjs'), read('idle-session.js')
  .replace("'./rate-write-limiter.js'", "'./rate-write-limiter.mjs'")
  .replace("'./long-task-guard.js'", "'./long-task-guard.mjs'")
  .replace("import('./loadboard.js')", "import('./loadboard.mjs')"));

const dom = new JSDOM('<!doctype html><body><input id="cell"></body>',
  { url: 'https://rfahrner.github.io/M-J-Site/index.html' });
globalThis.document = dom.window.document;
let navigatedTo = null;
let reloads = 0;
globalThis.window = { location: { reload: () => { reloads += 1; }, set href(v) { navigatedTo = v; }, get href() { return navigatedTo; } } };

const quiet = console.warn;
console.warn = () => {};
const limiter = await import(join(dir, 'rate-write-limiter.mjs'));
const idle = await import(join(dir, 'idle-session.mjs'));
console.warn = quiet;

const MIN = 60 * 1000;
const away = (minutes) => idle.__setLastActivity(Date.now() - minutes * MIN);
const panel = () => dom.window.document.getElementById('idle-session-panel');
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
console.log('\n1. the thresholds are the ones agreed');
check('pause at 30 minutes', idle.IDLE_PAUSE_MS, 30 * MIN);
check('sign out at 12 hours', idle.IDLE_SIGNOUT_MS, 12 * 60 * MIN);

console.log('\n2. someone still working is left alone');
away(29);
idle.__tick();
await settle();
check('not paused', idle.__state().paused, false);
check('no panel over the board', !!panel(), false);
check('still saving', limiter.allowRateWrite(16141), true);
check('still connected', calls.removeAllChannels, 0);

console.log('\n3. at half an hour the tab stands down');
away(31);
console.warn = () => {}; idle.__tick(); await settle(); console.warn = quiet;
check('paused', idle.__state().paused, true);
// A dimmed tab that keeps saving would be the worst of both.
check('automatic writes stop', limiter.allowRateWrite(16141), false);
check('and it says why', limiter.automaticWritesBlocked(), 'this tab has been idle');
check('every realtime channel is dropped', calls.removeAllChannels, 1);
check('the board is dimmed, not hidden', !!panel(), true);
check('and it is honest that the numbers are behind',
  /not showing[\s\S]*latest data/i.test(panel().textContent), true);
check('nobody was signed out yet', calls.signOut, 0);

console.log('\n4. coming back reloads rather than reconnecting');
// A paused tab missed every change, and five renderers each cache their own
// days; a reload is the only reconciliation that is certainly right.
check('resuming is a reload', /window\.location\.reload\(\)/.test(read('idle-session.js')), true);
panel().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('clicking the panel reloads', reloads, 1);
// Stray events must not silently un-pause a tab that is no longer connected.
away(31);
dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true }));
check('a stray keystroke does not un-pause it', idle.__state().paused, true);
check('and does not reconnect it', calls.removeAllChannels, 1);

console.log('\n5. a machine left overnight is signed out');
away(12 * 60 + 1);
console.warn = () => {}; idle.__tick(); await settle(); console.warn = quiet;
check('the session is ended', calls.signOut, 1);
check('and the tab goes to the login page', navigatedTo, 'login.html');
check('it does not sign out twice', (idle.__tick(), await settle(), calls.signOut), 1);

console.log('\n6. wiring');
const SRC = read('idle-session.js');
// It loads through the toolbar chain while loadboard.js is still evaluating,
// so the dependency has to be dynamic.
check('loadboard.js is imported dynamically', /import\('\.\/loadboard\.js'\)/.test(SRC), true);
check('and not statically', /^import[^\n]*from '\.\/loadboard\.js'/m.test(SRC), false);
check('it is on every board page via the toolbar chain',
  /import '\.\/idle-session\.js';/.test(read('loadboard-toolbar-controls.js')), true);
// removeAllChannels covers the standard boards, Houston, Mondelez and the
// driver list without this module knowing which page it is on.
check('it drops channels generically', /removeAllChannels/.test(SRC), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
