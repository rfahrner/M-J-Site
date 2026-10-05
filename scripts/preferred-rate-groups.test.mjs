import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';
const source = fs.readFileSync('preferred-rate-groups.js', 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { driverRate, rateOptions, rateMembers, ratingGroups, selectedRateMembers, savePreferredRate } = helpers;
const classify = d => String(d.rating || '').includes('DNU') ? 'DNU' : (d.rating || '').slice(0, 1) || null;
const pool = [
  { id: '1', normalRate: '400', rating: 'A', phone: '111' },
  { id: '2', normalRate: '400.00', rating: 'A1', phone: '222' },
  { id: '3', normalRate: 400, rating: 'B', phone: '333' },
  { id: '4', normalRate: 400, rating: 'DNU', phone: '444' },
  { id: '5', normalRate: 450, rating: 'A', phone: '555' },
  { id: '6', normalRate: '', rating: 'B' },
  { id: '7', normalRate: 0, rating: '' }
];

test('rates normalize numeric strings, preserve zero, and omit blank/invalid rates', () => {
  assert.deepEqual(rateOptions(pool), [0, 400, 450]);
  assert.equal(driverRate(''), null);
  assert.equal(driverRate('bad'), null);
  assert.equal(driverRate('-1'), null);
  assert.deepEqual(rateMembers(pool, '').map(d => d.id), []);
  assert.deepEqual(rateMembers(pool, '400').map(d => d.id), ['1','2','3','4']);
});

test('rating counts match rate and toggle exclusions without including DNU', () => {
  const members = rateMembers(pool, 400);
  assert.deepEqual(ratingGroups(members, classify), [['A',2],['B',1]]);
  const selected = new Set(['A','B']);
  assert.deepEqual(selectedRateMembers(members, selected, classify).map(d => d.id), ['1','2','3']);
  selected.delete('A');
  assert.deepEqual(selectedRateMembers(members, selected, classify).map(d => d.id), ['3']);
  selected.delete('B');
  assert.deepEqual(selectedRateMembers(members, selected, classify), []);
});

test('real Supabase builder saves only normal_rate to the matched driver and verifies the result', async () => {
  const calls = [];
  let stored = { id: 12, normal_rate: 325 };
  let failure = false;
  const client = createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false },
    global: { fetch:async (url, options) => {
      calls.push({ url:new URL(url), options });
      if (options.method === 'PATCH' && !failure) Object.assign(stored, JSON.parse(options.body));
      return new Response(JSON.stringify(stored), {status:200,headers:{'Content-Type':'application/json'}});
    } }
  });
  for (const [value, expected] of [['400',400],['0',0],['',null]]) {
    await savePreferredRate(client,12,value);
    const { data } = await client.from('atlanta_drivers').select('id,normal_rate').eq('id',12).single();
    assert.equal(data.normal_rate,expected);
  }
  assert.equal(calls[0].url.searchParams.get('id'),'eq.12');
  assert.deepEqual(JSON.parse(calls[0].options.body),{normal_rate:400});
  failure = true;
  await assert.rejects(savePreferredRate(client,12,'500'));
  await assert.rejects(savePreferredRate(client,12,'-5'));
  stored = null;
  await assert.rejects(savePreferredRate(client,12,'500'));
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
    rateMembers,selectedRateMembers,scheduledDriversOn:async()=>new Set(['1']),driverIsScheduled:(d,s)=>s.has(d.id),
    applyPhoneMode:m=>m,beginTextBatchFlow:(...args)=>batches.push(args)});
  vm.runInContext(lift('startGroupTexting'), context);
  await vm.runInContext('startGroupTexting()',context);
  assert.deepEqual(batches[0][0].map(d=>d.id),['2']);
  assert.equal(batches[0][3].allowDnu,false);
  context.rateTextRatings=new Set();
  await vm.runInContext('startGroupTexting()',context);
  assert.equal(batches.length,1);
  assert.match($('#tg-error').textContent,/Select at least one/);
});

test('rate counts select all ratings initially, apply eligibility, and stale async refreshes cannot overwrite a new rate', async () => {
  const $=elements();
  $('#tg-rate-select').value='400';
  $('#tg-exclude-scheduled').checked=true;
  $('#tg-day').value='2026-10-05';
  const resolvers=[];
  const context=vm.createContext({$,rateTextMode:true,rateTextRefresh:0,rateTextRatings:new Set(),rateTextEligible:[],
    driversForLocation:()=>pool,driverClassification:classify,rateMembers,ratingGroups,selectedRateMembers,
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
    const rateHeader={};
    const ratingHeader={before:node=>moves.push(['before-rating',node])};
    $('#activity-rating-sort').after=node=>moves.push(['after-activity',node]);
    const context=vm.createContext({$,state:{driverListTab:tab},
      document:{querySelector:selector=>selector.includes('normalRate') ? rateHeader : ratingHeader},
      getSortedDrivers:()=>[pool[0]],getDriverDisplayRate:d=>Number(d.normalRate),escapeHtml:v=>String(v ?? ''),
      refreshDriverDatalist:()=>{},$all:()=>[]});
    vm.runInContext(lift('renderDriverList')+';renderDriverList()',context);
    const html=$('#driverlist-table-body').innerHTML;
    const rateIndex=html.indexOf('driver-list-rate-cell');
    const ratingIndex=html.indexOf('driver-list-rating-cell');
    assert.equal(rateIndex<ratingIndex,tab==='preferred');
    assert.equal(html.includes('data-driver-rate="1"'),tab==='preferred');
    assert.equal(moves[0][0],tab==='preferred'?'before-rating':'after-activity');
  }
});
