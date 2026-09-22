import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../carrier-mileage-tiers.js', import.meta.url), 'utf8');
const { atlantaMileageTier, atlantaTierLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const tiers = [[0,25,325],[26,60.9,355],[61,140,400],[141,170,425],[171,187,450]].map(([min,max,rate],i)=>({ id:i+1,min,max,rate }));
const cases = [[0,325],[25,325],[25.0001,355],[25.5,355],[26,355],[60.9,355],[60.91,400],[60.999,400],[61,400],[140,400],[140.01,425],[140.9,425],[141,425],[170,425],[170.01,450],[170.9,450],[171,450],[187,450]];

test('every boundary and fractional gap maps to exactly one unchanged tier', () => {
  for (const [miles,rate] of cases) assert.equal(atlantaMileageTier([...tiers].reverse(),miles)?.rate,rate,String(miles));
  for (const miles of [-1,187.01,NaN,Infinity,null,'']) assert.equal(atlantaMileageTier(tiers,miles),null);
  for (let cents=0;cents<=18700;cents++) assert.ok(atlantaMileageTier(tiers,cents/100),String(cents/100));
  assert.equal(atlantaMileageTier(tiers,140.5),tiers[3]);
});

test('labels describe continuous mileage intervals', () => {
  assert.deepEqual(tiers.map(t=>atlantaTierLabel(tiers,t)),['0–25 MI','Over 25–60.9 MI','Over 60.9–140 MI','Over 140–170 MI','Over 170–187 MI']);
});

const boardSource = readFileSync(new URL('../boardrates.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
let driver = null;
const context = vm.createContext({ atlantaMileageTier, atlantaTierLabel, tiers, findDriver:()=>driver, console });
vm.runInContext(boardSource+'\ncachedTiers={atlanta:tiers};cachedSettings={};cachedDaily={};',context);
const calcBoard = vm.runInContext('calcLoadRateBreakdown',context);
const row = miles => ({location:'atlanta',shiftDate:'2026-09-23',trips:[{routeId:'test',routeMiles:miles,stopCount:2}]});

test('board calculation uses the correct tiers, preserving stop charges and over-tier pay', () => {
  for (const [miles,rate] of cases.filter(([m])=>m>0)) assert.equal(calcBoard('atlanta',row(miles)).total,rate,String(miles));
  const extraStop=row(140.5); extraStop.trips[0].stopCount=3;
  assert.equal(calcBoard('atlanta',extraStop).total,445);
  assert.equal(calcBoard('atlanta',row(200)).total,480);
});

test('gap mileage still respects daily, load and driver overrides by tier ID', () => {
  vm.runInContext("cachedDaily={atlanta:{'2026-09-23':{tiers:{4:440},settings:{}}}}",context);
  const r=row(140.5);
  assert.equal(calcBoard('atlanta',r).total,440);
  r.rateOverrides={tiers:{4:460}};
  assert.equal(calcBoard('atlanta',r).total,460);
  driver={atlantaRateOverrides:{tiers:{4:475}}};r.driverId='test';
  assert.equal(calcBoard('atlanta',r).total,475);
  driver=null;
});

test('Accounting applied-rate calculation agrees with board gap handling', () => {
  const accounting = readFileSync(new URL('../accounting-pricing-v2.js', import.meta.url),'utf8');
  const context=vm.createContext({atlantaMileageTier});
  for(const name of ['objOrEmpty','settingValue','dailySetting','driverSetting','calcAtlantaTotal']) {
    const fn=accounting.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(fn,name);vm.runInContext(fn[0],context);
  }
  const calc=vm.runInContext('calcAtlantaTotal',context);
  const dbTiers=tiers.map(t=>({id:t.id,min_miles:String(t.min),max_miles:String(t.max),rate:String(t.rate)}));
  for(const [miles,rate] of cases.filter(([m])=>m>0)) assert.equal(calc({},[{route_id:'test',route_miles:miles,stop_count:2}],null,dbTiers,[],{},'base'),rate);
});
