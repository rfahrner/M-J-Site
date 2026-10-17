// Real page, real alert scans/timers, and fake data only. No outgoing messages.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const server=spawn(process.execPath,['sandbox/serve.mjs','.','8787']);await new Promise((res,rej)=>{server.stdout.once('data',res);server.once('error',rej)});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/tmp/chromium',args:['--no-sandbox','--disable-gpu']});
const sdk=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8')+`
(()=>{const create=window.supabase.createClient;window.supabase.createClient=(...args)=>{const client=create(...args),from=client.from;client.from=table=>{const q=from(table),is=q.is;if(table==='loads_shifts')q.is=(key,value)=>key==='bol_text_sent_at'?from('__empty'):is(key,value);return q;};return client;};})();`;
try{
 for(const [file,location] of [['index.html','atlanta'],['dalaware.html','delaware'],['buildingc.html','buildingc']]){
  const page=await browser.newPage({viewport:{width:1400,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.clock.install({time:new Date('2026-10-17T15:00:00Z')});
  const shift=id=>({id,location,shift_date:'2026-10-17',shift_start:'10:00',driver_id:700,driver_name_text:'Sandbox Driver',driver_cell_snapshot:'7705551234',pro_number:'TEST'+id,bol_text_sent_at:'2026-10-17T14:00:00Z'});
  const trip=(id,shift_id,route,dispatch)=>({id,shift_id,trip_number:1,route_id:route,dispatch_time:dispatch,dispatch_text_event_id:'event'+id,complete:false,minimized:false});
  const rows={loads_shifts:[shift(1),shift(2)],loads_trips:[trip(11,1,'REG123','11:00'),trip(12,2,'REG456','')],atlanta_drivers:[{id:700,'Driver Name':'Sandbox Driver','Driver Cell':'7705551234'}]};
  await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;window.__SANDBOX_LATENCY_MS=70;localStorage.setItem('dl-alert-widget-prefs',JSON.stringify({expanded:true}));},rows);
  await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:sdk}));await page.route(/https:\/\//,r=>r.abort());
  await page.goto('http://127.0.0.1:8787/'+file,{waitUntil:'networkidle'});
  await page.waitForSelector('#board-table tbody tr');
  await page.clock.fastForward(61_000);
  await page.waitForFunction(()=>document.querySelector('#alert-widget-count')?.textContent==='(2)');
  await page.locator('#alert-widget-minimize').click();
  assert.equal(await page.locator('#alert-widget-count').textContent(),'(2)');assert.equal(await page.locator('#alert-widget-new').textContent(),'');
  await page.evaluate(()=>{
    window.__counts=[];new MutationObserver(()=>window.__counts.push(document.querySelector('#alert-widget-count').textContent)).observe(document.querySelector('#alert-widget-count'),{childList:true});
    const rows=window.__SANDBOX_ROWS;rows.loads_shifts.push({...rows.loads_shifts[0],id:3,pro_number:'TEST3'});
    rows.loads_trips.push({id:13,shift_id:3,trip_number:1,route_id:'PA123',dispatch_time:'11:00',dispatch_text_event_id:'event13',complete:false,minimized:false});
  });
  await page.clock.fastForward(61_000);
  await page.waitForFunction(()=>document.querySelector('#alert-widget-count')?.textContent==='(3)');
  assert.equal(await page.locator('#alert-widget').evaluate(el=>el.classList.contains('expanded')),false);
  assert.equal(await page.locator('#alert-widget').evaluate(el=>el.classList.contains('blinking')),true);
  assert.equal(await page.locator('#alert-widget-new').textContent(),'1 new');
  await page.evaluate(async()=>{await (await import('./alerts.js')).refreshBoardAlerts();});
  assert.equal(await page.locator('#alert-widget-count').textContent(),'(3)');
  assert.equal(await page.locator('#alert-widget').evaluate(el=>el.classList.contains('blinking')),true);
  assert.ok((await page.evaluate(()=>window.__counts)).every(text=>text!=='(0)'&&text!==''),'no zero count during redraw');
  await page.locator('#alert-widget-header').click();assert.equal(await page.locator('#alert-widget-new').textContent(),'');
  await page.locator('#alert-widget-close').click();
  await page.evaluate(()=>{const rows=window.__SANDBOX_ROWS;rows.loads_shifts.push({...rows.loads_shifts[0],id:4,pro_number:'TEST4'});rows.loads_trips.push({id:14,shift_id:4,trip_number:1,route_id:'FA456',dispatch_time:'11:00',dispatch_text_event_id:'event14',complete:false,minimized:false});});
  await page.clock.fastForward(61_000);await page.waitForFunction(()=>document.querySelector('#alert-widget-reopen-count')?.textContent==='4');
  assert.equal(await page.locator('#alert-widget-reopen').evaluate(el=>el.classList.contains('blinking')),true);
  await page.locator('#alert-widget-reopen').click();assert.equal(await page.locator('#alert-widget-count').textContent(),'(4)');
  assert.equal(await page.locator('#alert-widget-new').textContent(),'');assert.deepEqual(errors,[]);
  console.log('PASS '+location+': retained count, background scans, new-alert signal, redraw, closed bell and reopen');await page.close();
 }
}finally{await browser.close();server.kill();}
