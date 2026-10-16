// Every real application page, with a deliberately populated fake backend.
// Visitors must never execute a business query or display its sentinel records.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const server=spawn(process.execPath,['sandbox/serve.mjs','.','8787']);await new Promise((res,rej)=>{server.stdout.once('data',res);server.once('error',rej);});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/tmp/chromium',args:['--no-sandbox','--disable-gpu']});
const sdk=readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8')+`\n(()=>{const create=window.supabase.createClient;window.__businessQueries=[];window.supabase.createClient=(...args)=>{const c=create(...args);const from=c.from;c.from=table=>{window.__businessQueries.push(table);return from(table)};c.rpc=async name=>{if(name==='current_app_role')return {data:'visitor',error:null};window.__businessQueries.push('rpc:'+name);return {data:null,error:null}};c.auth.getUser=async()=>({data:{user:{id:'visitor',email:'visitor@dltransport.local',user_metadata:{role:'visitor'}}},error:null});return c;};})();`;
try{
 for(const file of ['index.html','dalaware.html','buildingc.html','houston.html','mondelez.html','accounting.html','driverlist.html','analytics-drivers.html','analytics-volume.html','location-analytics.html','historics.html','archive.html','paperwork.html','megaboard.html']){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:sdk}));await page.route('https://**',r=>r.abort());
  await page.addInitScript(()=>{window.__SANDBOX_ROWS={loads_shifts:[{id:1,pro_number:'LIVE_SECRET_LOAD'}],atlanta_drivers:[{id:1,'Driver Name':'LIVE_SECRET_DRIVER'}],loads_accounting:[{id:1,driver_name_text:'LIVE_SECRET_ACCOUNTING'}]};});
  await page.goto('http://127.0.0.1:8787/'+file,{waitUntil:'networkidle'});
  await page.locator('#visitor-banner').waitFor();assert.ok(page.url().endsWith('/'+file),file+' accessible');
  assert.doesNotMatch(await page.locator('body').innerText(),/LIVE_SECRET/);
  assert.deepEqual(await page.evaluate(()=>window.__businessQueries),[],file+' must not query business records');
  assert.deepEqual(errors,[],file+' runtime errors');
  console.log('PASS visitor '+file);await page.close();
 }
}finally{await browser.close();server.kill();}
