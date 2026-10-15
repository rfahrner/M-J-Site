// Actual page / event handlers in Chromium; all data and RPCs are local fakes.
// Real SQL calculations, permissions and atomicity run in the PGlite CI test.
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
 rows.loads_accounting=[{id:1,source_shift_id:1000,location:'atlanta',shift_date:rows.loads_shifts[0].shift_date,
   total_carrier_pay:777,total_cost:777,total_revenue:1234.56,status:'active',sent:true,carrier_pay_manual:true,revenue_manual:true}];
 rows.pricing_settings=[{key:'fsc_rate',value:3}];rows.user_roles=[{user_id:'sandbox-user',role:'admin'}];
 await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;window.__events=[];},rows);
 let fake=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8');
 fake=fake.replace('function result(data)', 'function result(data, table)').replace('from: (table) => result(rows()[table] || []),','from: (table) => result(structuredClone(rows()[table] || []), table),');
 fake=fake.replaceAll("email: 'sandbox@dltransport.com'", "email: 'sandbox@dltransport.com', user_metadata: { role: 'admin' }");
 fake=fake.replace('builder[m] = () => ({ ...builder, select: () => builder, maybeSingle: async () => ({ data: data[0] || null, error: null }) });',`builder[m] = (patch) => {
   if(m==='update') {window.__events.push({type:'manual',patch});Object.assign(data[0],patch);Object.assign(rows()[table][0],patch);}
   return ({...builder,select:()=>builder,maybeSingle:async()=>({data:data[0]||null,error:null})});
 };`);
 fake=fake.replace('rpc: async () => ({ data: null, error: null }),',`rpc: async (name,args) => {
   if(name==='current_app_role') return {data:'admin',error:null};
   if(name==='refresh_accounting_daily_rates') return {data:{checked:0,updated:0},error:null};
   if(name!=='reset_accounting_rate')return {data:null,error:null};
   window.__events.push({type:'reset-start',column:args.p_column});
   if(window.__resetDelay) await new Promise(resolve=>setTimeout(resolve,window.__resetDelay));
   if(window.__failReset) return {data:null,error:{message:'Sandbox calculation failed; saved rate kept'}};
   const a=rows().loads_accounting[0];
   if(args.p_column==='total_carrier_pay')Object.assign(a,{total_carrier_pay:600,total_cost:600,carrier_pay_manual:false});
   else Object.assign(a,{total_revenue:900,revenue_manual:false,fsc_payment:39.9});
   const saved={...a};window.__events.push({type:'reset-done',column:args.p_column});
   window.__sandboxEmit('loads_accounting',{eventType:'UPDATE',new:{...saved}});
   return {data:saved,error:null};
 },`);
 await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:fake}));
 await page.goto('http://127.0.0.1:8787/accounting.html',{waitUntil:'networkidle'});
 await page.waitForSelector('#acct-1');assert.deepEqual(errors,[]);
 const carrier=page.locator('[data-action="acct-carrier-pay"][data-id="1"]');
 const customer=page.locator('[data-action="acct-customer-rate"][data-id="1"]');
 const saved=()=>page.evaluate(()=>({...window.__SANDBOX_ROWS.loads_accounting[0]}));
 const waitValue=async(action,value)=>page.waitForFunction(({action,value})=>document.querySelector(`[data-action="${action}"][data-id="1"]`)?.value===value,{action,value});
 await carrier.fill('');await waitValue('acct-carrier-pay','600.00');
 assert.equal((await saved()).carrier_pay_manual,false);assert.equal((await saved()).total_revenue,1234.56);
 await customer.fill('');await waitValue('acct-customer-rate','900.00');
 assert.equal((await saved()).revenue_manual,false);assert.equal((await saved()).total_carrier_pay,600);
 console.log('PASS blank carrier/customer independently calculate and display immediately');
 for(const input of [carrier,customer])await input.fill('0');
 await page.locator('#btn-acct-refresh').click();
 await page.waitForFunction(()=>!document.querySelector('#btn-acct-refresh').disabled);
 assert.equal(await carrier.inputValue(),'0.00');assert.equal(await customer.inputValue(),'0.00');
 assert.equal((await saved()).carrier_pay_manual,true);assert.equal((await saved()).revenue_manual,true);
 assert.equal((await saved()).sent,true);
 console.log('PASS explicit zeros stay zero, protected, after Refresh');
 await page.evaluate(()=>{window.__resetDelay=1200;window.__events=[];});
 await carrier.fill('');
 await page.waitForFunction(()=>window.__events.some(e=>e.type==='reset-start'));
 await carrier.fill('0');
 await customer.fill('1111');
 await page.waitForFunction(()=>window.__events.some(e=>e.type==='reset-done'));
 assert.equal(await customer.inputValue(),'1111');assert.equal(await customer.evaluate(e=>document.activeElement===e),true);
 await page.locator('#btn-acct-refresh').click();
 await page.waitForFunction(()=>!document.querySelector('#btn-acct-refresh').disabled);
 assert.equal(await carrier.inputValue(),'0.00');assert.equal(await customer.inputValue(),'1111.00');
 assert.equal((await saved()).total_carrier_pay,0);assert.equal((await saved()).total_revenue,1111);
 console.log('PASS slow reset + newer zero + next-cell typing: latest values and focus survive realtime');
 await page.evaluate(()=>{window.__resetDelay=0;window.__failReset=true;window.__events=[];});
 await carrier.fill('');await waitValue('acct-carrier-pay','0.00');
 assert.equal((await saved()).total_carrier_pay,0);
 assert.match(await page.locator('body').innerText(),/Sandbox calculation failed/);
 console.log('PASS failed recalculation restores the saved figure and reports the error');
 assert.deepEqual(errors,[]);
}finally {await browser.close();server.kill();}
