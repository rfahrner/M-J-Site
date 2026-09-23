/*
 * What a tab does when nobody is using it.
 *
 * Boards get left up: a dispatcher goes home, the machine sits on the shift
 * screen all night, and the tab keeps a realtime connection open and keeps
 * recalculating and saving. Two stages, because "away for twenty minutes" and
 * "gone home" want different answers.
 *
 *   After IDLE_PAUSE_MS  -- pause. Automatic writes stop, every realtime
 *                          channel is dropped, and the board dims behind a
 *                          "Paused" panel. The numbers stay readable; the tab
 *                          just stops taking part.
 *   After IDLE_SIGNOUT_MS -- sign out. A dispatch board left authenticated on
 *                          a shared machine overnight is worth closing, and by
 *                          then nobody is coming back to this tab.
 *
 * "Idle" means nobody is using the tab, not that nothing is happening in it.
 * An archive export runs for hours, needs no input, and is started so somebody
 * can walk away -- and on 2026-09-23 this module paused one partway through.
 * A tab with a long task open is busy; the clock only starts once it ends.
 *
 * Resuming reloads the page rather than reconnecting in place. While paused,
 * every change made by everyone else was missed, and five different renderers
 * (three standard boards, Houston, Mondelez) each cache their own days -- a
 * reload is the only reconciliation that is certainly right, and it costs about
 * a second on a tab whose owner has been away for half an hour. It also picks
 * up any deploy that landed meanwhile.
 *
 * This does NOT fix rates flickering. That was a client computing from a rate
 * table it had not loaded and saving the result (see boardrates.js), and both
 * tabs involved were in active use -- neither would ever have been idle. Pausing
 * is worth doing for connections and for the overnight machine, not as a
 * substitute for that fix.
 *
 * Dependencies are imported dynamically: this loads through the toolbar chain
 * while loadboard.js is still evaluating.
 */

import { setAutomaticWritesBlocked } from './rate-write-limiter.js';
import { longTaskRunning, longTaskName } from './long-task-guard.js';

const MINUTE = 60 * 1000;
export const IDLE_PAUSE_MS = 30 * MINUTE;
// Long enough that it only ever catches a machine left overnight, not someone
// who is still on shift and reading.
export const IDLE_SIGNOUT_MS = 12 * 60 * MINUTE;
const TICK_MS = 30 * 1000;
const PANEL_ID = 'idle-session-panel';

let lastActivityAt = Date.now();
let paused = false;
let signedOut = false;
let timer = null;

// Anything the dispatcher does with their hands. Not scroll alone: a board can
// scroll from a redraw, and a wheel event already covers a real one.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'focusin'];

async function boardModule() {
  try {
    return await import('./loadboard.js');
  } catch (e) {
    console.error('[idle-session] could not reach the board module:', e);
    return null;
  }
}

function minutesAway() {
  return Math.round((Date.now() - lastActivityAt) / MINUTE);
}

function showPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Board paused');
  panel.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99998',
    'display:flex', 'flex-direction:column', 'gap:14px',
    'align-items:center', 'justify-content:center',
    'background:rgba(15,23,42,0.55)', 'backdrop-filter:blur(2px)',
    'color:#fff', 'cursor:pointer',
    'font:600 15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif',
  ].join(';');
  panel.innerHTML =
    `<div style="text-align:center;max-width:420px;padding:0 20px;">`
    + `<div style="font-size:19px;margin-bottom:8px;">Board paused</div>`
    + `<div style="font-weight:400;opacity:0.9;">Nothing has happened in this tab for ${minutesAway()} minutes, `
    + `so it stopped saving and disconnected from live updates. It is not showing `
    + `the latest data.</div></div>`;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Resume';
  button.style.cssText = 'padding:10px 24px;border:0;border-radius:8px;background:#fff;color:#0f172a;font:inherit;cursor:pointer;';
  panel.appendChild(button);
  // The whole panel resumes, not only the button: someone coming back clicks
  // wherever they were looking.
  panel.addEventListener('click', () => window.location.reload());
  (document.body || document.documentElement).appendChild(panel);
}

async function pause() {
  if (paused) return;
  paused = true;
  setAutomaticWritesBlocked(true, 'this tab has been idle');
  const lb = await boardModule();
  // removeAllChannels covers every page's own subscription -- the standard
  // boards, Houston, Mondelez, the driver list -- without this module having
  // to know which one it is on.
  try { await lb?.supabaseClient?.removeAllChannels?.(); } catch (e) {
    console.warn('[idle-session] could not drop realtime channels:', e);
  }
  showPanel();
  console.warn(`[idle-session] Paused after ${minutesAway()} minutes idle.`);
}

async function signOut() {
  if (signedOut) return;
  signedOut = true;
  const lb = await boardModule();
  try { await lb?.supabaseClient?.auth?.signOut(); } catch (e) {
    console.error('[idle-session] sign-out failed:', e);
  }
  window.location.href = 'login.html';
}

function tick() {
  if (signedOut) return;
  // Work in progress counts as the tab being in use. Keeping the clock pushed
  // forward, rather than only skipping the pause, means a task that ends after
  // four hours does not pause the tab on the very next tick.
  if (longTaskRunning()) {
    lastActivityAt = Date.now();
    return;
  }
  const away = Date.now() - lastActivityAt;
  if (away >= IDLE_SIGNOUT_MS) { void signOut(); return; }
  if (away >= IDLE_PAUSE_MS) void pause();
}

function markActivity() {
  // While paused the panel is the only way back, so stray events must not
  // quietly un-pause a tab that is no longer connected to anything.
  if (paused) return;
  lastActivityAt = Date.now();
}

export function initIdleSession() {
  // The task is over, so the idle clock starts now -- not from whenever the
  // dispatcher last touched the keyboard, which may have been hours ago.
  document.addEventListener('mj:long-task-ended', () => { lastActivityAt = Date.now(); });
  ACTIVITY_EVENTS.forEach((type) => {
    document.addEventListener(type, markActivity, { passive: true, capture: true });
  });
  // Coming back to the tab counts as being here, and is the moment to check
  // whether it was away long enough to have been signed out.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { tick(); markActivity(); }
  });
  clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
}

// Test seam.
export function __state() {
  return { lastActivityAt, paused, signedOut, IDLE_PAUSE_MS, IDLE_SIGNOUT_MS, busyWith: longTaskName() };
}
export function __setLastActivity(at) { lastActivityAt = at; }
export const __tick = tick;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initIdleSession, { once: true });
} else {
  initIdleSession();
}
