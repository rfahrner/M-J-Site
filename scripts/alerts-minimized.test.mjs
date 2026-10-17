import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const core=fs.readFileSync('alerts.js','utf8'),extras=fs.readFileSync('preshift-pro-text.js','utf8');
const shared=fs.readFileSync('alert-widget-state.js','utf8');
function lift(source,name){const m=new RegExp('^([ \\t]*)(?:export )?(?:async )?function '+name+'\\(','m').exec(source);assert.ok(m,name);const end=source.indexOf('\n'+m[1]+'}',m.index);return source.slice(m.index,end+m[1].length+2).replace('export ','');}
function fixture(prefs={}){
 const dom=new JSDOM('',{runScripts:'outside-only',url:'https://sandbox.invalid/index.html'}),w=dom.window,ctx=dom.getInternalVMContext();
 let fresh=[],extra=[],fail=false;
 Object.assign(ctx,{state:{activeLocation:'atlanta'},$:(s)=>w.document.querySelector(s),escapeHtml:s=>String(s),
  loadAlertWidgetPrefs:()=>prefs,saveAlertWidgetPrefs:()=>{},getDismissedAlertKeys:()=>new Set(),
  scanForBoardAlerts:async()=>{if(fail)throw Error('network failed');return fresh;},
  currentLocation:()=> 'atlanta',houstonPreShiftAlerts:async()=>[],carrierDocsAlerts:async()=>[],delawareBolAlerts:async()=>[],dispatchedRouteAlerts:async()=>extra,
 });
 vm.runInContext(shared.replace(/export /g,''),ctx);
 vm.runInContext('let boardAlerts=[],alertFirstSeenAt={},alertPanelExpanded=false,alertRefreshVersion=0;let alertObserver=null,observedAlertBody=null,refreshTimer=null,lastExtrasHtml=[],extraRefreshVersion=0;',ctx);
 for(const name of ['formatAlertTimestamp','renderAlertPanel','refreshBoardAlerts','toggleAlertPanel','closeAlertWidget','reopenAlertWidget','applyAlertWidgetPosition','wireAlertWidgetDrag','injectAlertWidget'])vm.runInContext(lift(core,name),ctx);
 for(const name of ['paintExtras','restoreExtrasNow','refreshExtraAlerts','scheduleRefresh','installAlertObserver'])vm.runInContext(lift(extras,name),ctx);
 ctx.injectAlertWidget();
 return {dom,w,ctx,board:keys=>{fresh=keys.map(key=>({key,message:key,type:'idle'}));},extra:keys=>{extra=keys.map(key=>({html:`<div class="alert-chat-item dispatch-extra-alert">${key}</div>`}));},fail:v=>fail=v,
  count:()=>w.document.getElementById('alert-widget-count').textContent,
  flush:async()=>{await Promise.resolve();await Promise.resolve();},
 };
}
test('minimizing retains both sources and every core redraw keeps the combined count',async()=>{
 const f=fixture({expanded:true});try{
  f.board(['core']);f.extra(['dispatch','BOL']);await f.ctx.refreshBoardAlerts();await f.ctx.refreshExtraAlerts();assert.equal(f.count(),'(3)');
  f.w.document.getElementById('alert-widget-minimize').click();assert.equal(f.count(),'(3)');assert.equal(f.w.document.getElementById('alert-widget').classList.contains('expanded'),false);
  for(let i=0;i<3;i++){await f.ctx.refreshBoardAlerts();assert.equal(f.count(),'(3)');await f.flush();assert.equal(f.w.document.querySelectorAll('.dispatch-extra-alert').length,2);}
  assert.equal(f.w.document.getElementById('alert-widget').classList.contains('blinking'),false,'reading then minimizing does not make old alerts new');
 }finally{f.dom.window.close();}
});
test('new alerts collect while collapsed; opening acknowledges them; a repeat scan does not re-notify',async()=>{
 const f=fixture({expanded:true});try{
  f.board(['one']);await f.ctx.refreshBoardAlerts();f.ctx.toggleAlertPanel();
  f.extra(['new dispatch']);await f.ctx.refreshExtraAlerts();assert.equal(f.count(),'(2)');
  assert.equal(f.w.document.getElementById('alert-widget-new').textContent,'1 new');assert.equal(f.w.document.getElementById('alert-widget').classList.contains('blinking'),true);
  await f.ctx.refreshBoardAlerts();assert.equal(f.count(),'(2)');assert.equal(f.w.document.getElementById('alert-widget-new').textContent,'1 new');
  f.ctx.toggleAlertPanel();assert.equal(f.w.document.getElementById('alert-widget-new').textContent,'');f.ctx.toggleAlertPanel();await f.ctx.refreshExtraAlerts();
  assert.equal(f.w.document.getElementById('alert-widget').classList.contains('blinking'),false);
  f.board(['one','new core']);await f.ctx.refreshBoardAlerts();assert.equal(f.count(),'(3)');assert.equal(f.w.document.getElementById('alert-widget-new').textContent,'1 new');
 }finally{f.dom.window.close();}
});
test('closing an expanded panel keeps scanning and gives the small bell a count and new-alert signal',async()=>{
 const f=fixture({expanded:true});try{
  f.board(['one']);await f.ctx.refreshBoardAlerts();f.ctx.closeAlertWidget();
  f.board(['one','two']);f.extra(['three']);await f.ctx.refreshBoardAlerts();await f.ctx.refreshExtraAlerts();
  const bell=f.w.document.getElementById('alert-widget-reopen');assert.equal(f.count(),'(3)');assert.equal(bell.textContent,'🔔3');assert.equal(bell.classList.contains('blinking'),true);assert.match(bell.getAttribute('aria-label'),/3 active alerts, 2 new/);
  f.ctx.reopenAlertWidget();assert.equal(f.count(),'(3)');assert.equal(bell.classList.contains('blinking'),false);
 }finally{f.dom.window.close();}
});
test('failed scans retain the previous count, while confirmed resolved alerts remove their unread signal',async()=>{
 const f=fixture();try{
  f.board(['one']);await f.ctx.refreshBoardAlerts();f.fail(true);await f.ctx.refreshBoardAlerts();assert.equal(f.count(),'(1)');
  f.fail(false);f.board([]);await f.ctx.refreshBoardAlerts();assert.equal(f.count(),'');assert.equal(f.w.document.getElementById('alert-widget').classList.contains('blinking'),false);
 }finally{f.dom.window.close();}
});
test('an older slow scan cannot overwrite a newer alert result',async()=>{
 const f=fixture();try{
  let finish;f.ctx.scanForBoardAlerts=()=>new Promise(resolve=>finish=resolve);const slow=f.ctx.refreshBoardAlerts();
  f.ctx.scanForBoardAlerts=async()=>[{key:'new',message:'new',type:'idle'}];await f.ctx.refreshBoardAlerts();finish([]);await slow;
  assert.equal(f.count(),'(1)');assert.match(f.w.document.getElementById('alert-widget-body').textContent,/new/);
 }finally{f.dom.window.close();}
});

test('a slower extra-reminder scan cannot erase reminders found by a newer scan',async()=>{
 const f=fixture();try{
  let finish;let calls=0;f.ctx.dispatchedRouteAlerts=()=>++calls===1?new Promise(resolve=>finish=resolve):Promise.resolve([{html:'<div class="alert-chat-item dispatch-extra-alert">new call</div>'}]);
  const slow=f.ctx.refreshExtraAlerts();await f.flush();await f.flush();await f.ctx.refreshExtraAlerts();assert.equal(f.count(),'(1)');
  finish([]);await slow;assert.equal(f.count(),'(1)');assert.match(f.w.document.getElementById('alert-widget-body').textContent,/new call/);
 }finally{f.dom.window.close();}
});
