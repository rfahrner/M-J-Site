/*
 * Browser sandbox: a call alert must not blink.
 *
 * "its there for a bit and then disappears... we need it to stop."
 *
 * alerts.js owns #alert-widget-body and rewrites it with innerHTML on its own
 * 60-second scan, which deletes every .dispatch-extra-alert. The extras
 * controller puts them back. Everything about whether a dispatcher sees a
 * steady alert or a blinking one lives in the gap between those two events,
 * and that gap is invisible to scripts/ -- jsdom has no real timers against a
 * real event loop, and an instant fake database hides it completely.
 *
 * So this measures the gap. It records every appear/disappear transition in
 * the page with timestamps and reports the LONGEST window the alert is
 * missing, under a database that answers in realistic time.
 *
 * Run: node sandbox/alert-stability.spec.mjs   (needs sandbox/serve.mjs running)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const FAKE = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.SANDBOX_URL || 'http://127.0.0.1:8787';
const CHROME = process.env.SANDBOX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LATENCY = Number(process.env.SANDBOX_LATENCY_MS || 120);   // a plausible round trip
const REDRAWS = Number(process.env.SANDBOX_REDRAWS || 6);

const today = new Date().toISOString().slice(0, 10);
const ROWS = {
  loads_shifts: [{
    id: 9001, location: 'atlanta', shift_date: today, driver_id: 700,
    driver_name_text: 'Jontavious Caslin', driver_cell_snapshot: '7705551234',
    pro_number: '2014695', shift_start: '11:00',
    shift_complete: false, tonu: false, called_off: false, load_cancelled: false,
  }],
  loads_trips: [{
    id: 41695, shift_id: 9001, trip_number: 1, route_id: 'PA5070', trip_id: '1310998',
    dispatch_time: '12:53', dispatch_text_event_id: 'evt-1', dispatch_call_ack_event_id: null,
    complete: false, minimized: false, backhaul: false, salvage: false,
  }],
  atlanta_drivers: [{ id: 700, 'Driver Name': 'Jontavious Caslin', 'Driver Cell': '7705551234' }],
  trip_stops: [], location_notes: [], board_rate_tiers: [], loads_accounting: [],
};

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext();
await ctx.route('**/supabase.min.js', (r) =>
  r.fulfill({ contentType: 'application/javascript', body: FAKE }));
const page = await ctx.newPage();
await page.addInitScript(([rows, ms]) => {
  window.__SANDBOX_ROWS = rows;
  window.__SANDBOX_LATENCY_MS = ms;
}, [ROWS, LATENCY]);

await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });

// Watch the widget from inside the page, so nothing is missed between polls.
await page.evaluate(() => {
  window.__tape = [];
  const SEL = '[data-special-call-trip]';
  let last = null;
  const sample = () => {
    const present = !!document.querySelector(SEL);
    if (present !== last) { window.__tape.push({ t: performance.now(), present }); last = present; }
  };
  sample();
  new MutationObserver(sample).observe(document.body, { childList: true, subtree: true });
  window.__sampler = setInterval(sample, 5);   // belt and braces
  window.__trace = [];
  const origInsert = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, html) {
    if (typeof html === 'string' && html.includes('dispatch-extra-alert')) {
      window.__trace.push({ t: performance.now(), what: 'extras-render' });
    }
    return origInsert.call(this, pos, html);
  };
  // Exactly what alerts.js does on its 60s scan (alerts.js:418/424).
  window.__alertsRedraw = () => {
    const body = document.getElementById('alert-widget-body');
    if (body) body.innerHTML = '<div class="alert-empty">Nothing needs attention right now.</div>';
  };
});

// Let the first render land.
await page.waitForSelector('[data-special-call-trip]', { timeout: 15000 }).catch(() => {});
const appeared = await page.evaluate(() => !!document.querySelector('[data-special-call-trip]'));
check('the call alert renders at all', appeared);

if (appeared) {
  for (let i = 0; i < REDRAWS; i++) {
    await page.evaluate(() => window.__alertsRedraw());
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(600);

  const tape = await page.evaluate(() => window.__tape);
  // Everything before the FIRST appearance is startup, not a drop-out: the
  // page has loaded but the alert has not been computed yet. A dispatcher
  // complaining that it "disappears" means after they have seen it. Measure
  // the two separately or the startup wait masquerades as a blink.
  const firstOn = tape.findIndex((e) => e.present);
  const startupMs = firstOn >= 0 ? Math.round(tape[firstOn].t - tape[0].t) : null;
  const afterFirst = firstOn >= 0 ? tape.slice(firstOn) : [];
  const gaps = [];
  for (let i = 0; i < afterFirst.length; i++) {
    if (!afterFirst[i].present) {
      const back = afterFirst.slice(i + 1).find((e) => e.present);
      if (back) gaps.push(Math.round(back.t - afterFirst[i].t));
    }
  }
  const worst = gaps.length ? Math.max(...gaps) : 0;
  const stillGone = afterFirst.length && !afterFirst[afterFirst.length - 1].present;

  console.log(`\n  ${REDRAWS} redraws, ${LATENCY}ms query latency`);
  console.log(`  time to first alert: ${startupMs}ms (startup, not a drop-out)`);
  console.log(`  drop-outs after it was visible: ${gaps.length}`);
  console.log(`  gaps (ms): ${gaps.join(', ') || 'none'}`);
  console.log(`  worst gap: ${worst}ms`);
  const t0 = tape.length ? tape[0].t : 0;
  console.log(`  timeline: ${tape.map((e) => `${Math.round(e.t - t0)}ms ${e.present ? 'ON' : 'off'}`).join('  ')}`);
  const trace = await page.evaluate(() => window.__trace || []);
  if (trace.length) console.log(`  renders:  ${trace.map((e) => `${Math.round(e.t - t0)}ms ${e.what}`).join('  ')}`);
  console.log('');

  check('the alert comes back every time', !stillGone,
    stillGone ? 'it is still missing at the end of the run' : '');
  // One frame at 60Hz is ~17ms. Under that, nothing was ever painted without it.
  check('the alert never visibly drops out once seen (<17ms)', worst < 17,
    worst >= 17 ? `gone for ${worst}ms -- a dispatcher sees this blink` : '');
  check('every alerts.js redraw was absorbed', gaps.length >= REDRAWS,
    gaps.length < REDRAWS ? `only ${gaps.length} of ${REDRAWS} redraws reached the widget -- the test may not be exercising it` : '');
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
