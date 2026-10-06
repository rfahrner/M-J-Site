/*
 * Text by Rate works like Text by Rating: buttons, nothing preselected.
 *
 * Asked for on 2026-10-05, after the rating tab was converted: "we need the
 * text by rate tab to be the same. It needs to have the Driver rate as
 * buttons and below that section it needs to have the rating options, so as
 * I select the rate, the button will pop up in the section below for me to
 * select the rating."
 *
 * So it is two steps, and the second depends on the first: the rating groups
 * and their counts are of THAT rate's drivers, so they cannot exist until a
 * rate is chosen.
 *
 * Both groups are multi-select: several pay ranges are routinely worth asking
 * at once, and the ratings under them are the union across whatever is
 * chosen, de-duplicated.
 *
 * Every rating stays on screen whether or not the chosen rates have anyone in
 * it -- dimmed, disabled and reading zero. Rendering only the applicable ones
 * made the modal grow and shrink on every click, and the dialog is centred,
 * so the whole thing jumped under the pointer. "Mainly working it that way so
 * the page doesnt resize. We dont want it to spazz out on us." The button
 * COUNT is therefore the thing to assert, not just the labels.
 *
 * Deliberately no counts on the rate buttons. The counts on the rating
 * buttons are AFTER DNU, no-phone and already-scheduled are removed; a count
 * on a rate could only be the raw pool, and two differently-filtered numbers
 * stacked above one another invite exactly the wrong arithmetic.
 *
 * The whole flow is driven here through the real functions, because the bug
 * that started this sequence was a modal that rendered empty and looked
 * merely featureless.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'loadboard.js'), 'utf8');
const HTML = readFileSync(join(root, 'driverlist.html'), 'utf8');

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
// driverClassification and availableDriverClasses are lifted for real rather
// than stubbed: the rate tab's buckets ARE that function, and the fixture
// leans on it (A1 and "core 1" both have to land on A).
const NAMES = ['driverClassification', 'availableDriverClasses', 'openTextGroupModal', 'setupRateTextOptions',
  'setTextGroupMode', 'refreshRatingTextGroups', 'renderRatingTextGroups', 'variantTitle', 'rateRatingChoices',
  'rateTextLabel', 'renderRateTextOptions', 'renderRateTextRatings', 'setRateRatingLabelVisible',
  'refreshRateTextRatings'];
const PHRASE_TABLE = /  const RATING_PHRASE_CLASSES = \{[\s\S]*?\n  \};/.exec(SRC)[0];

const PREFERRED = [
  { id: '1', name: 'P A', rating: 'A1', phone: '5551110001', normalRate: 700 },
  { id: '2', name: 'P B', rating: 'B', phone: '5551110002', normalRate: 700 },
  { id: '3', name: 'P C', rating: 'A', phone: '5551110003', normalRate: 850 },
  { id: '4', name: 'P D', rating: 'core 1', phone: '5551110004', normalRate: 700 },
];
const modal = /<div class="overlay hidden" id="modal-text-group">[\s\S]*?\n  <\/div>/.exec(HTML)[0];
const dom = new JSDOM(`<!doctype html><body>${modal}</body>`);
const doc = dom.window.document;
const env = {
  escapeHtml: (s) => String(s ?? ''), document: doc, window: dom.window,
  $: (s) => doc.querySelector(s), $all: (s, r) => [...(r || doc).querySelectorAll(s)],
  driversForLocation: () => PREFERRED, getBoardRateTiers: () => ({ atlanta: [] }),
  state: { drivers: [], driverListTab: 'atlanta' },
  rateOptions: () => ['DEFAULT', 700, 850],
  rateMembers: (pool, rate) => pool.filter((d) => rate === 'DEFAULT' ? true : String(d.normalRate) === String(rate)),
  dateKey: () => '2026-10-05', todayDate: () => new Date(),
  filterNeverTextRecipients: (l) => ({ allowed: l, blocked: [] }),
  formatTextAddress: (p) => String(p || ''), applyPhoneMode: (l) => l,
  scheduledDriversOn: async () => ({}), driverIsScheduled: () => false,
  isNeverTextDriver: (d) => String(d.rating || '').toUpperCase().includes('DNU'),
  ratingTextClass: (d) => d.rating || 'Unrated',
  ratingGroups: (list, cls) => { const m = new Map(); list.forEach((d) => m.set(cls(d), (m.get(cls(d)) || 0) + 1)); return [...m]; },
  selectedRateMembers: (list, set, cls) => list.filter((d) => set.has(cls(d))),
};
const decl = `const KNOWN_DRIVER_CLASSES=["A","B","C","D","DNU","R"];${PHRASE_TABLE}\n` + 'let rateTextMode=false,rateTextRefresh=0,groupTextState=null,ratingTextRatings=new Set(),ratingTextEligible=[],ratingTextRefresh=0,rateTextRatings=new Set(),rateTextEligible=[],rateTextRates=new Set(),rateTextOptions=[];\n';
const api = new Function(...Object.keys(env), `${decl}${NAMES.map(fn).join('\n')}
  return {
    openTextGroupModal, setTextGroupMode,
    clickRate: (r) => { const k = String(r); rateTextRates.has(k) ? rateTextRates.delete(k) : rateTextRates.add(k); renderRateTextOptions(); return refreshRateTextRatings(); },
    clickRating: (r) => { rateTextRatings.has(r) ? rateTextRatings.delete(r) : rateTextRatings.add(r); renderRateTextRatings(); },
    chosenRates: () => [...rateTextRates], chosenRatings: () => [...rateTextRatings],
  };`)(...Object.values(env));

const settle = () => new Promise((r) => setTimeout(r, 10));
const labels = (sel) => [...doc.querySelectorAll(`${sel} button`)].map((b) => b.textContent.trim().replace(/^[✓○]\s*/, ''));
const pressed = (sel) => [...doc.querySelectorAll(`${sel} button`)].map((b) => b.getAttribute('aria-pressed'));
const note = () => doc.querySelector('#tg-rate-count-note').textContent;
const disabled = (sel) => [...doc.querySelectorAll(`${sel} button`)].map((b) => b.disabled);
const stepTwoShown = () => !doc.querySelector('#tg-rate-rating-label').classList.contains('hidden');

console.log('\n1. the rate picker is buttons, not a dropdown');
check('no <select> left in the markup', /id="tg-rate-select"/.test(HTML), false);
check('nor anywhere in the code', /tg-rate-select/.test(SRC), false);
check('the markup has a rate button group', /id="tg-rate-buttons"/.test(HTML), true);
check('and it shares the rating buttons\' styling', /id="tg-rate-buttons" class="rate-rating-buttons"/.test(HTML), true);

console.log('\n2. opening the tab: rates offered, nothing chosen');
api.openTextGroupModal(); await settle();
api.setTextGroupMode('rate'); await settle();
check('every rate is a button', labels('#tg-rate-buttons'), ['Default', '$700', '$850']);
check('none is selected', pressed('#tg-rate-buttons'), ['false', 'false', 'false']);
check('and the note says what to do', note(), 'Choose one or more rates to see the rating groups.');

console.log('\n3. the ratings are ALREADY on screen, dimmed, so nothing resizes');
const atRest = doc.querySelectorAll('#tg-rate-ratings button').length;
check('they are drawn before any rate is chosen', atRest > 0, true);
check('every one reads zero', labels('#tg-rate-ratings').every((l) => / 0$/.test(l)), true);
check('and none can be clicked', disabled('#tg-rate-ratings').every(Boolean), true);
check('each is marked unavailable for the stylesheet',
  [...doc.querySelectorAll('#tg-rate-ratings button')].every((b) => b.classList.contains('is-unavailable')), true);

console.log('\n4. choosing a rate fills in the counts, same buttons');
await api.clickRate('700'); await settle();
check('the rate shows chosen', pressed('#tg-rate-buttons'), ['false', 'true', 'false']);
check('the button count has not moved', doc.querySelectorAll('#tg-rate-ratings button').length, atRest);
check('A now has its drivers', labels('#tg-rate-ratings').includes('A- 2'), true);
check('and B does too', labels('#tg-rate-ratings').includes('B- 1'), true);
check('a rating nobody holds is still there, at zero', labels('#tg-rate-ratings').includes('Unrated- 0'), true);
check('and still unclickable', doc.querySelector('[data-rate-rating="Unrated"]').disabled, true);
check('while A became clickable', doc.querySelector('[data-rate-rating="A"]').disabled, false);
check('the note prompts for a rating', note(),
  'No ratings selected. Choose the buttons for the drivers you want to text.');

console.log('\n5. rates are MULTI-select, and the ratings are their union');
await api.clickRate('850'); await settle();
check('both rates are pressed', pressed('#tg-rate-buttons'), ['false', 'true', 'true']);
check('both are remembered', api.chosenRates(), ['700', '850']);
check('A gained the $850 driver', labels('#tg-rate-ratings').includes('A- 3'), true);
check('the button count still has not moved', doc.querySelectorAll('#tg-rate-ratings button').length, atRest);

console.log('\n6. ratings survive a rate change rather than being thrown away');
api.clickRating('A');
check('A is on', doc.querySelector('[data-rate-rating="A"]').getAttribute('aria-pressed'), 'true');
await api.clickRate('850'); await settle();
check('dropping a rate leaves the rating chosen', api.chosenRatings(), ['A']);
check('and the count follows the smaller pool', /^2 eligible drivers selected/.test(note()), true);

console.log('\n7. clearing every rate goes back to the resting state');
await api.clickRate('700'); await settle();
check('no rate selected', pressed('#tg-rate-buttons'), ['false', 'false', 'false']);
check('the buttons are all still there', doc.querySelectorAll('#tg-rate-ratings button').length, atRest);
check('all back to zero', labels('#tg-rate-ratings').every((l) => / 0$/.test(l)), true);
check('and the note is the opening prompt again', note(), 'Choose one or more rates to see the rating groups.');

console.log('\n8. the send path reads the buttons, not a dropdown');
check('nothing reads a rate <select> any more', /tg-rate-select/.test(SRC), false);
check('it refuses with no rate chosen', /Choose at least one rate first\./.test(SRC), true);
check('it gathers across every chosen rate', /for \(const rate of rateTextRates\)/.test(SRC), true);
check('de-duplicating drivers found under two', /if \(seen\.has\(driver\.id\)\) continue;/.test(SRC), true);
check('and the batch label names them all', /\[\.\.\.rateTextRates\]\.map\(rateTextLabel\)\.join\(" \/ "\)/.test(SRC), true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
