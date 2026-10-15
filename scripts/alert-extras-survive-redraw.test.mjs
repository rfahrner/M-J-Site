/*
 * The call alert must come back the moment alerts.js wipes it.
 *
 * alerts.js owns #alert-widget-body and redraws it with innerHTML on a
 * 60-SECOND scan, which removes every .dispatch-extra-alert. The extras
 * controller watches for that with a MutationObserver and re-renders.
 *
 * It used to gate that observer on a 450ms time window, to stop its OWN
 * render retriggering it. A time window cannot tell one writer from another,
 * and BOTH schedulers run on 60-second timers -- so once they drifted into
 * the same 450ms they stayed there, alerts.js's wipe was swallowed as if it
 * were ours, and the alert stayed gone until the next minute tick. Reported
 * as "the call driver alert keeps disappearing and coming back after a few
 * minutes".
 *
 * Disconnecting while we write is exact: our mutations are never observed,
 * anyone else's always are, and no timing is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const src = fs.readFileSync('preshift-pro-text.js', 'utf8');

function lift(name) {
  const m = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`cannot lift ${name}`);
  return m[0].replace(/^export /, '');
}

function harness() {
  const dom = new JSDOM('<div id="alert-widget"><div id="alert-widget-body"></div><span id="alert-widget-count"></span></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  let renders = 0;
  // document/MutationObserver/setTimeout are already the window's own.
  Object.assign(w, {
    currentLocation: () => 'atlanta',
    houstonPreShiftAlerts: async () => [],
    carrierDocsAlerts: async () => [],
    dispatchedRouteAlerts: async () => { renders += 1; return [{html:'<div class="dispatch-extra-alert alert-chat-item">Call driver</div>'}]; },
  });
  w.eval(`
    let alertObserver = null, observedAlertBody = null, refreshTimer = null, lastExtrasHtml = [];
    ${lift('paintExtras')}
    ${lift('restoreExtrasNow')}
    ${lift('refreshExtraAlerts')}
    ${lift('scheduleRefresh')}
    ${lift('installAlertObserver')}
    this.refresh = refreshExtraAlerts;
    this.install = installAlertObserver;
  `);
  return { w, dom, calls: () => renders };
}

const present = (w) => w.document.querySelectorAll('.dispatch-extra-alert').length;
const tick = (w, ms) => new Promise((r) => w.setTimeout(r, ms));

test('our own render does not retrigger the observer (no infinite loop)', async () => {
  const { w, calls } = harness();
  w.install();
  await w.refresh();
  assert.equal(present(w), 1);
  const after = calls();
  await tick(w, 500);
  assert.equal(calls(), after, 'rendering must not schedule another render of itself');
});

test('an alerts.js redraw IMMEDIATELY after ours still restores the alert', async () => {
  const { w } = harness();
  w.install();
  await w.refresh();
  assert.equal(present(w), 1);

  // This is the collision: alerts.js wipes the body a few ms after our render,
  // well inside the old 450ms suppression window.
  await tick(w, 20);
  w.document.getElementById('alert-widget-body').innerHTML =
    '<div class="alert-empty">Nothing needs attention right now.</div>';
  assert.equal(present(w), 0, 'the wipe really did remove it');

  await tick(w, 400);
  assert.equal(present(w), 1,
    'the alert stayed gone -- the wipe was mistaken for our own render, so nothing restored it until the next 60s tick');
});

test('a redraw much later is restored too -- the ordinary case, which always worked', async () => {
  const { w } = harness();
  w.install();
  await w.refresh();
  await tick(w, 600);
  w.document.getElementById('alert-widget-body').innerHTML = '<div class="alert-empty">none</div>';
  await tick(w, 400);
  assert.equal(present(w), 1);
});

test('if alerts.js replaces the body ELEMENT, the extras still come back', async () => {
  const { w } = harness();
  w.install();
  await w.refresh();
  assert.equal(present(w), 1);

  // alerts.js rebuilds the whole widget in some paths: a NEW #alert-widget-body.
  const widget = w.document.getElementById('alert-widget');
  widget.innerHTML = '<div class="alert-widget-body" id="alert-widget-body"></div><span id="alert-widget-count"></span>';
  assert.equal(present(w), 0);

  w.install();           // the minute tick re-installs
  await w.refresh();
  assert.equal(present(w), 1, 'observer was left watching a detached node');

  // and the NEW body is genuinely watched now
  await tick(w, 20);
  w.document.getElementById('alert-widget-body').innerHTML = '<div class="alert-empty">none</div>';
  await tick(w, 400);
  assert.equal(present(w), 1, 'the replacement body is not being observed');
});

test('the observer is installed even when the widget appears AFTER init', async () => {
  // alerts.js builds #alert-widget-body when it mounts the widget, which is
  // after this module's init() runs. installAlertObserver() found no element,
  // returned early, and the observer was never created -- so nothing restored
  // a wiped alert except the 60-second interval. That is the whole "there for
  // a bit and then it disappears". Measured in sandbox/alert-stability.spec.mjs:
  // 0 of 6 redraws recovered before this, 6 of 6 after.
  const { w } = harness();
  const widget = w.document.getElementById('alert-widget');
  const body = w.document.getElementById('alert-widget-body');
  body.remove();                      // the widget does not exist yet
  w.install();                        // init() runs: nothing to observe
  widget.insertAdjacentHTML('afterbegin', '<div class="alert-widget-body" id="alert-widget-body"></div>');

  await w.refresh();                  // first render must install it
  assert.equal(present(w), 1);

  await tick(w, 20);
  w.document.getElementById('alert-widget-body').innerHTML = '<div class="alert-empty">none</div>';
  await tick(w, 300);
  assert.equal(present(w), 1,
    'the observer was never created, so only the 60-second interval could bring it back');
});

test('a wipe is repainted from cache in the same turn, not after a database round trip', async () => {
  // Recomputing takes three queries. Repainting what we last showed is
  // synchronous, so the wipe never reaches the screen; the refresh behind it
  // then corrects anything that actually changed.
  const { w, calls } = harness();
  w.install();
  await w.refresh();
  const before = calls();

  w.document.getElementById('alert-widget-body').innerHTML = '<div class="alert-empty">none</div>';
  // No await, no timers: by the time the observer callback has run, it is back.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(present(w), 1, 'repaint must not wait for the refresh');
  assert.equal(calls(), before, 'and it must not have needed a new query to do it');
});
