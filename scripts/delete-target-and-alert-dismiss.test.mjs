/*
 * Regression test for two behaviours that are easy to break silently.
 *
 * 1. Right-clicking a route pill must resolve to THAT route, not to the shift.
 *    The ROUTES column's pills are rendered inside the FIRST <tr> of a load
 *    (the one whose id is the shift's row id), so tr.id alone says "shift" even
 *    when the pointer is on a specific route. That is how a right-click meant
 *    for one route deleted an entire load.
 *
 * 2. A text sent from an alert must clear that alert. Alerts are derived from
 *    board state rather than stored, so without a dismissal registry the next
 *    60-second scan brings the same one straight back.
 *
 * Both are tested against the real code lifted out of the shipped files, not a
 * re-implementation.
 *
 * Run: npm i --no-save jsdom && node scripts/delete-target-and-alert-dismiss.test.mjs
 *
 * Not wired into ci.yml: it needs jsdom, which is deliberately not a dependency
 * of the site.
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const BOARD = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
const ALERTS = readFileSync(new URL('../alerts.js', import.meta.url), 'utf8');
const TEXT_FIX = readFileSync(new URL('../alert-text-button-fix.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}
function checkTrue(label, actual) { check(label, !!actual, true); }

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find function ${name}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

// ---------------------------------------------------------------------------
// 1. which route a right-click lands on
// ---------------------------------------------------------------------------
console.log('\n1. the context menu resolves the route actually under the pointer');

// Lift the three resolution lines straight out of the contextmenu listener so
// this cannot drift from what ships.
const RESOLVE = BOARD.match(
  /const tripEl = e\.target\.closest\("\[data-trip\]"\);\s*\n\s*const rowId = [^\n]*\n\s*const tripId = [^\n]*/,
);
if (!RESOLVE) throw new Error('could not lift the contextmenu route resolution from loadboard.js');

const ROW = 'r_1', T1 = 't_1', T2 = 't_2', T3 = 't_3';
const dom = new JSDOM(`<!doctype html><html><body>
  <table id="board-table"><tbody>
    <tr id="${ROW}">
      <td class="pin-pro"><input id="pro" data-row="${ROW}" data-field="proNumber" value="PRO-1"></td>
      <td class="col-routes">
        <button id="pill-3" class="trip-chip trip-segment-done" data-action="restore-trip"
                data-row="${ROW}" data-trip="${T3}">R-333</button>
      </td>
      <td class="col-tripId"><input id="r1-trip" data-row="${ROW}" data-trip="${T1}" data-field="tripId"></td>
    </tr>
    <tr id="${ROW}__${T2}" data-parent-row="${ROW}">
      <td class="col-tripId"><input id="r2-trip" data-row="${ROW}" data-trip="${T2}" data-field="tripId"></td>
    </tr>
  </tbody></table>
</body></html>`, { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;

// `tr` comes from the listener's own first line (e.target.closest("tr")); it is
// supplied here so the lifted lines run exactly as they do on the board.
const resolve = new Function('e', 'tr', `${RESOLVE[0]}\n return { rowId, tripId };`);
const at = (id) => {
  const target = document.getElementById(id);
  return resolve({ target }, target.closest('tr'));
};

const onPill = at('pill-3');
check('a route pill reports the load it belongs to', onPill.rowId, ROW);
check('a route pill reports its own route, not the shift', onPill.tripId, T3);

const onRoute2 = at('r2-trip');
check('a cell on route 2 reports route 2', onRoute2.tripId, T2);
check('a cell on route 2 still reports the parent load', onRoute2.rowId, ROW);

const onPro = at('pro');
check('a shift-level cell reports no route', onPro.tripId, null);
check('a shift-level cell reports the load', onPro.rowId, ROW);

// ---------------------------------------------------------------------------
// 2. the menu itself never offers an unlabelled Delete
// ---------------------------------------------------------------------------
console.log('\n2. both delete entries say what they delete');

const MENU = extractFunction(BOARD, 'openRowContextMenu');
checkTrue('the menu takes the route as a parameter',
  /function openRowContextMenu\(rowId, x, y, tripId\)/.test(MENU));
checkTrue('a route-scoped entry appears only when the load has more than one route',
  /canDeleteRoute = !!trip && \(row\.trips \|\| \[\]\)\.length > 1/.test(MENU));
checkTrue('the route entry calls deleteTrip, not deleteRow',
  /Delete route \$\{routeLabelForConfirm\(trip\)\} only[\s\S]{0,80}deleteTrip\(rowId, trip\.id\)/.test(MENU));
checkTrue('the load entry names the load', /Delete entire load \$\{loadLabelForConfirm\(row\)\}/.test(MENU));
check('no bare "Delete" entry survives', /\{ label: "Delete", /.test(MENU), false);

const DELETE_ROW = extractFunction(BOARD, 'deleteRow');
checkTrue('deleting a load spells out that the whole load goes',
  /Delete the entire load \$\{label\}/.test(DELETE_ROW) && /ENTIRE load/.test(DELETE_ROW));
const DELETE_TRIP = extractFunction(BOARD, 'deleteTrip');
checkTrue('deleting a route says the load itself stays',
  /Only this route goes — the load itself stays/.test(DELETE_TRIP));

// ---------------------------------------------------------------------------
// 3. a realtime echo lands on the route it is actually about
// ---------------------------------------------------------------------------
console.log('\n3. a realtime route payload is matched by database id');

const RT = extractFunction(BOARD, 'handleRealtimeTripChange');
checkTrue('the database id is tried before the trip_number slot',
  /find\(\(t\) => t\.dbId != null && String\(t\.dbId\) === String\(dbTrip\.id\)\)/.test(RT));
// The trip_number slot USED to be the fallback here. It was the source of the
// duplicated routes -- see scripts/realtime-trip-merge.test.mjs. A payload this
// tab cannot match by id is now matched by Trip ID, or adopted as its own
// route; nothing is placed by position and nothing is padded.
checkTrue('an unmatched payload falls back to Trip ID, not to a slot',
  /String\(t\.tripId \|\| ""\)\.trim\(\) === tripIdText/.test(RT));
checkTrue('and the positional fallback is gone',
  !/const idx = dbTrip\.trip_number - 1;/.test(RT));

// The case that matters: route 2 of 3 was deleted, so the surviving routes'
// trip_numbers (1 and 3) no longer line up with their array positions (0 and 1).
const parentRow = { trips: [{ id: 'a', dbId: 11 }, { id: 'c', dbId: 33 }] };
const matchByDbId = (dbTrip) => parentRow.trips.find(
  (t) => t.dbId != null && String(t.dbId) === String(dbTrip.id)) || null;
check('an echo for trip_number 3 reaches the route it belongs to',
  matchByDbId({ id: 33, trip_number: 3 })?.id, 'c');
check('and not the one sitting in array slot 3', matchByDbId({ id: 33, trip_number: 3 })?.id === 'a', false);

// ---------------------------------------------------------------------------
// 4. sending the text clears the alert
// ---------------------------------------------------------------------------
console.log('\n4. a sent text dismisses the alert that opened the modal');

// Match the parameter, not its punctuation -- `options` and `options = {}` are
// both fine, and pinning the exact spelling only produces false alarms.
checkTrue('openSendTextModal accepts an onSent hook',
  /export function openSendTextModal\(\s*recipients,\s*prefilledMessage,\s*markShiftIdsOnSent,\s*options\b/.test(BOARD));
const FINISH = extractFunction(BOARD, 'finishSendTextModalAsSent');
checkTrue('the shared exit hides the modal', /classList\.add\("hidden"\)/.test(FINISH));
checkTrue('the shared exit clears modal state', /sendTextModalState = null/.test(FINISH));
checkTrue('the shared exit runs the hook', /onSent\(\)/.test(FINISH));

const SUBMIT = extractFunction(BOARD, 'submitSendTextModal');
const exits = (SUBMIT.match(/finishSendTextModalAsSent\(\)/g) || []).length;
check('both the automatic send and the Outlook fallback use it', exits, 2);
// Specifically the MODAL. submitSendTextModal hides and shows its own footer
// buttons in there now, so matching any classList.add("hidden") flagged that
// as a violation -- which is what had this test red on main.
check('neither path hides the modal without it',
  /#modal-send-text"\)\.classList\.add\("hidden"\)/.test(SUBMIT), false);

checkTrue('alerts.js dismisses on send',
  /openSendTextModal\([\s\S]{0,200}onSent: \(\) => dismissAlert\(alert\.key\)/.test(ALERTS));
checkTrue('the alert widget\'s own Text handler dismisses too',
  /onSent: \(\) => alertsModule\.dismissAlert\(key\)/.test(TEXT_FIX));

// Dismissal really removes the alert from the next scan, and only that one.
const DISMISS_FILTER = /const dismissed = getDismissedAlertKeys\(\);\s*\n\s*if \(dismissed\.size\) fresh = fresh\.filter\(\(a\) => !dismissed\.has\(a\.key\)\);/;
checkTrue('every scan filters dismissed keys out', DISMISS_FILTER.test(ALERTS));

const dismissedKeys = new Set(['preshift-300']);
const scan = [{ key: 'preshift-300' }, { key: 'idle-7-0' }, { key: 'idle-7-1' }];
const surviving = scan.filter((a) => !dismissedKeys.has(a.key)).map((a) => a.key);
check('the dismissed alert is gone', surviving.includes('preshift-300'), false);
check('other alerts are untouched', surviving.length, 2);
// Repeating rules roll a tier into the key, so the next reminder is a new key.
dismissedKeys.add('idle-7-0');
check('the next tier of a repeating alert still comes through',
  scan.filter((a) => !dismissedKeys.has(a.key)).map((a) => a.key).includes('idle-7-1'), true);

// ---------------------------------------------------------------------------
// 5. the paper icon is gone for good
// ---------------------------------------------------------------------------
console.log('\n5. the board paperwork icon is removed, not just hidden');

const PWI = readFileSync(new URL('../paperwork-load-integration.js', import.meta.url), 'utf8');
const UNIFORM = readFileSync(new URL('../uniform-route-image-cells.js', import.meta.url), 'utf8');
check('no icon markup remains', /paperIconSvg/.test(PWI), false);
check('no indicator class remains', /mjapp-paperwork-indicator/.test(PWI + UNIFORM), false);
check('no extra wrapper is injected around the dropzone',
  /mjapp-image-cell-wrap/.test(PWI + UNIFORM), false);
checkTrue('what is left watches the modal rather than the whole document',
  /observer\.observe\(modal \|\| document\.documentElement/.test(PWI));

// ---------------------------------------------------------------------------
// 6. the Rate panel is not re-rendered differently a moment after it draws
// ---------------------------------------------------------------------------
console.log('\n6. the Rate box does not change size right after it renders');

const HIER = readFileSync(new URL('../daily-rate-hierarchy.js', import.meta.url), 'utf8');
const EXPLANATION = /RATE_PANEL_EXPLANATION = "([^"]+)";/;
const inBoard = BOARD.match(EXPLANATION);
const inHier = HIER.match(EXPLANATION);
checkTrue('loadboard.js declares the shared explanation', !!inBoard);
checkTrue('daily-rate-hierarchy.js declares it too', !!inHier);
check('both files say exactly the same thing', inBoard?.[1], inHier?.[1]);
checkTrue('the renderer uses the constant rather than its own wording',
  /<div class="subtext" style="margin: -4px 0 10px;">\$\{escapeHtml\(RATE_PANEL_EXPLANATION\)\}<\/div>/.test(BOARD));

// The two money formatters have to agree, or every figure in the box changes
// width the moment the decorator runs.
const boardMoney = (n) => (n == null || isNaN(n) ? '—' : `$${Number(n).toFixed(2)}`);
const hierMoneyBody = HIER.match(/function money\(value\) \{[\s\S]*?\n\}/)[0];
const hierMoney = new Function(`${hierMoneyBody}\nreturn money;`)();
for (const n of [0, 400, 1234.5, 62.125, null]) {
  check(`money(${JSON.stringify(n)}) matches the renderer`, hierMoney(n), boardMoney(n));
}

checkTrue('the decorator compares rendered text, not a wiped dataset signature',
  /if \(!sameRenderedText\(box, html\)\) box\.innerHTML = html;/.test(HIER));
check('the old signature guard is gone', /hierarchySig/.test(HIER), false);

// sameRenderedText must see through the whitespace difference between the two
// renderers, and still notice a real change.
const sameBody = HIER.match(/const scratchNode[\s\S]*?\nfunction sameRenderedText\(el, html\) \{[\s\S]*?\n\}/)[0];
const sameRenderedText = new Function('document', `${sameBody}\nreturn sameRenderedText;`)(document);
const boardish = document.createElement('div');
boardish.innerHTML = `<div class="rate-section-subheader">How this was calculated</div>
          <div class="rate-breakdown-row">
            <span>Base</span>
            <span class="subtext">61-140 mi</span>
            <span>$400.00</span>
          </div>`;
const hierish = '<div class="rate-section-subheader">How this was calculated</div>'
  + '<div class="rate-breakdown-row"><span>Base</span><span class="subtext">61-140 mi</span><span>$400.00</span></div>';
check('identical content with different whitespace is left alone',
  sameRenderedText(boardish, hierish), true);
check('a genuinely changed figure is still rewritten',
  sameRenderedText(boardish, hierish.replace('$400.00', '$450.00')), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
