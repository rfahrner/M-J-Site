/*
 * The Text Group modal either builds, or says it didn't.
 *
 * The rating picker is written by JS into #tg-rating-buttons. The labels,
 * checkboxes and message box around it are static markup. So anything that
 * throws part-way through opening leaves a modal that looks FINISHED and
 * simply has no rating picker in it -- which reads as "that feature is
 * missing" rather than "something broke", and leaves nothing on screen to
 * report. That is the worst failure mode this modal has, and it is the one
 * it had: setupRateTextOptions() wrote straight into #tg-rate-select with no
 * null check.
 *
 * #btn-text-group is only on driverlist.html today, so only that page could
 * reach it -- but the modal shell is copied into all four board pages, where
 * none of the new markup exists. One wiring change away from a modal that
 * opens empty on every board.
 *
 * Two things pinned here:
 *   - on the page that has the markup, opening selects NOTHING and shows
 *     every rating as a button, which is what was asked for;
 *   - on a page that does not, opening fails LOUDLY in the modal's own error
 *     row rather than rendering a convincing-looking empty one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'loadboard.js'), 'utf8');
const CSS = readFileSync(join(root, 'loadboard.css'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected)
    ? Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i])
    : Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
const fn = (n) => {
  const m = SRC.match(new RegExp(`  (?:export )?(?:async )?function ${n}\\([^]*?\\n  \\}`));
  if (!m) throw new Error(`anchor moved: ${n}`);
  return m[0].replace('export ', '');
};
const NAMES = ['openTextGroupModal', 'setupRateTextOptions', 'setTextGroupMode', 'refreshRatingTextGroups', 'renderRatingTextGroups'];
const DRIVERS = [
  { id: '1', name: 'A One', rating: 'A', phone: '5551112222' },
  { id: '2', name: 'B Two', rating: 'B', phone: '5551112223' },
  { id: '3', name: 'D Three', rating: 'DNU', phone: '5551112224' },
];
function openOn(page) {
  const html = readFileSync(join(root, page), 'utf8');
  const modal = /<div class="overlay hidden" id="modal-text-group">[\s\S]*?\n  <\/div>/.exec(html)?.[0] || '';
  const dom = new JSDOM(`<!doctype html><body>${modal}</body>`);
  const doc = dom.window.document;
  const env = {
    escapeHtml: (s) => String(s ?? ''), document: doc, window: dom.window,
    $: (s) => doc.querySelector(s), $all: (s, r) => [...(r || doc).querySelectorAll(s)],
    driversForLocation: () => DRIVERS, getBoardRateTiers: () => ({ atlanta: [] }),
    state: { drivers: [], driverListTab: 'atlanta' }, rateOptions: () => ['DEFAULT'],
    dateKey: () => '2026-10-05', todayDate: () => new Date(),
    filterNeverTextRecipients: (l) => ({ allowed: l, blocked: [] }),
    formatTextAddress: (p) => String(p || ''), applyPhoneMode: (l) => l,
    scheduledDriversOn: async () => ({}), driverIsScheduled: () => false,
    isNeverTextDriver: (d) => String(d.rating || '').toUpperCase().includes('DNU'),
    refreshRateTextRatings: async () => {},
    availableDriverClasses: () => ['A', 'B', 'DNU'],
    ratingTextClass: (d) => String(d.rating || 'Unrated').toUpperCase().includes('DNU') ? 'DNU' : (d.rating || 'Unrated'),
  };
  const decl = 'let rateTextMode=false,rateTextRefresh=0,groupTextState=null,ratingTextRatings=new Set(),ratingTextEligible=[],ratingTextRefresh=0,rateTextRatings=new Set(),rateTextEligible=[];\n';
  const api = new Function(...Object.keys(env), `${decl}${NAMES.map(fn).join('\n')}\nreturn { openTextGroupModal };`)(...Object.values(env));
  let threw = null;
  const quiet = console.error; console.error = () => {};
  try { api.openTextGroupModal(); } catch (e) { threw = e; } finally { console.error = quiet; }
  return { doc, threw };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

console.log('\n1. only driverlist.html carries the picker markup');
for (const page of ['index.html', 'buildingc.html', 'dalaware.html', 'houston.html']) {
  const html = readFileSync(join(root, page), 'utf8');
  check(`${page} has no Text Group button`, /id="btn-text-group"/.test(html), false);
}
check('driverlist.html has it', /id="btn-text-group"/.test(readFileSync(join(root, 'driverlist.html'), 'utf8')), true);
check('and it is the only wiring for the modal',
  /on\("btn-text-group", "click", openTextGroupModal\)|\$\("#btn-text-group"\)\.addEventListener\("click", openTextGroupModal\)/.test(SRC), true);

console.log('\n2. opening it selects nobody');
let { doc, threw } = openOn('driverlist.html');
await settle();
check('it did not throw', threw, null);
const buttons = [...doc.querySelectorAll('#tg-rating-buttons button')];
check('every rating is a button, plus All Drivers', buttons.length, 5);
check('nothing starts selected', buttons.every((b) => b.getAttribute('aria-pressed') === 'false'), true);
check('and each one shows it is unselected', buttons.every((b) => b.textContent.includes('○')), true);
check('the note says so in words',
  doc.querySelector('#tg-rating-count-note').textContent,
  'No ratings selected. Choose the buttons for the drivers you want to text.');
check('DNU is offered separately', buttons.some((b) => b.dataset.textRating === 'DNU'), true);
check('no error is shown', doc.querySelector('#tg-error').classList.contains('hidden'), true);

console.log('\n3. selected vs unselected is obvious, not just a glyph');
check('pressed buttons are filled', /\.rate-rating-toggle\[aria-pressed="true"\][^}]*background:/.test(CSS), true);
check('unpressed buttons are not', /\.rate-rating-toggle\[aria-pressed="false"\][^}]*background:\s*#fff/.test(CSS), true);
check('and they differ by border too', /\.rate-rating-toggle\[aria-pressed="true"\][^}]*border-color:/.test(CSS), true);

console.log('\n4. a page without the markup fails loudly, not silently');
({ doc, threw } = openOn('index.html'));
await settle();
check('the open call does not throw out to the caller', threw, null);
check('the error row is shown', doc.querySelector('#tg-error').classList.contains('hidden'), false);
check('and it says to reload', /didn't load properly/.test(doc.querySelector('#tg-error').textContent), true);
check('rather than leaving a convincing empty modal',
  doc.querySelector('#tg-rating-buttons'), null);

console.log('\n5. the rate tab is guarded the same way');
const setup = fn('setupRateTextOptions');
check('it checks its three elements first',
  /if \(!rateSelect \|\| !rateRatings \|\| !rateNote\) return;/.test(setup), true);
check('and writes through the checked references',
  /rateSelect\.innerHTML =/.test(setup) && /rateRatings\.innerHTML = ""/.test(setup), true);
check('the shared footer controls are optional too',
  /\$\("#" \+ id\)\?\.classList\.add\("hidden"\)/.test(setup), true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
