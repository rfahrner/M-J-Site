/*
 * Two Houston board bugs reported together on 2026-10-02.
 *
 * 1. "the calandar doesnt have the red dot on previous days where we have
 *    drivers run"
 *
 *    loadHoustonDatesWithData() asked for every shift_date in the browsable
 *    range in one query. That range is two years, PostgREST caps a response
 *    at 1,000 rows, and it says nothing when it does -- the array just
 *    arrives short. Houston had 1,165 rows across 104 days; 88 days got a
 *    dot and 16 did not, and all 16 missing ones were recent (2026-07-16
 *    onward), because the rows past the cap are the ones added last.
 *
 *    Atlanta was paged for exactly this reason and carried a comment saying
 *    so. Houston and Mondelez each kept their own unpaged copy. Three copies
 *    of one rule, two of them wrong, is why this is now one shared helper --
 *    a fourth board cannot forget it.
 *
 * 2. "several PRO#s did not have a profile button populate"
 *
 *    The cell renders its ↗ from `row.aljexNumber ? ... : ""`, true at DRAW
 *    time only. A number typed into a row already on screen got no button
 *    until something forced a redraw, so rows loaded with the page had one
 *    and rows filled in since did not, side by side.
 *
 * The helper returns null on failure rather than an empty Set, and callers
 * keep what they had: a blank calendar reads as "no loads ran", which is a
 * worse lie than a stale one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LB = readFileSync(join(root, 'loadboard.js'), 'utf8');
const HOU = readFileSync(join(root, 'houston.js'), 'utf8');
const MDZ = readFileSync(join(root, 'mondelez.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
function extract(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name);
}

// --- the real helper, driven against a fake PostgREST that enforces the cap.
const PAGE = 1000;
function makeClient(rowsByTable) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, filters: {}, _from: 0, _to: PAGE - 1 };
      const api = {
        select() { return api; },
        gte(col, v) { q.filters[`gte:${col}`] = v; return api; },
        lte(col, v) { q.filters[`lte:${col}`] = v; return api; },
        eq(col, v) { q.filters[`eq:${col}`] = v; return api; },
        order() { return api; },
        range(from, to) { q._from = from; q._to = to; return api; },
        then(resolve) {
          calls.push({ table, from: q._from, to: q._to, filters: { ...q.filters } });
          let rows = (rowsByTable[table] || []).filter((r) =>
            r.shift_date >= q.filters['gte:shift_date'] && r.shift_date <= q.filters['lte:shift_date'] &&
            (q.filters['eq:location'] === undefined || r.location === q.filters['eq:location']));
          rows = rows.slice().sort((a, b) => (a.shift_date < b.shift_date ? -1 : 1));
          // The cap: a range wider than 1,000 comes back truncated, no error.
          const size = Math.min(q._to - q._from + 1, PAGE);
          return resolve({ data: rows.slice(q._from, q._from + size), error: null });
        },
      };
      return api;
    },
  };
}
const state = { minDate: '2024-10-02', maxDate: '2026-10-16' };
function buildHelper(client) {
  return new Function('supabaseClient', 'state', `${extract(LB, 'fetchDatesWithData').replace(/^export /, '')}; return fetchDatesWithData;`)(client, state);
}

// 1,165 Houston rows over 104 days, shaped like the real table.
const houstonRows = [];
for (let d = 0; d < 104; d++) {
  const day = new Date(Date.UTC(2025, 0, 1) + d * 86400000).toISOString().slice(0, 10);
  const n = d < 88 ? 11 : 12;
  for (let i = 0; i < n; i++) houstonRows.push({ shift_date: day });
}

console.log('\n1. every day with a driver gets a dot, past the 1,000-row cap');
let client = makeClient({ loads_houston: houstonRows });
let dates = await buildHelper(client)('loads_houston');
check('the fixture really is over the cap', houstonRows.length > PAGE, true);
check('every distinct day came back', dates.size, 104);
check('it took more than one request', client.calls.length > 1, true);
check('paging by range, not re-asking for the same slice',
  client.calls[1].from, PAGE);

console.log('\n2. one page is one request');
client = makeClient({ loads_houston: houstonRows.slice(0, 40) });
dates = await buildHelper(client)('loads_houston');
check('a short table stops immediately', client.calls.length, 1);
check('and still reports its days', dates.size > 0, true);

console.log('\n3. an empty table is not an error');
client = makeClient({ loads_houston: [] });
dates = await buildHelper(client)('loads_houston');
check('no days, no dots, no crash', dates.size, 0);

console.log('\n4. a filter still applies on every page');
const mixed = houstonRows.map((r, i) => ({ ...r, location: i % 2 ? 'atlanta' : 'delaware' }));
client = makeClient({ loads_shifts: mixed });
dates = await buildHelper(client)('loads_shifts', (q) => q.eq('location', 'atlanta'));
check('the filter reached the first page', client.calls[0].filters['eq:location'], 'atlanta');
for (let i = 1; i < client.calls.length; i++) {
  check(`and page ${i + 1}`, client.calls[i].filters['eq:location'], 'atlanta');
}

console.log('\n5. a failure keeps the old dots rather than blanking the calendar');
check('the helper returns null on error', /return null;/.test(extract(LB, 'fetchDatesWithData')), true);
for (const [page, src, fn] of [['houston', HOU, 'loadHoustonDatesWithData'], ['mondelez', MDZ, 'loadMondelezDatesWithData']]) {
  check(`${page} bails instead of assigning`, /const dates = await fetchDatesWithData\([A-Z_]+\);\s*if \(!dates\) return;/.test(extract(src, fn)), true);
}

console.log('\n6. all three boards use the one helper');
check('loadboard exports it', /export async function fetchDatesWithData\(/.test(LB), true);
check('Atlanta uses it', /fetchDatesWithData\(SHIFTS_TABLE, \(q\) => q\.eq\("location", locationKey\)\)/.test(LB), true);
check('Houston uses it', /fetchDatesWithData\(HOUSTON_TABLE\)/.test(HOU), true);
check('Mondelez uses it', /fetchDatesWithData\(MONDELEZ_TABLE\)/.test(MDZ), true);
check('Houston imports it rather than copying', /fetchDatesWithData,/.test(HOU), true);
check('Mondelez imports it rather than copying', /fetchDatesWithData,/.test(MDZ), true);
for (const [page, src] of [['houston.js', HOU], ['mondelez.js', MDZ]]) {
  check(`${page} keeps no unpaged copy`,
    /\.select\("shift_date"\)\s*\n?\s*\.gte\("shift_date"/.test(src), false);
}

console.log('\n7. the Aljex # link button appears when you leave the cell');
const focusout = /boardTable\.addEventListener\("focusout", \(e\) => \{([\s\S]*?)\n    \}\);/.exec(HOU)?.[1] || '';
check('Houston has a focusout handler', focusout.length > 0, true);
check('scoped to the Aljex # cell', /t\.dataset\.field !== "aljexNumber"/.test(focusout), true);
check('it reuses the cell-with-link wrapper the markup already draws',
  /closest\("\.cell-with-link"\)/.test(focusout), true);
check('it does not add a second button to a cell that has one',
  /if \(!btn\) \{/.test(focusout), true);
check('clearing the number removes it',
  /\} else if \(btn\) \{\s*btn\.remove\(\);/.test(focusout), true);
check('the button carries the row id the click handler reads',
  /btn\.dataset\.openHouLoad = t\.dataset\.row;/.test(focusout), true);
check('which is the same attribute the renderer emits',
  /data-open-hou-load="\$\{row\.id\}"/.test(HOU), true);
check('and the same one the click handler looks for',
  /closest\("\[data-open-hou-load\]"\)/.test(HOU), true);
check('on focusout, not input, so it does not flicker in mid-number',
  /addEventListener\("input"[\s\S]{0,400}aljexNumber[\s\S]{0,200}cell-link-btn/.test(HOU), false);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
