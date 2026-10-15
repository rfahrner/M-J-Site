// Actual list pages and membership mapper; fixture SDK only, no production writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {boardFixture} from './fixtures.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const server=spawn(process.execPath,['sandbox/serve.mjs','.','8787']);await new Promise(resolve=>server.stdout.once('data',resolve));
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const data=boardFixture({shifts:0,drivers:4});
 Object.assign(data.atlanta_drivers[0],{location:'preferred',preferred_list_active:false});
 Object.assign(data.atlanta_drivers[1],{location:'preferred',preferred_list_active:true});
 Object.assign(data.atlanta_drivers[2],{location:'atlanta',preferred_list_active:false});
 Object.assign(data.atlanta_drivers[3],{location:'atlanta',preferred_list_active:true});
 await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;},data);
 await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8')}));await page.route('https://**',r=>r.abort());
 await page.goto('http://127.0.0.1:8787/driverlist.html',{waitUntil:'networkidle'});await page.waitForSelector('#dl-502');assert.equal(await page.locator('#dl-503').count(),1);
 await page.locator('#driverlist-location-tabs [data-location="preferred"]').click();await page.waitForSelector('#dl-501');assert.equal(await page.locator('#dl-500').count(),0);assert.equal(await page.locator('#dl-502').count(),0);
 const state=await page.evaluate(async()=>{const lb=await import('./loadboard.js');return {preferred:lb.driversForLocation('preferred').map(d=>d.id),atlanta:lb.driversForLocation('atlanta').map(d=>d.id),buildingc:lb.driversForLocation('buildingc').map(d=>d.id),historical:lb.findDriver(500)?.id};});
 assert.deepEqual(state.preferred,[501]);assert.deepEqual(state.atlanta,[502,503]);assert.deepEqual(state.buildingc,state.atlanta);assert.equal(state.historical,500);assert.deepEqual(errors,[]);
 console.log('PASS actual Driver List: retired Preferred entry hidden, moved and existing Atlanta entries visible to Atlanta/Building C, historical profile still resolves');
}finally{await browser.close();server.kill();}
