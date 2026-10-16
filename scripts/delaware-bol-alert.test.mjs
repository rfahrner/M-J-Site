/*
 * Delaware's BOL-photo request: who it asks for, and when.
 *
 * "need a new text alert for Delaware, this needs send to every delaware
 *  driver at the start of every shift"
 *
 * Two things make this worth pinning rather than eyeballing.
 *
 * ONE: the shift clock. loads_shifts.shift_start holds BOTH "1300" and
 * "13:00", and which one you get depends on who entered the day rather than
 * on the row -- Delaware's 2026-10-15 was ten bare-digit shifts, its
 * 2026-10-13 eight colon ones, 114 of 206 bare over thirty days. This file's
 * parser used to accept only the colon form, so on a bare-digit day every
 * shift read as "no start time" and the alert would have been absent for the
 * entire day with nothing on screen saying so. Case 1 is that whole day.
 *
 * TWO: midnight. Delaware starts shifts at 0001, 0200 and 2200. At 02:00 the
 * shift that needs this text belongs to yesterday's date, so a plain
 * "shift_date === today" test would never prompt the night dispatcher for it.
 * Eligibility is therefore measured on the board's own shift-relative
 * timeline, with the same twelve-hour operating window the alert scan uses --
 * which is also the thing that stops "stays until sent" meaning "forever".
 *
 * The clock functions here are the REAL ones from overnight-times.js. Only
 * the database and the current instant are faked.
 *
 * Run: node --test scripts/delaware-bol-alert.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('preshift-pro-text.js', 'utf8');
// The repo has no "type": "module", so a .js file cannot be imported as one.
// Every test here reads the source and strips `export`, which is the house
// style -- and it has the advantage that the clock code under test is the
// shipped text of overnight-times.js, not a second copy of its rules.
const TIMES = fs.readFileSync('overnight-times.js', 'utf8').replace(/^export /gm, '');
const BOARD = fs.readFileSync('loadboard.js', 'utf8');

// The REAL phone validator, lifted from loadboard.js. Supplying a stub would
// defeat the point: the bug this guards against was the alert using a looser
// notion of "has a phone" than openSendTextModal() does.
function liftBoard(name) {
  const m = BOARD.match(new RegExp(`^  (?:export )?function ${name}\\([^]*?\\n  \\}`, 'm'));
  if (!m) throw new Error(`cannot lift ${name} from loadboard.js`);
  return m[0].replace(/^  export /, '  ');
}

function lift(name) {
  // A one-liner first: `function clean(v) { ... }` has no `\n}` of its own, so
  // the block form below would swallow everything down to the next function's
  // closing brace and silently redeclare whatever was in between.
  const one = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\(.*\\}$`, 'm'));
  const m = one || src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`cannot lift ${name}`);
  return m[0].replace(/^export /, '');
}
function liftConst(name) {
  const m = src.match(new RegExp(`^const ${name} = [^]*?;$`, 'm'));
  if (!m) throw new Error(`cannot lift const ${name}`);
  return m[0];
}

// The parser binding is LIFTED, not supplied. Writing `const parseHHMM =
// clockMinutes` into the harness by hand made case 1 test clockMinutes rather
// than the shipped code: putting the old colon-only parser back into
// preshift-pro-text.js left all seventeen cases green.
const PARSER = liftConst('parseHHMM');

// Every shift_date in the fixtures is relative to one frozen instant, so the
// test says nothing different in the small hours than it does at noon.
const AT = (iso) => new Date(iso);

function build(rows, nowIso, { location = 'delaware', error = null } = {}) {
  const calls = [];
  const query = { table: null, filters: {} };
  const builder = {
    select(cols) { query.select = cols; return builder; },
    eq(col, val) { query.filters[`eq:${col}`] = val; return builder; },
    in(col, vals) { query.filters[`in:${col}`] = vals; return builder; },
    is(col, val) { query.filters[`is:${col}`] = val; return builder; },
    then(resolve) { calls.push({ ...query, filters: { ...query.filters } }); return Promise.resolve(error ? { data: null, error } : { data: rows, error: null }).then(resolve); },
  };
  const supabaseClient = { from(table) { query.table = table; return builder; } };

  const RealDate = Date;
  const frozen = AT(nowIso);
  function FakeDate(...args) { return args.length ? new RealDate(...args) : new RealDate(frozen.getTime()); }
  FakeDate.now = () => frozen.getTime();
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const scope = SCOPE(supabaseClient, () => location, async () => new Map(), FakeDate);
  return { run: () => scope.delawareBolAlerts(), calls };
}

// One compiled scope, instantiated per case with its own frozen clock.
const SCOPE = new Function(
  'supabaseClient', 'currentLocation', 'driverMap', 'Date',
  `
  ${TIMES}
  ${liftBoard('formatTextAddress')}
  ${liftBoard('formatTextAddresses')}
  ${lift('clean')}
  ${lift('esc')}
  ${PARSER}
  ${liftConst('BOL_NAMES_SHOWN')}
  ${liftConst('UNKNOWN_START_WINDOW_MIN')}
  ${lift('extraAlertHtml')}
  ${lift('delawareBolAlerts')}
  return { delawareBolAlerts, clockMinutes, offsetDate, OPERATING_WINDOW_MIN, formatTextAddresses };
  `,
);
const { clockMinutes, offsetDate, OPERATING_WINDOW_MIN, formatTextAddresses } = SCOPE(null, () => null, null, Date);

let autoId = 1;
const shift = (over = {}) => ({
  id: autoId++, shift_date: over.shift_date, shift_start: over.shift_start ?? '1300',
  driver_id: null, driver_name_text: over.driver_name_text ?? 'Test Driver',
  driver_cell_snapshot: over.driver_cell_snapshot ?? '3025551234',
  shift_complete: false, called_off: false, tonu: false, load_cancelled: false,
  bol_text_sent_at: null, ...over,
});

// A fixed afternoon and a fixed small-hours instant, both in New York terms.
const NOON = '2026-10-15T18:00:00Z';        // 14:00 EDT on the 15th
const SMALL_HOURS = '2026-10-16T06:00:00Q'.replace('Q', 'Z'); // 02:00 EDT on the 16th
const DAY15 = '2026-10-15', DAY16 = '2026-10-16';

const textOf = (html) => /class="alert-chat-text">([^<]*)</.exec(html)?.[1] ?? '';
const idsOf = (html) => /data-delaware-bol-shifts="([^"]*)"/.exec(html)?.[1] ?? null;

// ---------------------------------------------------------------------------
test('1. a whole bare-digit day is seen, exactly like a colon day', async () => {
  // This is Delaware 2026-10-15 as it is actually stored: ten shifts, every
  // shift_start bare. Under the old colon-only parser this produced nothing.
  const bare = ['1300', '1300', '1400', '1400', '1600', '1700', '2000'].map((shift_start, i) =>
    shift({ shift_date: DAY15, shift_start, driver_name_text: `Bare ${i}` }));
  const { run } = build(bare, NOON);
  const extras = await run();
  const started = idsOf(extras[0].html).split(',');
  // 13:00, 13:00, 14:00, 14:00 have started by 14:00; 16:00, 17:00, 20:00 have not.
  assert.equal(started.length, 4, textOf(extras[0].html));

  const colon = ['13:00', '13:00', '14:00', '14:00', '16:00', '17:00', '20:00'].map((shift_start, i) =>
    shift({ shift_date: DAY15, shift_start, driver_name_text: `Colon ${i}` }));
  const same = await build(colon, NOON).run();
  assert.equal(idsOf(same[0].html).split(',').length, 4, 'the two formats must not disagree');
});

test('2. a shift that has not started yet is not asked for its BOLs', async () => {
  const { run } = build([shift({ shift_date: DAY15, shift_start: '2000' })], NOON);
  assert.deepEqual(await run(), []);
});

test('3. the exact minute of the start counts as started', async () => {
  const { run } = build([shift({ shift_date: DAY15, shift_start: '1400' })], NOON);
  const extras = await run();
  assert.equal(extras.length, 1);
  assert.ok(idsOf(extras[0].html), 'and it is textable');
});

test('4. yesterday\'s night shift is still asked at 02:00 -- the reason the window is shift-relative', async () => {
  const { run } = build([shift({ shift_date: DAY15, shift_start: '2200' })], SMALL_HOURS);
  const extras = await run();
  assert.equal(extras.length, 1, 'a 22:00 shift is four hours old at 02:00, not over');
});

test('5. a shift past the operating window has stopped being live', async () => {
  // 13:00 yesterday, seen at 14:00 today: 25 hours. "Stays until sent" cannot
  // mean a dead shift nags forever.
  const stale = build([shift({ shift_date: DAY15, shift_start: '1300' })], '2026-10-16T18:00:00Z');
  assert.deepEqual(await stale.run(), []);

  // And the edge itself, measured in both directions.
  const inside = build([shift({ shift_date: DAY16, shift_start: '0200' })], '2026-10-16T18:00:00Z');  // 12h exactly
  assert.equal((await inside.run()).length, 1, `${OPERATING_WINDOW_MIN} minutes in is still live`);
  const outside = build([shift({ shift_date: DAY16, shift_start: '0159' })], '2026-10-16T18:00:00Z'); // 12h01
  assert.deepEqual(await outside.run(), [], 'one minute past the window is over');
});

test('6. the query asks only for shifts nobody has texted yet', async () => {
  const { run, calls } = build([], NOON);
  await run();
  assert.equal(calls[0].table, 'loads_shifts');
  assert.equal(calls[0].filters['is:bol_text_sent_at'], null,
    'without this the alert re-asks for shifts already sent');
  assert.equal(calls[0].filters['eq:location'], 'delaware');
  assert.deepEqual(calls[0].filters['in:shift_date'], [DAY15, DAY15, DAY16].map((_, i) => offsetDate(DAY15, i - 1)),
    'yesterday, today and tomorrow -- yesterday is what carries a night shift over midnight');
});

test('7. a settled shift is never asked', async () => {
  for (const field of ['shift_complete', 'called_off', 'tonu', 'load_cancelled']) {
    const { run } = build([shift({ shift_date: DAY15, shift_start: '1300', [field]: true })], NOON);
    assert.deepEqual(await run(), [], `${field} should settle the shift`);
  }
});

test('8. a missing Shift Start is reported, not silently skipped', async () => {
  const { run } = build([
    shift({ shift_date: DAY15, shift_start: '', driver_name_text: 'No Clock' }),
    shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: 'Has Clock' }),
  ], NOON);
  const extras = await run();
  assert.equal(extras.length, 2);
  assert.match(textOf(extras[0].html), /Has Clock/);
  assert.match(textOf(extras[1].html), /no Shift Start/);
  assert.match(textOf(extras[1].html), /No Clock/);
  assert.equal(idsOf(extras[1].html), null, 'there is nothing to send until the start time is entered');
});

test('8b. a YESTERDAY-dated shift with an unreadable start is reported too', async () => {
  // The first version of this gate read `shift_date === today`, which also
  // excluded yesterday -- the whole population the three-day window exists
  // for. At 02:00 a yesterday-dated shift with a blank Shift Start produced
  // nothing at all: no ask, and no notice that there was nothing to ask with.
  for (const shift_start of ['', 'TBD', 'ASAP']) {
    const { run } = build([shift({ shift_date: DAY15, shift_start, driver_name_text: 'Night Blank' })], SMALL_HOURS);
    const extras = await run();
    assert.equal(extras.length, 1, `shift_start ${JSON.stringify(shift_start)} vanished`);
    assert.match(textOf(extras[0].html), /no Shift Start/);
  }
  // ...and it stops once that day cannot still be running: 23:59 + the
  // operating window is as late as an unknown start could reach.
  const late = build([shift({ shift_date: DAY15, shift_start: '' })], '2026-10-16T20:00:00Z'); // 16:00 EDT
  assert.deepEqual(await late.run(), [], 'a day-old blank start must not nag into the next afternoon');
});

test('9. a blank Shift Start on a shift pencilled in for tomorrow does not nag today', async () => {
  const { run } = build([shift({ shift_date: DAY16, shift_start: '' })], NOON);
  assert.deepEqual(await run(), []);
});

test('10. a driver with no phone number is named rather than dropped', async () => {
  const { run } = build([
    shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: 'Reachable' }),
    shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: 'Unreachable', driver_cell_snapshot: '' }),
  ], NOON);
  const extras = await run();
  const text = textOf(extras[0].html);
  assert.match(text, /without a usable phone number \(Unreachable\)/);
  assert.equal(idsOf(extras[0].html).split(',').length, 1, 'only the reachable one is texted');
});

test('10b. a phone the text gateway would reject counts as no phone, not as sendable', async () => {
  /*
   * This is the one that mattered. openSendTextModal() drops any recipient
   * formatTextAddresses() rejects, but the shift ids handed to onSent are
   * frozen before the modal runs -- so a driver stored as "7208173663 x2" was
   * never texted while their shift was stamped bol_text_sent_at, which removes
   * it from the alert's query for good. Nobody is ever asked again, and the
   * only trace is a note in a collapsed <details> of a modal that has closed.
   *
   * These shapes are the ones scripts/text-phone-validation.test.mjs records
   * as actually reported from the board.
   */
  const bad = ['7208173663 x2', '7208173663 ext 12', '720817366', '4708196730 / invalid', '72081736637208177007'];
  for (const phone of bad) {
    assert.deepEqual(formatTextAddresses(phone), [], `${phone} should be unsendable`);
    const { run } = build([
      shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: 'Good', driver_cell_snapshot: '3025551234' }),
      shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: 'Bad', driver_cell_snapshot: phone }),
    ], NOON);
    const extras = await run();
    assert.equal(idsOf(extras[0].html).split(',').length, 1, `${phone} was offered as sendable`);
    assert.match(textOf(extras[0].html), /1 without a usable phone number \(Bad\)/, textOf(extras[0].html));
  }
  // A number with separators the gateway DOES accept stays sendable.
  const ok = build([shift({ shift_date: DAY15, shift_start: '1300', driver_cell_snapshot: '(302) 555-1234' })], NOON);
  assert.equal(idsOf((await ok.run())[0].html).split(',').length, 1);
});

test('11. when nobody on shift has a phone, the alert says so instead of offering a dead button', async () => {
  const { run } = build([shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: 'Unreachable', driver_cell_snapshot: '' })], NOON);
  const extras = await run();
  assert.equal(idsOf(extras[0].html), null);
  assert.match(textOf(extras[0].html), /cannot be texted/);
});

test('12. an empty row with no driver at all is not a person to text', async () => {
  const { run } = build([shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: '', driver_cell_snapshot: '' })], NOON);
  assert.deepEqual(await run(), []);
});

test('13. the names list stops before it pushes the Text button off the widget', async () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    shift({ shift_date: DAY15, shift_start: '1300', driver_name_text: `Driver ${i}` }));
  const extras = await build(many, NOON).run();
  const text = textOf(extras[0].html);
  assert.match(text, /\+3 more/, text);
  assert.equal(idsOf(extras[0].html).split(',').length, 9, 'all nine are still texted');
});

test('14. the alert belongs to the Delaware board only', async () => {
  const { run } = build([shift({ shift_date: DAY15, shift_start: '1300' })], NOON, { location: 'atlanta' });
  assert.deepEqual(await run(), []);
});

test('18. a query failure is reported, and does not take the call alerts down with it', async () => {
  // refreshExtraAlerts() wraps every extra source in ONE try/catch, so a throw
  // from here deletes the PA/FA call alerts too. The likeliest cause is also
  // the worst: this code deployed before the migration, so the column is
  // missing and every refresh wipes the board's call alerts.
  const { run } = build([], NOON, { error: { message: 'column loads_shifts.bol_text_sent_at does not exist' } });
  const extras = await run();
  assert.equal(extras.length, 1, 'it reports rather than throwing');
  assert.match(textOf(extras[0].html), /could not check/);
  assert.equal(idsOf(extras[0].html), null);
});

test('19a. the send marks only shifts the modal will actually address', () => {
  // The filter and the id list must come from the SAME test, or the two drift
  // and a dropped recipient's shift is marked sent anyway.
  const handler = lift('handleDelawareBolClick');
  const code = handler.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /\.filter\(\(person\) => formatTextAddresses\(person\.phone\)\.length > 0\)/,
    'sendability must be formatTextAddresses(), not a truthy phone string');
  assert.match(code, /const shiftIds = sendable\.map\(/,
    'the marked ids must be derived from the filtered list');
});

test('19. the send re-reads by id and skips anything already sent', () => {
  // The alert may have been painted a minute ago and another dispatcher may
  // have sent it since; without both of these the second dispatcher texts the
  // whole shift again. The browser spec cannot check this -- the sandbox fake
  // answers from() without honouring the WHERE -- so it is pinned here.
  const handler = lift('handleDelawareBolClick');
  assert.match(handler, /\.in\('id', ids\)/);
  assert.match(handler, /\.is\('bol_text_sent_at', null\)/);
});

// ---------------------------------------------------------------------------
// Pinned against the source rather than run, because they are about which
// column is written and which argument carries it.
test('15. the message is Ron\'s wording, character for character', () => {
  const wanted = 'Please send a photo of your BOL(s)-with the Route number it is for this shift (e.g.: 1st Route, 2nd route, 3rd Load) to this text thread OR text it in, also confirm how many stops, and total miles for the route w/ photo of each BOL.';
  const got = /^const DELAWARE_BOL_MESSAGE = '(.*)';$/m.exec(src)?.[1];
  assert.equal(got, wanted.replaceAll("'", "\\'"));
});

test('16. sending marks its own column, not the ETA reminder\'s', () => {
  const handler = lift('handleDelawareBolClick');
  // Comments stripped: this one explains why the ETA marker is NOT used, and
  // would otherwise fail the very assertion it documents.
  const code = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[^]*?\*\//g, '');
  assert.ok(!/pre_shift_text_sent/.test(code),
    'the ETA marker must not be touched -- sharing it would make either text silence the other');
  // The third argument of openSendTextModal is the pre-shift marker, so it has
  // to be null here and the write has to happen in onSent.
  assert.match(code, /DELAWARE_BOL_MESSAGE,\s*null,/);
  assert.match(lift('markBolTextSent'), /bol_text_sent_at/);
  assert.match(code, /onSent:/);
});

test('17. the operating window is the board\'s, not a second opinion', () => {
  assert.equal(OPERATING_WINDOW_MIN, 720);
  assert.match(src, /OPERATING_WINDOW_MIN.*from '\.\/overnight-times\.js'/,
    'imported, not re-declared -- a local copy is free to drift, which is exactly how the clock parser broke');
  assert.equal(PARSER, 'const parseHHMM = clockMinutes;',
    'the private parser must stay deleted -- any local re-implementation, arrow form included, is free to drift again');
  assert.ok(!/function parseHHMM/.test(src));
  assert.equal(clockMinutes('1300'), clockMinutes('13:00'));
});
