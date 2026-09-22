/*
 * Regression test for accepting PDFs wherever an image can go.
 *
 * Dispatchers get trip sheets and paperwork as PDFs as often as photographs.
 * Before this, every dropzone tested file.type.startsWith("image/") inline --
 * about ten separate places, with a matching accept="image/*" on a dozen file
 * inputs -- so a dragged or pasted PDF was silently dropped. The three storage
 * buckets also had an image-only MIME allowlist, which rejected a PDF server
 * side even if the browser had let it through (fixed in
 * supabase/migrations/20260922_allow_pdf_uploads_in_image_buckets.sql).
 *
 * The rule now lives in upload-file-types.js, a leaf module that imports
 * nothing -- mondelez.js and load-overview-timesheet-image.js are imported BY
 * loadboard.js, so a shared helper has to sit below all of them or it becomes
 * an import cycle.
 *
 * What this pins:
 *  - the predicate: images and PDFs in, everything else out, including a PDF
 *    that arrives with a blank MIME type (which is what a Windows paste does)
 *  - isPdfRef reads the extension from the PATH, not the query string, so a
 *    signed URL whose token happens to contain ".pdf" is not a false positive
 *  - no shipped module still filters on image/ by itself
 *  - every file input offers PDFs, except the driver PWA's camera
 *  - the chip escapes its filename -- that text comes from whatever the
 *    uploader named the file
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}
const checkTrue = (label, v) => check(label, !!v, true);

// The repo has no package.json, so node treats a bare .js as CommonJS and
// chokes on `export`. The browser loads it as <script type="module"> and does
// not care. Copy the real source to a .mjs and import THAT, so the test still
// exercises the shipped file rather than a transcription of it.
const shim = join(mkdtempSync(join(tmpdir(), 'pdfmod-')), 'upload-file-types.mjs');
writeFileSync(shim, read('upload-file-types.js'));
const mod = await import('file://' + shim);

// ---------------------------------------------------------------------------
console.log('1. what counts as uploadable');
const f = (name, type) => ({ name, type });
check('a jpeg is accepted', mod.isAcceptedUpload(f('sheet.jpg', 'image/jpeg')), true);
check('a heic is accepted', mod.isAcceptedUpload(f('IMG_1.heic', 'image/heic')), true);
check('a pdf is accepted', mod.isAcceptedUpload(f('trip sheet.pdf', 'application/pdf')), true);
check('a pdf with no MIME type is accepted on its extension',
  mod.isAcceptedUpload(f('trip sheet.pdf', '')), true);
check('a pdf with a generic MIME type is accepted',
  mod.isAcceptedUpload(f('sheet.PDF', 'application/octet-stream')), true);
check('a word document is not', mod.isAcceptedUpload(f('notes.docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document')), false);
check('a spreadsheet is not', mod.isAcceptedUpload(f('rates.xlsx', 'application/vnd.ms-excel')), false);
check('a zip is not', mod.isAcceptedUpload(f('all.zip', 'application/zip')), false);
check('nothing is not', mod.isAcceptedUpload(null), false);
check('acceptedUploads filters a list',
  mod.acceptedUploads([f('a.jpg', 'image/jpeg'), f('b.docx', 'application/msword'), f('c.pdf', 'application/pdf')]).length, 2);

// ---------------------------------------------------------------------------
console.log('\n2. recognising a stored PDF');
check('a storage path', mod.isPdfRef('4211/1758_ab12_trip sheet.pdf'), true);
check('an image path', mod.isPdfRef('4211/1758_ab12_route.jpg'), false);
check('a signed url', mod.isPdfRef(
  'https://x.supabase.co/storage/v1/object/sign/trip-sheets/4211/1758_ab12_sheet.pdf?token=abc.def'), true);
// The token is base64ish and can contain anything; the extension must be read
// from the path or a token ending in ".pdf" would turn every image into a PDF.
check('an image whose signed-url TOKEN contains .pdf', mod.isPdfRef(
  'https://x.supabase.co/storage/v1/object/sign/trip-sheets/4211/route.jpg?token=eyJhbGc.pdf'), false);
check('uppercase extension', mod.isPdfRef('4211/SCAN.PDF'), true);
check('empty', mod.isPdfRef(''), false);
check('a url with a fragment', mod.isPdfRef('https://x/y/z.pdf#page=2'), true);

console.log('\n3. the chip is labelled with the original filename');
check('upload prefix stripped', mod.fileNameFromRef('4211/1758823_ab12cd_trip sheet.pdf'), 'trip sheet.pdf');
check('a real Date.now() prefix too',
  mod.fileNameFromRef('4211/1758823456789_k3f9zq_trip sheet.pdf'), 'trip sheet.pdf');
check('percent-encoding decoded', mod.fileNameFromRef('4211/1758823_ab12cd_trip%20sheet.pdf'), 'trip sheet.pdf');
check('a plain name survives', mod.fileNameFromRef('sheet.pdf'), 'sheet.pdf');
// A name that merely starts with digits is not a prefix, and must survive:
// only the full <digits>_<random>_ shape is stripped.
check('a date-named file is left alone', mod.fileNameFromRef('20260922_load.pdf'), '20260922_load.pdf');

// ---------------------------------------------------------------------------
console.log('\n4. the chip escapes what the uploader named the file');
const dom = new JSDOM('<!doctype html><body><div id="h"></div></body>');
const hostile = '4211/1758823_ab12cd_<img src=x onerror=alert(1)>.pdf';
dom.window.document.getElementById('h').innerHTML = mod.pdfChipHtml('https://x/y.pdf', { label: mod.fileNameFromRef(hostile) });
check('no injected element', dom.window.document.querySelectorAll('#h img').length, 0);
checkTrue('the name is still shown as text',
  /<img src=x onerror/.test(dom.window.document.querySelector('.mdz-pdf-chip-name').textContent));
const chip = dom.window.document.querySelector('.mdz-pdf-chip');
check('opens in a new tab', chip.getAttribute('target'), '_blank');
check('with noopener', chip.getAttribute('rel'), 'noopener');

// ---------------------------------------------------------------------------
console.log('\n5. no shipped module still filters on images alone');
const SKIP = new Set(['upload-file-types.js', 'supabase.min.js']);
const offenders = [];
for (const name of readdirSync(root)) {
  if (!name.endsWith('.js') || SKIP.has(name)) continue;
  const src = read(name);
  if (/startsWith\(['"]image\//.test(src)) offenders.push(name);
}
check('none left', offenders.join(', '), '');

console.log('\n6. every picker offers PDFs (except the driver camera)');
const inputs = [];
for (const name of [...readdirSync(root), 'driver/index.html', 'public/driver/index.html']) {
  if (!/\.(js|html)$/.test(name) || SKIP.has(name)) continue;
  let src;
  try { src = read(name); } catch { continue; }
  for (const m of src.matchAll(/<input[^>]*type="file"[^>]*>/g)) {
    if (/accept="\$\{UPLOAD_ACCEPT\}"/.test(m[0])) continue;      // shared constant
    if (/capture="environment"/.test(m[0])) continue;              // camera
    const accept = /accept="([^"]*)"/.exec(m[0]);
    if (!accept) continue;
    if (!/pdf/i.test(accept[1])) inputs.push(`${name}: ${accept[1]}`);
  }
}
check('no image-only file input left', inputs.join(' | '), '');

console.log('\n7. the shared accept string covers both');
checkTrue('images', /image\/\*/.test(mod.UPLOAD_ACCEPT));
checkTrue('pdf mime', /application\/pdf/.test(mod.UPLOAD_ACCEPT));
checkTrue('and the extension, for shells that ignore the MIME type', /\.pdf/.test(mod.UPLOAD_ACCEPT));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
