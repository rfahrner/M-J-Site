import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../carrier-mileage-tiers.js', import.meta.url), 'utf8');
const { carrierMileageTier, carrierTierLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const tiers = [[0,25,325],[26,60.9,355],[61,140,400],[141,170,425],[171,187,450]].map(([min,max,rate],i)=>({ id:i+1,min,max,rate }));
const cases = [[0,325],[25,325],[25.0001,325],[25.9,325],[25.999,325],[26,355],[60.9,355],[60.91,355],[60.999,355],[61,400],[140,400],[140.01,400],[140.999,400],[141,425],[170,425],[170.01,425],[170.999,425],[171,450],[187,450],[187.999,450]];
const deTiers = [[0,25,600],[26,75,700],[76,150,800],[151,200,900],[201,250,1000]].map(([min,max,rate],i)=>({id:i+16,min,max,rate}));

test('every boundary and fractional gap maps to exactly one unchanged tier', () => {
  for (const [miles,rate] of cases) assert.equal(carrierMileageTier([...tiers].reverse(),miles)?.rate,rate,String(miles));
  for (const miles of [-1,188,NaN,Infinity,null,'']) assert.equal(carrierMileageTier(tiers,miles),null);
  for (let cents=0;cents<18800;cents++) assert.ok(carrierMileageTier(tiers,cents/100),String(cents/100));
  assert.equal(carrierMileageTier(tiers,140.5),tiers[2]);
});

test('labels describe continuous mileage intervals', () => {
  assert.deepEqual(tiers.map(t=>carrierTierLabel(tiers,t)),['0–25.9 MI','26–60.9 MI','61–140.9 MI','141–170.9 MI','171–187.9 MI']);
});

const boardSource = readFileSync(new URL('../boardrates.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
let driver = null;
const context = vm.createContext({ carrierMileageTier, carrierTierLabel, tiers, deTiers, findDriver:()=>driver, console });
vm.runInContext(boardSource+'\ncachedTiers={atlanta:tiers,delaware:deTiers};cachedSettings={};cachedDaily={};',context);
const calcBoard = vm.runInContext('calcLoadRateBreakdown',context);
const row = miles => ({location:'atlanta',shiftDate:'2026-09-23',trips:[{routeId:'test',routeMiles:miles,stopCount:2}]});

test('board calculation uses the correct tiers, preserving stop charges and over-tier pay', () => {
  for (const [miles,rate] of cases.filter(([m])=>m>0)) assert.equal(calcBoard('atlanta',row(miles)).total,rate,String(miles));
  const extraStop=row(140.5); extraStop.trips[0].stopCount=3;
  assert.equal(calcBoard('atlanta',extraStop).total,420);
  assert.equal(calcBoard('atlanta',row(200)).total,480);
});

test('gap mileage still respects daily, load and driver overrides by tier ID', () => {
  vm.runInContext("cachedDaily={atlanta:{'2026-09-23':{tiers:{3:440},settings:{}}}}",context);
  const r=row(140.5);
  assert.equal(calcBoard('atlanta',r).total,440);
  r.rateOverrides={tiers:{3:460}};
  assert.equal(calcBoard('atlanta',r).total,460);
  driver={atlantaRateOverrides:{tiers:{3:475}}};r.driverId='test';
  assert.equal(calcBoard('atlanta',r).total,475);
  driver=null;
});

test('Accounting applied-rate calculation agrees with board gap handling', () => {
  const accounting = readFileSync(new URL('../accounting-pricing-v2.js', import.meta.url),'utf8');
  const context=vm.createContext({carrierMileageTier});
  for(const name of ['objOrEmpty','settingValue','dailySetting','driverSetting','calcAtlantaTotal']) {
    const fn=accounting.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(fn,name);vm.runInContext(fn[0],context);
  }
  const calc=vm.runInContext('calcAtlantaTotal',context);
  const dbTiers=tiers.map(t=>({id:t.id,min_miles:String(t.min),max_miles:String(t.max),rate:String(t.rate)}));
  for(const [miles,rate] of cases.filter(([m])=>m>0)) assert.equal(calc({},[{route_id:'test',route_miles:miles,stop_count:2}],null,dbTiers,[],{},'base'),rate);
});


test('Delaware rounds down at every band edge and retains actual over-tier mileage', () => {
  const deRow = miles => ({ ...row(miles), location:'delaware' });
  for (const tier of deTiers) {
    for (const miles of [tier.min || 0.1, tier.max, tier.max + 0.9, tier.max + 0.999]) {
      assert.equal(carrierMileageTier(deTiers,miles),tier);
      assert.equal(calcBoard('delaware',deRow(miles)).total,tier.rate);
    }
  }
  assert.deepEqual(deTiers.map(t=>carrierTierLabel(deTiers,t)),['0–25.9 MI','26–75.9 MI','76–150.9 MI','151–200.9 MI','201–250.9 MI']);
  assert.equal(carrierMileageTier(deTiers,251),null);
  assert.equal(calcBoard('delaware',deRow(251.5)).total,1006);
  vm.runInContext("cachedDaily={delaware:{'2026-09-23':{tiers:{16:650},settings:{}}}}",context);
  const r=deRow(25.9);
  assert.equal(calcBoard('delaware',r).total,650);
  r.rateOverrides={tiers:{16:675}};
  assert.equal(calcBoard('delaware',r).total,675);
  driver={delawareRateOverrides:{tiers:{16:700}}};r.driverId='test';
  assert.equal(calcBoard('delaware',r).total,700);
  driver=null;
});
