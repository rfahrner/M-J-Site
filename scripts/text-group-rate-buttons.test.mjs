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
 * The rate buttons are single-select, unlike the ratings. A driver sits on
 * one rate card, so these are radio buttons wearing the toggle's clothes --
 * picking a second replaces the first, and picking the chosen one again
 * clears it, because otherwise there is no way back to "nothing selected"
 * once you have touched one.
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
const NAMES = ['openTextGroupModal', 'setupRateTextOptions', 'setTextGroupMode', 'refreshRatingTextGroups',
  'renderRatingTextGroups', 'rateTextLabel', 'renderRateTextOptions', 'renderRateTextRatings',
  'setRateRatingLabelVisible', 'refreshRateTextRatings'];

const PREFERRED = [
  { id: '1', name: 'P A', rating: 'A', phone: '5551110001', normalRate: 700 },
  { id: '2', name: 'P B', rating: 'B', phone: '5551110002', normalRate: 700 },
  { id: '3', name: 'P C', rating: 'A', phone: '5551110003', normalRate: 850 },
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
  availableDriverClasses: () => ['A', 'B'], ratingTextClass: (d) => d.rating || 'Unrated',
  driverClassification: (d) => d.rating || 'Unrated',
  ratingGroups: (list, cls) => { const m = new Map(); list.forEach((d) => m.set(cls(d), (m.get(cls(d)) || 0) + 1)); return [...m]; },
  selectedRateMembers: (list, set, cls) => list.filter((d) => set.has(cls(d))),
};
const decl = 'let rateTextMode=false,rateTextRefresh=0,groupTextState=null,ratingTextRatings=new Set(),ratingTextEligible=[],ratingTextRefresh=0,rateTextRatings=new Set(),rateTextEligible=[],rateTextRate="",rateTextOptions=[];\n';
const api = new Function(...Object.keys(env), `${decl}${NAMES.map(fn).join('\n')}
  return {
    openTextGroupModal, setTextGroupMode,
    clickRate: (r) => { rateTextRate = String(rateTextRate) === String(r) ? "" : r; renderRateTextOptions(); return refreshRateTextRatings(true); },
    clickRating: (r) => { rateTextRatings.has(r) ? rateTextRatings.delete(r) : rateTextRatings.add(r); renderRateTextRatings(); },
    chosenRate: () => rateTextRate, chosenRatings: () => [...rateTextRatings],
  };`)(...Object.values(env));

const settle = () => new Promise((r) => setTimeout(r, 10));
const labels = (sel) => [...doc.querySelectorAll(`${sel} button`)].map((b) => b.textContent.trim().replace(/^[✓○]\s*/, ''));
const pressed = (sel) => [...doc.querySelectorAll(`${sel} button`)].map((b) => b.getAttribute('aria-pressed'));
const note = () => doc.querySelector('#tg-rate-count-note').textContent;
const stepTwoShown = () => !doc.querySelector('#tg-rate-rating-label').classList.contains('hidden');

console.log('\n1. the rate picker is buttons, not a dropdown');
check('no <select> left in the markup', /id="tg-rate-select"/.test(HTML), false);
check('nor anywhere in the code', /tg-rate-select/.test(SRC), false);
check('the markup has a rate button group', /id="tg-rate-buttons"/.test(HTML), true);
check('and it shares the rating buttons\' styling', /id="tg-rate-buttons" class="rate-rating-buttons"/.test(HTML), true);

console.log('\n2. opening the tab: rates offered, nothing chosen, no step two');
api.openTextGroupModal(); await settle();
api.setTextGroupMode('rate'); await settle();
check('every rate is a button', labels('#tg-rate-buttons'), ['Default', '$700', '$850']);
check('none is selected', pressed('#tg-rate-buttons'), ['false', 'false', 'false']);
check('the ratings section is empty', doc.querySelector('#tg-rate-ratings').innerHTML, '');
check('its heading is hidden until it applies', stepTwoShown(), false);
check('and the note says what to do', note(), 'Choose a rate to see the rating groups.');

console.log('\n3. choosing a rate pops the ratings up underneath');
await api.clickRate('700'); await settle();
check('the chosen rate shows chosen', pressed('#tg-rate-buttons'), ['false', 'true', 'false']);
check('the ratings for THAT rate appear', labels('#tg-rate-ratings'), ['A- 1', 'B- 1']);
check('the heading comes with them', stepTwoShown(), true);
check('none of them is preselected', pressed('#tg-rate-ratings'), ['false', 'false']);
check('and the note prompts rather than reporting zero', note(),
  'No ratings selected. Choose the buttons for the drivers you want to text.');

console.log('\n4. ratings still multi-select');
api.clickRating('A');
check('A is on', pressed('#tg-rate-ratings'), ['true', 'false']);
check('the count follows', note(), '1 eligible drivers selected. DNU drivers are excluded; shared phone numbers receive one text.');
api.clickRating('B');
check('both can be on at once', api.chosenRatings(), ['A', 'B']);

console.log('\n5. rates are single-select, and switching resets the ratings');
await api.clickRate('850'); await settle();
check('only the new rate is pressed', pressed('#tg-rate-buttons'), ['false', 'false', 'true']);
check('the previous rate let go', api.chosenRate(), '850');
check('the ratings are for the new rate', labels('#tg-rate-ratings'), ['A- 1']);
check('and the earlier rating choices were cleared', api.chosenRatings(), []);

console.log('\n6. clicking the chosen rate again gets you back to nothing');
await api.clickRate('850'); await settle();
check('no rate selected', pressed('#tg-rate-buttons'), ['false', 'false', 'false']);
check('step two is gone', doc.querySelector('#tg-rate-ratings').innerHTML, '');
check('its heading too', stepTwoShown(), false);
check('and the note is back to the prompt', note(), 'Choose a rate to see the rating groups.');

console.log('\n7. reopening the modal forgets the last choice');
await api.clickRate('700'); await settle();
api.clickRating('A');
api.openTextGroupModal(); await settle();
api.setTextGroupMode('rate'); await settle();
check('no rate carried over', api.chosenRate(), '');
check('no ratings carried over', api.chosenRatings(), []);
check('buttons all unpressed', pressed('#tg-rate-buttons'), ['false', 'false', 'false']);

console.log('\n8. the send path reads the buttons, not a dropdown');
const send = /function startGroupText\(\)[\s\S]*?\n  \}/.exec(SRC)?.[0] || SRC;
check('it uses the stored rate', /const rate = rateTextRate;/.test(send), true);
check('and still refuses with none chosen', /Choose a rate first\./.test(send), true);
check('the batch label uses the shared formatter', /rateTextLabel\(rate\)/.test(SRC), true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
