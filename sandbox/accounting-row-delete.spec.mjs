// Real Accounting page and context-menu clicks; synthetic database only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { boardFixture } from './fixtures.mjs';
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const server=spawn(process.execPath,['sandbox/serve.mjs','.','8787']);
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try {
 const page=await browser.newPage({viewport:{width:1400,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const rows=boardFixture({shifts:1,drivers:1});
 rows.loads_accounting=['atlanta','delaware','buildingc','houston','mondelez'].map((location,i)=>({
   id:i+1,location,shift_date:rows.loads_shifts[0].shift_date,aljex_load_number:`TEST-${i+1}`,driver_name_text:'Sandbox Driver',
   total_carrier_pay:600,total_cost:600,total_revenue:900,status:'active',sent:true,hidden:false,
 }));
 rows.loads_accounting_routes=[];rows.pricing_settings=[{key:'fsc_rate',value:3}];rows.user_roles=[{user_id:'sandbox-user',role:'admin'}];
 await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;window.__events=[];},rows);
 let fake=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8');
 fake=fake.replaceAll("email: 'sandbox@dltransport.com'", "email: 'sandbox@dltransport.com', user_metadata: { role: 'admin' }");
 const start=fake.indexOf('  function result(data)');const end=fake.indexOf('  // Realtime handlers',start);
 fake=fake.slice(0,start)+`  function result(data,table) {
   let filters=[],patch=null;
   const selected=()=>data.filter(r=>filters.every(([k,v])=>String(r[k])===String(v)));
   const run=()=>{
     if(patch){
       window.__events.push({table,patch});
       if(window.__failDelete && patch.hidden)return {data:null,error:{message:'Sandbox permission denied'}};
       for(const r of selected())Object.assign(r,patch);
     }
     return {data:structuredClone(selected()),error:null};
   };
   const builder={then:resolve=>resolve(run()),single:async()=>{const r=run();return {...r,data:r.data?.[0]||null};},maybeSingle:async()=>{const r=run();return {...r,data:r.data?.[0]||null};}};
   for(const key of ['select','neq','in','is','not','gte','lte','gt','lt','or','order','limit','range','filter','contains','ilike','like','match'])builder[key]=()=>builder;
   builder.eq=(k,v)=>{filters.push([k,v]);return builder;};
   builder.update=p=>{patch=p;return builder;};
   for(const key of ['insert','upsert','delete'])builder[key]=()=>{throw Error('Unexpected database '+key);};
   return builder;
  }
`+fake.slice(end);
 fake=fake.replace('from: (table) => result(rows()[table] || []),','from: (table) => result(rows()[table] || [],table),');
 fake=fake.replace('rpc: async () => ({ data: null, error: null }),',`rpc: async name=>({data:name==='current_app_role'?'admin':name==='refresh_accounting_daily_rates'?{checked:0,updated:0}:null,error:null}),`);
 await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:fake}));
 await page.goto('http://127.0.0.1:8787/accounting.html',{waitUntil:'networkidle'});
 await page.waitForSelector('#acct-1');assert.deepEqual(errors,[]);
 const sourceBefore=await page.evaluate(()=>JSON.stringify(window.__SANDBOX_ROWS.loads_shifts));
 async function menu(id){await page.locator(`#acct-${id} td`).first().click({button:'right'});await page.waitForSelector('#acct-context-menu');}
 async function choose(id,accept){await menu(id);page.once('dialog',d=>accept?d.accept():d.dismiss());await page.locator('[data-action="acct-delete"]').click();}
 await choose(1,false);assert.equal(await page.locator('#acct-1').count(),1);
 assert.equal((await page.evaluate(()=>window.__events)).length,0);
 console.log('PASS cancelling removal makes no database change');
 await page.evaluate(()=>{window.__failDelete=true;});await choose(1,true);
 await page.waitForFunction(()=>document.body.innerText.includes('Sandbox permission denied'));
 assert.equal(await page.locator('#acct-1').count(),1);await page.evaluate(()=>{window.__failDelete=false;});
 console.log('PASS denied removal keeps the row and reports the error');
 await page.locator('#acct-1 [data-action="acct-carrier-pay"]').fill('777');
 await choose(1,true);await page.waitForFunction(()=>!document.querySelector('#acct-1'));
 let a=await page.evaluate(()=>window.__SANDBOX_ROWS.loads_accounting[0]);assert.equal(a.total_carrier_pay,777);assert.equal(a.hidden,true);assert.equal(a.status,'deleted');assert.equal(a.sent,true);
 for(const [i,loc] of [[2,'delaware'],[3,'buildingc'],[4,'houston'],[5,'mondelez']]) {
   await page.locator(`#acct-location-tabs [data-location="${loc}"]`).click();await page.waitForSelector(`#acct-${i}`);
   await choose(i,true);await page.waitForFunction(id=>!document.querySelector('#acct-'+id),i);
 }
 console.log('PASS right-click removal works on all five tabs and flushes a pending rate');
 await page.locator('#btn-acct-refresh').click();await page.waitForFunction(()=>!document.querySelector('#btn-acct-refresh').disabled);
 assert.equal(await page.locator('#accounting-table-body tr[id^="acct-"]').count(),0);
 assert.equal(await page.evaluate(()=>JSON.stringify(window.__SANDBOX_ROWS.loads_shifts)),sourceBefore);
 assert.ok((await page.evaluate(()=>window.__events)).every(e=>e.table==='loads_accounting'));
 const persisted=await page.evaluate(()=>window.__SANDBOX_ROWS);
 await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;},persisted);
 await page.reload({waitUntil:'networkidle'});
 assert.equal(await page.locator('#accounting-table-body tr[id^="acct-"]').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS refresh and reload keep removed rows out; source-board data stays unchanged');
}finally {await browser.close();server.kill();}
