/*
 * Regression test for taking a text into Outlook by hand.
 *
 * A mailto: goes to whatever Windows has registered as the default mail
 * client. That is not necessarily the Outlook the dispatcher's mailbox is set
 * up in: a machine migrated to new Outlook while the account still only exists
 * in classic Outlook opens the draft in an app that cannot send it, and a web
 * page cannot choose between the two. So the same draft is also offered as
 * copy-and-paste, which does not depend on the default app at all.
 *
 * What this pins:
 *  - the mailto still uses COMMAS (what the mailto spec requires, and what
 *    works for everyone whose default app is correct)
 *  - the clipboard copy uses SEMICOLONS, because that text is pasted into
 *    Outlook's own To: field, where classic Outlook needs a semicolon unless
 *    "Commas can be used to separate multiple recipients" has been turned on
 *  - the anchor is in the document when it is clicked; a synthetic click on a
 *    detached anchor is not guaranteed to reach the OS protocol handler
 *  - the copy path still lets the dispatcher mark the text as sent, so an
 *    alert that was handled by hand still clears
 *
 * Run: npm i --no-save jsdom && node scripts/text-draft-fallback.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}

// Two of these functions take a destructured options object, e.g.
// ({ withDone = false } = {}). Counting braces from the first `{` latches onto
// the PARAMETER braces and closes the function early, so the parameter list is
// walked with a paren counter first and brace counting starts after it.
function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = src.indexOf('(', src.indexOf(`function ${name}`));
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const HINT = /const TEXT_DRAFT_HINT\s*=\s*\n?\s*"([^"]*)"/.exec(SRC);
const bodies = ['openMailDraft', 'copyToClipboard', 'textDraftControlsHtml', 'wireTextDraftControls']
  .map((n) => extractFunction(SRC, n)).join('\n');

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://example.test/' });
const { window } = dom;

// Record what the draft opener does instead of letting jsdom navigate.
const clicks = [];
const origClick = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = function () {
  clicks.push({ href: this.href, inDocument: this.ownerDocument.contains(this) });
};
void origClick;

const copied = [];
const nav = { clipboard: { writeText: async (t) => { copied.push(t); } } };

const sandbox = {
  window, document: window.document, navigator: nav,
  escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  $: (sel) => window.document.querySelector(sel),
  console: { error: () => {} },
  TEXT_DRAFT_HINT: HINT ? HINT[1] : '',
};
const api = new Function(
  ...Object.keys(sandbox),
  `${bodies}; return { openMailDraft, copyToClipboard, textDraftControlsHtml, wireTextDraftControls };`
)(...Object.values(sandbox));

const ADDRS = ['15551230001@textbetter.com', '15551230002@textbetter.com', '15551230003@textbetter.com'];
const MESSAGE = 'Dispatch 0500, gate code 4417. Reply if you cannot make it.';

// ---------------------------------------------------------------------------
console.log('1. the mailto keeps commas, and the anchor is in the document');
api.openMailDraft(ADDRS, MESSAGE);
check('one draft opened', clicks.length, 1);
check('anchor was attached when clicked', clicks[0]?.inDocument, true);
check('recipients comma-separated', /^mailto:15551230001@textbetter\.com,15551230002@textbetter\.com,15551230003@textbetter\.com\?/.test(clicks[0]?.href || ''), true);
check('message is url-encoded in the body', (clicks[0]?.href || '').includes(encodeURIComponent(MESSAGE)), true);
check('no anchor left behind in the document', window.document.querySelectorAll('a').length, 0);

// ---------------------------------------------------------------------------
console.log('\n2. the clipboard copy uses semicolons, for Outlook\'s own To: field');
window.document.getElementById('host').innerHTML = api.textDraftControlsHtml('t1', { withDone: true });
let opened = 0, done = 0;
api.wireTextDraftControls('t1', ADDRS, MESSAGE, { onOpened: () => { opened++; }, onDone: () => { done++; } });

window.document.getElementById('t1-copy-addrs').click();
await new Promise((r) => setTimeout(r, 0));
check('addresses copied', copied.length, 1);
check('separated by "; "', copied[0], ADDRS.join('; '));
check('and NOT by commas', copied[0].includes(','), false);
check('confirmation shown', /3 addresses copied/.test(window.document.getElementById('t1-copied').textContent), true);

window.document.getElementById('t1-copy-msg').click();
await new Promise((r) => setTimeout(r, 0));
check('message copied verbatim', copied[1], MESSAGE);

// ---------------------------------------------------------------------------
console.log('\n3. either route can mark the text as sent');
window.document.getElementById('t1-open').click();
check('opening the draft marked it sent', opened, 1);
check('and opened exactly one more draft', clicks.length, 2);
window.document.getElementById('t1-done').click();
check('Done marked it sent too', done, 1);

// ---------------------------------------------------------------------------
console.log('\n4. the group flow gets copy controls but no Done button');
window.document.getElementById('host').innerHTML = api.textDraftControlsHtml('t2');
check('no Done button', window.document.getElementById('t2-done'), null);
check('still has Copy Addresses', !!window.document.getElementById('t2-copy-addrs'), true);
check('still has Open in Outlook', !!window.document.getElementById('t2-open'), true);

// ---------------------------------------------------------------------------
console.log('\n5. the hint says what to do when the wrong Outlook opens');
check('hint mentions copying', /copy the addresses and message/i.test(sandbox.TEXT_DRAFT_HINT), true);
check('hint mentions the default', /default/i.test(sandbox.TEXT_DRAFT_HINT), true);

// ---------------------------------------------------------------------------
console.log('\n6. a single recipient reads correctly');
copied.length = 0;
window.document.getElementById('host').innerHTML = api.textDraftControlsHtml('t3');
api.wireTextDraftControls('t3', [ADDRS[0]], MESSAGE, {});
window.document.getElementById('t3-copy-addrs').click();
await new Promise((r) => setTimeout(r, 0));
check('one address, no separator', copied[0], ADDRS[0]);
check('singular wording', /1 address copied/.test(window.document.getElementById('t3-copied').textContent), true);

// ---------------------------------------------------------------------------
console.log('\n7. the call sites are wired to the shared helpers');
check('single-recipient fallback uses the controls',
  /textDraftControlsHtml\("send-text-draft", \{ withDone: true \}\)/.test(SRC), true);
check('single-recipient fallback wires them',
  /wireTextDraftControls\("send-text-draft"/.test(SRC), true);
check('group batch renders the controls', /textDraftControlsHtml\("tg-draft"\)/.test(SRC), true);
check('group batch open uses openMailDraft', /openMailDraft\(batch\.map/.test(SRC), true);
check('no raw mailto anchors left in the text paths',
  (SRC.match(/a\.href = `mailto:/g) || []).length, 1); // openMailDraft itself

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
