/*
 * Regression test for the row highlight flickering under the pointer.
 *
 * Two separate causes, both pinned here.
 *
 * Hovering a board row lights it blue. Moving the pointer from one cell to the
 * next INSIDE that same row fires mouseout -- it bubbles -- with a
 * relatedTarget in the very same row, and the handler responded by clearing
 * every highlight in the table and immediately re-adding it. On a load with
 * more than one route that also stripped and re-added the rowspanned parent's
 * highlight, which is what read as the blue jumping to the row below and back.
 *
 * Re-lighting the row that is already lit is not work worth doing, so
 * applyHover() is now a no-op when the hovered row has not changed.
 *
 * Second: a load's shift-level cells are rowspanned out of its first <tr>, so
 * sliding the pointer out of route 2's cells into the pinned Driver column
 * lands on a cell that belongs, in the DOM, to route 1 -- the highlight jumped
 * a row and jumped back for one continuous move. Hovering a shared cell means
 * "this load", so the route already lit is held.
 *
 * Third, and the reason neither of the above was observable: the module built
 * its row selector as `${TABLE_SELECTOR} tbody tr`, and a comma is the lowest
 * -precedence operator in a CSS selector, so that read as `table.board` OR
 * `table.driverlist` OR `table.available-table tbody tr`. closest() answered
 * with the <table>, and every class went on the table element.
 *
 * Run: npm i --no-save jsdom && node scripts/board-row-hover.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../board-row-hover-enhancements.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}

const dom = new JSDOM(`<!doctype html><body>
  <table class="board"><tbody>
    <tr id="r1">
      <td class="pin pin-driver" id="r1-driver" rowspan="2"><span id="r1-driver-text">Marcus</span></td>
      <td class="col-routeId" id="r1-route"><input id="r1-input"></td>
    </tr>
    <tr id="r1__t2" data-parent-row="r1">
      <td class="col-routeId" id="r2-route"><input id="r2-input"></td>
      <td class="col-routeMiles" id="r2-miles"></td>
    </tr>
    <tr id="r3"><td class="col-routeId" id="r3-route"></td></tr>
  </tbody></table>
</body>`, { url: 'https://example.test/' });
const { window } = dom;
global.window = window; global.document = window.document;
// jsdom is not running scripts, so window.Function is Node's Function and the
// module's globals resolve against Node's, not the window's. Without these the
// module's MutationObserver lookup throws from inside an event handler, where
// the failure is swallowed and only shows up as "the class did not get added".
global.MutationObserver = window.MutationObserver;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.setTimeout = setTimeout;
window.CSS = { escape: (s) => s };

// Run the real module. Its own bootstrap defers to DOMContentLoaded, which
// has already passed for a DOM built this way, so init() is called directly --
// once, because installHoverBehavior() would otherwise attach twice.
const BOOTSTRAP = /if \(document\.readyState === 'loading'\)[\s\S]*$/;
// ROW_SELECTOR is module-local, and section 8 needs the real one rather than a
// copy of the expression that produced it.
new window.Function(SRC.replace(/^import .*$/gm, '')
  .replace(BOOTSTRAP, 'window.__rowSelector = ROW_SELECTOR; init();'))();
const ROW_SELECTOR = window.__rowSelector;

const $ = (id) => window.document.getElementById(id);
const lit = () => [...window.document.querySelectorAll('tr')]
  .filter((tr) => tr.classList.contains('site-row-hover-current')).map((tr) => tr.id).join(',');
const parents = () => [...window.document.querySelectorAll('tr')]
  .filter((tr) => tr.classList.contains('site-row-hover-parent')).map((tr) => tr.id).join(',');

// Count how often the classes actually change, by watching the attribute.
let classWrites = 0;
new window.MutationObserver((recs) => { classWrites += recs.length; })
  .observe(window.document.querySelector('tbody'), { attributes: true, attributeFilter: ['class'], subtree: true });

const move = (fromId, toId) => {
  const from = fromId ? $(fromId) : null;
  const to = toId ? $(toId) : null;
  if (from) {
    const out = new window.MouseEvent('mouseout', { bubbles: true });
    Object.defineProperty(out, 'relatedTarget', { value: to });
    from.dispatchEvent(out);
  }
  if (to) {
    const over = new window.MouseEvent('mouseover', { bubbles: true });
    Object.defineProperty(over, 'relatedTarget', { value: from });
    to.dispatchEvent(over);
  }
};

console.log('1. hovering a row lights it');
move(null, 'r1-driver');
check('row 1 is lit', lit(), 'r1');
check('and nothing is marked as a parent', parents(), '');

console.log('\n2. moving between cells of the SAME row changes nothing');
await new Promise((r) => setTimeout(r, 0));
classWrites = 0;
move('r1-driver', 'r1-route');
move('r1-route', 'r1-input');
move('r1-input', 'r1-driver-text');
await new Promise((r) => setTimeout(r, 0));
check('still the same row', lit(), 'r1');
// This is the whole bug: every one of those moves used to clear and re-add.
check('no class churn at all', classWrites, 0);

console.log('\n3. a route row also lights its rowspanned parent');
move('r1-driver', 'r2-route');
check('route row is lit', lit(), 'r1__t2');
check('parent carries the shared-cell highlight', parents(), 'r1');

console.log('\n4. and moving within the route row does not strip the parent');
await new Promise((r) => setTimeout(r, 0));
classWrites = 0;
move('r2-route', 'r2-input');
move('r2-input', 'r2-miles');
await new Promise((r) => setTimeout(r, 0));
check('route row still lit', lit(), 'r1__t2');
check('parent still marked', parents(), 'r1');
check('no class churn', classWrites, 0);

console.log('\n5. a shared rowspanned cell belongs to the load, not to route 1');
// The pointer slid left out of route 2 and into the pinned Driver column. That
// cell is in route 1's <tr>; reassigning the highlight to it is the flicker.
move('r2-miles', 'r1-driver-text');
check('route 2 keeps the highlight', lit(), 'r1__t2');
check('and the parent keeps its shared-cell mark', parents(), 'r1');
// Coming back out of it must not move anything either.
move('r1-driver-text', 'r2-route');
check('still route 2 on the way back', lit(), 'r1__t2');

console.log('\n6. moving to a genuinely different row does move the highlight');
move('r2-route', 'r3-route');
check('row 3 is lit', lit(), 'r3');
check('and the parent mark is gone', parents(), '');

console.log('\n7. leaving the table clears it');
move('r3-route', null);
check('nothing lit', lit(), '');

console.log('\n8. the highlight survives a board redraw');
// A redraw throws away the <tr> under the pointer, and no further mouseover
// arrives until the pointer MOVES -- the row went dark and came back when the
// dispatcher twitched the mouse, which reads as blinking.
const tbody = window.document.querySelector('tbody');
const REDRAWN = tbody.innerHTML;
move(null, 'r3-route');
check('row 3 lit before the redraw', lit(), 'r3');
// jsdom has no layout, so elementFromPoint is stubbed to answer with the cell
// standing in for "under the pointer" -- resolved lazily, because the whole
// point is that the element it returns is a NEW one after the rebuild.
window.document.elementFromPoint = () => window.document.getElementById('r3-route');
// What a redraw really does: every row is thrown away and rebuilt, so the
// class is gone and the row the pointer is over is a different element.
tbody.innerHTML = REDRAWN;
check('the rebuilt rows start with no highlight at all', lit(), '');
await new Promise((r) => setTimeout(r, 5));
check('and it is put back without the pointer moving', lit(), 'r3');
delete window.document.elementFromPoint;

console.log('\n9. the row selector distributes over every table, not just the last');
const cell = $('r1-route');
check('closest() finds a <tr>, not the <table>', cell.closest(ROW_SELECTOR)?.tagName, 'TR');
for (const table of ['table.board', 'table.driverlist', 'table.available-table']) {
  check(`${table} gets its own ' tbody tr'`, ROW_SELECTOR.includes(`${table} tbody tr`), true);
}

console.log('\n10. board hover is not driven by native :hover any more');
// Native :hover cannot express "this load"; it follows the DOM row, which is
// precisely what walks the highlight onto route 1 inside the pinned columns.
const CSS_SRC = readFileSync(new URL('../loadboard.css', import.meta.url), 'utf8');
const nativeBoardHover = CSS_SRC
  .split('\n')
  .filter((line) => /table\.board tbody tr[^{]*:hover/.test(line) && !line.trim().startsWith('*'));
check('no table.board row :hover rules remain', nativeBoardHover.join(' | '), '');
// The hover treatment itself lives in this module's injected styles, beside
// the script that decides which logical row is hovered; the stylesheet keeps
// the rules that are about a row's STATE rather than the pointer. Look in
// both, or this only pins where the CSS happens to sit today.
const MODULE_SRC = readFileSync(new URL('../board-row-hover-enhancements.js', import.meta.url), 'utf8');
const styledAnywhere = (rule) => CSS_SRC.includes(rule)
  || MODULE_SRC.includes(rule.replace('site-row-hover-current', '${HOVER_CLASS}'));
for (const rule of [
  'table.board tbody tr.site-row-hover-current > td',
  'table.board tbody tr.is-load-cancelled.site-row-hover-current',
]) {
  check(`replaced by ${rule}`, styledAnywhere(rule), true);
}
// Hover is a tint laid OVER the cell, not a repaint of it: an opaque fill wiped
// out the column colours (Shift Start's pea flower, Next Call Time's butter
// yellow, the pistachio route block) for whichever row the pointer was on. A
// gradient in background-image composites over the cell's own background-color.
check('the hover fill is a tint, not an opaque colour',
  /background-image: linear-gradient\(\$\{HOVER_TINT\}, \$\{HOVER_TINT\}\) !important;/.test(MODULE_SRC), true);
check('and the row has a defined top and bottom edge',
  /inset 0 1px 0 0 \$\{HOVER_EDGE\}, inset 0 -1px 0 0 \$\{HOVER_EDGE\}/.test(MODULE_SRC), true);
// Three different blues were in play for one state, which is most of why it
// never looked deliberate.
for (const deadBlue of ['#d7e8ff', '#eaf1ff', '#f0f5ff']) {
  check(`the old hover blue ${deadBlue} is gone from the stylesheet`, CSS_SRC.includes(deadBlue), false);
}
// The other two tables have no rowspanned cells and keep the cheap native rule.
check('driverlist keeps native :hover', CSS_SRC.includes('table.driverlist tbody tr:hover > td'), true);

console.log('\n11. every page busts the stylesheet cache on the same token');
// The hover rules moved from :hover to a class in the stylesheet while the
// class itself is applied by script. A browser holding the OLD stylesheet
// against the NEW script gets no board hover from either, so this rewrite is
// only safe if the stylesheet URL changed with it. index.html already had a
// ?v= token and the rest had none at all.
const { readdirSync } = await import('node:fs');
const pages = readdirSync(new URL('../', import.meta.url))
  .filter((name) => name.endsWith('.html'))
  .map((name) => [name, readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')])
  .filter(([, html]) => html.includes('loadboard.css'));
check('found the pages that load the stylesheet', pages.length > 5, true);
const tokens = new Set();
for (const [name, html] of pages) {
  const m = /loadboard\.css\?v=([^"']+)/.exec(html);
  check(`${name} carries a version token`, !!m, true);
  if (m) tokens.add(m[1]);
}
check('and they all carry the same one', tokens.size, 1);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
