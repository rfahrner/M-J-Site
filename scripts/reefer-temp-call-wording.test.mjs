/*
 * The PA/FA call alert is a REEFER TEMP check, and three surfaces have to say so.
 *
 * "it needs to say something like, driver is pulling a reefer, we need to
 *  verify that the driver has confirmed the temp on the reefer"
 *
 * isCallRequiredRoute() fires this alert on PA/FA routes only, and those are
 * the reefer loads. The call exists so somebody confirms with the driver that
 * the reefer temperature is set -- which makes the wording an ATTESTATION,
 * not decoration:
 *
 *   1. the alert on the board, which is what a dispatcher reads first;
 *   2. the modal, which is what they are agreeing to when they type their name;
 *   3. load_change_history, written by acknowledge_special_route_call() and
 *      the only part that still exists a month later.
 *
 * (3) is the one worth a test. If a load is ever questioned on temperature,
 * that row is the evidence, and a note saying "Driver call confirmed" while
 * the screen said "verify the driver has confirmed the temperature" records
 * less than the dispatcher actually attested to. Nothing but this file reads
 * the two together, and nothing pinned the modal's text at all before now.
 *
 * The modal is RENDERED here rather than regexed, because what matters is
 * what a dispatcher sees, and a source match passes on text that never
 * reaches the screen.
 *
 * Run: npm i --no-save jsdom && node scripts/reefer-temp-call-wording.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const SRC = read('preshift-pro-text.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

function lift(name) {
  const one = SRC.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\(.*\\}$`, 'm'));
  const m = one || SRC.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`cannot lift ${name}`);
  return m[0].replace(/^export /, '');
}

// ---------------------------------------------------------------------------
console.log('\n1. the modal a dispatcher actually sees');

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.invalid/index.html' });
const { window } = dom;
const scope = new window.Function(
  'supabaseClient', 'scheduleRefresh', 'document', 'window',
  `
  ${lift('clean')}
  ${lift('esc')}
  ${lift('showSpecialRouteCallModal')}
  return showSpecialRouteCallModal;
  `,
);
const open = scope({ rpc: async () => ({ data: true, error: null }) }, () => {}, window.document, window);

await open({ dataset: {
  specialCallTrip: '41695', specialCallEvent: 'evt-1',
  specialCallRoute: 'PA6074', specialCallDriver: 'Raldo Clarke',
} });

const modal = window.document.getElementById('special-route-call-modal');
const text = modal.textContent.replace(/\s+/g, ' ').trim();
const heading = modal.querySelector('h2').textContent.trim();
const submit = modal.querySelector('[type="submit"]').textContent.trim();

check('it opened', !!modal, true);
check('the heading names the reefer check', /Reefer Temp/i.test(heading), true);
check('the body says the driver is pulling a reefer', /pulling a reefer/i.test(text), true);
check('and that the TEMPERATURE is what gets verified', /confirmed the temperature on the reefer/i.test(text), true);
check('the driver and route are still named', /Raldo Clarke/.test(text) && /PA6074/.test(text), true);
check('it still says the confirmation clears the alert for everyone',
  /clear this alert for every dispatcher/i.test(text), true);

// The button is the moment of attestation, so it has to name what is being
// attested. "Confirm Call" under text about a temperature is a mismatch.
check('the button names the verification, not just the call', /Temp/i.test(submit), true);
check('it is no longer the bare "Confirm Call"', submit === 'Confirm Call', false);

console.log('\n2. the alert on the board says the same thing');
// What a dispatcher reads before they click anything.
const alertLine = /text:`\$\{name\} \(\$\{shift\.pro_number \|\| 'No PRO'\}, \$\{label\}\) — ([^`]*)`/.exec(SRC)?.[1] || '';
check('it mentions the reefer', /reefer/i.test(alertLine), true);
check('it mentions the temp', /temp/i.test(alertLine), true);
check('and it still asks for the call', /call driver/i.test(alertLine), true);

console.log('\n3. the audit trail records the same claim');
/*
 * load_change_history is the part that outlives the shift. A note that says
 * only "call confirmed" under-records what the dispatcher agreed to.
 */
const migrations = readdirSync(new URL('supabase/migrations/', root)).sort();
const ackFiles = migrations.filter((f) => /acknowledge_special_route_call/.test(read(`supabase/migrations/${f}`)));
check('there is a migration defining the acknowledgment', ackFiles.length > 0, true);
const latest = read(`supabase/migrations/${ackFiles.at(-1)}`);
const note = /'([^']*confirmed[^']*)' \|\| v_name/i.exec(latest)?.[1] || '';
check('the note names the reefer temp', /reefer temp/i.test(note), true);
check('and it is written by the dispatcher', /dispatcher $/.test(note) || /dispatcher\s*$/.test(note), true);

console.log('\n4. rewording the note did not quietly drop a guard');
/*
 * The migration is a `create or replace` of the WHOLE function, so a reword is
 * a copy of fifty lines in which a role check, the row lock, the PA/FA test or
 * one of the settled-shift guards could vanish without anyone noticing. Diff
 * the function bodies: exactly one line may differ, and it must be the note.
 */
const body = (sql) => {
  const m = /create or replace function public\.acknowledge_special_route_call[^]*?\n\$\$;/.exec(sql);
  if (!m) throw new Error('cannot find the function body');
  return m[0].split('\n');
};
const previous = ackFiles.length > 1 ? body(read(`supabase/migrations/${ackFiles.at(-2)}`)) : null;
if (previous) {
  const current = body(latest);
  check('same number of lines', current.length, previous.length);
  const differing = current.map((line, i) => [i, line, previous[i]]).filter(([, a, b]) => a !== b);
  check('exactly one line changed', differing.length, 1);
  check('and it is the history note', /load_change_history|confirmed/i.test(differing[0]?.[1] || ''), true);
} else {
  console.log('  --   only one acknowledgment migration; nothing to diff against');
}

console.log('\n5. the alert still belongs to reefer routes only');
// If this ever fires on something other than PA/FA, every sentence above
// becomes a lie on whatever load it lands on.
const rule = read('dispatch-route-text.js');
check('isCallRequiredRoute is still PA/FA',
  /export function isCallRequiredRoute[^]*?\/\^\(PA\|FA\)\/i/.test(rule), true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
