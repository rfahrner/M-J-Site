/*
 * A tab that is working is not a tab that is idle.
 *
 * Two modules take a tab out of service when nobody appears to be using it:
 * idle-session.js pauses it after 30 minutes without a keystroke, and
 * site-version-watch.js reloads it outright when a deploy lands and the tab is
 * hidden. Both are right about a dispatch board left up overnight and both are
 * badly wrong about an archive export, which runs for a long time, needs no
 * input at all, and is usually started precisely so somebody can walk away.
 *
 * On 2026-09-23 that is what happened: an archive run was killed partway
 * through by the idle pause I added for the overnight case. "Nothing has
 * happened in this tab" was measuring the dispatcher's hands, not the tab.
 *
 * So work declares itself. While a long task is open the tab is busy, not
 * idle: it is not paused, and it is not reloaded from under the work. It also
 * asks the operating system to stay awake and warns before a close. Everything
 * else about idling is unchanged -- the moment the task ends, the clock starts
 * again from now, because the dispatcher genuinely has been away.
 *
 * A leaf: imports nothing. idle-session.js and site-version-watch.js already
 * load through the toolbar chain while loadboard.js is still evaluating, so
 * anything they depend on has to stay dependency-free.
 */

const running = new Map();
let nextToken = 1;
let wakeLock = null;
let beforeUnload = null;

function label() {
  return [...running.values()][0] || 'work';
}

// Best effort in every direction: the API is unavailable in some browsers, is
// rejected when the page is not visible, and drops the lock on its own when
// the tab is hidden. None of that is a reason to fail a task, so a lock is
// requested when possible and its absence is never checked.
async function requestWakeLock() {
  if (wakeLock || !navigator.wakeLock?.request) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  const held = wakeLock;
  wakeLock = null;
  try { await held?.release?.(); } catch { /* already gone */ }
}

// A hidden tab loses the lock; a hidden tab running an export is the exact case
// that needs it, so take it again when the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running.size) void requestWakeLock();
});

function installUnloadWarning() {
  if (beforeUnload) return;
  beforeUnload = (event) => {
    if (!running.size) return undefined;
    event.preventDefault();
    // Browsers show their own wording; a non-empty return value is what asks.
    event.returnValue = `${label()} is still running. Closing this tab stops it.`;
    return event.returnValue;
  };
  window.addEventListener('beforeunload', beforeUnload);
}

function removeUnloadWarning() {
  if (!beforeUnload) return;
  window.removeEventListener('beforeunload', beforeUnload);
  beforeUnload = null;
}

export function beginLongTask(name) {
  const token = nextToken++;
  running.set(token, String(name || 'work'));
  installUnloadWarning();
  void requestWakeLock();
  return token;
}

export function endLongTask(token) {
  if (!running.delete(token)) return;
  if (running.size) return;
  removeUnloadWarning();
  void releaseWakeLock();
  // Whoever started this really has been away for however long it took, so the
  // idle clock must not resume mid-count and pause the tab a second later.
  document.dispatchEvent(new CustomEvent('mj:long-task-ended'));
}

export function longTaskRunning() {
  return running.size > 0;
}

export function longTaskName() {
  return running.size ? label() : null;
}

// Test seam.
export function __reset() {
  running.clear();
  removeUnloadWarning();
  wakeLock = null;
}
