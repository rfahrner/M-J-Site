// Browser integration with fake Supabase; database semantics are exercised
// separately by the PGlite CI test. No production services are contacted.
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
    total_carrier_pay:400,total_cost:400,total_revenue:1234.56,status:'active',sent:true,carrier_pay_manual:false}];
  rows.pricing_settings=[{key:'fsc_rate',value:3}];
  rows.user_roles=[{user_id:'sandbox-user',role:'admin'}];
  await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;window.__accountingEvents=[];},rows);
  let fake=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8');
  fake=fake.replaceAll("email: 'sandbox@dltransport.com'", "email: 'sandbox@dltransport.com', user_metadata: { role: 'admin' }");
  fake=fake.replace('builder[m] = () => ({ ...builder, select: () => builder, maybeSingle: async () => ({ data: data[0] || null, error: null }) });',`builder[m] = (patch) => {
    if(m==='update') { window.__accountingEvents.push('manual-save'); Object.assign(data[0],patch); }
    return ({ ...builder, select: () => builder, maybeSingle: async () => ({data:data[0] || null,error:null}) });
  };`);
  fake=fake.replace('rpc: async () => ({ data: null, error: null }),',`rpc: async (name,args) => {
    if(name==='current_app_role') return {data:'admin',error:null};
    if(name!=='refresh_accounting_daily_rates') return {data:null,error:null};
    window.__accountingEvents.push('rate-check');window.__lastRateCheck=args;
    const a=rows().loads_accounting[0], changed=!a.carrier_pay_manual && a.total_carrier_pay!==600;
    if(changed) {a.total_carrier_pay=600;a.total_cost=600;}
    return {data:{checked:1,updated:changed?1:0},error:null};
  },`);
  await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:fake}));
  await page.goto('http://127.0.0.1:8787/accounting.html',{waitUntil:'networkidle'});
  try { await page.waitForSelector('#acct-1',{timeout:5000}); }
  catch(error) { console.log(JSON.stringify({url:page.url(),errors,text:(await page.locator('body').innerText()).slice(-1800)}));throw error; }
  assert.deepEqual(errors,[],'real module graph initializes without circular-import errors');
  await page.locator('#btn-acct-refresh').click();
  await page.waitForFunction(()=>document.querySelector('#btn-acct-refresh').disabled===false && window.__accountingEvents.includes('rate-check'));
  assert.equal(await page.locator('[data-action="acct-carrier-pay"][data-id="1"]').inputValue(),'600.00');
  assert.equal(await page.locator('[data-action="acct-customer-rate"][data-id="1"]').inputValue(),'1234.56');
  assert.equal(await page.locator('[data-action="acct-sent"][data-id="1"]').isChecked(),true);
  assert.equal(await page.evaluate(()=>window.__lastRateCheck.p_location),'atlanta');
  console.log('PASS actual Accounting startup + Refresh: corrected pay appears, revenue and Sent stay intact');
  await page.evaluate(()=>{window.__accountingEvents=[];});
  await page.locator('[data-action="acct-carrier-pay"][data-id="1"]').fill('777');
  await page.locator('#btn-acct-refresh').click();
  await page.waitForFunction(()=>!document.querySelector('#btn-acct-refresh').disabled && window.__accountingEvents.includes('rate-check'));
  assert.deepEqual(await page.evaluate(()=>window.__accountingEvents),['manual-save','rate-check']);
  assert.equal(await page.locator('[data-action="acct-carrier-pay"][data-id="1"]').inputValue(),'777.00');
  assert.equal(await page.evaluate(()=>window.__SANDBOX_ROWS.loads_accounting[0].carrier_pay_manual),true);
  assert.deepEqual(errors,[]);
  console.log('PASS type manual pay then immediately Refresh: edit saves first and remains displayed');
}finally {await browser.close();server.kill();}
