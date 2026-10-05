import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const board = fs.readFileSync('loadboard.js', 'utf8');
const html = fs.readFileSync('driverlist.html', 'utf8');
const helperSource = fs.readFileSync('preferred-rate-groups.js', 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
function lift(name) { return board.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`))[0]; }
function setup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const $ = selector => window.document.querySelector(selector);
  const pool = [
    { id: 'a', name: 'Driver A', rating: 'A', phone: '111', dispatcherPhone: '999', atlantaRateOverrides: { tiers: { target: 400 } } },
    { id: 'b', name: 'Driver B', rating: 'B', phone: '222', atlantaRateOverrides: { tiers: { target: 400 } } },
    { id: 'dnu', name: 'Driver DNU', rating: 'DNU', phone: '333', atlantaRateOverrides: { tiers: { target: 400 } } },
    { id: 'u', name: 'Unrated Driver', rating: '', phone: '444' }
  ];
  const batches=[];
  let scheduled=new Set();
  Object.assign(window,helpers,{
    $, $all:(selector,root)=>[...(root||window.document).querySelectorAll(selector)], state:{driverListTab:'preferred',drivers:pool},
    driversForLocation:()=>pool, isNeverTextDriver:d=>d.rating==='DNU',
    filterNeverTextRecipients:members=>({allowed:members.filter(d=>d.rating!=='DNU')}), formatTextAddress:p=>p,
    escapeHtml:s=>String(s), getBoardRateTiers:()=>({atlanta:[{id:'target',min:61,max:140}]}),
    dateKey:()=> '2026-10-05', todayDate:()=>new Date(),
    scheduledDriversOn:async()=>scheduled, driverIsScheduled:(d,index)=>index.has(d.id),
    beginTextBatchFlow:(...args)=>batches.push(args)
  });
  const names=['driverClassification','availableDriverClasses','applyPhoneMode','openTextGroupModal','setupRateTextOptions','setTextGroupMode','ratingTextClass','toggleRatingTextGroup','renderRatingTextGroups','refreshRatingTextGroups','refreshRateTextRatings','renderRateTextRatings','rateTextLabel','renderRateTextOptions','setRateRatingLabelVisible','startGroupTexting'];
  window.eval(`const KNOWN_DRIVER_CLASSES=['A','B','C','D','DNU','R'];let groupTextState=null,rateTextMode=false,rateTextRatings=new Set(),rateTextRefresh=0,rateTextEligible=[],ratingTextRatings=new Set(),ratingTextEligible=[],ratingTextRefresh=0,rateTextRate='',rateTextOptions=[];${names.map(lift).join('\n')}
    window.openModal=openTextGroupModal;window.toggle=toggleRatingTextGroup;window.refreshRating=refreshRatingTextGroups;window.refreshRate=refreshRateTextRatings;window.start=startGroupTexting;window.mode=setTextGroupMode;window.selectRateRating=rating=>{rateTextRatings.add(rating);renderRateTextRatings();};window.pickRate=rate=>{rateTextRate=rate;renderRateTextOptions();};window.chosenRate=()=>rateTextRate;
  `);
  const settle=async()=>{await Promise.resolve();await Promise.resolve();};
  return {window,$,pool,batches,settle,schedule:ids=>{scheduled=new Set(ids);}};
}

test('opening and reopening clears both tabs, and the rating dropdown is replaced by unselected buttons', async () => {
  const {window,$,settle}=setup();
  window.openModal();await settle();
  assert.equal($('#tg-group-select'),null);
  assert.ok($('#tg-rating-buttons [data-text-rating="A"]'));
  assert.equal($('#tg-rating-buttons [aria-pressed="true"]'),null);
  assert.match($('#tg-rating-count-note').textContent,/No ratings selected/);
  window.toggle('A');
  assert.equal($('#tg-rating-buttons [data-text-rating="A"]').getAttribute('aria-pressed'),'true');
  assert.match($('#tg-rating-buttons [data-text-rating="A"]').textContent,/✓/);
  window.openModal();await settle();
  assert.equal($('#tg-rating-buttons [aria-pressed="true"]'),null);
  assert.equal(window.chosenRate(),'');
  assert.ok([...$('#tg-rate-buttons').querySelectorAll('button')].every(b=>b.getAttribute('aria-pressed')==='false'));
});

test('multiple rating buttons select only those drivers, toggling off excludes them, and empty selection cannot start', async () => {
  const {window,$,batches,settle}=setup();
  window.openModal();await settle();$('#tg-message').value='Available tonight?';
  await window.start();
  assert.equal(batches.length,0);
  assert.match($('#tg-error').textContent,/Select at least one rating/);
  window.toggle('A');window.toggle('B');
  assert.match($('#tg-rating-count-note').textContent,/2 eligible drivers selected/);
  window.toggle('A');
  assert.equal($('#tg-rating-buttons [data-text-rating="A"]').getAttribute('aria-pressed'),'false');
  assert.match($('#tg-rating-buttons [data-text-rating="A"]').textContent,/○/);
  await window.start();
  assert.deepEqual(batches[0][0].map(d=>d.id),['b']);
  assert.equal(batches[0][3].allowDnu,false);
});

test('All Drivers selects ordinary ratings including Unrated; explicit DNU remains exclusive', async () => {
  const {window,$,batches,settle}=setup();
  window.openModal();await settle();$('#tg-message').value='Available?';
  window.toggle('ALL');await window.start();
  assert.deepEqual(batches[0][0].map(d=>d.id),['a','b','u']);
  assert.equal(batches[0][3].allowDnu,false);
  window.toggle('DNU');
  assert.equal($('#tg-rating-buttons [data-text-rating="A"]').getAttribute('aria-pressed'),'false');
  await window.start();
  assert.deepEqual(batches[1][0].map(d=>d.id),['dnu']);
  assert.equal(batches[1][3].allowDnu,true);
  window.toggle('B');
  assert.equal($('#tg-rating-buttons [data-text-rating="DNU"]').getAttribute('aria-pressed'),'false');
});

test('eligibility options update counts and sender without auto-selecting groups or changing the message', async () => {
  const {window,$,batches,settle,schedule}=setup();
  schedule(['b']);window.openModal();await settle();
  assert.match($('#tg-rating-buttons [data-text-rating="B"]').textContent,/B- 0/);
  assert.equal($('#tg-rating-buttons [aria-pressed="true"]'),null);
  window.toggle('ALL');$('#tg-message').value='Same message';$('#tg-dispatch-mode').checked=true;
  await window.refreshRating();await window.start();
  assert.deepEqual(batches[0][0].map(d=>d.id),['a','u']);
  assert.equal(batches[0][0][0].phone,'999');
  assert.equal($('#tg-message').value,'Same message');
});

test('choosing or changing a rate clears rating selection; changing options preserves deliberate choices', async () => {
  const {window,$,settle}=setup();
  window.openModal();await settle();window.mode('rate');
  window.pickRate('400');await window.refreshRate(true);
  assert.equal($('#tg-rate-ratings [aria-pressed="true"]'),null);
  window.selectRateRating('B');
  assert.match($('#tg-rate-ratings [data-rate-rating="B"]').textContent,/✓/);
  await window.refreshRate();
  assert.equal($('#tg-rate-ratings [data-rate-rating="B"]').getAttribute('aria-pressed'),'true');
  await window.refreshRate(true);
  assert.equal($('#tg-rate-ratings [aria-pressed="true"]'),null);
});
