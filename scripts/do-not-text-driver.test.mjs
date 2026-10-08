/*
 * Regression test: "Do not text" keeps a driver out of the GROUP BLASTS and
 * nowhere else.
 *
 * A blast reached a driver whose carrier has him on a do-not-text list
 * (2026-10-06). Before this there was no way to record that short of the
 * hardcoded NEVER_TEXT_DRIVER_NAMES set, which is a code deploy and which
 * blocks a driver everywhere -- too blunt. The owner's ruling: flagged drivers
 * stay dispatchable and stay textable one at a time from a board row, an
 * alert or the pre-shift prompt; only the Text a Group modal drops them.
 *
 * Two things this has to get right, both of which fail silently:
 *
 *  1. startGroupTexting() REBUILDS its member list from the driver pool
 *     instead of reusing ratingTextEligible / rateTextEligible. Filtering only
 *     the count refreshers would show the correct, smaller number on the
 *     buttons and still send to everyone.
 *  2. The block is keyed on PHONE NUMBER, not profile row. The same person
 *     routinely has two profiles with the same cell (581 duplicates
 *     outstanding), so flagging the row in front of you and sending from the
 *     other one is the obvious failure.
 *
 * Also pinned here: with "Text dispatch where applicable" ON, a driver with no
 * dispatcher number is dropped rather than quietly texted on their own cell.
 *
 * Run: node --test scripts/do-not-text-driver.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const board = fs.readFileSync('loadboard.js', 'utf8');
const html = fs.readFileSync('driverlist.html', 'utf8');
const helperSource = fs.readFileSync('preferred-rate-groups.js', 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);

// Some of these are exported from loadboard.js; `export` is not valid inside
// an eval, so it comes off on the way in.
function lift(name) {
  return board.match(new RegExp(`  (?:export )?(?:async )?function ${name}\\([^]*?\\n  \\}`))[0]
    .replace(/^\s*export\s+/, '  ');
}

function setup(poolOverride) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const $ = (selector) => window.document.querySelector(selector);

  // Najm's real shape: the same cell on two profile rows, a "preferred" one
  // and a location one. Only the preferred row carries the flag.
  const pool = poolOverride || [
    { id: 'najm-pref', name: 'Najm M', rating: 'A', phone: '630-770-9231', dispatcherPhone: '309-643-0963', doNotText: true,  atlantaRateOverrides: { tiers: { target: 400 } } },
    { id: 'najm-atl',  name: 'Najm M', rating: 'A', phone: '630-770-9231', dispatcherPhone: '309-643-0963', doNotText: false, atlantaRateOverrides: { tiers: { target: 400 } } },
    { id: 'ok',        name: 'Textable Driver', rating: 'A', phone: '770-555-0100', dispatcherPhone: '770-555-0200', atlantaRateOverrides: { tiers: { target: 400 } } },
    { id: 'b',         name: 'Driver B', rating: 'B', phone: '770-555-0101', atlantaRateOverrides: { tiers: { target: 400 } } },
  ];

  const batches = [];
  Object.assign(window, helpers, {
    $,
    $all: (selector, root) => [...(root || window.document).querySelectorAll(selector)],
    state: { driverListTab: 'preferred', drivers: pool },
    driversForLocation: () => pool,
    isNeverTextDriver: (d) => String(d.rating || '').toUpperCase().includes('DNU'),
    filterNeverTextRecipients: (members) => ({ allowed: members.filter((d) => !String(d.rating || '').toUpperCase().includes('DNU')), blocked: [] }),
    formatTextAddresses: p => p ? [String(p)] : [], formatTextAddress: (p) => (String(p || '').replace(/\D/g, '').length >= 10 ? String(p) : ''),
    escapeHtml: (s) => String(s),
    getBoardRateTiers: () => ({ atlanta: [{ id: 'target', min: 61, max: 140 }] }),
    dateKey: () => '2026-10-06',
    todayDate: () => new Date(),
    scheduledDriversOn: async () => new Set(),
    driverIsScheduled: () => false,
    beginTextBatchFlow: (...args) => batches.push(args),
  });

  const names = [
    'driverClassification', 'availableDriverClasses', 'setsIntersect', 'textPhoneKeys',
    'doNotTextPhones', 'splitDoNotTextRecipients', 'applyPhoneMode',
    'openTextGroupModal', 'setupRateTextOptions', 'setTextGroupMode', 'ratingTextClass',
    'toggleRatingTextGroup', 'renderRatingTextGroups', 'refreshRatingTextGroups',
    'refreshRateTextRatings', 'renderRateTextRatings', 'rateTextLabel',
    'renderRateTextOptions', 'setRateRatingLabelVisible', 'startGroupTexting',
    // Added by the multi-rate work (PR #205): the rating buttons carry the
    // real ratings behind each letter as a title.
    'variantTitle',
  ];
  const PHRASE_TABLE = /  const RATING_PHRASE_CLASSES = \{[\s\S]*?\n  \};/.exec(board)[0];
  window.eval(`const KNOWN_DRIVER_CLASSES=['A','B','C','D','DNU','R'];${PHRASE_TABLE}
    let groupTextState=null,rateTextMode=false,rateTextRatings=new Set(),rateTextRefresh=0,rateTextEligible=[],ratingTextRatings=new Set(),ratingTextEligible=[],ratingTextRefresh=0,rateTextRates=new Set(),rateTextOptions=[];
    ${names.map(lift).join('\n')}
    window.openModal=openTextGroupModal;window.toggle=toggleRatingTextGroup;
    window.refreshRating=refreshRatingTextGroups;window.start=startGroupTexting;
    window.splitDoNotText=splitDoNotTextRecipients;window.applyPhoneMode=applyPhoneMode;
  `);

  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { window, $, pool, batches, settle };
}

const sent = (batches) => (batches.at(-1) ? batches.at(-1)[0] : []);

/* ------------------------------------------------------------------ */
test('a flagged driver is dropped from the blast that actually SENDS', async () => {
  const { window, $, batches, settle } = setup();
  window.openModal();
  await settle();
  window.toggle('A');
  await settle();

  $('#tg-message').value = 'Loads open tomorrow, who wants one?';
  await window.start();
  await settle();

  assert.equal(batches.length, 1, 'a batch was started');
  const phones = sent(batches).map((d) => String(d.phone).replace(/\D/g, ''));

  // The modal opens with dispatch mode ON, so the unflagged driver arrives at
  // his DISPATCHER's number, not his cell.
  assert.ok(phones.includes('7705550200'), 'the unflagged A driver is in, via his dispatcher');

  // The flagged driver is gone entirely -- neither his cell nor his
  // dispatcher's number. Excluding the man and then texting his dispatcher
  // about him would be the same blast by another route.
  assert.ok(!phones.includes('6307709231'), 'the flagged cell is not in the batch');
  assert.ok(!phones.includes('3096430963'), 'and neither is his dispatcher');
});

test('the flag follows the PHONE, so a duplicate profile cannot leak it', async () => {
  const { window } = setup();
  // Only the 'preferred' row is flagged; the Atlanta row is not. Both carry
  // the same cell, so both must be blocked -- this is the duplicate-profile
  // failure, and it is the whole reason the rule is keyed on the number.
  const result = window.splitDoNotText([
    { id: 'najm-atl', name: 'Najm M', phone: '630-770-9231', doNotText: false },
  ]);
  assert.equal(result.allowed.length, 0);
  assert.equal(result.blocked.length, 1);
});

test('formatting differences in the number do not defeat the block', async () => {
  const { window } = setup();
  for (const spelling of ['6307709231', '(630) 770-9231', '1-630-770-9231', '630.770.9231']) {
    const r = window.splitDoNotText([{ name: 'Najm M', phone: spelling }]);
    assert.equal(r.blocked.length, 1, `${spelling} should be blocked`);
  }
});

test('nobody is blocked when nobody is flagged -- no accidental empty blasts', async () => {
  const { window } = setup([
    { id: 'a', name: 'A', phone: '770-555-0100' },
    { id: 'b', name: 'B', phone: '770-555-0101' },
  ]);
  const r = window.splitDoNotText([{ name: 'A', phone: '770-555-0100' }, { name: 'B', phone: '770-555-0101' }]);
  assert.equal(r.blocked.length, 0);
  assert.equal(r.allowed.length, 2);
});

test('a blast where everyone is flagged refuses and says so, rather than sending nothing quietly', async () => {
  const { window, $, batches, settle } = setup([
    { id: 'x', name: 'Only Driver', rating: 'A', phone: '630-770-9231', doNotText: true, atlantaRateOverrides: { tiers: { target: 400 } } },
  ]);
  window.openModal();
  await settle();
  window.toggle('A');
  await settle();
  $('#tg-message').value = 'anyone?';
  await window.start();
  await settle();

  assert.equal(batches.length, 0, 'nothing was sent');
  assert.match($('#tg-error').textContent, /do not text/i);
  assert.equal($('#tg-error').classList.contains('hidden'), false);
});

/* ---------------- it must NOT reach the individual paths ---------------- */
test('the one-to-one send path is untouched by the flag', () => {
  // openSendTextModal is what a board row, an alert and the pre-shift prompt
  // all call. It filters DNU and nothing else -- if splitDoNotTextRecipients
  // ever appears in it, flagged drivers stop being textable at all, which is
  // not what was asked for.
  const fn = board.match(/export function openSendTextModal\([^]*?\n  \}/)[0];
  assert.equal(/splitDoNotTextRecipients|doNotText/.test(fn), false);

  // Same for the board's "text selected loads" batch: those drivers are
  // already on a load that day, so it is operational, not a blast.
  const selected = board.match(/function startTextSelected\([^]*?\n  \}/)[0];
  assert.equal(/splitDoNotTextRecipients|doNotText/.test(selected), false);

  // And beginTextBatchFlow itself stays neutral, because it is shared between
  // the blast and "text selected loads".
  const begin = board.match(/export function beginTextBatchFlow\([^]*?\n  \}/)[0];
  assert.equal(/splitDoNotTextRecipients/.test(begin), false);
});

/* ---------------- dispatch mode falls back, and SAYS it did -------------- */
test('dispatch mode falls back to the cell when there is no dispatcher number', async () => {
  const { window, $ } = setup();
  $('#tg-dispatch-mode').checked = true;

  const out = window.applyPhoneMode([
    { name: 'Has Dispatcher', phone: '770-555-0100', dispatcherPhone: '770-555-0200' },
    { name: 'No Dispatcher', phone: '770-555-0101', dispatcherPhone: '' },
  ]);

  assert.equal(out[0].phone, '770-555-0200');
  assert.match(out[0].name, /\(dispatch\)$/);
  assert.equal(!!out[0].directPhoneFallback, false);

  // Dropping these was tried and reversed: a third of every pool has no
  // dispatcher number on file (204/538 preferred, 999/3128 Atlanta), so
  // skipping them would cut a third of the drivers out of every blast.
  assert.equal(out[1].phone, '770-555-0101', 'reached on their own cell');
  assert.equal(out[1].name, 'No Dispatcher', 'not labelled as a dispatch send');

  // But it is flagged, because a silent fallback is the original bug.
  assert.equal(out[1].directPhoneFallback, true);
});

test('the progress panel names who is getting it on their personal phone', () => {
  const render = board.match(/function renderGroupTextProgress\([^]*?\n  \}/)[0];
  assert.match(render, /directPhoneFallback/);
  assert.match(render, /will be texted directly/);
  // and it has to actually reach the rendered output, not just be computed
  assert.match(render, /\[directNote, skipNote/);
});

test('the Text a Group modal opens with dispatch mode ON', async () => {
  const { window, $, settle } = setup();
  window.openModal();
  await settle();
  assert.equal($('#tg-dispatch-mode').checked, true);
});

test('the board\'s "text selected loads" still opens with it OFF', () => {
  // Same modal, different mode: those drivers are already on a load that day,
  // so it is a message about work in progress, not a solicitation.
  const fn = board.match(/function openTextSelectedModal\([^]*?\n  \}/)[0];
  assert.match(fn, /dispatchModeCheckbox\.checked = false/);

  const group = board.match(/function openTextGroupModal\([^]*?\n  \}/)[0];
  assert.match(group, /dispatchModeCheckbox\.checked = true/);
});

test('the markup carries no checked attribute -- the opener decides', () => {
  // The attribute said checked while every open set it false, so for three
  // weeks the box read as on and was off. Now that the two openers disagree
  // with each other on purpose, a markup default could only be wrong for one
  // of them.
  assert.match(html, /id="tg-dispatch-mode"(?![^>]*\bchecked\b)/);
});

/* ---------------- the flag has to survive a round trip ------------------- */
test('do_not_text maps both ways, or the checkbox saves nothing', () => {
  const toDb = board.match(/function driverToDbRow\([^]*?\n  \}/)[0];
  const fromDb = board.match(/export function driverFromDbRow\([^]*?\n  \}/)[0];
  assert.match(toDb, /"do_not_text": !!d\.doNotText/);
  assert.match(fromDb, /doNotText: !!row\["do_not_text"\]/);

  // And the form has to read it, or the mapper writes false forever.
  assert.match(board, /doNotText: !!\$\("#ad-do-not-text"\)\?\.checked/);
  assert.match(html, /id="ad-do-not-text"/);

  // Edit populates it; Add clears it. A checkbox that keeps the last driver's
  // value is how the wrong person gets flagged.
  assert.match(board, /doNotTextEdit.*checked = !!d\.doNotText/);
  assert.match(board, /doNotTextAdd.*checked = false/);
});
