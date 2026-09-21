/*
 * Regression test for the shared route-image upload/delete callbacks.
 *
 * Reported as "Couldn't upload that image (Cannot read properties of undefined
 * (reading 'id'))" on the Mondelez board. The upload had actually SUCCEEDED --
 * the file was in storage and the path was saved. What failed was the redraw
 * immediately afterwards.
 *
 * uploadRowImage/deleteRowImage called their render callback as renderFn(),
 * with no argument. Four of the five boards pass a function that redraws
 * everything and takes no parameters, so nobody noticed. Mondelez passes
 * refreshMondelezImageCell(row), which repaints one cell and dereferences
 * row.id -- undefined, throw, caught by the upload's own try, reported to the
 * dispatcher as a failure.
 *
 * In deleteRowImage it was worse: the redraw ran BEFORE the storage delete and
 * the save, so the throw skipped both. The image disappeared from the screen,
 * stayed in storage and in the database, and returned on the next refresh.
 *
 * Run: npm i --no-save jsdom && node scripts/row-image-callbacks.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const BOARD = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
const UNIFIED = readFileSync(new URL('../unified-board-image-cells.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}
const checkTrue = (label, v) => check(label, !!v, true);

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), parens = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')') { parens--; if (parens === 0) break; }
  }
  let i = src.indexOf('{', j), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window; global.document = dom.window.document;

// ---------------------------------------------------------------------------
console.log('\n1. the render callback is told which row changed');

const UPLOAD = extractFunction(BOARD, 'uploadRowImage');
const DELETE = extractFunction(BOARD, 'deleteRowImage');
check('upload no longer calls renderFn with nothing', /renderFn\(\);/.test(UPLOAD), false);
check('delete no longer calls renderFn with nothing', /renderFn\(\);/.test(DELETE), false);
checkTrue('upload passes the row', /renderFn\(row\);/.test(UPLOAD));
checkTrue('delete passes the row', /renderFn\(row\)/.test(DELETE));

// ---------------------------------------------------------------------------
console.log('\n2. a failing redraw cannot cost the deletion');

checkTrue('the delete redraw is wrapped', /try \{ renderFn\(row\); \} catch/.test(DELETE));
// The storage removal and the save must still be reached after a redraw throw.
const redrawAt = DELETE.indexOf('renderFn(row)');
const removeAt = DELETE.indexOf('.remove([oldPath])');
const saveAt = DELETE.indexOf('await saveRowFn(row)');
checkTrue('the storage delete still comes after the redraw', removeAt > redrawAt);
checkTrue('the save still comes after the redraw', saveAt > redrawAt);

// ---------------------------------------------------------------------------
console.log('\n3. the Mondelez callback survives being called with nothing');

const ctx = {};
new Function('ctx', `
  const rowImageDropzoneHtml = () => '<div class="mdz-image-dropzone"></div>';
  ${extractFunction(UNIFIED, 'refreshMondelezImageCell')}
  ctx.refresh = refreshMondelezImageCell;
`)(ctx);

document.body.innerHTML = '<table><tr id="mdz_1"><td class="col-mdz-image">old</td></tr></table>';

let threw = null;
try { ctx.refresh(undefined); } catch (e) { threw = e; }
check('called with no row it does not throw', threw, null);
try { ctx.refresh({}); } catch (e) { threw = e; }
check('called with a row that has no id it does not throw', threw, null);
check('the cell is left alone in that case',
  document.querySelector('.col-mdz-image').textContent, 'old');

// And it still does its job when called properly.
ctx.refresh({ id: 'mdz_1' });
checkTrue('given a real row it repaints that row\'s cell',
  document.querySelector('.col-mdz-image').innerHTML.includes('mdz-image-dropzone'));

// ---------------------------------------------------------------------------
console.log('\n4. every board\'s render callback tolerates the argument');

// Four boards pass zero-parameter functions; passing one extra argument to a
// JS function is harmless. This pins that none of them started depending on
// arity in a way that the new call would break.
const wirings = [...BOARD.matchAll(/wireRowImageDropzone\(/g)].length;
checkTrue('loadboard wires the shared dropzone in several places', wirings >= 3);
checkTrue('Mondelez passes its single-cell refresher',
  /wireRowImageDropzone\([\s\S]{0,200}refreshMondelezImageCell/.test(UNIFIED));

// A zero-parameter callback called with an argument must still run cleanly.
let ran = 0;
const zeroArg = () => { ran += 1; };
zeroArg({ id: 'x' });
check('a zero-parameter redraw ignores the extra argument', ran, 1);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
