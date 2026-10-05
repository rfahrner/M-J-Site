import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source=fs.readFileSync('loadboard.js','utf8');
function lift(name) { return source.match(new RegExp(`  (?:export )?function ${name}\\([^]*?\\n  \\}`))[0].replace('export ', ''); }
function setup(metadata) {
  const dom=new JSDOM(`<table><tbody><tr><td><input data-driver-ac="true" ${metadata} value="Jason"></td></tr></tbody></table>`,{runScripts:'outside-only'});
  const {window}=dom;
  window.eval(lift('finishDriverCellSelection')+'\n'+lift('captureFocusForRerender')+';window.capture=captureFocusForRerender;');
  return window;
}

test('save/realtime redraw preserves Jason plus a trailing space and the cursor before continuing the last name',()=>{
  for(const metadata of ['data-row="r1" data-field="driverName"','data-mdz-row="r1" data-mdz-field="driverName"','data-avail-row="r1" data-avail-field="driverName"','id="ld-ov-driver"']) {
    const window=setup(metadata),document=window.document;
    const input=document.querySelector('input');
    input.focus();input.value='Jason ';input.setSelectionRange(6,6);
    const restore=window.capture();
    // Mirrors a redraw which renders the linked profile's canonical name.
    document.querySelector('td').innerHTML=input.outerHTML;
    const fresh=document.querySelector('input');fresh.value='Jason';
    let valueAtFocus;
    fresh.addEventListener('focus',()=>{valueAtFocus=fresh.value;});
    restore();
    assert.equal(document.activeElement,fresh);
    assert.equal(fresh.value,'Jason ');
    assert.equal(valueAtFocus,'Jason '); // autocomplete must also see the raw draft
    assert.equal(fresh.selectionStart,6);
    assert.equal(fresh.selectionEnd,6);
    fresh.value+='Ward';
    assert.equal(fresh.value,'Jason Ward');
  }
});

test('active name drafts preserve casing, partial names, empty values, and selected text ranges',()=>{
  for(const draft of ['jason wa','Jason  Ward ','',' Jason ']) {
    const window=setup('data-row="r1" data-field="driverName"'),document=window.document;
    const input=document.querySelector('input');input.focus();input.value=draft;input.setSelectionRange(0,draft.length);
    const restore=window.capture();
    document.querySelector('td').innerHTML=input.outerHTML;document.querySelector('input').value='Jason Ward';
    restore();
    const fresh=document.querySelector('input');
    assert.equal(fresh.value,draft);
    assert.equal(fresh.selectionStart,0);
    assert.equal(fresh.selectionEnd,draft.length);
  }
});

test('a completed driver selection remains a selected cell and accepts refreshed profile text',()=>{
  const window=setup('data-row="r1" data-field="driverName"'),document=window.document;
  const cell=document.querySelector('td');cell.dataset.driverCellSelected='true';cell.tabIndex=-1;cell.focus();
  const restore=window.capture();
  document.querySelector('tbody').innerHTML=document.querySelector('tbody').innerHTML;
  const fresh=document.querySelector('input');fresh.value='Jason Ward';
  restore();
  assert.equal(document.activeElement,fresh.closest('td'));
  assert.equal(fresh.value,'Jason Ward');
});
