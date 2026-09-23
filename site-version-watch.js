/*
 * Notices when the deployed site has changed under a tab that is still open.
 *
 * Dispatchers leave the board up overnight. A tab that loaded at 07:00 keeps
 * running the JavaScript it loaded at 07:00 for as long as it stays open --
 * ES modules are fetched once -- so after a deploy the site is running in two
 * versions at the same time, on the same data.
 *
 * That is not cosmetic. On 2026-09-22 an old tab and a new one disagreed about
 * what a load's rate should be and wrote their two answers at each other about
 * twice a second for an hour: 9,443 rows of carrier_rate churn, and a Rate
 * cell visibly flickering on the board. Neither tab was wrong about anything
 * it could see. Telling everyone to refresh is not a control -- the tab that
 * causes the damage is the one nobody is sitting at.
 *
 * So a stale tab takes itself out of the argument:
 *
 *   1. It stops making automatic, calculated writes immediately. Everything
 *      the dispatcher does by hand still saves -- someone mid-shift must not
 *      lose what they typed because a deploy landed.
 *   2. It says so, with a Reload button.
 *   3. If nobody is using it, it reloads itself. Idle and hidden tabs are
 *      exactly the ones left running overnight, and reloading one costs
 *      nothing.
 *
 * Version marker: the ETag (or Last-Modified) GitHub Pages serves for
 * loadboard.js. No build step to remember, nothing to bump by hand, and it
 * changes exactly when the file does.
 *
 * Imports only the rate limiter, which is itself a leaf. Do not make this
 * import loadboard.js -- it loads through the toolbar chain while loadboard.js
 * is still evaluating.
 */

import { setAutomaticWritesBlocked } from './rate-write-limiter.js';
import { longTaskRunning } from './long-task-guard.js';

const WATCHED = 'loadboard.js';
const POLL_MS = 5 * 60 * 1000;
// Comfortably longer than the 700ms save debounce and than anyone's pause
// between keystrokes, so an idle tab really is idle.
const IDLE_MS = 2 * 60 * 1000;
// After hours of work the tab is holding a result somebody has to see -- the
// archive export leaves the purge confirmation on screen. Reloading it away
// 30 seconds after the run ends would be its own kind of losing the work.
const RECENT_WORK_MS = 10 * 60 * 1000;
const BANNER_ID = 'site-version-stale-banner';

let deployedVersion = null;
let stale = false;
let lastActivityAt = Date.now();
let lastLongTaskEndedAt = 0;

async function currentVersion() {
  try {
    const url = new URL(WATCHED, document.baseURI).href;
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    return res.headers.get('etag') || res.headers.get('last-modified') || null;
  } catch {
    // Offline, or the request was blocked. Not knowing is not a reason to act.
    return null;
  }
}

function showBanner() {
  if (document.getElementById(BANNER_ID)) return;
  const bar = document.createElement('div');
  bar.id = BANNER_ID;
  bar.setAttribute('role', 'status');
  bar.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:99999',
    'display:flex', 'gap:12px', 'align-items:center', 'justify-content:center',
    'padding:10px 16px', 'background:#1e293b', 'color:#fff',
    'font:600 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif',
    'box-shadow:0 -2px 8px rgba(0,0,0,0.25)',
  ].join(';');
  bar.innerHTML =
    '<span>This board has been updated. This tab is still running the older version, '
    + 'so it has stopped saving calculated rates. Reload to pick up the update '
    + '\u2014 anything long-running in this tab, such as an archive export, finishes first.</span>';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload now';
  button.style.cssText = 'padding:6px 14px;border:0;border-radius:6px;background:#fff;color:#1e293b;font:inherit;cursor:pointer;';
  button.addEventListener('click', () => window.location.reload());
  bar.appendChild(button);
  (document.body || document.documentElement).appendChild(bar);
}

// Reloading under someone's hands loses what they are typing and closes what
// they have open, so every one of these has to be true.
function safeToReloadUnattended() {
  // A hidden tab is normally the safest one to reload. A hidden tab running an
  // archive export is the most dangerous: hours of work, and nobody watching
  // to notice it restarted. Work outranks hidden.
  if (longTaskRunning()) return false;
  if (Date.now() - lastLongTaskEndedAt < RECENT_WORK_MS) return false;
  if (document.visibilityState === 'hidden') return true;
  if (Date.now() - lastActivityAt < IDLE_MS) return false;
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false;
  if (active && active.isContentEditable) return false;
  if (document.querySelector('.overlay:not(.hidden)')) return false;
  return true;
}

function goStale() {
  if (stale) return;
  stale = true;
  // Before anything else: an old tab must not keep writing calculated values
  // that the new one disagrees with, even if it never reloads.
  setAutomaticWritesBlocked(true, 'this tab is running an older version of the board');
  showBanner();
  const reloadIfUnattended = () => {
    if (safeToReloadUnattended()) window.location.reload();
  };
  reloadIfUnattended();
  setInterval(reloadIfUnattended, 30 * 1000);
}

export async function checkForNewDeploy() {
  const seen = await currentVersion();
  if (!seen) return;
  if (deployedVersion == null) { deployedVersion = seen; return; }
  if (seen !== deployedVersion) goStale();
}

function markActivity() { lastActivityAt = Date.now(); }

export async function initSiteVersionWatch() {
  ['pointerdown', 'keydown', 'wheel', 'focusin'].forEach((type) => {
    document.addEventListener(type, markActivity, { passive: true, capture: true });
  });
  document.addEventListener('mj:long-task-ended', () => { lastLongTaskEndedAt = Date.now(); });
  await checkForNewDeploy();
  setInterval(checkForNewDeploy, POLL_MS);
  // A tab brought back to the front after hours asleep should find out now
  // rather than up to five minutes later.
  document.addEventListener('visibilitychange', () => {
    markActivity();
    if (document.visibilityState === 'visible') void checkForNewDeploy();
  });
}

// Test seam.
export const __safeToReloadUnattended = safeToReloadUnattended;
export function __state() {
  return { deployedVersion, stale, lastActivityAt, lastLongTaskEndedAt };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void initSiteVersionWatch(), { once: true });
} else {
  void initSiteVersionWatch();
}
