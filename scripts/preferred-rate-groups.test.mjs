import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('preferred-rate-groups.js', 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { driverRate, rateOptions, rateMembers, ratingGroups, selectedRateMembers, preferredTierRate } = helpers;
const classify = d => String(d.rating || '').includes('DNU') ? 'DNU' : (d.rating || '').slice(0, 1) || null;
const tiers = [{ id: 'short', min: 0, max: 25, rate: 325 }, { id: 'target', min: 61, max: 140, rate: 400 }];
const pool = [
  { id: '1', normalRate: '999', atlantaRateOverrides: { tiers: { target: 400 } }, rating: 'A', phone: '111' },
  { id: '2', normalRate: '999', atlantaRateOverrides: { tiers: { target: '400.00' } }, rating: 'A1', phone: '222' },
  { id: '3', normalRate: 999, atlantaRateOverrides: { tiers: { target: 400 } }, rating: 'B', phone: '333' },
  { id: '4', normalRate: 999, atlantaRateOverrides: { tiers: { target: 400 } }, rating: 'DNU', phone: '444' },
  { id: '5', normalRate: 999, atlantaRateOverrides: { tiers: { target: 450 } }, rating: 'A', phone: '555' },
  { id: '6', normalRate: '400', rating: 'B', phone: '666' },
  { id: '7', normalRate: 999, atlantaRateOverrides: { tiers: { target: 0 } }, rating: '' }
];

test('rates normalize numeric strings, preserve zero, and omit blank/invalid rates', () => {
  assert.deepEqual(rateOptions(pool, tiers), ['DEFAULT', 0, 400, 450]);
  assert.equal(driverRate(''), null);
  assert.equal(driverRate('bad'), null);
  assert.equal(driverRate('-1'), null);
  assert.deepEqual(rateMembers(pool, '', tiers).map(d => d.id), []);
  assert.deepEqual(rateMembers(pool, '400', tiers).map(d => d.id), ['1','2','3','4']);
});

test('rating counts match rate and toggle exclusions without including DNU', () => {
  const members = rateMembers(pool, 400, tiers);
  assert.deepEqual(ratingGroups(members, classify), [['A',2],['B',1]]);
  const selected = new Set(['A','B']);
  assert.deepEqual(selectedRateMembers(members, selected, classify).map(d => d.id), ['1','2','3']);
  selected.delete('A');
  assert.deepEqual(selectedRateMembers(members, selected, classify).map(d => d.id), ['3']);
  selected.delete('B');
  assert.deepEqual(selectedRateMembers(members, selected, classify), []);
});

test('profile tier overrides are the sole source, and Default stays distinct from explicit base-rate overrides', () => {
  assert.equal(preferredTierRate(pool[0], tiers), 400);
  assert.equal(preferredTierRate(pool[5], tiers), null);
  assert.equal(preferredTierRate({ normalRate: 777, atlantaRateOverrides: { tiers: { short: 600 } } }, tiers), null);
  for (const value of [undefined, null, '', 'default']) {
    assert.equal(preferredTierRate({ atlantaRateOverrides: { tiers: { target: value } } }, tiers), null);
  }
  assert.equal(preferredTierRate(pool[0], [{ id: 'target', min: '61', max: '140.9' }]), 400);
  assert.deepEqual(rateMembers(pool, 'DEFAULT', tiers).map(d => d.id), ['6']);
  assert.deepEqual(rateMembers(pool, '400', tiers).map(d => d.id), ['1','2','3','4']);
});

const board = fs.readFileSync('loadboard.js', 'utf8');
function lift(name) { return board.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`))[0]; }
function elements() {
  const map = new Map();
  return selector => {
    if (!map.has(selector)) map.set(selector,{value:'',checked:false,innerHTML:'',textContent:'',classList:{add(){},remove(){}}});
    return map.get(selector);
  };
}

test('rate sender passes only the selected rating at the chosen rate and still excludes scheduled drivers', async () => {
  const $ = elements();
  $('#tg-message').value='Available tonight?';
  $('#tg-rate-select').value='400';
  $('#tg-exclude-scheduled').checked=true;
  $('#tg-day').value='2026-10-05';
  const batches=[];
  const context=vm.createContext({$,state:{driverListTab:'preferred'},rateTextMode:true,rateTextRatings:new Set(['A']),
    driversForLocation:()=>pool,driverClassification:classify,isNeverTextDriver:d=>classify(d)==='DNU',
    rateMembers,selectedRateMembers,getBoardRateTiers:()=>({atlanta:tiers}),scheduledDriversOn:async()=>new Set(['1']),driverIsScheduled:(d,s)=>s.has(d.id),
    applyPhoneMode:m=>m,beginTextBatchFlow:(...args)=>batches.push(args)});
  vm.runInContext(lift('startGroupTexting'), context);
  await vm.runInContext('startGroupTexting()',context);
  assert.deepEqual(batches[0][0].map(d=>d.id),['2']);
  assert.equal(batches[0][3].allowDnu,false);
  context.rateTextRatings=new Set();
  await vm.runInContext('startGroupTexting()',context);
  assert.equal(batches.length,1);
  assert.match($('#tg-error').textContent,/Select at least one/);
  $('#tg-rate-select').value='DEFAULT';
  context.rateTextRatings=new Set(['B']);
  await vm.runInContext('startGroupTexting()',context);
  assert.deepEqual(batches[1][0].map(d=>d.id),['6']);
  assert.match(batches[1][1],/^Default/);
});

test('rate counts select all ratings initially, apply eligibility, and stale async refreshes cannot overwrite a new rate', async () => {
  const $=elements();
  $('#tg-rate-select').value='400';
  $('#tg-exclude-scheduled').checked=true;
  $('#tg-day').value='2026-10-05';
  const resolvers=[];
  const context=vm.createContext({$,rateTextMode:true,rateTextRefresh:0,rateTextRatings:new Set(),rateTextEligible:[],
    driversForLocation:()=>pool,driverClassification:classify,rateMembers,ratingGroups,selectedRateMembers,getBoardRateTiers:()=>({atlanta:tiers}),
    filterNeverTextRecipients:m=>({allowed:m.filter(d=>classify(d)!=='DNU')}),applyPhoneMode:m=>m,
    formatTextAddress:p=>p,driverIsScheduled:(d,s)=>s.has(d.id),escapeHtml:x=>x,
    scheduledDriversOn:()=>new Promise(resolve=>resolvers.push(resolve))});
  vm.runInContext(lift('refreshRateTextRatings')+'\n'+lift('renderRateTextRatings'),context);
  const first=vm.runInContext('refreshRateTextRatings(true)',context);
  $('#tg-rate-select').value='450';
  const second=vm.runInContext('refreshRateTextRatings(true)',context);
  resolvers[1](new Set());await second;
  resolvers[0](new Set());await first;
  assert.match($('#tg-rate-ratings').innerHTML,/A- 1/);
  assert.doesNotMatch($('#tg-rate-ratings').innerHTML,/B-/);
  assert.match($('#tg-rate-ratings').innerHTML,/aria-pressed="true"/);
  $('#tg-rate-select').value='400';
  const third=vm.runInContext('refreshRateTextRatings(true)',context);
  resolvers[2](new Set(['1']));await third;
  assert.match($('#tg-rate-ratings').innerHTML,/A- 1/);
  assert.match($('#tg-rate-ratings').innerHTML,/B- 1/);
  vm.runInContext('rateTextRatings.delete("A");renderRateTextRatings()',context);
  assert.match($('#tg-rate-count-note').textContent,/1 eligible drivers/);
  assert.match($('#tg-rate-ratings').innerHTML,/aria-pressed="false"/);
});

test('Preferred rate renders before Rating while other tabs retain their existing column order', () => {
  for (const tab of ['preferred', 'atlanta']) {
    const $ = elements();
    $('#btn-text-by-rate').classList.toggle=()=>{};
    const moves=[];
    const rateHeader={dataset:{}};
    const ratingHeader={before:node=>moves.push(['before-rating',node])};
    $('#activity-rating-sort').after=node=>moves.push(['after-activity',node]);
    const context=vm.createContext({$,state:{driverListTab:tab},
      document:{querySelector:selector=>selector.includes('normalRate') ? rateHeader : ratingHeader},
      getSortedDrivers:()=>[pool[0]],getDriverDisplayRate:d=>preferredTierRate(d,tiers),escapeHtml:v=>String(v ?? ''),
      refreshDriverDatalist:()=>{},$all:()=>[]});
    vm.runInContext(lift('renderDriverList')+';renderDriverList()',context);
    const html=$('#driverlist-table-body').innerHTML;
    const rateIndex=html.indexOf('driver-list-rate-cell');
    const ratingIndex=html.indexOf('driver-list-rating-cell');
    assert.equal(rateIndex<ratingIndex,tab==='preferred');
    assert.equal(html.includes('data-driver-rate='),false);
    assert.ok(html.includes('$400'));
    assert.equal(rateHeader.dataset.sort,tab==='preferred'?'displayRate':'normalRate');
    assert.equal(moves[0][0],tab==='preferred'?'before-rating':'after-activity');
  }
});


test('Preferred column displays Default for a profile with no mileage-tier override', () => {
  const $ = elements();
  $('#btn-text-by-rate').classList.toggle=()=>{};
  const rateHeader={dataset:{}};
  const context=vm.createContext({$,state:{driverListTab:'preferred'},
    document:{querySelector:selector=>selector.includes('normalRate') ? rateHeader : {before(){}}},
    getSortedDrivers:()=>[pool[5]],getDriverDisplayRate:d=>preferredTierRate(d,tiers),escapeHtml:v=>String(v ?? ''),
    refreshDriverDatalist:()=>{},$all:()=>[]});
  vm.runInContext(lift('renderDriverList')+';renderDriverList()',context);
  const html=$('#driverlist-table-body').innerHTML;
  assert.match(html,/61–140.9 MI">Default<\/td>/);
  assert.doesNotMatch(html,/\$400/);
});
