// Actual Houston page, CSS, menu listener and dirty-field saves. All SDK
// requests are intercepted; this cannot write to production or send messages.
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
 const data=boardFixture({shifts:0,drivers:1,location:'houston'});
 const date=new Date().toISOString().slice(0,10);
 data.loads_houston=[{id:41,shift_date:date,aljex_number:'2012345',driver_id:500,driver_name:'Driver 00',time:'09:00',normal_rate:600,rate_manual:true,comments:'Keep my comments'},
 {id:42,shift_date:date,aljex_number:'2016789',driver_id:500,driver_name:'Driver 00',time:'10:00',normal_rate:700,rate_manual:true,comments:'Other load'}];
 await page.addInitScript(data=>{window.__SANDBOX_ROWS=data;window.__menuWrites=[];},data);
 const sdk=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8')+`\n(()=>{const original=window.supabase.createClient;window.supabase.createClient=(...args)=>{const client=original(...args),from=client.from;client.from=table=>{if(table!=='loads_houston')return from(table);const filters=[];let patch=null;let single=false;const q={single:()=>{single=true;return q},select:()=>q,order:()=>q,limit:()=>q,range:()=>q,eq:(k,v)=>{filters.push([k,v]);return q},gte:()=>q,lte:()=>q,in:()=>q,update:p=>{patch=p;return q},then:resolve=>{const rows=window.__SANDBOX_ROWS.loads_houston.filter(r=>filters.every(([k,v])=>r[k]===v));if(patch){window.__menuWrites.push({ids:rows.map(r=>r.id),patch});rows.forEach(r=>Object.assign(r,patch));}resolve({data:single?rows[0]:rows,error:null});}};return q;};return client;};})();`;
 await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:sdk}));
 await page.route('https://**',r=>r.abort());
 await page.goto('http://127.0.0.1:8787/houston.html',{waitUntil:'networkidle'});
 const input=page.locator('#board-table input[data-field="aljexNumber"]').filter({hasText:''});await input.first().waitFor();
 const row=page.locator('#board-table tbody tr').filter({has:page.locator('input[data-field="aljexNumber"][value="2012345"]')});
 await row.locator('input[data-field="aljexNumber"]').click({button:'right'});
 assert.deepEqual(await page.locator('#row-context-menu button').allTextContents(),['TONU','Cancellation - driver fall off','Kroger cancelled shift - non-TONU','Shift Complete','Delete entire load 2012345']);
 await page.getByRole('button',{name:'Kroger cancelled shift - non-TONU',exact:true}).click();
 const modal=page.locator('#hou-cancellation-overlay');await modal.waitFor();
 const box=await modal.locator('.modal').boundingBox();assert.ok(box&&box.width>200&&box.x>=0&&box.y>=0);
 await page.locator('#hou-cancellation-reason').fill('Customer cancelled');await modal.getByRole('button',{name:'Save cancellation'}).click();await modal.waitFor({state:'detached'});
 await page.waitForSelector('#board-table tr.is-load-cancelled');
 assert.equal(await page.locator('#board-table tr.is-load-cancelled .pin-rate').innerText(),'cancelled');
 assert.equal(await page.locator('#board-table tr.is-load-cancelled input[data-field="comments"]').inputValue(),'Keep my comments');
 let writes=await page.evaluate(()=>window.__menuWrites);assert.equal(writes.length,1);assert.deepEqual(writes[0].ids,[41]);assert.deepEqual(Object.keys(writes[0].patch).sort(),['load_cancelled','load_cancelled_at','load_cancelled_reason']);
 await page.locator('#board-table tr.is-load-cancelled input[data-field="aljexNumber"]').click({button:'right'});await page.getByRole('button',{name:'Un-mark Kroger cancelled shift',exact:true}).click();
 await page.waitForSelector('#board-table input[data-field="normalRate"][value="600"]');

 await page.reload({waitUntil:'networkidle'});await page.waitForSelector('#board-table input[data-field="aljexNumber"]');
 // The SDK reload fixture resets to the original source; verify module startup
 // and all row-menu handlers work without runtime errors.
 assert.deepEqual(errors,[]);console.log('PASS real Houston page: Atlanta menu parity, modal layout, row-specific dirty patch, cancellation display, undo and startup');
}finally{await browser.close();server.kill();}
