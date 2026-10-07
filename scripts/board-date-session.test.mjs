import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source=fs.readFileSync('board-date-session.js','utf8').replace(/export /g,'');
const make=(page)=>{
  const dom=new JSDOM('',{url:`https://sandbox.test/${page}`,runScripts:'outside-only'});
  dom.window.eval(source+';window.restore=restoreBoardDate;window.install=installBoardDatePersistence;');
  return dom.window;
};
for(const page of ['mondelez.html','houston.html','index.html','dalaware.html','buildingc.html']){
 const w=make(page),key=`mj-board-date:${page}`;
 const restore=()=>w.restore('2026-10-07','2024-10-07','2026-10-21');
 assert.equal(restore(),'2026-10-07');
 w.sessionStorage.setItem(key,'2026-09-29');assert.equal(restore(),'2026-09-29');
 for(const bad of ['bad','2026-02-30','2023-01-01','2030-01-01']){w.sessionStorage.setItem(key,bad);assert.equal(restore(),'2026-10-07');}
 let day='2026-09-29';w.install(()=>day);day='2026-09-30';w.dispatchEvent(new w.Event('pagehide'));
 assert.equal(w.sessionStorage.getItem(key),'2026-09-30');
 w.close();
}
const w=make('accounting.html');w.sessionStorage.setItem('mj-board-date:mondelez.html','2026-09-29');
assert.equal(w.restore('2026-10-07','2024-10-07','2026-10-21'),'2026-10-07');w.close();
const blocked=make('mondelez.html');Object.defineProperty(blocked,'sessionStorage',{get(){throw Error('blocked');}});
assert.equal(blocked.restore('2026-10-07','2024-10-07','2026-10-21'),'2026-10-07');blocked.install(()=> '2026-09-29');blocked.dispatchEvent(new blocked.Event('pagehide'));blocked.close();
console.log('Board date persistence: valid dates, navigation, bounds, invalid dates, non-board pages and blocked storage pass.');
