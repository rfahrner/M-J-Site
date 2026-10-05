import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync('loadboard.js', 'utf8');
function lift(name) {
  const match = source.match(new RegExp(`  (?:export )?function ${name}\\([^]*?\\n  \\}`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[0].replace('export ', '');
}
function setup(tableId='board-table', metadata='data-row="r1" data-field="driverName"') {
  const dom = new JSDOM(`<!doctype html><body><table id="${tableId}"><tbody><tr><td><input data-driver-ac="true" ${metadata} value="Atiba War"></td><td><input class="next" value="1400"></td></tr><tr><td><input class="previous-row" value="Next row"></td></tr></tbody></table></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const input = document.querySelector('[data-driver-ac]');
  let picks=0, opens=0;
  window.$all = (selector, root) => [...root.querySelectorAll(selector)];
  window.requestAnimationFrame = callback => callback();
  window.findDriver = () => ({ id: 12, name: 'Atiba Ward' });
  window.openAddDriverModal = () => {};
  const editable = 'input:not([disabled]):not([readonly]):not([type="checkbox"]):not([tabindex="-1"]), textarea:not([disabled]):not([readonly]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"])';
  const funcs = ['closeDriverAutocomplete','finishDriverCellSelection','commitDriverAutocomplete','handleDriverAcKeydown','setDriverAcHighlight','ensureDriverAcBox','handleRowAwareTab','captureFocusForRerender'].map(lift).join('\n');
  window.eval(`let driverAcBox=null,driverAcInput=null,driverAcOnPick=null,driverAcHighlight=0,driverAcMatches=[{id:12,name:'Atiba Ward'}],driverAcShowAddOption=false,driverAcQuery='Atiba War';const EDITABLE_SELECTOR=${JSON.stringify(editable)};${funcs}
    window.setPicker=(input,callback)=>{driverAcInput=input;driverAcOnPick=callback;ensureDriverAcBox().classList.remove('hidden');input.addEventListener('keydown',handleDriverAcKeydown);};
    window.capture=captureFocusForRerender;
    window.tab=(event)=>handleRowAwareTab(event,'#${tableId}');
    window.setHighlight=value=>driverAcHighlight=value;
  `);
  const arm = (callback) => window.setPicker(input, callback || (driver => { input.value=driver.name;picks++; }));
  input.addEventListener('focus', () => { opens++; arm(); });
  input.addEventListener('blur', () => window.eval('closeDriverAutocomplete()'));
  document.querySelector('table').addEventListener('keydown', window.tab);
  input.focus();
  return { dom, window, document, input, arm, picks:()=>picks, opens:()=>opens };
}
const key = (window, element, name, extras={}) => element.dispatchEvent(new window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...extras}));

test('Arrow-down/Enter accepts driver, ends editing, and leaves its cell selected with a closed picker', () => {
  const { window, document, input, picks, opens } = setup();
  window.setHighlight(-1);
  document.querySelector('#driver-ac-floating').innerHTML='<div class="autocomplete-item" data-ac-index="0">Atiba Ward</div>';
  document.querySelector('[data-ac-index]').scrollIntoView=()=>{};
  key(window,input,'ArrowDown');
  assert.ok(document.querySelector('[data-ac-index]').classList.contains('is-highlighted'));
  key(window,input,'Enter');
  assert.equal(picks(),1);
  assert.equal(input.value,'Atiba Ward');
  assert.equal(document.activeElement,input.closest('td'));
  assert.equal(document.activeElement.dataset.driverCellSelected,'true');
  assert.ok(document.querySelector('#driver-ac-floating').classList.contains('hidden'));
  assert.equal(opens(),1);
});

test('mouse selection follows the same commit path and a later focus can reopen the picker', () => {
  const { window, document, input, picks } = setup();
  document.querySelector('#driver-ac-floating').innerHTML='<div data-pick-driver="12">Atiba Ward</div>';
  document.querySelector('[data-pick-driver]').dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  assert.equal(picks(),1);
  assert.equal(document.activeElement,input.closest('td'));
  assert.ok(document.querySelector('#driver-ac-floating').classList.contains('hidden'));
  input.focus();
  assert.equal(document.querySelector('#driver-ac-floating').classList.contains('hidden'),false);
});

test('Tab enters the next cell for typing from a selected driver cell on all board types', () => {
  for (const [table, metadata] of [['board-table','data-row="r1" data-field="driverName"'],['available-table','data-avail-row="r1" data-avail-field="driverName"'],['mondelez-table','data-mdz-row="r1" data-mdz-field="driverName"']]) {
    const { window, document, input }=setup(table,metadata);
    key(window,input,'Enter');
    key(window,document.activeElement,'Tab');
    assert.equal(document.activeElement,document.querySelector('.next'));
    assert.equal(document.activeElement.selectionStart,0);
    assert.equal(document.activeElement.selectionEnd,4);
    assert.ok(document.querySelector('#driver-ac-floating').classList.contains('hidden'));
  }
});

test('plain Enter without a highlighted suggestion finishes the cell; F2 resumes editing', () => {
  const { window, document, input }=setup();
  window.setHighlight(-1);
  key(window,input,'Enter');
  assert.equal(document.activeElement,input.closest('td'));
  key(window,document.activeElement,'F2');
  assert.equal(document.activeElement,input);
  assert.equal(document.querySelector('#driver-ac-floating').classList.contains('hidden'),false);
});

test('a redraw restores the selected cell without reopening its input or driver options', () => {
  const { window, document, input }=setup();
  key(window,input,'Enter');
  const restore=window.capture();
  const tbody=document.querySelector('tbody');
  tbody.innerHTML=tbody.innerHTML;
  restore();
  const fresh=document.querySelector('[data-driver-ac]');
  assert.equal(document.activeElement,fresh.closest('td'));
  assert.notEqual(document.activeElement,fresh);
  assert.ok(document.querySelector('#driver-ac-floating').classList.contains('hidden'));
});

test('a callback that opens another modal retains its focus', () => {
  const { window, document, input, arm }=setup();
  const button=document.createElement('button');document.body.append(button);
  arm(driver => {input.value=driver.name;button.focus();});
  key(window,input,'Enter');
  assert.equal(document.activeElement,button);
});
