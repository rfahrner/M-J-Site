import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const dialogs = [];
  const microtasks = [];
  const previousFocus = { isConnected: true, focus() { this.focused = true; } };
  function element(tag) {
    return { tag, children: [], events: {}, attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(key, fn) { this.events[key] = fn; },
      append(...nodes) { this.children.push(...nodes); },
      showModal() { this.open = true; }, close() { this.open = false; },
      remove() { this.removed = true; }, focus() { this.focused = true; }
    };
  }
  const context = vm.createContext({
    document: { activeElement: previousFocus, createElement: element, body: { append(dialog) { dialogs.push(dialog); } } },
    queueMicrotask(fn) { microtasks.push(fn); }
  });
  vm.runInContext(fs.readFileSync('dnu-assignment.js', 'utf8').replaceAll('export function', 'function'), context);
  return { dialogs, previousFocus,
    warn: vm.runInContext('acknowledgeDnuAssignment', context),
    isNew: vm.runInContext('isNewDnuAssignment', context),
    flush() { while (microtasks.length) microtasks.shift()(); }
  };
}

test('only a newly assigned DNU driver requires acknowledgment', () => {
  const { isNew } = fixture();
  assert.equal(isNew({ id: 12, rating: 'dnu', name: 'Driver' }, null), true);
  assert.equal(isNew({ id: 12, rating: 'DNU' }, '12'), false);
  assert.equal(isNew({ id: 12, rating: 'A' }, null), false);
  assert.equal(isNew(null, null), false);
});

test('dialog identifies the driver and requires its explicit acknowledgment button', () => {
  const f = fixture();
  f.warn({ id: 12, name: '<Driver>', rating: 'DNU' });
  assert.equal(f.dialogs.length, 0);
  f.flush();
  const dialog = f.dialogs[0];
  assert.equal(dialog.open, true);
  assert.equal(dialog.children[0].textContent, 'DNU');
  assert.ok(dialog.children[1].textContent.includes('<Driver>'));
  assert.equal(dialog.children[3].focused, true);
  let prevented = false;
  dialog.events.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, true);
  dialog.children[3].events.click();
  assert.equal(dialog.open, false);
  assert.equal(dialog.removed, true);
  assert.equal(f.previousFocus.focused, true);
});

test('pending warnings do not stack and each different DNU driver is acknowledged', () => {
  const f = fixture();
  f.warn({ id: 1, name: 'First', rating: 'DNU' });
  f.warn({ id: 1, name: 'First', rating: 'DNU' });
  f.warn({ id: 2, name: 'Second', rating: 'DNU' });
  f.flush();
  assert.equal(f.dialogs.length, 1);
  f.dialogs[0].children[3].events.click();
  assert.equal(f.dialogs.length, 2);
  assert.ok(f.dialogs[1].children[1].textContent.includes('Second'));
  f.dialogs[1].children[3].events.click();
  f.warn({ id: 2, name: 'Second', rating: 'DNU' }, 2);
  f.flush();
  assert.equal(f.dialogs.length, 2);
});


test('notes link opens the assigned driver in a new tab without dismissing the acknowledgment', () => {
  const f = fixture();
  f.warn({ id: 'driver/12', name: 'Driver', rating: 'DNU' });
  f.flush();
  const dialog = f.dialogs[0];
  const link = dialog.children[2];
  assert.equal(link.tag, 'a');
  assert.equal(link.href, 'driverlist.html?driver=driver%2F12&tab=notes');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(dialog.open, true);
});

test('profile deep link targets Notes and safely ignores missing or invalid drivers', () => {
  const source = fs.readFileSync('loadboard.js', 'utf8');
  const fn = source.match(/  function openRequestedDriverProfileNotes\(\) \{[\s\S]*?\n  \}/)[0];
  for (const [search, expected] of [
    ['?driver=12&tab=notes', ['12', 'notes']],
    ['?driver=missing&tab=notes', []],
    ['?driver=12&tab=edit', []],
    ['?tab=notes', []],
    ['', []]
  ]) {
    const calls = [];
    const context = vm.createContext({ URLSearchParams, window: { location: { search } },
      findDriver: id => id === '12' ? { id } : null,
      openEditDriverModal: id => calls.push(id), switchAddDriverTab: tab => calls.push(tab) });
    vm.runInContext(fn + ';openRequestedDriverProfileNotes();', context);
    assert.deepEqual(calls, expected);
  }
});
