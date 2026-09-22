/*
 * Regression test for the board's note and change-history logging.
 *
 * Both are logged on focusout, which is the right moment in principle. But the
 * board redraws while a dispatcher is typing -- realtime echoes, debounced
 * saves -- and a redraw replaces the focused input, firing focusout with
 * whatever partial text happened to be on screen. One sentence therefore
 * became a row per redraw:
 *
 *   "store"                                          7:48:54 PM
 *   "store did not have S"                           7:48:58 PM
 *   "store did not have Salvage for driver to..."    7:49:10 PM
 *
 * Only the last line is the note. In load_change_history the same thing made
 * 740 of 36,352 entries keystroke fragments rather than changes.
 *
 * The merge itself lives in SQL (log_board_note / log_load_change) because it
 * has to be atomic and has to hold for any caller -- see
 * supabase/migrations/20260922_coalesce_keystroke_notes_and_changes.sql, which
 * records the checks run against the live database. What this test pins is the
 * browser half: that these two functions go through those RPCs and never back
 * to a bare INSERT, that they pass the arguments the functions expect, and that
 * the guards which avoid a pointless round trip are still there.
 *
 * Run: npm i --no-save jsdom && node scripts/note-keystroke-coalescing.test.mjs
 */

import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}

// Lift a function body straight out of the shipped file so the test cannot
// drift from what actually runs.
function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// A Supabase stub that records rpc() calls and screams if anyone inserts.
function makeClient(recorder) {
  return {
    rpc: async (name, args) => { recorder.rpc.push({ name, args }); return { data: 1, error: null }; },
    from: (table) => ({
      insert: (payload) => {
        recorder.inserts.push({ table, payload });
        const res = Promise.resolve({ data: [{ id: 1 }], error: null });
        res.select = () => Promise.resolve({ data: [{ id: 1 }], error: null });
        return res;
      },
    }),
  };
}

async function run(fnSource, fnName, call, { label = 'user one' } = {}) {
  const recorder = { rpc: [], inserts: [], errors: [] };
  const sandbox = {
    supabaseClient: makeClient(recorder),
    currentUserLabel: label,
    LOAD_NOTES_TABLE: 'load_notes',
    console: { error: (...a) => recorder.errors.push(a.join(' ')) },
  };
  const factory = new Function(
    ...Object.keys(sandbox),
    `${fnSource}; return ${fnName};`
  );
  const fn = factory(...Object.values(sandbox));
  await call(fn);
  return recorder;
}

// ---------------------------------------------------------------------------
console.log('1. a board note is logged through log_board_note, not an INSERT');

const noteSrc = extractFunction(SRC, 'logBoardNoteToPermanentLog');
let r = await run(noteSrc, 'logBoardNoteToPermanentLog',
  (fn) => fn(16118, 'store did not have Salvage for driver to take back. '), { label: 'molly' });

check('no bare INSERT into load_notes', r.inserts.length, 0);
check('one rpc call', r.rpc.length, 1);
check('it is log_board_note', r.rpc[0]?.name, 'log_board_note');
check('shift id passed as p_shift_id', r.rpc[0]?.args?.p_shift_id, 16118);
check('text passed as p_note_text', r.rpc[0]?.args?.p_note_text,
  'store did not have Salvage for driver to take back. ');
check('author passed as p_created_by', r.rpc[0]?.args?.p_created_by, 'molly');
check('nothing was logged as an error', r.errors.length, 0);

console.log('\n2. it still refuses to log nothing');
for (const [what, args] of [
  ['blank text', [16118, '   ']],
  ['empty text', [16118, '']],
  ['no shift id', [null, 'a real note']],
]) {
  const rr = await run(noteSrc, 'logBoardNoteToPermanentLog', (fn) => fn(...args));
  check(`${what}: no rpc, no insert`, rr.rpc.length + rr.inserts.length, 0);
}

// ---------------------------------------------------------------------------
console.log('\n3. a change-history entry goes through log_load_change');

const changeSrc = extractFunction(SRC, 'logChange');
r = await run(changeSrc, 'logChange',
  (fn) => fn(16118, 'PRO 884512', 'route_id', 'FRGT', 'FRGT 2'), { label: 'molly' });

check('no bare INSERT into load_change_history', r.inserts.length, 0);
check('one rpc call', r.rpc.length, 1);
check('it is log_load_change', r.rpc[0]?.name, 'log_load_change');
check('shift id', r.rpc[0]?.args?.p_shift_id, 16118);
check('label', r.rpc[0]?.args?.p_load_label, 'PRO 884512');
check('field name', r.rpc[0]?.args?.p_field_name, 'route_id');
check('old value preserved', r.rpc[0]?.args?.p_old_value, 'FRGT');
check('new value', r.rpc[0]?.args?.p_new_value, 'FRGT 2');
check('author', r.rpc[0]?.args?.p_changed_by, 'molly');

console.log('\n4. and it still does not log a non-change');
for (const [what, args] of [
  ['first entry into a blank field', [16118, 'L', 'route_id', '', 'FRGT']],
  ['blank-ish before', [16118, 'L', 'route_id', '   ', 'FRGT']],
  ['null before', [16118, 'L', 'route_id', null, 'FRGT']],
  ['value unchanged', [16118, 'L', 'route_id', 'FRGT', 'FRGT']],
]) {
  const rr = await run(changeSrc, 'logChange', (fn) => fn(...args));
  check(`${what}: no rpc, no insert`, rr.rpc.length + rr.inserts.length, 0);
}

// ---------------------------------------------------------------------------
console.log('\n5. the modal note path is deliberately left as an INSERT');
// It has an explicit Submit button, so it cannot produce a keystroke chain --
// and it needs the inserted row back to update the open modal.
const modalSrc = extractFunction(SRC, 'submitLoadNote');
check('submitLoadNote still inserts', /from\(LOAD_NOTES_TABLE\)[\s\S]{0,40}\.insert\(/.test(modalSrc), true);
check('submitLoadNote does not call an rpc', /\.rpc\(/.test(modalSrc), false);
check('and it still tags itself as source "modal"', /source: "modal"/.test(modalSrc), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
