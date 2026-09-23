/*
 * Regression test: a tab doing hours of work is not an idle tab.
 *
 * On 2026-09-23 an archive export was killed partway through by the idle pause
 * added for boards left up overnight. The export runs for a long time, takes no
 * input, and is started precisely so somebody can walk away -- so "nothing has
 * happened in this tab for 30 minutes" was measuring the dispatcher's hands and
 * concluding the wrong thing about the tab.
 *
 * site-version-watch.js was the sharper edge of the same mistake: it treats a
 * hidden tab as the safest one to reload, and a hidden tab three hours into an
 * export is the most expensive one in the building.
 *
 * What must hold:
 *   - work in progress is never paused and never reloaded from under;
 *   - the idle clock restarts when the work ends, not from the last keystroke
 *     hours earlier, or the tab pauses on the very next tick;
 *   - the tab is not reloaded straight after a run either -- the export leaves
 *     the purge confirmation on screen for someone to read;
 *   - and when nothing is running, both modules behave exactly as before.
 *
 * Run: npm i --no-save jsdom && node scripts/long-task-guard.test.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'mj-longtask-'));
const calls = { removeAllChannels: 0, signOut: 0 };
globalThis.__idleTestCalls = calls;

writeFileSync(join(dir, 'loadboard.mjs'), `
  const calls = globalThis.__idleTestCalls;
  export const supabaseClient = {
    removeAllChannels: async () => { calls.removeAllChannels += 1; },
    auth: { signOut: async () => { calls.signOut += 1; } },
  };
`);
const asModule = (name, source) => writeFileSync(join(dir, name), source
  .replace(/'\.\/rate-write-limiter\.js'/g, "'./rate-write-limiter.mjs'")
  .replace(/'\.\/long-task-guard\.js'/g, "'./long-task-guard.mjs'")
  .replace(/'\.\/loadboard\.js'/g, "'./loadboard.mjs'"));
asModule('rate-write-limiter.mjs', read('rate-write-limiter.js'));
asModule('long-task-guard.mjs', read('long-task-guard.js'));
asModule('idle-session.mjs', read('idle-session.js'));
asModule('site-version-watch.mjs', read('site-version-watch.js'));

const dom = new JSDOM('<!doctype html><body></body>',
  { url: 'https://rfahrner.github.io/M-J-Site/archive.html' });
// Backgrounded: the state in which site-version-watch.js used to reload without
// asking anyone, and the state a long export is usually left in.
Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
globalThis.document = dom.window.document;
let reloads = 0;
globalThis.window = {
  location: { reload: () => { reloads += 1; }, href: null },
  addEventListener: () => {},
  removeEventListener: () => {},
};
// Node has its own navigator, and it has no wakeLock. That is the point: the
// API is missing in plenty of real browsers too, and its absence must not throw
// or fail a task.
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
// site-version-watch HEAD-fetches loadboard.js on import. Nothing to learn from
// a version marker in this test, so it never changes.
globalThis.fetch = async () => ({ ok: true, headers: { get: () => '"v1"' } });

const quiet = console.warn;
console.warn = () => {};
const guard = await import(join(dir, 'long-task-guard.mjs'));
const limiter = await import(join(dir, 'rate-write-limiter.mjs'));
const idle = await import(join(dir, 'idle-session.mjs'));
const version = await import(join(dir, 'site-version-watch.mjs'));
console.warn = quiet;

const MIN = 60 * 1000;
const away = (minutes) => idle.__setLastActivity(Date.now() - minutes * MIN);
const panel = () => dom.window.document.getElementById('idle-session-panel');
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
console.log('\n1. the guard says what is happening');
check('nothing running to begin with', guard.longTaskRunning(), false);
const task = guard.beginLongTask('The archive export');
check('now something is', guard.longTaskRunning(), true);
check('and it is named, for the close warning', guard.longTaskName(), 'The archive export');
// Two overlapping tasks must not have the first one to finish clear the flag.
const second = guard.beginLongTask('Something else');
guard.endLongTask(second);
check('a second task ending does not end the first', guard.longTaskRunning(), true);

console.log('\n2. a three-hour export is not an idle tab');
away(3 * 60);
console.warn = () => {}; idle.__tick(); await settle(); console.warn = quiet;
check('not paused', idle.__state().paused, false);
check('no panel over the export', !!panel(), false);
check('realtime is left alone', calls.removeAllChannels, 0);
check('and the state says why', idle.__state().busyWith, 'The archive export');
// Twelve hours idle would otherwise sign the tab out mid-run and lose it all.
away(13 * 60);
console.warn = () => {}; idle.__tick(); await settle(); console.warn = quiet;
check('nor is it signed out', calls.signOut, 0);

console.log('\n3. nor is it reloaded out from under');
// The dangerous combination: a new deploy landed and the tab is in the
// background, which is exactly when this used to reload without asking.
check('the tab really is hidden', dom.window.document.visibilityState, 'hidden');
check('a hidden tab mid-export is not safe to reload', version.__safeToReloadUnattended(), false);

console.log('\n4. the clock restarts when the work ends');
guard.endLongTask(task);
check('the task is over', guard.longTaskRunning(), false);
// lastActivityAt was 13 hours ago when the export ended. Reading it literally
// would sign the tab out on the next tick, half a second later.
check('idle is measured from the end of the run', Math.round((Date.now() - idle.__state().lastActivityAt) / 1000), 0);
console.warn = () => {}; idle.__tick(); await settle(); console.warn = quiet;
check('so the next tick does nothing', idle.__state().paused, false);
check('and nobody was signed out', calls.signOut, 0);

console.log('\n5. and the result stays on screen long enough to read');
// The export ends by putting the purge confirmation up. Reloading 30 seconds
// later because the tab is hidden throws that away.
check('not reloaded straight after a run', version.__safeToReloadUnattended(), false);
check('the guard recorded when the run ended', version.__state().lastLongTaskEndedAt > 0, true);

console.log('\n6. with nothing running, the old behaviour is unchanged');
away(31);
console.warn = () => {}; idle.__tick(); await settle(); console.warn = quiet;
check('an idle tab still pauses', idle.__state().paused, true);
check('automatic writes still stop', limiter.allowRateWrite(16141), false);
check('realtime is still dropped', calls.removeAllChannels, 1);
check('and the panel still appears', !!panel(), true);

console.log('\n7. the work actually declares itself');
const EXPORT = read('archive-page.js');
const PURGE = read('archive-purge.js');
check('the export begins a long task', /const longTask = beginLongTask\(/.test(EXPORT), true);
// finally, so a cancelled or failed export releases it too -- otherwise one
// AbortError leaves the tab permanently exempt from both protections.
check('and ends it in a finally block', /\} finally \{[\s\S]{0,400}endLongTask\(longTask\);/.test(EXPORT), true);
check('the purge begins one too', /beginLongTask\("The archive purge"\)/.test(PURGE), true);
check('and releases it when it fails', /purgeInProgress = false;\n  endLongTask\(purgeLongTask\);/.test(PURGE), true);

console.log('\n8. the guard is a leaf');
// idle-session.js and site-version-watch.js both load through the toolbar
// chain while loadboard.js is still evaluating; anything they import must not
// reach back into it.
const GUARD = read('long-task-guard.js');
check('it imports nothing', /^\s*import\s/m.test(GUARD), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
