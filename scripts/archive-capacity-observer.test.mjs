import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../archive-image-backup-capacity.js', import.meta.url), 'utf8');

// Model childList delivery, including the browser behavior that assigning
// identical innerHTML replaces children and queues another observer callback.
function mount({ delayed = false } = {}) {
  let callback, observing = false, pending = false, writes = 0;
  let panelPresent = !delayed;
  const notes = [];
  const mutate = () => { if (observing) pending = true; };
  const schedule = {
    textContent: 'Schedule: Daily background sweep',
    html: '<strong>Schedule:</strong> Daily background sweep',
    get innerHTML() { return this.html; },
    set innerHTML(value) { this.html = value; writes++; mutate(); },
  };
  const panel = {
    querySelectorAll: () => [schedule],
    appendChild: note => { notes.push(note); mutate(); },
  };
  const document = {
    readyState: 'complete', documentElement: {},
    getElementById: id => id === 'image-backup-panel' ? (panelPresent ? panel : null) : notes.find(note => note.id === id),
    createElement: () => ({}),
  };
  const context = {
    document, setTimeout: () => {},
    MutationObserver: class {
      constructor(fn) { callback = fn; }
      observe() { observing = true; }
      disconnect() { observing = false; }
    },
  };
  vm.runInNewContext(source, context);
  function settle() {
    let deliveries = 0;
    while (pending && deliveries < 10) {
      pending = false;
      callback();
      deliveries++;
    }
    assert.equal(pending, false, 'observer must settle instead of starving clicks, timers, and network callbacks');
  }
  return { schedule, notes, settle, mutate, get writes() { return writes; },
    addPanel() { panelPresent = true; mutate(); },
  };
}

test('unrelated page updates do not start an Archive mutation loop', () => {
  const page = mount();
  const initialWrites = page.writes;
  for (let i = 0; i < 3; i++) { page.mutate(); page.settle(); }
  assert.equal(page.writes, initialWrites);
  assert.equal(page.notes.length, 1);
  assert.match(page.schedule.innerHTML, /Every 15 minutes/);
});

test('a delayed dashboard mount gets its label and one note, then settles', () => {
  const page = mount({ delayed: true });
  page.addPanel();
  page.settle();
  assert.equal(page.writes, 1);
  assert.equal(page.notes.length, 1);
  page.mutate();
  page.settle();
  assert.equal(page.writes, 1);
  assert.equal(page.notes.length, 1);
});
