/*
 * The driver pool arrives after the board has already drawn.
 *
 * Reported 2026-10-02 on Houston: "when I navigate and come back, driver info
 * isnt populated" -- a screenshot of three rows with names and five columns of
 * dashes.
 *
 * Nothing was lost. init() does not await loadDriversFromSupabase(), so the
 * board renders while 5,700+ driver rows are still paging in. Phone,
 * dispatcher phone, carrier, MC and rating all come off the driver profile;
 * the NAME falls back to row.driverName, stored on the row itself, which is
 * exactly what makes this read as data loss rather than a lookup that has not
 * happened yet. A cached page loses the race more often than a cold one, which
 * is why it shows up as "navigate away and come back".
 *
 * loadDriversFromSupabase() already redrew the driver list, the standard board
 * and the Available section -- each added after the same bug was reported
 * against it. Houston and Mondelez keep their own rows and their own
 * renderers, so none of those three fixes reached them.
 *
 * The broadcast is a DOM event rather than direct calls. loadboard.js already
 * imports each board's init(), so this is not about avoiding an import -- it
 * is that one dispatch does not grow as boards are added, and each board
 * decides for itself whether a redraw is wanted and when.
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

// --- the real pick(), which is what turns a missed lookup into a dash.
const pick = new Function(`${/export function pick\([\s\S]*?\n  \}/.exec(LB)[0].replace('export ', '')}; return pick;`)();

console.log('\n1. a missed profile lookup is what draws the dashes');
check('no profile and no snapshot is a dash', pick(undefined, ''), '—');
check('the profile wins when it is there', pick('770-555-0101', ''), '770-555-0101');
check('the row snapshot is the fallback', pick(undefined, '770-555-0102'), '770-555-0102');
check('whitespace is not a value', pick('   ', '  '), '—');

console.log('\n2. and the name survives, which is what disguises it');
// Houston renders the name from the profile OR row.driverName; every other
// column has no such fallback. Name + dashes is the signature of this bug.
check('the name falls back to the row', /const displayName = drv \? drv\.name : row\.driverName;/.test(HOU), true);
for (const col of ['phone', 'dispatcherPhone', 'carrier', 'mc', 'rating']) {
  check(`${col} comes off the profile first`,
    new RegExp(`pick\\(drv && drv\\.${col},`).test(HOU), true);
}

console.log('\n3. loading the drivers tells every board, not just the standard one');
const loader = /async function loadDriversFromSupabase\(\)[\s\S]*?\n  \}/.exec(LB)[0];
check('the standard board is still redrawn directly', /renderBoardTable\(\)/.test(loader), true);
check('the driver list too', /renderDriverList\(\)/.test(loader), true);
check('the Available section too', /renderAvailableTableKeepingFocus\(\)/.test(loader), true);
check('and the other boards are told',
  /document\.dispatchEvent\(new CustomEvent\("drivers:loaded"\)\)/.test(loader), true);
check('after state.drivers is populated, not before',
  loader.indexOf('state.drivers = all.map') < loader.indexOf('drivers:loaded'), true);
check('it is not dispatched on the error path',
  /return;\s*\n\s*\}\s*\n\s*document\.dispatchEvent/.test(loader), false);

console.log('\n4. Houston and Mondelez listen, and redraw themselves');
const houHandler = /document\.addEventListener\("drivers:loaded", \(\) => \{([\s\S]*?)\n    \}\);/.exec(HOU)?.[1] || '';
check('Houston listens', houHandler.length > 0, true);
check('it redraws its own table', /renderHoustonBoardTable\(\)/.test(houHandler), true);
check('and only on its own page', /state\.activeLocation !== "houston"/.test(houHandler), true);

const mdzHandler = /document\.addEventListener\("drivers:loaded", \(\) => \{([\s\S]*?)\n  \}\);/.exec(MDZ)?.[1] || '';
check('Mondelez listens', mdzHandler.length > 0, true);
check('it redraws its own table', /renderMondelezTable\(\)/.test(mdzHandler), true);
check('and only on its own page', /state\.activeLocation !== "mondelez"/.test(mdzHandler), true);
check('Mondelez reads MC off the profile, so it had the same bug',
  /findDriver\(row\.driverId\)\?\.mc/.test(MDZ), true);

console.log('\n5. the guard matches what each page actually sets');
check('Houston sets activeLocation to houston', /state\.activeLocation = "houston";/.test(HOU), true);
check('Mondelez sets activeLocation to mondelez', /state\.activeLocation = "mondelez";/.test(MDZ), true);
// A tab switch inside Mondelez must not take it out of scope for the redraw.
const switchTab = /export function switchMondelezTab\(tabKey\) \{([\s\S]*?)\n\}/.exec(MDZ)?.[1] || '';
check('switching Mondelez tabs does not change activeLocation',
  /activeLocation/.test(switchTab), false);

console.log('\n6. loadboard stays ignorant of what each board renders');
// It already imports each board's init(), so this is not about the import
// edge. It is that adding a board must not mean editing this file again.
check('it does not reach for Houston\'s renderer', /renderHoustonBoardTable/.test(LB), false);
check('nor Mondelez\'s', /renderMondelezTable/.test(LB), false);
check('it imports only each board\'s init', /import \{ initHoustonBoardPage \} from '\.\/houston\.js';/.test(LB), true);
check('the boards still import from loadboard', /from ['"]\.\/loadboard\.js['"]/.test(HOU), true);

console.log('\n7. the listener is registered where the page is set up');
// Registered at init rather than at module scope: the module is imported by
// loadboard.js on every page, and a listener that fires on the Accounting
// page would call a renderer whose table is not in the document.
check('Houston registers it inside initHoustonBoardPage',
  HOU.indexOf('drivers:loaded') > HOU.indexOf('export function initHoustonBoardPage'), true);
check('Mondelez registers it inside initMondelezPage',
  MDZ.indexOf('drivers:loaded') > MDZ.indexOf('export async function initMondelezPage'), true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
