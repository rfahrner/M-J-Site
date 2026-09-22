import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
function fixture() {
  const elements = new Map();
  const footer = [];
  const add = (id, value = '') => {
    const classes = new Set();
    const element = { value, disabled: false, textContent: '',
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      remove: () => { elements.delete('#'+id); footer.splice(footer.indexOf(id), 1); },
      addEventListener: (_, handler) => { element.click = handler; },
      insertAdjacentHTML: (_, html) => {
        for (const match of html.matchAll(/id="([^"]+)"/g)) {
          add(match[1]); footer.splice(footer.indexOf(id), 0, match[1]);
        }
      },
    };
    elements.set('#'+id, element); return element;
  };
  add('send-text-cancel'); add('send-text-submit'); footer.push('send-text-cancel','send-text-submit');
  add('send-text-message', 'Original message'); add('send-text-status');
  const opened = [];
  const context = vm.createContext({
    $: selector => elements.get(selector), console: { error() {} }, SUPABASE_URL: 'test',
    sendTextModalState: { recipients: [{ phone: '15555550100' }], allowDnu: true },
    filterNeverTextRecipients: recipients => ({ allowed: recipients }), formatTextAddress: phone => phone+'@textbetter.com',
    fetch: async () => { throw new Error('Failed to fetch'); },
    openMailDraft: (addresses, message) => opened.push({ type: 'desktop', addresses, message }),
    openOutlookWebDraft: (addresses, message) => opened.push({ type: 'web', addresses, message }),
    finishSendTextModalAsSent() {},
  });
  for (const name of ['textDraftControlsHtml','wireTextDraftControls','resetSendTextActions','submitSendTextModal']) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`));
    assert.ok(match, name); vm.runInContext(match[0], context);
  }
  return { elements, footer, opened, context };
}

test('failed Send leaves exactly Cancel, Outlook Web, Outlook in the footer', async () => {
  const f = fixture();
  await vm.runInContext('submitSendTextModal()', f.context);
  const visible = f.footer.filter(id => !f.elements.get('#'+id).classList.contains('hidden'));
  assert.deepEqual(visible, ['send-text-cancel','send-text-draft-open-web','send-text-draft-open']);
  f.elements.get('#send-text-message').value = 'Edited message';
  f.elements.get('#send-text-draft-open-web').click();
  assert.equal(f.opened[0].type, 'web');
  assert.equal(f.opened[0].message, 'Edited message');
  assert.equal(f.elements.has('#send-text-draft-copy-addrs'), false);
});

test('reopening restores Send and removes the old fallback buttons', async () => {
  const f = fixture(); await vm.runInContext('submitSendTextModal()', f.context);
  vm.runInContext('resetSendTextActions()', f.context);
  assert.deepEqual(f.footer, ['send-text-cancel','send-text-submit']);
  assert.equal(f.elements.get('#send-text-submit').classList.contains('hidden'), false);
});
