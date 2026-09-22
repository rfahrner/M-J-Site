/*
 * Regression test for getting a file onto a board row at all.
 *
 * Drag-and-drop onto the IMAGE column stopped working for a day, and the
 * change that looked responsible was reverted before it turned out to be
 * innocent. Nothing in the app covered the three ways a file actually gets
 * into a row -- drop, click-to-browse, paste -- so the only way to tell
 * whether they worked was for a dispatcher to try it.
 *
 * This wires the REAL dropzone markup to the REAL delegated handlers and
 * fires the three events, asserting the upload function is reached with the
 * right row and file. It would have answered that question in a second.
 *
 * Run: npm i --no-save jsdom && node scripts/board-image-drop.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const SRC = read('loadboard.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('missing ' + name);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = src.indexOf('(', src.indexOf(`function ${name}`)), p = 0;
  for (; i < src.length; i++) { if (src[i] === '(') p++; else if (src[i] === ')') { p--; if (!p) { i++; break; } } }
  i = src.indexOf('{', i);
  let d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1); } }
  throw new Error('unbalanced ' + name);
}

const dom = new JSDOM('<!doctype html><body><table id="board-table"><tbody><tr><td id="cell"></td></tr></tbody></table></body>');
const { window } = dom;
global.window = window; global.document = window.document;

const escapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The real file-type rules, not a copy of them.
const TYPES = read('upload-file-types.js').replace(/^export /gm, '');

const calls = { upload: [], view: [], del: [] };
const api = new Function(
  'escapeHtml', 'uploadRowImage', 'viewRowImage', 'deleteRowImage', 'confirm', 'console',
  `${TYPES}
   ${extractFunction(SRC, 'rowImageDropzoneHtml')}
   ${extractFunction(SRC, 'wireRowImageDropzone')}
   return { rowImageDropzoneHtml, wireRowImageDropzone };`
)(escapeHtml,
  (row, files) => calls.upload.push({ row: row.id, files: Array.from(files).map((f) => f.name) }),
  (...a) => calls.view.push(a),
  (...a) => calls.del.push(a),
  () => true,
  console);

const ROW = { id: 'trip-7', routeImageUrls: [] };
document.getElementById('cell').innerHTML = api.rowImageDropzoneHtml(ROW, 'trip-7');
api.wireRowImageDropzone(
  document.getElementById('board-table'),
  (id) => (id === 'trip-7' ? ROW : null),
  async () => {}, () => {}, () => 'PRO 884512');

const zone = document.querySelector('[data-action="row-image-dropzone"]');
check('the dropzone renders', !!zone, true);

// A FileList is array-like, not an array -- the handlers have to cope.
function fileList(files) {
  const l = { length: files.length, item: (i) => files[i], [Symbol.iterator]: function* () { yield* files; } };
  files.forEach((f, i) => { l[i] = f; });
  return l;
}
const fire = (type, patch) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, patch);
  zone.dispatchEvent(e);
  return e;
};

console.log('\n1. dragging a file onto the cell');
calls.upload.length = 0;
fire('drop', { dataTransfer: { files: fileList([{ name: 'route.jpg', type: 'image/jpeg' }]) } });
check('upload was reached', calls.upload.length, 1);
check('with the right row', calls.upload[0]?.row, 'trip-7');
check('and the right file', calls.upload[0]?.files.join(), 'route.jpg');

console.log('\n2. dragover marks the cell so there is feedback');
zone.classList.remove('mdz-dropzone-active');
const over = fire('dragover', {});
check('default prevented, or the browser refuses the drop', over.defaultPrevented, true);
check('cell shows as a target', zone.classList.contains('mdz-dropzone-active'), true);

console.log('\n3. clicking the cell opens the file picker');
const input = zone.querySelector('input[type="file"]');
let picked = false;
input.click = () => { picked = true; };
fire('click', {});
check('picker opened', picked, true);
check('and it offers PDFs as well as images', /pdf/i.test(input.getAttribute('accept') || ''), true);

console.log('\n4. pasting a file');
calls.upload.length = 0;
fire('paste', { clipboardData: { items: [
  { kind: 'file', type: 'image/png', getAsFile: () => ({ name: 'pasted.png', type: 'image/png' }) },
] } });
check('upload was reached', calls.upload[0]?.files.join(), 'pasted.png');

console.log('\n5. a PDF goes through the same three doors');
for (const [what, patch] of [
  ['drop',  { dataTransfer: { files: fileList([{ name: 'sheet.pdf', type: 'application/pdf' }]) } }],
  // A PDF pasted from Explorer often arrives with a blank item type.
  ['paste', { clipboardData: { items: [
      { kind: 'file', type: '', getAsFile: () => ({ name: 'sheet.pdf', type: '' }) }] } }],
]) {
  calls.upload.length = 0;
  fire(what, patch);
  check(`${what} accepts a PDF`, calls.upload[0]?.files.join(), 'sheet.pdf');
}

console.log('\n6. and something that is neither is refused');
// The drop handler forwards whatever was dropped; uploadRowImage is what
// filters, via acceptedUploads. Assert that directly rather than pretending
// the handler rejected it.
const acceptedUploads = new Function(`${TYPES}; return acceptedUploads;`)();
check('a spreadsheet is filtered out before upload',
  acceptedUploads([{ name: 'rates.xlsx', type: 'application/vnd.ms-excel' }]).length, 0);
check('while an image beside it survives',
  acceptedUploads([
    { name: 'rates.xlsx', type: 'application/vnd.ms-excel' },
    { name: 'route.jpg', type: 'image/jpeg' },
  ]).map((f) => f.name).join(), 'route.jpg');

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
