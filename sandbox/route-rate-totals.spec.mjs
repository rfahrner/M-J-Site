// Reproduce load 2010710 in real pages/handlers with fake Supabase only.
// PLAYWRIGHT_MODULE_PATH and CHROME_PATH can select a local Chromium install.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { boardFixture } from './fixtures.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const server=spawn(process.execPath,['sandbox/serve.mjs','.','8787']);
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try {
  for(const fixed of [false,true]) {
    const page=await browser.newPage({viewport:{width:1400,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    const rows=boardFixture({shifts:1,drivers:1,location:'delaware'});
    Object.assign(rows.loads_shifts[0],{pro_number:'2010710',driver_id:500,carrier_rate:1000,rate_manual:false});
    Object.assign(rows.atlanta_drivers[0],{'Driver Name':'Loui Sekulla',normal_rate:1000});
    rows.loads_trips=[15,47,48,106].map((m,i)=>({id:2000+i,shift_id:1000,trip_number:i+1,route_id:['Bobtail','PF2007','PF2040','DG2012'][i],route_miles:m,stop_count:[1,2,2,4][i]}));
    rows.board_rate_tiers=[600,700,800,900,1000].map((r,i)=>({id:16+i,location:'delaware',min_miles:[0,26,76,151,201][i],max_miles:[25,75,150,200,250][i],rate:r}));
    rows.board_rate_settings=[{location:'delaware',key:'over_tier_per_mile',value:4}];
    await page.addInitScript(rows=>{window.__SANDBOX_ROWS=rows;},rows);
    await page.route('**/supabase.min.js',r=>r.fulfill({contentType:'text/javascript',body:readFileSync(new URL('./fake-supabase.js',import.meta.url),'utf8')}));
    if(!fixed) {
      const body=execFileSync('git',['show','f464e47d666aa0b0b4bce590c1257c868a368ac0:loadboard.js'],{encoding:'utf8',maxBuffer:2000000});
      await page.route('**/loadboard.js',r=>r.fulfill({contentType:'text/javascript',body}));
    }
    await page.goto('http://127.0.0.1:8787/dalaware.html',{waitUntil:'networkidle'});
    await page.waitForSelector('#board-table [data-open-pro]:not([data-trip])');
    const expected=fixed?'2800':'1000';
    await page.waitForFunction(expected=>document.querySelector('#board-table input[data-field="rate"]').value===expected,expected);
    await page.locator('#board-table [data-open-pro]:not([data-trip])').click();
    await page.waitForSelector('#ld-rate-total');
    assert.equal(await page.locator('#ld-rate-total').inputValue(),expected);
    if(fixed) {
      const text=await page.locator('#ld-tab-content .rate-breakdown').innerText();
      for(const name of ['Bobtail','PF2007','PF2040','DG2012'])assert.ok(text.includes(name),name);
      assert.ok(text.includes('$2800.00') || text.includes('$2,800.00'),text);
      assert.equal(await page.evaluate(async()=>{const lb=await import('./loadboard.js');const row=Object.values(lb.state.sheets).flat()[0];return lb.getEffectiveRateInfo(row).total;}),2800);
    }
    assert.deepEqual(errors,[]);
    console.log(`${fixed?'PASS':'REPRODUCED'} real Delaware board and modal show ${expected} for the reported routes`);
    await page.close();
  }
}finally {await browser.close();server.kill();}
