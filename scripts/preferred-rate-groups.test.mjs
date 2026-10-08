import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('preferred-rate-groups.js', 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { driverRate, rateOptions, rateMembers, ratingGroups, selectedRateMembers, preferredTierRate, resolveAtlantaRateProfile } = helpers;
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
    if (!map.has(selector)) map.set(selector,{value:'',checked:false,innerHTML:'',textContent:'',classList:{add(){},remove(){},toggle(){}}});
    return map.get(selector);
  };
}

test('rate sender passes only the selected rating at the chosen rate and still excludes scheduled drivers', async () => {
  const $ = elements();
  $('#tg-message').value='Available tonight?';
  $('#tg-exclude-scheduled').checked=true;
  $('#tg-day').value='2026-10-05';
  const batches=[];
  const context=vm.createContext({$,state:{driverListTab:'preferred',drivers:pool},rateTextMode:true,rateTextRates:new Set(['400']),rateTextRatings:new Set(['A']),
    driversForLocation:()=>pool,driverClassification:classify,isNeverTextDriver:d=>classify(d)==='DNU',
    rateMembers,selectedRateMembers,getBoardRateTiers:()=>({atlanta:tiers}),scheduledDriversOn:async()=>new Set(['1']),driverIsScheduled:(d,s)=>s.has(d.id),
    splitDoNotTextRecipients:m=>({allowed:m,blocked:[]}),applyPhoneMode:m=>m,beginTextBatchFlow:(...args)=>batches.push(args)});
  vm.runInContext(lift('rateTextLabel')+'\n'+lift('startGroupTexting'), context);
  await vm.runInContext('startGroupTexting()',context);
  assert.deepEqual(Array.from(batches[0][0],d=>d.id),['2']);
  assert.equal(batches[0][3].allowDnu,false);
  context.rateTextRatings=new Set();
  await vm.runInContext('startGroupTexting()',context);
  assert.equal(batches.length,1);
  assert.match($('#tg-error').textContent,/Select at least one/);
  context.rateTextRates=new Set(['DEFAULT']);
  context.rateTextRatings=new Set(['B']);
  await vm.runInContext('startGroupTexting()',context);
  assert.deepEqual(Array.from(batches[1][0],d=>d.id),['6']);
  assert.match(batches[1][1],/^Default/);
});

test('rate counts start unselected, apply eligibility, and stale async refreshes cannot overwrite a new rate', async () => {
  const $=elements();
  $('#tg-exclude-scheduled').checked=true;
  $('#tg-day').value='2026-10-05';
  const resolvers=[];
  const context=vm.createContext({$,state:{drivers:pool},rateTextMode:true,rateTextRates:new Set(['400']),rateTextRefresh:0,rateTextRatings:new Set(),rateTextEligible:[],
    driversForLocation:()=>pool,driverClassification:classify,rateMembers,ratingGroups,selectedRateMembers,getBoardRateTiers:()=>({atlanta:tiers}),
    splitDoNotTextRecipients:m=>({allowed:m,blocked:[]}),filterNeverTextRecipients:m=>({allowed:m.filter(d=>classify(d)!=='DNU')}),applyPhoneMode:m=>m,
    formatTextAddresses: p => p ? [String(p)] : [], formatTextAddress:p=>p,driverIsScheduled:(d,s)=>s.has(d.id),escapeHtml:x=>x,
    availableDriverClasses:()=>['A','B'],variantTitle:()=>'',
    scheduledDriversOn:()=>new Promise(resolve=>resolvers.push(resolve))});
  vm.runInContext(lift('rateRatingChoices')+'\n'+lift('setRateRatingLabelVisible')+'\n'+lift('refreshRateTextRatings')+'\n'+lift('renderRateTextRatings'),context);
  const first=vm.runInContext('refreshRateTextRatings(true)',context);
  context.rateTextRates=new Set(['450']);
  const second=vm.runInContext('refreshRateTextRatings(true)',context);
  resolvers[1](new Set());await second;
  resolvers[0](new Set());await first;
  assert.match($('#tg-rate-ratings').innerHTML,/A- 1/);
  // Every rating now stays on screen so the panel cannot change height; a
  // rating nobody at these rates holds reads zero and is disabled rather
  // than disappearing.
  assert.match($('#tg-rate-ratings').innerHTML,/B- 0/);
  assert.match($('#tg-rate-ratings').innerHTML,/B- 0<\/button>|B- 0</);
  assert.doesNotMatch($('#tg-rate-ratings').innerHTML,/aria-pressed="true"/);
  context.rateTextRates=new Set(['400']);
  const third=vm.runInContext('refreshRateTextRatings(true)',context);
  resolvers[2](new Set(['1']));await third;
  assert.match($('#tg-rate-ratings').innerHTML,/A- 1/);
  assert.match($('#tg-rate-ratings').innerHTML,/B- 1/);
  vm.runInContext('rateTextRatings.add("B");renderRateTextRatings()',context);
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

test('modal tabs switch selection panels while preserving shared options, message, rate, and rating toggles', () => {
  const $ = elements();
  const hidden = new Map();
  for (const selector of ['#tg-group-tabs-wrap','#tg-rate-wrap']) {
    $(selector).classList.toggle=(_class, value)=>hidden.set(selector,value);
  }
  $('#tg-message').value='Keep this message';
  $('#tg-day').value='2026-10-06';
  $('#tg-dispatch-mode').checked=true;
  $('#tg-exclude-scheduled').checked=true;
  const buttons=['rating','rate'].map(mode=>({dataset:{textGroupMode:mode},classList:{toggle(_class,value){this.active=value;}},setAttribute(key,value){this[key]=value;}}));
  let refreshes=0;
  // The chosen rate is module state behind a button group now, not a <select>
  // value, so switching tabs has to leave it alone the same way.
  const context=vm.createContext({$, $all:()=>buttons, rateTextMode:false,rateTextRefresh:0,
    rateTextRates:new Set(['400']), rateTextOptions:[], escapeHtml:x=>x, availableDriverClasses:()=>['A','B'], driverClassification:()=>'A', variantTitle:()=>'',
    rateTextRatings:new Set(['B']), refreshRateTextRatings:()=>refreshes++, refreshRatingTextGroups:()=>{}});
  vm.runInContext(lift('rateTextLabel')+'\n'+lift('renderRateTextOptions')+'\n'+lift('setTextGroupMode'),context);
  vm.runInContext('setTextGroupMode("rate")',context);
  assert.equal(context.rateTextMode,true);
  assert.equal(hidden.get('#tg-rate-wrap'),false);
  assert.equal(hidden.get('#tg-group-tabs-wrap'),true);
  assert.equal(buttons[1]['aria-selected'],'true');
  vm.runInContext('setTextGroupMode("rating")',context);
  assert.equal(context.rateTextMode,false);
  assert.equal(hidden.get('#tg-rate-wrap'),true);
  assert.equal(buttons[0]['aria-selected'],'true');
  assert.equal($('#tg-message').value,'Keep this message');
  assert.equal($('#tg-day').value,'2026-10-06');
  assert.equal($('#tg-dispatch-mode').checked,true);
  assert.equal($('#tg-exclude-scheduled').checked,true);
  assert.deepEqual([...context.rateTextRates],['400']);
  assert.deepEqual([...context.rateTextRatings],['B']);
  assert.equal(refreshes,1);
});


test('missing Preferred card resolves by unique name and MC, and rate grouping uses the same live card', () => {
  const preferred = { id: 'p', location: 'preferred', name: '  Howard   Barnett ', mc: '1618522', rating: 'B', phone: '111' };
  const atlanta = { id: 'a', location: 'atlanta', name: 'HOWARD BARNETT', mc: '1618522', atlantaRateOverrides: { tiers: { target: 400 } } };
  const profiles = [preferred, atlanta];
  assert.equal(resolveAtlantaRateProfile(preferred, profiles), atlanta);
  assert.equal(preferredTierRate(preferred, tiers, profiles), 400);
  assert.deepEqual(rateOptions([preferred], tiers, profiles), [400]);
  assert.deepEqual(rateMembers([preferred], 400, tiers, profiles), [preferred]);
  assert.deepEqual(rateMembers([preferred], 'DEFAULT', tiers, profiles), []);
  atlanta.atlantaRateOverrides.tiers.target = 450;
  assert.equal(preferredTierRate(preferred, tiers, profiles), 450);
  assert.deepEqual(rateMembers([preferred], 400, tiers, profiles), []);
  assert.deepEqual(rateMembers([preferred], 450, tiers, profiles), [preferred]);
  assert.equal(preferred.atlantaRateOverrides, undefined);
});

test('existing Preferred cards and unmatched or ambiguous identities never inherit another driver rate', () => {
  const preferred = { id: 'p', location: 'preferred', name: 'Howard Barnett', mc: '1618522' };
  const atlanta = { id: 'a', location: 'atlanta', name: 'Howard Barnett', mc: '1618522', atlantaRateOverrides: { tiers: { target: 400 } } };
  for (const local of [{ tiers: { target: 500 } }, { tiers: { short: 350 } }, { settings: { overmi: 4 } }]) {
    const d = { ...preferred, atlantaRateOverrides: local };
    assert.equal(resolveAtlantaRateProfile(d, [atlanta]), d);
  }
  for (const d of [{ ...preferred, mc: '' }, { ...preferred, mc: '999' }, { ...preferred, name: 'Other Driver' }, { ...preferred, location: 'delaware' }]) {
    assert.equal(resolveAtlantaRateProfile(d, [atlanta]), d);
  }
  assert.equal(resolveAtlantaRateProfile(preferred, [atlanta, { ...atlanta, id: 'b', location: 'buildingc' }]), preferred);
  assert.equal(resolveAtlantaRateProfile(preferred, [{ ...atlanta, atlantaRateOverrides: null }]), preferred);
  assert.equal(resolveAtlantaRateProfile(preferred, [{ ...atlanta, location: 'buildingc' }]).id, 'a');
  assert.equal(resolveAtlantaRateProfile({ ...preferred, atlantaRateOverrides: {} }, [atlanta]), atlanta);
});

test('Preferred rate inputs are read when edited, including a linked card', () => {
  const context = vm.createContext({
    driverProfileState: { driverId: 'p', rateSourceId: 'a' },
    $: () => ({}),
    $all: selector => selector.includes('tier') ? [{ value: '475', dataset: { drTierId: 'target' } }] : []
  });
  vm.runInContext(lift('readAtlantaRateOverridesFromForm'), context);
  assert.equal(vm.runInContext('readAtlantaRateOverridesFromForm().tiers.target', context), 475);
});

test('an inherited Atlanta card remains visible even when Preferred runs-out-of checkbox is absent', () => {
  const hidden = new Map();
  const context = vm.createContext({ findDriver: () => ({ atlantaRateOverrides: { tiers: { target: 400 } } }), ensureDelawareRateSection: () => {}, driverProfileState: { driverId: 'p', rateSourceId: 'a' },
    $: selector => selector.startsWith('input') ? { checked: false } : { classList: { toggle: (name, value) => hidden.set(selector, value) } }
  });
  vm.runInContext(lift('updateDriverRateSectionVisibility') + ';updateDriverRateSectionVisibility()', context);
  assert.equal(hidden.get('#ad-atlanta-rate-section'), false);
  assert.equal(hidden.get('#ad-delaware-rate-section'), true);
});

test('Preferred profile displays the linked card and allows editing it directly', () => {
  const preferred = { id: 'p', location: 'preferred', name: 'Howard Barnett', mc: '1618522' };
  const atlanta = { id: 'a', location: 'atlanta', name: 'Howard Barnett', mc: '1618522', atlantaRateOverrides: { tiers: { target: 400 } } };
  const $ = elements();
  $('#ad-mc').dataset = {};
  $('#ad-name').focus = () => {};
  const input = { disabled: false };
  $('#ad-atlanta-rate-boxes').insertAdjacentHTML = (_position, html) => { $('#ad-atlanta-rate-boxes').innerHTML += html; };
  const context = vm.createContext({ $, state: { drivers: [preferred, atlanta] }, driverProfileState: null,
    findDriver: id => [preferred, atlanta].find(d => d.id === id), resolveAtlantaRateProfile, driverToDbRow: d => ({ 'Driver Name': d.name }),
    $all: selector => selector === 'input' ? [input] : [], setVal: () => {}, setText: () => {},
    ensureDelawareRateSection: () => {}, updateDriverRateSectionVisibility: () => {},
    driverAtlantaRateBoxesHtml: card => JSON.stringify(card), driverDelawareRateBoxesHtml: () => ''
  });
  const fn = board.match(/  export function openEditDriverModal\([^]*?\n  \}/)[0].replace('export ', '');
  vm.runInContext(fn + ';openEditDriverModal("p")', context);
  assert.equal(context.driverProfileState.rateSourceId, 'a');
  assert.match($('#ad-atlanta-rate-boxes').innerHTML, /"target":400/);
  assert.match($('#ad-atlanta-rate-boxes').innerHTML, /Changes apply to both lists/);
  assert.equal(input.disabled, false);
  vm.runInContext('openEditDriverModal("a")', context);
  assert.equal(context.driverProfileState.rateSourceId, 'a');
  assert.equal(context.driverProfileState.driverId, 'a');
  assert.doesNotMatch($('#ad-atlanta-rate-boxes').innerHTML, /shared-driver-rate-source/);
});

test('rate options, eligibility and send recipients follow every active driver tab', async () => {
  const profiles=['atlanta','preferred','houston','delaware','mondelez'].map((location,i)=>({
    id:location,name:location,location,runsOutOf:location==='mondelez'?['mondelez']:[],rating:'A',phone:'770555010'+i,
    atlantaRateOverrides:{tiers:{target:400+i*10}}
  }));
  // A driver assigned elsewhere but checked for Houston belongs in Houston too.
  profiles.push({id:'shared-houston',location:'delaware',runsOutOf:['houston'],rating:'A',phone:'7705550199',atlantaRateOverrides:{tiers:{target:420}}});
  const $=elements();$('#tg-message').value='Sandbox fixture';const batches=[];
  const ctx=vm.createContext({$,state:{driverListTab:'houston',drivers:profiles},rateTextMode:true,rateTextRefresh:0,rateTextEligible:[],
    rateTextOptions:[],rateTextRates:new Set(),rateTextRatings:new Set(),rateOptions,rateMembers,selectedRateMembers,
    getBoardRateTiers:()=>({atlanta:tiers}),renderRateTextOptions(){},setRateRatingLabelVisible(){},renderRateTextRatings(){},
    driverClassification:classify,splitDoNotTextRecipients:allowed=>({allowed,blocked:[]}),filterNeverTextRecipients:allowed=>({allowed,blocked:[]}),
    applyPhoneMode:m=>m,formatTextAddresses:p=>[p],beginTextBatchFlow:members=>batches.push(Array.from(members,d=>d.id))});
  const drivers=board.match(/  export function driversForLocation\([^]*?\n  \}/)[0].replace('export ','');
  vm.runInContext(lift('locationGroupFor')+drivers+['setupRateTextOptions','refreshRateTextRatings','rateTextLabel','startGroupTexting'].map(lift).join('\n'),ctx);
  for(const location of ['houston','atlanta','preferred','delaware','mondelez']) {
    ctx.state.driverListTab=location;
    vm.runInContext('setupRateTextOptions()',ctx);
    const expected=profiles.filter(d=>location==='mondelez'?d.runsOutOf.includes('mondelez'):location==='houston'?d.location==='houston'||d.runsOutOf.includes('houston'):d.location===location);
    assert.deepEqual(Array.from(ctx.rateTextOptions),rateOptions(expected,tiers,profiles));
    ctx.rateTextRates=new Set(ctx.rateTextOptions.map(String));ctx.rateTextRatings=new Set(['A']);
    await vm.runInContext('refreshRateTextRatings()',ctx);
    assert.deepEqual(Array.from(ctx.rateTextEligible,d=>d.id).sort(),expected.map(d=>d.id).sort());
    await vm.runInContext('startGroupTexting()',ctx);
    assert.deepEqual(batches.at(-1).sort(),expected.map(d=>d.id).sort());
  }
});
