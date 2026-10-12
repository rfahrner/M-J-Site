// Run the full board and History modal in Chromium with a local SDK fixture.
// No real messaging service or database is contacted.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {boardFixture} from './fixtures.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const server=spawn(process.execPath,['sandbox/serve.mjs','.','8787']);
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
 const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const data=boardFixture({shifts:1,drivers:1});const time=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
 Object.assign(data.loads_shifts[0],{pro_number:'PRO9000',driver_id:500,shift_start:'00:00'});
 data.loads_trips=[{id:2000,shift_id:1000,trip_number:1,route_id:'FA123',dispatch_time:time,dispatch_text_event_id:'sandbox-event'}];data.load_change_history=[];
 await page.addInitScript(data=>{window.__SANDBOX_ROWS=data;window.__auditWrites=[];},data);
 const sdk=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8')+`\n(()=>{const original=window.supabase.createClient;window.supabase.createClient=(...args)=>{const c=original(...args),rpc=c.rpc;c.rpc=async(name,p)=>{if(name!=='log_alert_text_click')return rpc(name,p);window.__auditWrites.push(p);const entries=p.p_load_ids.map(id=>({id:window.__SANDBOX_ROWS.load_change_history.length+1,shift_id:id,trip_id:p.p_trip_id,field_name:'alert_text_clicked',old_value:null,new_value:p.p_alert_label,note:'Draft message (click only; sending is not confirmed): '+p.p_message,changed_by:'sandbox@example.invalid',changed_at:new Date().toISOString(),source:p.p_source}));window.__SANDBOX_ROWS.load_change_history.push(...entries);return {data:entries,error:null};};return c;};})();`;
 await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:sdk}));await page.route('https://**',r=>r.abort());
 await page.goto('http://127.0.0.1:8787/index.html',{waitUntil:'networkidle'});
 const button=page.locator('[data-dispatch-text-trip="2000"]');await button.waitFor();
 if(!await button.isVisible())await page.locator('#alert-widget-minimize').click();
 await button.dispatchEvent('click');await page.waitForSelector('#modal-send-text:not(.hidden)');
 assert.equal(await page.evaluate(()=>window.__auditWrites.length),1);
 await page.locator('#send-text-cancel').click();
 await button.dispatchEvent('click');await page.waitForSelector('#modal-send-text:not(.hidden)');assert.equal(await page.evaluate(()=>window.__auditWrites.length),2);await page.locator('#send-text-cancel').click();
 await page.locator('#board-table [data-open-pro]:not([data-trip])').first().click();
 await page.locator('#ld-tabs [data-tab="history"]').click();
 await page.waitForFunction(()=>document.querySelector('#ld-tab-content')?.textContent.includes('Alert Text clicked'));
 const text=await page.locator('#ld-tab-content').innerText();assert.ok(text.includes('sandbox@example.invalid'));assert.ok((await page.locator('#ld-tab-content [data-hist-note-id]').evaluateAll(nodes=>nodes.map(n=>n.value))).join(' ').includes('click only; sending is not confirmed'));
 assert.equal((text.match(/Alert Text clicked/g)||[]).length,2);assert.deepEqual(errors,[]);
 console.log('PASS real page: FA dispatch alert clicked twice, both cancellations retain audit entries, History shows user/context/draft without claiming sent');
}finally{await browser.close();server.kill();}
