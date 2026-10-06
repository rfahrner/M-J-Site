/*
 * Which drivers each rating button actually covers.
 *
 * Two rounds of this, same session.
 *
 * "These need to include all variation... so a1, a2, a3 ect. go under A."
 * They already did -- driverClassification() buckets on the first letter. What
 * made it look otherwise is the data: the Preferred pool holds no plain "A" at
 * all, only A1, A2 and A3, so the button read "A- 10" beside a rating nobody
 * appeared to have, with nothing on screen to say what it included. Each
 * button now carries its real ratings as a tooltip.
 *
 * Then: "make core 1 A, core 2 B, Core A. refused load isnt a rating... should
 * be D i guess. perfered and others like it can be B and last resort are D."
 * First-letter bucketing had been putting free text somewhere wrong and
 * silently -- "core 1"/"core 2" on C beside the real C1/C2, "preferred"/"per"
 * on P, "refused load" on R beside the real R, "Last resort" on L. Two of
 * those invented a group out of nothing; the other two padded a real one, so
 * texting C was also texting Core. RATING_PHRASE_CLASSES is the owner's
 * mapping, keyed on the whole normalized value.
 *
 * "li" (one driver) was left unmapped at first -- nobody had said what it
 * meant, and guessing is how a driver ends up in the wrong text. The owner
 * answered the next day: it is a D.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'loadboard.js'), 'utf8');
let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
const fn = (n) => {
  const m = SRC.match(new RegExp(`  (?:export )?(?:async )?function ${n}\\([^]*?\\n  \\}`));
  if (!m) throw new Error(`anchor moved: ${n}`);
  return m[0].replace('export ', '');
};
const PHRASE_TABLE = /  const RATING_PHRASE_CLASSES = \{[\s\S]*?\n  \};/.exec(SRC)[0];

// The Preferred pool's real shape, counts straight off the live table.
const SHAPE = [['D', 94], ['R', 87], ['E', 80], ['C2', 75], ['DNU', 61], ['B2', 47], ['B1', 26],
  ['C1', 25], ['F', 15], ['A1', 6], ['A3', 6], ['B', 5], ['A2', 3], ['c2', 2], ['C', 2], ['', 2], ['D1', 1], ['F-', 1]];
const POOL = [];
for (const [rating, n] of SHAPE) for (let i = 0; i < n; i++) POOL.push({ id: `${rating}-${i}`, rating, phone: '5551110000' });

const modal = /<div class="overlay hidden" id="modal-text-group">[\s\S]*?\n  <\/div>/.exec(readFileSync(join(root, 'driverlist.html'), 'utf8'))[0];
const doc = new JSDOM(`<!doctype html><body>${modal}</body>`).window.document;
const env = {
  escapeHtml: (s) => String(s ?? ''), $: (s) => doc.querySelector(s), document: doc,
  driversForLocation: () => POOL, state: { driverListTab: 'preferred' },
  isNeverTextDriver: (d) => String(d.rating || '').toUpperCase().includes('DNU'),
};
const NAMES = ['driverClassification', 'availableDriverClasses', 'ratingTextClass', 'variantTitle', 'renderRatingTextGroups'];
const decl = `const KNOWN_DRIVER_CLASSES=["A","B","C","D","DNU","R"];${PHRASE_TABLE}\nlet ratingTextRatings=new Set(),ratingTextEligible=${JSON.stringify(POOL)};\n`;
const api = new Function(...Object.keys(env), `${decl}${NAMES.map(fn).join('\n')}
  renderRatingTextGroups();
  return { driverClassification };`)(...Object.values(env));
const cls = (rating) => api.driverClassification({ rating });
const buttons = [...doc.querySelectorAll('#tg-rating-buttons button')];
const byLabel = (letter) => buttons.find((b) => b.dataset.textRating === letter);
const countOf = (letter) => Number(/-\s*(\d+)$/.exec(byLabel(letter).textContent.trim())?.[1]);

console.log('\n1. numbered and decorated variants bucket onto their letter');
for (const [raw, letter] of [['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B'], ['B2', 'B'],
  ['C1', 'C'], ['C2', 'C'], ['D1', 'D'], ['A+', 'A'], ['A-', 'A'], ['B?', 'B'], ['F-', 'F'],
  ['c2', 'C'], ['  b1  ', 'B']]) {
  check(`${JSON.stringify(raw)} -> ${letter}`, cls(raw), letter);
}

console.log('\n2. DNU wins over its first letter, wherever it appears');
check('DNU', cls('DNU'), 'DNU');
check('Hard DNU is DNU, not H', cls('Hard DNU'), 'DNU');
check('a plain D is still D', cls('D'), 'D');
check('and no rating is no class', cls('  '), null);

console.log('\n3. the free text the owner mapped');
for (const [raw, letter] of [['core', 'A'], ['Core', 'A'], ['core 1', 'A'], ['Core 1', 'A'],
  ['core 2', 'B'], ['Core 2', 'B'], ['core  2', 'B'],
  ['preferred', 'B'], ['Preferred', 'B'], ['pref', 'B'], ['per', 'B'],
  ['refused load', 'D'], ['refused', 'D'], ['Last resort', 'D'], ['last resort', 'D'],
  ['li', 'D'], ['Li', 'D'], ['  LI  ', 'D']]) {
  check(`${JSON.stringify(raw)} -> ${letter}`, cls(raw), letter);
}

console.log('\n4. the mapping is on the whole value, never a substring');
check('"hardcore" is not "core"', cls('hardcore'), 'H');
check('"lift" is not "li"', cls('lift'), 'L');
check('a real C rating is untouched', cls('C1'), 'C');
check('and an unmapped word still falls to its letter', cls('maybe'), 'M');

console.log('\n5. counts on the live Preferred shape');
check('A holds A1+A2+A3', countOf('A'), 15);
check('B holds B+B1+B2', countOf('B'), 78);
check('C holds C+C1+C2+c2', countOf('C'), 104);
check('D holds D+D1, and not DNU', countOf('D'), 95);
check('F holds F+F-', countOf('F'), 16);
check('DNU stands alone', countOf('DNU'), 61);
check('blank ratings are Unrated', countOf('Unrated'), 2);
check('All Drivers is everyone except DNU', countOf('ALL'), POOL.length - 61);

console.log('\n6. every button says what it covers');
check('A names its variants', byLabel('A').getAttribute('title'), 'Includes: A1, A2, A3');
check('B names its variants', byLabel('B').getAttribute('title'), 'Includes: B, B1, B2');
check('C names them, lower-case and all', byLabel('C').getAttribute('title'), 'Includes: C, C1, c2, C2');
check('F names them', byLabel('F').getAttribute('title'), 'Includes: F, F-');
check('a single-value bucket says so plainly', byLabel('R').getAttribute('title'), 'Rated R');
check('Unrated explains itself', byLabel('Unrated').getAttribute('title'), 'Drivers with no rating recorded');
check('All Drivers says what it excludes', byLabel('ALL').getAttribute('title'), 'Every rating except DNU');

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
