import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync('loadboard.js','utf8');
const html=fs.readFileSync('driverlist.html','utf8');
const mdz=fs.readFileSync('mondelez.js','utf8');
const locations=new Function(`${mdz.match(/export const MONDELEZ_LOCATIONS = \[[\s\S]*?\n\];/)[0].replace('export ','')} return MONDELEZ_LOCATIONS;`)();
function lift(name){return source.match(new RegExp(`  (?:export )?(?:async )?function ${name}\\([^]*?\\n  \\}`))[0].replace(/^\s*export\s+/,'  ');}
function setup(){
  const dom=new JSDOM(html,{runScripts:'outside-only'});const w=dom.window;
  Object.assign(w,{MONDELEZ_LOCATIONS:locations,$:s=>w.document.querySelector(s),$all:s=>Array.from(w.document.querySelectorAll(s)),
    escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    state:{driverListTab:'mondelez',driverSort:{key:'name',dir:'asc'}},getDriverDisplayRate:()=>null,refreshDriverDatalist:()=>{},
    getSortedDrivers:()=>[
      {id:1,name:'Multi-site',phone:'7705550100',mondelezLocations:['morris','addison'],email:''},
      {id:2,name:'Unassigned',phone:'7705550101',email:''}
    ]});
  w.eval(`${['mondelezDriverLocationOptions','driverMondelezLocationLabel','renderDriverList','populateDriverMondelezLocations','compareForSort','driverToDbRow','driverFromDbRow','switchDriverListTab'].map(lift).join('\n')}
  window.render=renderDriverList;window.populate=populateDriverMondelezLocations;window.compare=compareForSort;window.toDb=driverToDbRow;window.fromDb=driverFromDbRow;window.switchTab=switchDriverListTab;`);
  return {w,$:w.$};
}
test('Mondelez shows named locations after the driver name, including multiple sites and unassigned profiles',()=>{
  const {w,$}=setup();w.render();
  assert.equal($('#driverlist-mondelez-location').classList.contains('hidden'),false);
  assert.equal($('#dl-1').cells[1].textContent,'Multi-site');
  assert.equal($('#dl-1').cells[2].textContent,'Morris, Addison');
  assert.equal($('#dl-1').cells[3].textContent,'7705550100');
  assert.equal($('#dl-2 .driver-list-location-cell').textContent,'Not set');
});
test('other tabs keep their existing columns; switching back restores the Mondelez column',()=>{
  const {w,$}=setup();w.render();
  for(const tab of ['atlanta','delaware','houston','preferred']){
    w.state.driverListTab=tab;w.render();
    assert.equal($('#driverlist-mondelez-location').classList.contains('hidden'),true);
    assert.equal($('.driver-list-location-cell'),null);
    assert.equal($('#dl-1').cells[2].textContent,'7705550100');
  }
  w.state.driverListTab='mondelez';w.render();assert.ok($('.driver-list-location-cell'));
});
test('profile checkboxes use all board locations, restore saved selections, and clear for the next new driver',()=>{
  const {w,$}=setup();w.populate(['morris','addison']);
  assert.equal(w.document.querySelectorAll('[name="ad-mondelez-location"]').length,locations.length+2);
  assert.deepEqual(Array.from(w.document.querySelectorAll('[name="ad-mondelez-location"]:checked'),c=>c.value),['morris','addison']);
  w.populate([]);assert.equal(w.document.querySelectorAll('[name="ad-mondelez-location"]:checked').length,0);
  assert.match(source,/populateDriverMondelezLocations\(\[\]\)/);
  assert.match(source,/populateDriverMondelezLocations\(d\.mondelezLocations \|\| \[\]\)/);
  assert.match(source,/mondelezLocations: \$all\('input\[name="ad-mondelez-location"\]'\)\.filter\(\(c\) => c.checked\)/);
});
test('location assignments survive database mapping and can be explicitly cleared',()=>{
  const {w}=setup();
  const saved=w.toDb({name:'Driver',phone:'7705550100',mondelezLocations:['addison','morris']});
  assert.deepEqual(Array.from(w.fromDb(saved).mondelezLocations),['addison','morris']);
  const cleared=w.toDb({name:'Driver',mondelezLocations:[]});assert.equal(cleared.mondelez_locations,null);
  assert.deepEqual(Array.from(w.fromDb(cleared).mondelezLocations),[]);
});
test('location sorting uses readable site names, with unassigned drivers last in either direction',()=>{
  const {w}=setup();const a={mondelezLocations:['addison']},m={mondelezLocations:['morris']},blank={};
  assert.ok(w.compare(a,m,'mondelezLocations','asc')<0);
  assert.ok(w.compare(a,m,'mondelezLocations','desc')>0);
  for(const dir of ['asc','desc'])assert.ok(w.compare(blank,a,'mondelezLocations',dir)>0);
});

test('leaving Mondelez clears a hidden location sort while other sorts stay selected',()=>{
  const {w}=setup();w.state.driverSort={key:'mondelezLocations',dir:'desc'};
  w.switchTab('houston');assert.equal(w.state.driverSort.key,'name');
  w.state.driverSort={key:'mc',dir:'desc'};w.switchTab('preferred');assert.equal(w.state.driverSort.key,'mc');
});

test('historical Brooklyn Park and Clarksville origins are selectable and displayed',()=>{
  const {w,$}=setup();w.populate(['brooklynpark','clarksville']);
  assert.deepEqual(Array.from(w.document.querySelectorAll('[name="ad-mondelez-location"]:checked'),c=>c.value),['brooklynpark','clarksville']);
  w.getSortedDrivers=()=>[{id:1,name:'Historical driver',email:'',mondelezLocations:['brooklynpark','clarksville']}];
  w.render();assert.equal($('#dl-1 .driver-list-location-cell').textContent,'Brooklyn Park, Clarksville');
});
