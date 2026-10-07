import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const BASELINE='118d8a2e705acff3bdee92a103ec0135071636c8';
function lift(src,name){
 const m=new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\(`,'m').exec(src);
 if(!m)throw Error(name);const end=src.indexOf(`\n${m[1]}}`,m.index);
 return src.slice(m.index,end+m[1].length+2).replace(/export /g,'');
}
const browser=await chromium.launch({executablePath:process.env.MJ_TEST_CHROMIUM||'/tmp/mj-sandbox-chromium',headless:true,args:['--no-sandbox']});
try{
 for(const fixed of [false,true])for(const location of ['atlanta','delaware','buildingc']){
  const src=fixed?fs.readFileSync('loadboard.js','utf8'):execFileSync('git',['show',`${BASELINE}:loadboard.js`],{encoding:'utf8',maxBuffer:2000000});
  const names=['blankTrip','shiftFromDbRow','tripFromDbRow','openTripsFor','handleRealtimeShiftChange','handleRealtimeTripChange','dbFieldsSafeToApply'];
  if(src.includes('function isUnusedAutoRoutePlaceholder('))names.push('isUnusedAutoRoutePlaceholder');
  const source=names.map(n=>lift(src,n)).join('\n');
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<table><tbody id="routes"></tbody></table>');
  await page.evaluate(({source,location})=>{
   window.eval(`let seq=0;const uid=p=>p+'-'+(++seq);
    const state={activeLocation:'${location}',activeDate:'2026-10-07',minDate:'2024-10-01',maxDate:'2026-10-21',datesWithData:new Set(),sheets:{'${location}__2026-10-07':[]}};
    const sheetKey=(l,d)=>l+'__'+d,dirtyTripFields=new Map(),dirtyShiftFields=new Map(),SHIFT_FIELD_TO_STATE_KEY={},MAX_TRIPS_PER_LOAD=5,BOARD_IMAGE_BUCKET='mock';
    const parseRouteImagePaths=v=>v?[v]:[];const batchSignImageUrls=async()=>{};
    const currentlyEditedField=(rowId,tripId)=>document.activeElement?.dataset.trip===tripId?'notes':null;
    const captureFocusForRerender=()=>()=>{};
    ${source}
    const renderBoardTable=()=>{const row=state.sheets[sheetKey(state.activeLocation,state.activeDate)][0];if(!row)return;document.querySelector('#routes').innerHTML=openTripsFor(row).map(t=>'<tr data-trip="'+t.id+'"><td>'+t.routeId+'</td><td><input data-trip="'+t.id+'" value="'+t.notes+'"></td></tr>').join('');};
    window.shift=()=>handleRealtimeShiftChange({eventType:'INSERT',new:{id:16651,location:state.activeLocation,shift_date:state.activeDate,pro_number:'2006883'}});
    window.echo=(minimized=false)=>handleRealtimeTripChange({eventType:'INSERT',new:{id:41274,shift_id:16651,trip_number:1,route_id:'FRTG',trip_id:'1306423',minimized}});
    window.row=()=>state.sheets[sheetKey(state.activeLocation,state.activeDate)][0];
    window.redraw=renderBoardTable;
    window.typeDraft=()=>{const t=row().trips.find(t=>t.autoRoutePlaceholder);t.notes='Keep my notes';dirtyTripFields.set(t.id,new Set(['notes']));};
    window.addExplicit=()=>row().trips.push(blankTrip());
   `);
  },{source,location});
  await page.evaluate(()=>{shift();echo();});
  const count=await page.locator('tr').count();assert.equal(count,fixed?1:2);
  console.log(`${fixed?'PASS':'REPRODUCED'} ${location}: new shift then live route shows ${count} route line(s)`);
  if(fixed){
   await page.evaluate(()=>{for(let i=0;i<20;i++){echo();redraw();}});assert.equal(await page.locator('tr').count(),1);
   await page.evaluate(()=>{row().trips[0].minimized=true;redraw();echo(false);});assert.equal(await page.locator('tr').count(),1);
   await page.evaluate(()=>{row().trips[0].minimized=true;redraw();typeDraft();echo(false);});
   assert.equal(await page.locator('tr').count(),2);assert.equal(await page.evaluate(()=>row().trips.find(t=>t.autoRoutePlaceholder).notes),'Keep my notes');
   console.log(`PASS ${location}: repeated echoes and restore do not add blanks; notes draft survives`);
  }
  assert.deepEqual(errors,[]);await page.close();
 }
}finally{await browser.close();}
