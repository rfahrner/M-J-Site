/*
 * Regression test: the Rate column is hidden, and that is ALL it is.
 *
 * The board's Rate cell recalculated under the dispatcher's eyes -- worst on
 * 2026-09-22, when two clients disagreed and it strobed between two numbers --
 * on a screen people read for times and routes. So the column goes away.
 *
 * What must NOT go away is the value behind it. `loads_shifts.carrier_rate` is
 * what Accounting bills from: `auto_send_shifts_to_accounting()` prices every
 * load off it and `accounting-pricing-v2.js` reads it back. Hiding a column is
 * cosmetic; stopping the calculation would change what customers are charged.
 * This test exists to make that distinction hard to erase by accident.
 *
 * Hidden, not deleted: `hiddenCols` is not persisted anywhere, so the default
 * applies on every load, and a dispatcher who wants the column for an hour can
 * tick it in the Columns panel without a deploy.
 *
 * Run: node scripts/rate-column-hidden.test.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const BOARD = read('loadboard.js');
const CSS = read('loadboard.css');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// ---------------------------------------------------------------------------
console.log('\n1. the column is hidden by default');
const hiddenBlock = /hiddenCols: new Set\(\[([\s\S]*?)\]\)/.exec(BOARD);
check('the default hidden set is declared', !!hiddenBlock, true);
const hidden = [...(hiddenBlock?.[1] || '').matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
check('rate is in it', hidden.includes('rate'), true);

console.log('\n2. hidden, not deleted -- it can be turned back on');
check('it is offered in the Columns panel',
  /\{ key: "rate", label: "Rate" \}/.test(BOARD), true);
check('the stylesheet knows how to hide it',
  /table\.board\.hide-col-rate \.col-rate/.test(CSS), true);
// applyColumnVisibility drives off DRIVER_INFO_COLS, so a column that is not
// in that list can be hidden by default and never turned back on.
const APPLY = /function applyColumnVisibility\(\)[\s\S]*?\n  \}/.exec(BOARD)[0];
check('visibility is applied from the same list', /DRIVER_INFO_COLS/.test(APPLY), true);
// Nothing writes hiddenCols to storage, so the default is what everyone gets.
check('the hidden set is not persisted', /hiddenCols[\s\S]{0,80}localStorage/.test(BOARD), false);

console.log('\n3. the cell still exists, so nothing downstream loses its input');
check('the board still renders the Rate cell', /<td class="col-rate"/.test(BOARD), true);
check('with the editable field intact', /data-field="rate"/.test(BOARD), true);

// ---------------------------------------------------------------------------
console.log('\n4. the rate is STILL calculated and saved -- Accounting bills from it');
const RECOMPUTE = /function recomputeRowRate\(row, forceSave\)[\s\S]*?\n  \}/.exec(BOARD)[0];
check('recomputeRowRate still schedules a save', /scheduleShiftSave\(row\)/.test(RECOMPUTE), true);
check('and still assigns the calculated value', /row\.rate = nextRate;/.test(RECOMPUTE), true);
// The guards added after the flicker stay; hiding the column is not a reason
// to drop them.
check('it still refuses to price from an unloaded rate table',
  /breakdown\.notReady/.test(RECOMPUTE), true);
check('and still goes through the write limiter',
  /allowRateWrite\(/.test(RECOMPUTE), true);
check('carrier_rate is still what the shift payload carries',
  /carrier_rate: numOrNull\(row\.rate\)/.test(BOARD), true);
check('and Accounting still reads it',
  /Number\(shift\.carrier_rate\)/.test(read('accounting-pricing-v2.js')), true);

console.log('\n5. Atlanta keeps its Carrier Rate column');
// A different column: the driver's 61-140.9 MI card rate, read-only, never
// calculated or saved from the board, so it was never part of the problem.
check('still in the column list',
  /\{ key: "carrierRate", label: "Carrier Rate", location: "atlanta" \}/.test(BOARD), true);
check('and not hidden by default', hidden.includes('carrierRate'), false);

console.log('\n6. the stylesheet change reaches browsers');
// The hide rule is new CSS. A browser holding the old stylesheet would show
// the column anyway, so the token has to have moved with it.
const pages = readdirSync(new URL('../', import.meta.url))
  .filter((name) => name.endsWith('.html'))
  .map((name) => [name, read(name)])
  .filter(([, html]) => html.includes('loadboard.css'));
const tokens = new Set(pages.map(([, html]) => /loadboard\.css\?v=([^"']+)/.exec(html)?.[1]));
check('every page carries one shared token', tokens.size, 1);
check('and it is not the one that shipped before this change',
  tokens.has('20260922-row-hover'), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
