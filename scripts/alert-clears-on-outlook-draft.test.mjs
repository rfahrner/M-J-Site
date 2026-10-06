/*
 * Regression test: sending the text clears the alert, even when the gateway
 * failed and the dispatcher finished in Outlook.
 *
 * Reported 2026-10-06: "I just sent a text from the alerts pop up and it
 * didn't make the alert go away." It was a PRE-SHIFT alert, and the send fell
 * back to Outlook -- which is the one combination where the dismissal hangs
 * off a database write.
 *
 * The fallback used to run:
 *
 *     const markSent = async () => {
 *       if (sendTextModalState.markShiftIdsOnSent) await markPreShiftTextSent(...);
 *       finishSendTextModalAsSent();     // <- onSent(), i.e. dismiss the alert
 *     };
 *
 * Three ways that loses the dismissal, all silent:
 *   - markPreShiftTextSent() rejects (it swallows its own query error, but
 *     logChange/labelForRow after the try are not covered), so the await
 *     throws and finishSendTextModalAsSent() is never reached;
 *   - sendTextModalState is read AGAIN after the await, so anything that
 *     closed or replaced the modal in that window makes it null;
 *   - nothing awaits or catches markSent(), so the rejection is an unhandled
 *     promise nobody sees.
 *
 * The dispatcher HAS sent the text -- the draft is open in their mail client.
 * Bookkeeping must not be able to bring the alert back. Clear it first, record
 * it second, and SAY so if recording fails.
 *
 * Run: node --test scripts/alert-clears-on-outlook-draft.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const board = fs.readFileSync('loadboard.js', 'utf8');
const lift = (name) =>
  board.match(new RegExp(`  (?:export )?(?:async )?function ${name}\\([^]*?\\n  \\}`))[0]
    .replace(/^\s*export\s+/, '  ');

function setup({ markThrows = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="modal-send-text">
      <div id="send-text-status"></div>
      <textarea id="send-text-message">Your shift starts at 14:00</textarea>
      <div id="send-text-actions">
        <button id="send-text-cancel">Cancel</button>
        <button id="send-text-submit">Send</button>
      </div>
    </div></body>`);
  const { window } = dom;
  const $ = (sel) => window.document.querySelector(sel);

  const events = [];
  const marked = [];
  const statuses = [];

  const context = vm.createContext({
    window,
    document: window.document,
    $,
    $all: (sel, root) => [...(root || window.document).querySelectorAll(sel)],
    console,
    Promise, Error, JSON, String, Number, Set, Array, Object, Boolean, Date,
    setTimeout, clearTimeout,
    // the gateway is down -- this is what forces the Outlook fallback
    fetch: async () => { throw new Error('gateway unreachable'); },
    SUPABASE_URL: 'https://example.supabase.co',
    filterNeverTextRecipients: (r) => ({ allowed: r, blocked: [] }),
    formatTextAddress: (p) => String(p),
    setDriverSyncStatus: (msg, kind) => statuses.push({ msg, kind }),
    openMailDraft: () => events.push('opened-outlook'),
    openOutlookWebDraft: () => events.push('opened-outlook-web'),
    sendFromReminderHtml: () => '',
    markPreShiftTextSent: async (ids) => {
      marked.push(ids);
      // The real one catches its own query error, but logChange() and
      // labelForRow() run after that try. This stands in for either throwing.
      if (markThrows) throw new Error('logChange blew up');
    },
    escapeHtml: (s) => String(s),
  });

  vm.runInContext(`
    let sendTextModalState = null;
    ${lift('textDraftControlsHtml')}
    ${lift('resetSendTextActions')}
    ${lift('wireTextDraftControls')}
    ${lift('finishSendTextModalAsSent')}
    ${lift('submitSendTextModal')}
    globalThis.__open = (state) => { sendTextModalState = state; };
    globalThis.__submit = submitSendTextModal;
    globalThis.__state = () => sendTextModalState;
  `, context);

  return { window, $, context, events, marked, statuses };
}

const PRE_SHIFT_STATE = (onSent) => ({
  recipients: [{ name: 'Driver A', phone: '7705550100' }],
  markShiftIdsOnSent: [1234],
  allowDnu: false,
  onSent,
});

/* ------------------------------------------------------------------ */
test('the Outlook fallback dismisses the alert', async () => {
  const { $, context, events } = setup();
  let dismissed = 0;
  context.__open(PRE_SHIFT_STATE(() => { dismissed++; }));

  await context.__submit();                       // gateway fails -> fallback UI
  assert.ok($('#send-text-draft-open'), 'the Outlook buttons appeared');

  $('#send-text-draft-open').dispatchEvent(new context.window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(events.includes('opened-outlook'), 'the draft opened');
  assert.equal(dismissed, 1, 'the alert was dismissed');
  assert.equal($('#modal-send-text').classList.contains('hidden'), true, 'and the modal closed');
});

test('and still dismisses it when recording the send fails', async () => {
  // This is the reported bug. The dispatcher has sent the text; a failure to
  // write pre_shift_text_sent must not resurrect the alert.
  const { $, context, statuses } = setup({ markThrows: true });
  let dismissed = 0;
  context.__open(PRE_SHIFT_STATE(() => { dismissed++; }));

  await context.__submit();
  $('#send-text-draft-open').dispatchEvent(new context.window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(dismissed, 1, 'the alert is dismissed even though the write threw');
  assert.equal($('#modal-send-text').classList.contains('hidden'), true);
  // ...and the failure is reported rather than swallowed.
  assert.ok(statuses.some((s) => s.kind === 'error' && /record|sav/i.test(s.msg)),
    `the write failure is surfaced; got ${JSON.stringify(statuses)}`);
});

test('the web-Outlook button behaves identically', async () => {
  const { $, context, events } = setup();
  let dismissed = 0;
  context.__open(PRE_SHIFT_STATE(() => { dismissed++; }));
  await context.__submit();
  $('#send-text-draft-open-web').dispatchEvent(new context.window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(events.includes('opened-outlook-web'));
  assert.equal(dismissed, 1);
});

test('the shift is still recorded as texted on the happy path', async () => {
  const { $, context, marked } = setup();
  context.__open(PRE_SHIFT_STATE(() => {}));
  await context.__submit();
  $('#send-text-draft-open').dispatchEvent(new context.window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(marked, [[1234]], 'pre_shift_text_sent is still written');
});

test('an alert with no shift ids still dismisses', async () => {
  const { $, context } = setup();
  let dismissed = 0;
  context.__open({ ...PRE_SHIFT_STATE(() => { dismissed++; }), markShiftIdsOnSent: null });
  await context.__submit();
  $('#send-text-draft-open').dispatchEvent(new context.window.Event('click'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dismissed, 1);
});

test('the dismissal does not read modal state after an await', () => {
  // The structural rule, pinned in source: whatever onSent needs must be
  // captured BEFORE the first await, because the modal can be closed or
  // replaced while a database write is in flight.
  const fn = board.match(/const markSent = async \(\)[^]*?\n      \};/)[0];
  const finishAt = fn.indexOf('finishSendTextModalAsSent()');
  const awaitAt = fn.indexOf('await ');
  assert.ok(finishAt !== -1, 'the fallback still finishes the modal');
  assert.ok(awaitAt === -1 || finishAt < awaitAt,
    'the alert is cleared before anything is awaited');
});
