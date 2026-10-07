import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
// Manual browser regression: MJ_TEST_CHROMIUM=/path/to/chromium node scripts/sandbox-date-time.test.mjs
// Uses a localhost fixture and a mock database; no production services are contacted.
const BASELINE_REF='b58fcab8aaf9049837151bad35b4920334a1d11e';
const read=(name,fixed=true)=>fixed?fs.readFileSync(name,'utf8'):execFileSync('git',['show',`${BASELINE_REF}:${name}`],{encoding:'utf8',maxBuffer:2000000});
function lift(src,name) {
  const re=new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\(`,'m');
  const m=re.exec(src);if(!m)throw Error(name);
  const end=src.indexOf(`\n${m[1]}}`,m.index);
  return src.slice(m.index,end+m[1].length+2).replace(/export /g,'');
}
const strip=src=>src.replace(/^import[^;]+;\n/gm,'').replace(/export /g,'');
let version='one';
const server=http.createServer((req,res)=>{
  if(req.url.endsWith('loadboard.js')){res.setHeader('etag',version);res.end();return;}
  const fixed=req.url.includes('/fixed/');
  const expression=read('loadboard.js',fixed).match(/activeDate: ([^\n]+),/)[1];
  const dateScript='';
  const watcher=strip(read('site-version-watch.js',fixed));
  const pageName=req.url.split('/').pop();
  const navSource=pageName==='mondelez.html'?'mondelez.js':pageName==='houston.html'?'houston.js':'loadboard.js';
  const navName=pageName==='mondelez.html'?'setMondelezActiveDate':pageName==='houston.html'?'setHoustonActiveDate':'setActiveDate';
  const navigation=lift(read(navSource,fixed),navName);
  res.setHeader('Content-Type','text/html');
  res.end(`<body tabindex="-1"><button id="older">Older day</button><p id="date"></p><script>
  let fixtureToday='2026-10-07T12:00:00';const todayDate=()=>new Date(fixtureToday);
  const dateKey=d=>d.toISOString().slice(0,10);const addDays=(d,n)=>{const o=new Date(d);o.setDate(o.getDate()+n);return o;};
  const HISTORY_DAYS=730,FUTURE_DAYS=14;
  ${dateScript}
  const state={todayKey:'2026-10-07',activeDate:${expression},minDate:'2024-10-01',maxDate:'2026-10-21'};window.boardState=state;

  document.querySelector('#date').textContent=state.activeDate;
  const loadAndRenderBoard=()=>{document.querySelector('#date').textContent=state.activeDate;};
  const loadAndRenderHoustonBoard=loadAndRenderBoard,loadAndRenderMondelez=loadAndRenderBoard;
  ${navigation}
  const nightShiftActive=()=>false;${lift(read('loadboard.js',fixed),'checkMidnightRollover')}
  window.rollMidnight=()=>{fixtureToday='2026-10-08T12:00:00';checkMidnightRollover();};
  document.querySelector('#older').onclick=()=>${navName}('2026-09-29');
  const setAutomaticWritesBlocked=()=>{};const longTaskRunning=()=>false;
  ${watcher}
  window.watcherState=__state;
  </script></body>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.MJ_TEST_CHROMIUM || '/tmp/mj-sandbox-chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const results=[];
const browserErrors=[];

try {
  for(const fixed of [false,true])for(const board of fixed?['mondelez','index','dalaware','buildingc','houston']:['mondelez']){
    version='one';const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',error=>browserErrors.push(error.message));
    await page.clock.install({time:new Date('2026-10-07T12:00:00Z')});
    await page.goto(`${base}/${fixed?'fixed':'baseline'}/${board}.html`);
    await page.waitForFunction(()=>window.watcherState?.().deployedVersion==='one');
    await page.click('#older');version='two';
    const reload=fixed?null:page.waitForNavigation();
    await page.clock.fastForward(5*60*1000+1000);if(reload)await reload;
    if(fixed)await page.waitForFunction(()=>window.watcherState().stale);
    const date=await page.evaluate(()=>boardState.activeDate);
    assert.equal(date,fixed?'2026-09-29':'2026-10-07');
    results.push(`${fixed?'PASS':'REPRODUCED'} ${board}: deploy detection ${fixed?'leaves visible older day in place':'reloads and resets older day to today'}`);
    if(fixed){
      for(let minute=0;minute<10;minute++){await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'})));await page.clock.fastForward(60*1000);assert.equal(await page.evaluate(()=>boardState.activeDate),'2026-09-29');}
      await page.evaluate(()=>rollMidnight());assert.equal(await page.evaluate(()=>boardState.activeDate),'2026-09-29');
      results.push(`PASS ${board}: activity, repeated deploy checks, and midnight keep historical day`);
      await page.reload();assert.equal(await page.evaluate(()=>boardState.activeDate),'2026-10-07');results.push(`PASS ${board}: manual refresh opens today`);}
    await context.close();
  }
  for(const fixed of [false,true])for(const board of ['mondelez','houston'])for(const navigation of ['tab','click'])for(const testField of (fixed ? (board==='mondelez' ? ['driverName','startTime','notes','aljexNumber','deliveryGroup','driverAppId','trailerNumber','returnTrailerNumber','stopCount','miles','carrierRpm','carrierPayPerStop','carrierPay','fsc','additionalCharges','revenueTotal'] : ['driverName','time','comments','aljexNumber','ttc','ttt','rating','driverPhone','timeOutRemarks','dispatcherPhone','carrier','mc','normalRate']) : [board==='mondelez'?'startTime':'time',board==='mondelez'?'notes':'comments'])){
    const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',error=>browserErrors.push(error.message));
    const isM=board==='mondelez';const cap=isM?'Mondelez':'Houston';const src=read(`${board}.js`,fixed);const shared=read('loadboard.js',fixed);
    const rowField=testField;const dbField=testField.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
    const numeric=['stopCount','miles','carrierRpm','carrierPayPerStop','carrierPay','fsc','additionalCharges','revenueTotal','normalRate'].includes(rowField);
    const value=numeric?'123':rowField==='driverAppId'?'123456789':['startTime','time'].includes(rowField)?'16:45':'Keep this entry';
    const functions=[`${board}RowToDbRow`,`${board}RowFromDbRow`,`save${cap}RowNow`,...(fixed?[`persist${cap}Row`]:[]),`schedule${cap}RowSave`,`handleRealtime${cap}Change`].map(n=>lift(src,n)).join('\n');
    const guards=[...(fixed?['dirtyFieldsToDbPatch']:[]),'markFieldDirty','snapshotDirtyFields','confirmDirtyFieldsSaved','dbFieldsSafeToApply','runScheduledCellSave'].map(n=>lift(shared,n)).join('\n');
    let inputBlock=isM?src.match(/  table.addEventListener\("input", \(e\) => \{[^]*?\n  \}\);/)[0]:src.match(/    boardTable.addEventListener\("input", \(e\) => \{[^]*?\n    \}\);/)[0];
    if(!isM) inputBlock+='\n'+src.match(/    boardTable.addEventListener\("input", \(e\) => \{\n      const t = e.target;\n      if \(t.dataset.field !== "driverName"\)[^]*?\n    \}\);/)[0];
    await page.setContent('<table id="fixture"><tbody></tbody></table><button id="outside">Outside</button>');
    await page.evaluate(({functions,guards,inputBlock,board,cap,rowField,dbField,isM,fixed,parse})=>{
      let seq=0;window.uid=()=>`generated-${++seq}`;
      window.state={activeDate:'2026-09-29',minDate:'2024-10-01',maxDate:'2026-10-21'};
      const row={id:'r1',dbId:1,shiftDate:state.activeDate,location:'addison',[rowField]:'',notes:'',selected:false};
      const table=document.querySelector('#fixture');
      const render=()=>{table.querySelector('tbody').innerHTML=`<tr id="r1"><td><input id="time" ${isM?'data-mdz-row="r1" data-mdz-field':'data-row="r1" data-field'}="${rowField}" value="${row[rowField]}"></td><td><input id="next" ${isM?'data-mdz-row="r1" data-mdz-field':'data-row="r1" data-field'}="fixtureNext" value="${row.notes}"></td></tr>`;};
      window.renderMondelezTable=render;window.renderHoustonBoardTable=render;
      window.houstonRowToHtml=()=>{render();return document.getElementById('r1').outerHTML;};
      window.captureFocusForRerender=()=>{const id=document.activeElement.id;return()=>document.getElementById(id)?.focus({preventScroll:true});};
      window.mondelezState={datesWithData:new Set(),rowsByDate:{[state.activeDate]:[row]}};
      window.houstonState={datesWithData:new Set(),sheets:{[state.activeDate]:[row]}};
      window.mondelezNightShiftActive=window.houstonNightShiftActive=()=>false;
      window.getMondelezRowsForDate=()=>[row];window.findHoustonRowAnywhere=()=>({row});
      window.driversForLocation=()=>[];window.acknowledgeDnuAssignment=()=>{};window.updateMondelezMcCell=()=>{};window.pick=(a,b)=>a||b||'';window.recomputeMondelezRevenue=()=>{};window.setDriverSyncStatus=()=>{};window.saved=[];window.failSave=false;window.latency=0;
      window.supabaseClient={from:()=>({update:payload=>({eq:async()=>{
        await new Promise(r=>setTimeout(r,window.latency));
        if(window.failSave)return {error:{message:'simulated network error'}};
        window.saved.push({...payload});return {error:null};
      }})})};
      window.eval(`const SAVE_DEBOUNCE_MS=700,MONDELEZ_TABLE='mondelez_loads',HOUSTON_TABLE='loads_houston';
        const dirtyMondelezFields=new Map(),dirtyHoustonFields=new Map(),scheduledCellSaves=new Map();
        const mondelezSaveTimers=new Map();let houstonSaveTimers={};
        ${guards}\n${parse}\n${functions}
        const boardTable=document.querySelector('#fixture'),table=boardTable;
        ${inputBlock}
        window.sendEcho=(value)=>handleRealtime${cap}Change({eventType:'UPDATE',new:{id:1,shift_date:state.activeDate,location:'addison',notes:'remote-note',${dbField}:value}});
        window.saveNow=()=>save${cap}RowNow(window.fixtureRow);
        window.reschedule=()=>schedule${cap}RowSave(window.fixtureRow);
      `);
      window.fixtureRow=row;render();
    },{functions,guards,inputBlock,board,cap,rowField,dbField,isM,fixed,parse:isM?lift(src,'parseMondelezImagePaths'):''});
    await page.clock.install();await page.clock.pauseAt(new Date());
    await page.fill('#time',value);
    if(navigation==='tab')await page.press('#time','Tab');else await page.click('#outside');
    await page.evaluate(()=>sendEcho(''));
    assert.equal(await page.inputValue('#time'),fixed?value:'');
    await page.clock.resume();
    await page.waitForFunction(()=>saved.length>0);
    assert.equal(await page.evaluate(field=>saved.at(-1)[field],dbField),fixed?(numeric?Number(value):value):null);
    results.push(`${fixed?'PASS':'REPRODUCED'} ${board}: ${rowField}: ${navigation} + stale echo ${fixed?'retains and saves entry':'erases and saves blank entry'}`);
    if(fixed && ['startTime','time'].includes(rowField)){
      await page.click('#outside');await page.evaluate(()=>sendEcho('17:20'));
      assert.equal(await page.inputValue('#time'),'17:20','confirmed edits allow later legitimate remote updates');
      await page.evaluate(()=>{failSave=true;});await page.fill('#time','18:10');await page.click('#outside');
      await page.waitForTimeout(850);await page.evaluate(()=>sendEcho('17:20'));
      assert.equal(await page.inputValue('#time'),'18:10','failed save remains protected');
      await page.evaluate(async()=>{failSave=false;await saveNow();});
      assert.equal(await page.evaluate(field=>saved.at(-1)[field],dbField),'18:10');
      await page.evaluate(()=>{latency=1000;});await page.fill('#time','19:00');await page.click('#outside');
      await page.waitForTimeout(750);await page.fill('#time','19:30');await page.click('#outside');
      await page.evaluate(()=>sendEcho('18:10'));
      await page.waitForTimeout(1100);await page.evaluate(()=>sendEcho('19:00'));
      assert.equal(await page.inputValue('#time'),'19:30','earlier acknowledgement cannot clear newer edit');
      await page.waitForFunction(field=>saved.at(-1)[field]==='19:30',dbField);
      results.push(`PASS ${board}: confirmed remote updates, failed save/retry, newer typing during slow save`);
    }
    await context.close();
  }
  // The three Kroger boards already have a dirty-field guard; verify time cells
  // with the real input, save and realtime functions as well.
  for (const location of ['atlanta','delaware','buildingc']) for (const navigation of ['tab','click']) {
    const page=await browser.newPage();page.on('pageerror',e=>browserErrors.push(e.message));
    await page.setContent('<table id="board-table"><tbody></tbody></table><button id="outside">Outside</button>');
    const src=read('loadboard.js');
    const functions=['dirtyFieldsToDbPatch','markFieldDirty','snapshotDirtyFields','confirmDirtyFieldsSaved','dbFieldsSafeToApply','runScheduledCellSave','currentlyEditedField','tripToDbRow','tripFromDbRow','saveTripNow','scheduleTripSave','handleRealtimeTripChange','isUnusedAutoRoutePlaceholder'].map(n=>lift(src,n)).join('\n');
    const inputBlock=src.match(/    boardTable.addEventListener\("input", \(e\) => \{[^]*?\n    \}\);/)[0];
    await page.evaluate(({functions,inputBlock,location})=>{
      const trip={id:'t1',dbId:2,dispatchTime:'',trailerOut:'',routeImagePaths:[]};
      const row={id:'r1',dbId:1,location,trips:[trip]};
      window.state={activeLocation:location,sheets:{fixture:[row]}};
      window.uid=()=> 'incoming';window.numOrNull=v=>v==null||v===''?null:Number(v);window.withoutUndefined=o=>o;
      window.parseRouteImagePaths=()=>[];window.findRowAnywhere=()=>({row});
      window.recalcRowCalcCellsInPlace=()=>{};window.queueAljexSync=()=>{};
      window.setDriverSyncStatus=()=>{};window.saved=[];
      window.supabaseClient={from:()=>({update:payload=>({eq:async()=>{saved.push(payload);return {error:null};}})})};
      const table=document.querySelector('#board-table');
      window.renderBoardTable=()=>{table.querySelector('tbody').innerHTML=`<tr id="r1"><td><input id="time" data-row="r1" data-trip="t1" data-field="dispatchTime" value="${trip.dispatchTime}"></td><td><input id="next" data-row="r1" data-trip="t1" data-field="trailerOut" value="${trip.trailerOut}"></td></tr>`;};
      window.captureFocusForRerender=()=>{const id=document.activeElement.id;return()=>document.getElementById(id)?.focus({preventScroll:true});};
      window.eval(`const SAVE_DEBOUNCE_MS=700,TRIPS_TABLE='loads_trips',MAX_TRIPS_PER_LOAD=5;
        const dirtyTripFields=new Map(),dirtyShiftFields=new Map(),scheduledCellSaves=new Map(),tripSaveTimers=new Map();
        const SHIFT_FIELD_TO_STATE_KEY={},boardCellHistory={input:()=>{}};
        ${functions}
        const boardTable=document.querySelector('#board-table');${inputBlock}
        window.echo=()=>handleRealtimeTripChange({eventType:'UPDATE',new:{id:2,shift_id:1,dispatch_time:''}});
      `);renderBoardTable();
    },{functions,inputBlock,location});
    await page.clock.install();await page.clock.pauseAt(new Date());
    await page.fill('#time','16:45');
    if(navigation==='tab')await page.press('#time','Tab');else await page.click('#outside');
    await page.evaluate(()=>echo());assert.equal(await page.inputValue('#time'),'16:45');
    await page.clock.resume();await page.waitForFunction(()=>saved.length>0);
    assert.equal(await page.evaluate(()=>saved.at(-1).dispatch_time),'16:45');
    assert.deepEqual(await page.evaluate(()=>Object.keys(saved.at(-1))),['dispatch_time']);
    results.push(`PASS ${location}: ${navigation} + stale echo retains and saves dispatch time`);
    await page.close();
  }
  assert.deepEqual(browserErrors, [], 'sandbox fixtures must not hide runtime errors');
  console.log(results.join('\n'));
  fs.writeFileSync('/tmp/mj-sandbox-results.json',JSON.stringify(results,null,2));
} finally {await browser.close();await new Promise(r=>server.close(r));}
