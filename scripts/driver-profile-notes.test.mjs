import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

process.env.TZ = 'America/Chicago';
const source = readFileSync(new URL('../driver-profile-notes.js', import.meta.url), 'utf8');
const { cancellationNotePayload, shiftStartMinutes, sortDriverNotes, driverNoteRowHtml } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cancellation = (id, date, time) => ({
  id, note_type: 'cancellation', created_at: '2026-09-18T21:53:37.336218Z', created_by: 'opstx',
  source_shift_date: date, source_shift_start: time, source_load_label: String(id), note_text: 'Driver cancelled.',
});

test('cancellation payload snapshots the shift and author, not time of cancellation', () => {
  const payload = cancellationNotePayload({ dbId: 100, shiftDate: '2026-09-13', shiftStart: '16:00', proNumber: '1984002' }, '5', 'Reason', 'opstx');
  assert.deepEqual(payload, {
    driver_id: 5, note_text: 'Reason', created_by: 'opstx', note_type: 'cancellation',
    source_shift_id: 100, source_shift_date: '2026-09-13', source_shift_start: '16:00', source_load_label: '1984002',
  });
});

test('normalizes board clocks and legacy spreadsheet fractions without inventing unknown times', () => {
  for (const [value, expected] of [['16:00', 960], ['1600', 960], ['02:00:00', 120], ['2:15 pm', 855], ['12 AM', 0], ['1.0833333333333333', 120], ['0.6666666667', 960], ['', null], [null, null], ['ASAP', null], ['99:00', null], ['12:78', null]]) {
    assert.equal(shiftStartMinutes(value), expected, value);
  }
});

test('mixes manual notes and cancellation shift times newest-first, not cancellation-entry time', () => {
  const input = [
    cancellation(1, '2026-09-13', '16:00'),
    cancellation(2, '2026-09-12', '1.0833333333333333'),
    { id: 3, note_text: 'Manual', created_at: '2026-09-13T20:00:00Z' }, // 15:00
    { id: 4, note_text: 'Newest manual', created_at: '2026-09-18T21:00:00Z' },
    cancellation(5, '2026-09-13', '17:00'),
  ];
  assert.deepEqual(sortDriverNotes(input).map(n => n.id), [4, 5, 1, 3, 2]);
  assert.deepEqual(input.map(n => n.id), [1, 2, 3, 4, 5]); // no mutation
});

test('equal dates and times have a stable tie-breaker', () => {
  assert.deepEqual(sortDriverNotes([cancellation(1, '2026-09-13', '16:00'), cancellation(2, '2026-09-13', '16:00')]).map(n => n.id), [2, 1]);
});

test('legacy note displays shift date, time, author and reason without the insertion timestamp or duplicate date', () => {
  const note = { ...cancellation(1, '2026-09-13', '16:00'), source_load_label: '1984002', note_text: 'Cancellation — 2026-09-13 — 1984002 — Another misunderstanding' };
  const html = driverNoteRowHtml(note, esc);
  assert.match(html, /9\/13\/2026 · 16:00/);
  assert.match(html, /By opstx/);
  assert.match(html, /Cancellation — Load 1984002 — Another misunderstanding/);
  assert.doesNotMatch(html, /9\/18\/2026|4:53:37|2026-09-13|ld-history-row|<strong|<b>/);
});

test('old cancellation strings remain readable when no metadata or author is known', () => {
  const html = driverNoteRowHtml({ created_at: '2026-09-18T21:53:37Z', note_text: 'Cancellation — 2026-09-12 — 1983673 — Reason' }, esc);
  assert.match(html, /9\/12\/2026 · time not recorded/);
  assert.match(html, /By User not recorded/);
  assert.doesNotMatch(html, /9\/18\/2026/);
});

test('manual notes use their own timestamp, keep their author, and share cancellation styling', () => {
  const html = driverNoteRowHtml({ created_at: '2026-09-18T21:53:37Z', created_by: 'jeffj', note_text: 'Prefers mornings.' }, esc);
  assert.match(html, /9\/18\/2026, 4:53 PM/);
  assert.match(html, /By jeffj/);
  assert.match(html, /Prefers mornings\./);
  assert.match(html, /class="driver-note-row"/);
  assert.match(driverNoteRowHtml(cancellation(1, '2026-09-13', '16:00'), esc), /class="driver-note-row"/);
});

test('escapes user-authored text, authors and load numbers', () => {
  const html = driverNoteRowHtml({ ...cancellation(1, '2026-09-13', '16:00'), note_text: '<script>bad</script>', created_by: '<img>', source_load_label: '<svg>' }, esc);
  assert.doesNotMatch(html, /<script>|<img>|<svg>/);
  assert.match(html, /&lt;script&gt;/);
});

test('note rows cannot inherit the history table first-child header style', () => {
  const css = readFileSync(new URL('../loadboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.driver-note-row\s*\{[^}]*font-weight:\s*400;[^}]*text-transform:\s*none;/);
  const html = driverNoteRowHtml(cancellation(1, '2026-09-13', '16:00'), esc);
  assert.doesNotMatch(html, /ld-history-row/);
});

test('the profile loader fetches every page before ordering notes by effective date', async () => {
  const board = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
  const start = board.indexOf('  async function loadDriverProfileNotes(');
  const end = board.indexOf('\n  // Manages the three tabs', start);
  assert.ok(start > 0 && end > start);
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, created_at: '2026-09-14T12:00:00Z', note_text: 'Regular note' }));
  // A future shift cancellation written earlier lives on the second page,
  // but belongs at the top when ordered by the shift time.
  rows.push({ ...cancellation(501, '2026-09-20', '16:00'), created_at: '2026-09-13T12:00:00Z' });
  const ranges = [];
  const query = {
    select() { return this; }, eq() { return this; }, order() { return this; },
    range(from, to) { ranges.push([from, to]); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
  };
  const load = new Function('supabaseClient', 'DRIVER_NOTES_TABLE', 'sortDriverNotes', `${board.slice(start, end)}; return loadDriverProfileNotes;`)({ from: () => query }, 'driver_notes', sortDriverNotes);
  const result = await load(5);
  assert.equal(result.length, 501);
  assert.equal(result[0].id, 501);
  assert.deepEqual(ranges, [[0, 499], [500, 999]]);
});
