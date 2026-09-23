import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync('accounting.js','utf8');
function fixture(notes){
 const flags=new Map();
 const client={from:table=>{assert.equal(table,'load_notes');let ids;return {select(){return this},in(_,values){ids=values;return this},order(){return this},range:async(a,b)=>({data:notes.filter(n=>ids.includes(String(n.shift_id))).slice(a,b+1),error:null})}}};
 const ctx=vm.createContext({accountingLoadNoteFlags:flags,supabaseClient:client,console});
 for(const name of ['refreshAccountingLoadNotes','accountingNoteButton']){
  const fn=source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));assert.ok(fn);vm.runInContext(fn[0],ctx);
 }
 return {flags,refresh:vm.runInContext('refreshAccountingLoadNotes',ctx),button:vm.runInContext('accountingNoteButton',ctx)};
}
test('yellow reflects this load, not other loads assigned to the driver',async()=>{
 const f=fixture([{id:1,shift_id:10,note_text:'Existing note'},{id:2,shift_id:11,note_text:'  '}]);
 await f.refresh([10,11,12]);
 assert.match(f.button({id:1,source_shift_id:10}),/has-notes/);
 assert.doesNotMatch(f.button({id:2,source_shift_id:11}),/has-notes/);
 assert.doesNotMatch(f.button({id:3,source_shift_id:12}),/has-notes/);
 assert.match(f.button({id:1,source_shift_id:10}),/data-acct-load-notes="1"/);
});
test('note lookup handles pagination and clears removed notes',async()=>{
 const notes=Array.from({length:1001},(_,i)=>({id:i+1,shift_id:i===1000?11:10,note_text:'note'}));
 const f=fixture(notes);await f.refresh([10,11]);assert.equal(f.flags.get('11'),true);
 notes.splice(0);await f.refresh([10,11]);assert.equal(f.flags.get('10'),false);assert.equal(f.flags.get('11'),false);
});
test('click routes to the load Notes tab without intercepting the load-number button',()=>{
 assert.match(source,/openLoadDetailsFromAccounting\(noteBtn.dataset.acctLoadNotes, null, null, 'notes'\)/);
 const board=readFileSync('loadboard.js','utf8');
 assert.match(board,/initialTab === 'notes' && loadDetailsState\?\.rowId === row.id/);
 assert.match(board,/loadDetailsState.activeTab = 'notes';\s+renderLoadDetailsTabs\(\)/);
});
