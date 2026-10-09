// Real Chromium layout checks, using fake Supabase only. No live data writes.
// Start: node sandbox/serve.mjs . 8787
// Run: node sandbox/driver-picker-parity.spec.mjs
// Optional: PLAYWRIGHT_MODULE_PATH, CHROME_PATH, SANDBOX_URL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { boardFixture } from './fixtures.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const fake = readFileSync(new URL('./fake-supabase.js', import.meta.url), 'utf8');
const base = process.env.SANDBOX_URL || 'http://127.0.0.1:8787';
let checks = 0;
const check = (label, condition, detail) => {
  assert.ok(condition, `${label}: ${JSON.stringify(detail)}`);
  console.log(`ok ${label}`); checks++;
};
try {
  for (const [location, file] of [['delaware','dalaware.html'], ['atlanta','index.html'], ['buildingc','buildingc.html']]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.addInitScript(rows => { window.__SANDBOX_ROWS = rows; }, boardFixture({ shifts:40, drivers:40, location }));
    await page.route('**/supabase.min.js', route => route.fulfill({ contentType:'text/javascript', body:fake }));
    if (process.env.MJ_PICKER_BASELINE) {
      const body = execFileSync('git', ['show','origin/main:loadboard.js'], { encoding:'utf8', maxBuffer:2000000 });
      await page.route('**/loadboard.js', route => route.fulfill({ contentType:'text/javascript', body }));
    }
    await page.goto(`${base}/${file}`, { waitUntil:'networkidle' });
    await page.waitForSelector('#board-table tbody input[data-driver-ac]');
    check(`${location}: page initializes`, errors.length === 0, errors);
    // A real board cell, scrolled into the visible grid. Typing and arrowing
    // exercise the shipped event handlers, not a replica of the picker.
    const grid = page.locator('#board-view .grid-scroll');
    await grid.evaluate(el => { el.scrollTop = 350; });
    const index = await page.evaluate(() => {
      const box=document.querySelector('#board-view .grid-scroll').getBoundingClientRect();
      return [...document.querySelectorAll('#board-table tbody input[data-driver-ac]')].findIndex(el => {
        const r=el.getBoundingClientRect();return r.top>box.top+60 && r.bottom<box.bottom-40;
      });
    });
    check(`${location}: visible cell exists`, index >= 0, index);
    const input=page.locator('#board-table tbody input[data-driver-ac]').nth(index);
    await input.click();
    const before=await grid.evaluate(el => [el.scrollTop,el.scrollLeft]);
    await input.fill('Driver');
    for (let i=0;i<12;i++) await page.keyboard.press('ArrowDown');
    const after=await grid.evaluate(el => [el.scrollTop,el.scrollLeft]);
    check(`${location}: typing/arrow navigation holds both scroll axes`, before.every((v,i)=>Math.abs(v-after[i])<=2), {before,after});
    await page.keyboard.press('Escape');
    // Measure real bounding boxes across shrinking content, edges, and
    // scrolled field positions. Use both board and Available field markers.
    const geometry=await page.evaluate(async () => {
      const api=await import('./loadboard.js');
      const field=document.createElement('input');
      field.style.cssText='position:fixed;left:1200px;width:180px;height:24px;z-index:600';
      document.body.append(field);
      const results=[];
      for(const available of [false,true]) {
        if(available)field.dataset.availRow='test';else delete field.dataset.availRow;
        for(const top of [400,20,740]) {
          field.style.top=top+'px';field.value='Driver';field.focus({preventScroll:true});
          api.openDriverAutocomplete(field, undefined,()=>{});
          for(const value of ['Driver','Driver 0','Driver 01','not on file']) {
            field.value=value;api.updateDriverAutocomplete(field);
            const r=field.getBoundingClientRect(), b=document.querySelector('#driver-ac-floating').getBoundingClientRect();
            results.push({available,top,value,clear:b.bottom<=r.top-1 || b.top>=r.bottom+1,
              preferred:top===20 ? b.top>=r.bottom : b.bottom<=r.top,
              fits:b.left>=7 && b.right<=innerWidth-7 && b.top>=7 && b.bottom<=innerHeight-7,
              field:{top:r.top,bottom:r.bottom},box:{top:b.top,bottom:b.bottom,left:b.left,right:b.right}});
          }
          api.closeDriverAutocomplete();
        }
      }
      field.remove();return results;
    });
    check(`${location}: all 24 picker states leave typed text clear`, geometry.every(x=>x.clear), geometry.filter(x=>!x.clear));
    check(`${location}: above except at the top edge`, geometry.every(x=>x.preferred), geometry.filter(x=>!x.preferred));
    check(`${location}: choices fit the viewport`, geometry.every(x=>x.fits), geometry.filter(x=>!x.fits));
    check(`${location}: no runtime errors`, errors.length===0, errors);
    await page.close();
  }
  console.log(`${checks} browser checks passed`);
} finally { await browser.close(); }
