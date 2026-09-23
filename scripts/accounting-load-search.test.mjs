/*
 * Regression test: finding a load from the Accounting page.
 *
 * The sheet shows one location on one day, so the only way to reach a load
 * used to be already knowing its date and location -- usually the thing being
 * asked on the phone. This adds a search by Trip ID, Route ID, Load # or PRO #.
 *
 * Two facts about the real data decide the whole design, and both are easy to
 * "simplify" away later:
 *
 *   1. Matching is EXACT. loads_trips.trip_id and route_id are free text in
 *      practice -- 'TONU', 'txt 0441', 'Truck down @ 2230' are all live values
 *      -- so a contains-match on a short query buries the answer.
 *   2. One query legitimately finds MANY loads. 1,314 distinct trip_id values
 *      and 2,773 route_id values sit on more than one load; 'TONU' alone is on
 *      246. So: a result list, never a guess. One hit opens directly, because
 *      then there is nothing to choose between.
 *
 * Houston and Mondelez modals only have markup on their own pages, so those
 * results navigate there with the load's own date rather than trying to render
 * a modal that is not in the document.
 *
 * Run: npm i --no-save jsdom && node scripts/accounting-load-search.test.mjs
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

// ---------------------------------------------------------------------------
// The module imports loadboard.js, which cannot load outside a browser. Stand
// in for it so the real accounting-load-search.js runs unmodified.
const dir = mkdtempSync(join(tmpdir(), 'mj-acctsearch-'));
const calls = { rpc: [], opened: [], navigated: [] };
globalThis.__searchTestCalls = calls;

writeFileSync(join(dir, 'loadboard.mjs'), `
  const calls = globalThis.__searchTestCalls;
  export const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  export const $ = (sel) => document.querySelector(sel);
  export const supabaseClient = {
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: globalThis.__searchRows, error: null };
    },
  };
  export async function openLoadStandalone(dbId, opts) {
    calls.opened.push({ dbId, ...opts });
    return true;
  }
`);
writeFileSync(join(dir, 'search.mjs'),
  read('accounting-load-search.js').replace("'./loadboard.js'", "'./loadboard.mjs'"));

const dom = new JSDOM(`<!doctype html><body>
  ${/<div class="acct-search"[\s\S]*?<\/div>\s*<\/div>/.exec(read('accounting.html'))?.[0] || ''}
</body>`, { url: 'https://rfahrner.github.io/M-J-Site/accounting.html' });
globalThis.document = dom.window.document;
globalThis.URLSearchParams = dom.window.URLSearchParams;
let navigated = null;
globalThis.window = { location: { set href(v) { navigated = v; calls.navigated.push(v); }, get href() { return navigated; } } };

const search = await import(join(dir, 'search.mjs'));
search.initAccountingLoadSearch();

const $ = (s) => dom.window.document.querySelector(s);
const input = $('#acct-load-search-input');
const panel = () => $('#acct-load-search-results');
const settle = () => new Promise((r) => setTimeout(r, 0));

async function searchFor(text, rows) {
  globalThis.__searchRows = rows;
  input.value = text;
  $('#acct-load-search-go').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle(); await settle();
}

const hit = (over = {}) => ({
  source_table: 'loads_shifts', source_id: 16133, trip_db_id: null,
  shift_date: '2026-09-20', customer: 'Kroger', location: 'atlanta',
  load_number: '1993193', driver_name: 'Christopher Woods',
  matched_field: 'PRO #', matched_value: '1993193', total_matches: 1, ...over,
});

// ---------------------------------------------------------------------------
console.log('\n1. the markup the page ships is what this drives');
check('the search box is on the Accounting page', /id="acct-load-search"/.test(read('accounting.html')), true);
check('and the test is driving that same markup', !!input, true);
check('the placeholder names all four fields',
  input.getAttribute('placeholder'), 'Trip ID, Route ID, Load # or PRO #');

console.log('\n2. one match opens the load, with nothing to choose');
await searchFor('1993193', [hit()]);
check('it asked the server, once', calls.rpc.length, 1);
check('through the search function', calls.rpc[0].name, 'search_loads_by_identifier');
check('passing the typed value', calls.rpc[0].args.p_query, '1993193');
check('the load was opened', calls.opened.length, 1);
check('by its database id', calls.opened[0].dbId, '16133');

console.log('\n3. a route match opens on that route, not the overview');
calls.opened.length = 0;
await searchFor('WTR310', [hit({ trip_db_id: 40564, matched_field: 'Route ID', matched_value: 'WTR310' })]);
// route_id is a name, not a key: the same text repeats inside one load, so the
// trip's own row id is what says which route was meant.
check('the trip row id is carried through', calls.opened[0].tripDbId, '40564');

console.log('\n4. several matches are listed, never guessed between');
calls.opened.length = 0;
await searchFor('TONU', [
  hit({ source_id: 16133, matched_field: 'Trip ID', matched_value: 'TONU', total_matches: 246 }),
  hit({ source_id: 16090, shift_date: '2026-09-18', driver_name: 'Ronald Grey-C', matched_field: 'Trip ID', matched_value: 'TONU', total_matches: 246 }),
]);
check('nothing was opened', calls.opened.length, 0);
check('both are offered', panel().querySelectorAll('.acct-search-hit').length, 2);
// A list that stops at 50 without saying so reads as "that is all of them".
check('and it admits there are more', /246 loads match/.test(panel().textContent), true);
check('saying how many are shown', /Showing the 2 most recent of 246/.test(panel().textContent), true);
check('each row says which field matched', /Trip ID: TONU/.test(panel().textContent), true);
check('and whose load it is', /Ronald Grey-C/.test(panel().textContent), true);

console.log('\n5. clicking one opens it');
panel().querySelectorAll('.acct-search-hit')[1]
  .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await settle(); await settle();
check('the one clicked, not the first', calls.opened[0].dbId, '16090');

console.log('\n6. Houston and Mondelez go to their own board');
// Their modal markup exists only on those pages; rendering it here would fail
// silently, which is how this would look "done" and not work.
calls.opened.length = 0;
await searchFor('999489', [hit({ source_table: 'loads_houston', source_id: 6315, shift_date: '2022-09-16', location: 'houston' })]);
check('no modal was attempted here', calls.opened.length, 0);
check('it goes to the Houston board', calls.navigated.at(-1), 'houston.html?load=6315&date=2022-09-16');

await searchFor('1992938', [hit({ source_table: 'mondelez_loads', source_id: 1363, customer: 'Mondelez', location: 'westchester', shift_date: '2026-09-22' })]);
// The date AND the DC, because that board is one day and one location at a time.
check('and Mondelez carries its location too',
  calls.navigated.at(-1), 'mondelez.html?load=1363&date=2026-09-22&loc=westchester');

console.log('\n7. nothing found says why, rather than just nothing');
await searchFor('199319', []);
check('it reports the miss', /Nothing matches/.test(panel().textContent), true);
// The single most likely confusion: typing part of a number and getting zero.
check('and that the match is exact', /exact/.test(panel().textContent), true);

console.log('\n8. an empty box clears the results rather than searching');
const before = calls.rpc.length;
input.value = '   ';
$('#acct-load-search-go').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await settle();
check('no request went out', calls.rpc.length, before);
check('and the panel is hidden', panel().className.includes('hidden'), true);

console.log('\n9. the pieces it depends on exist');
const SRC = read('accounting-load-search.js');
const BOARD = read('loadboard.js');
// A builder/thenable has no .catch; the error must come off the awaited result.
check('the rpc result is awaited, not .catch()ed', /\.rpc\([^)]*\)\.catch\(/.test(SRC), false);
check('and its error is handled', /if \(error\) \{/.test(SRC), true);
check('loadboard exports the standalone opener', /export async function openLoadStandalone\(/.test(BOARD), true);
check('houston exports its deep-link opener', /export async function openHoustonLoadByDbId\(/.test(read('houston.js')), true);
check('mondelez exports its own', /export async function openMondelezLoadByDbId\(/.test(read('mondelez.js')), true);
check('the accounting page wires the search up', /initAccountingLoadSearch\(\);/.test(read('accounting.js')), true);
// New CSS: a browser holding the old stylesheet would show an unstyled list.
const pages = ['accounting.html', 'index.html', 'houston.html', 'mondelez.html', 'archive.html'];
const tokens = new Set(pages.map((p) => /loadboard\.css\?v=([^"']+)/.exec(read(p))?.[1]));
check('every page agrees on the stylesheet token', tokens.size, 1);
check('and it moved off the previous one', tokens.has('20260923-accounting-push'), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
