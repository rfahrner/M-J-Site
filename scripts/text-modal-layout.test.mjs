/*
 * Regression test for the text modals' buttons, their Details summary, and the
 * two Outlook routes the buttons lead to.
 *
 * The group modal used to show Cancel, Start, Send Now and "Open in Outlook
 * Instead" at once, above three stacked yellow notes that pushed the buttons
 * off the bottom of a long batch -- four choices before anything had happened,
 * two of which only mattered after a failure. The resting footer is now Cancel
 * and Send Now; the Outlook pair appears only once an automatic send has
 * failed; and the notes fold into one summary that starts closed.
 *
 * Start is still in the DOM, hidden. Three pages bind their own starter to it
 * -- driver-list groups, board selection, Houston selection -- and Send Now
 * triggers whichever one this page wired, so deleting it would silently unwire
 * all three.
 *
 * Parts 6 and 7 carry over the two load-bearing facts from the old
 * text-draft-fallback test, which was removed once the copy-to-clipboard
 * controls went: the mailto must use COMMAS, and its anchor must be attached
 * to the document when clicked. A synthetic click on a detached anchor is not
 * reliably handed to the OS protocol handler, and that is the exact shape of
 * "the button does nothing at all".
 *
 * Run: npm i --no-save jsdom && node scripts/text-modal-layout.test.mjs
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
const checkTrue = (l, v) => check(l, !!v, true);

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = src.indexOf('(', src.indexOf(`function ${name}`)), p = 0;
  for (; i < src.length; i++) { if (src[i] === '(') p++; else if (src[i] === ')') { p--; if (!p) { i++; break; } } }
  i = src.indexOf('{', i);
  let d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1); } }
  throw new Error(`unbalanced braces in ${name}`);
}

const GROUP_PAGES = ['index.html', 'buildingc.html', 'dalaware.html', 'houston.html', 'driverlist.html'];
const SEND_PAGES  = ['index.html', 'buildingc.html', 'dalaware.html', 'houston.html', 'mondelez.html'];

// ---------------------------------------------------------------------------
console.log('1. the group footer reads Cancel, Open in Outlook Web, Open in Outlook');
for (const page of GROUP_PAGES) {
  const footer = new JSDOM(read(page)).window.document.querySelector('#modal-text-group .modal-footer');
  checkTrue(`${page} has the group footer`, !!footer);
  if (!footer) continue;
  check(`${page} order`, [...footer.querySelectorAll('button')].map((b) => b.id).join(','),
    'tg-cancel,tg-open-web,tg-open-batch,tg-send-now,tg-confirm-sent,tg-finish,tg-start');
  const hidden = (id) => footer.querySelector(`#${id}`).classList.contains('hidden');
  check(`${page}: Send Now showing at rest`, hidden('tg-send-now'), false);
  check(`${page}: Outlook pair hidden at rest`, hidden('tg-open-web') && hidden('tg-open-batch'), true);
  check(`${page}: Start present but hidden`, hidden('tg-start'), true);
}

console.log('\n2. and the single-recipient modal has somewhere for the notes');
for (const page of SEND_PAGES) {
  const doc = new JSDOM(read(page)).window.document;
  check(`${page}: says Send Now`, doc.querySelector('#send-text-submit').textContent.trim(), 'Send Now');
  checkTrue(`${page}: has a details slot`, !!doc.querySelector('#modal-send-text #send-text-details'));
}

// ---------------------------------------------------------------------------
console.log('\n3. the notes collapse into one summary that starts closed');
checkTrue('the render builds a <details>', /<details class="text-modal-details"><summary>Details<\/summary>/.test(SRC));
check('it is never rendered open', /text-modal-details"[^>]*\sopen/.test(SRC), false);
checkTrue('the three notes are what go inside',
  /const detailNotes = \[skipNote, dedupedNote, blockedNote\]\.filter\(Boolean\)/.test(SRC));
check('and they are no longer emitted loose above the buttons',
  /\$\{skipNote\}\$\{dedupedNote\}\$\{blockedNote\}/.test(SRC), false);

const batchBlock = /Batch \$\{s\.batchIndex \+ 1\}[\s\S]{0,600}?`;/.exec(SRC)?.[0] || '';
checkTrue('Details renders after the recipient list',
  batchBlock.indexOf('${details}') > batchBlock.indexOf('batch.map((d) => d.name)'));

const dom = new JSDOM('<!doctype html><body><div id="h"></div></body>');
dom.window.document.getElementById('h').innerHTML =
  '<details class="text-modal-details"><summary>Details</summary><div class="calc-note">x</div></details>';
check('a freshly rendered summary is closed', dom.window.document.querySelector('details').open, false);
checkTrue('the stylesheet gives it a closed marker',
  /\.text-modal-details > summary::before \{ content: "\\25B8"/.test(read('loadboard.css')));

// ---------------------------------------------------------------------------
console.log('\n4. one press: Send Now runs this page\'s starter, then sends');
checkTrue('Send Now goes through the shared handler', /export function groupSendNowPressed\(\)/.test(SRC));
checkTrue('it clicks the hidden starter while still in setup',
  /const starter = \$\("#tg-start"\);\s*\n\s*if \(starter\) starter\.click\(\);/.test(SRC));
checkTrue('and the progress render carries on into the send',
  /if \(autoSendAfterStart\) \{\s*\n\s*autoSendAfterStart = false;\s*\n\s*void sendCurrentGroupBatchDirect\(\);/.test(SRC));
check('no page binds Send Now straight to the sender',
  /on\("tg-send-now", "click", sendCurrentGroupBatchDirect\)/.test(SRC + read('houston.js') + read('driverlist-text-batch-fix.js')), false);

console.log('\n5. the Outlook pair appears only after a failure');
checkTrue('a failed send reveals it', /showGroupOutlookFallback\(\);/.test(SRC));
check('and nothing else does',
  SRC.split('setGroupFooter("tg-open-web", "tg-open-batch")').length, 2);
checkTrue('either route then moves on to Sent - Next Batch',
  (SRC.match(/setGroupFooter\("tg-confirm-sent"\)/g) || []).length >= 2);

// ---------------------------------------------------------------------------
console.log('\n6. the mailto uses commas, on an anchor that is in the document');
const win = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' }).window;
const clicks = [];
win.HTMLAnchorElement.prototype.click = function () {
  clicks.push({ href: this.href, inDocument: this.ownerDocument.contains(this) });
};
const opens = [];
win.open = (url, target, features) => { opens.push({ url, target, features }); return null; };
const api = new Function('window', 'document', 'OUTLOOK_WEB_COMPOSE',
  `${extractFunction(SRC, 'openMailDraft')}
   ${extractFunction(SRC, 'openOutlookWebDraft')}
   return { openMailDraft, openOutlookWebDraft };`
)(win, win.document, /const OUTLOOK_WEB_COMPOSE = "([^"]+)"/.exec(SRC)[1]);

const ADDRS = ['15551230001@textbetter.com', '15551230002@textbetter.com'];
const MESSAGE = 'Dispatch 0500, gate code 4417.';
api.openMailDraft(ADDRS, MESSAGE);
check('one draft opened', clicks.length, 1);
// The reason this matters: a detached anchor is not reliably handed to the OS.
check('the anchor was attached when clicked', clicks[0]?.inDocument, true);
check('recipients comma-separated', clicks[0]?.href.startsWith(`mailto:${ADDRS.join(',')}?`), true);
check('body url-encoded', clicks[0]?.href.includes(encodeURIComponent(MESSAGE)), true);
check('and nothing left behind', win.document.querySelectorAll('a').length, 0);

console.log('\n7. Outlook on the web needs no mail app at all');
api.openOutlookWebDraft(ADDRS, MESSAGE);
check('a compose tab opened', opens.length, 1);
check('in a new tab', opens[0]?.target, '_blank');
checkTrue('with noopener', /noopener/.test(opens[0]?.features || ''));
checkTrue('at the compose deeplink',
  opens[0]?.url.startsWith('https://outlook.office.com/mail/deeplink/compose?'));
checkTrue('recipients unescaped', opens[0]?.url.includes(`to=${ADDRS.join(',')}`));
// That endpoint rejects plus-encoding, so encodeURIComponent is the right one.
checkTrue('body percent-encoded', opens[0]?.url.includes(`body=${encodeURIComponent(MESSAGE)}`));
check('no raw spaces in the url', /\s/.test(opens[0]?.url || ''), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
