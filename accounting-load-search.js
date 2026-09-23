/*
 * Find a load from the Accounting page by Trip ID, Route ID, Load # or PRO #.
 *
 * The sheet shows one location on one day. A load somebody rings up about is
 * rarely today's and often isn't on the tab in front of you, so the only way
 * to reach it was to already know its date and location -- which is usually
 * the thing being asked.
 *
 * Two facts about the data shape this:
 *
 *   Matching is exact. loads_trips.trip_id and route_id are free text in
 *   practice -- 'TONU', 'txt 0441', 'Truck down @ 2230' are all real values --
 *   so a contains-match on a short query returns a wall of unrelated loads.
 *
 *   One query can legitimately find many loads. 1,314 distinct trip_id values
 *   and 2,773 route_id values sit on more than one load; 'TONU' alone is on
 *   246. So a result list, never a guess at which one was meant. A single hit
 *   opens straight away, because then there is nothing to choose.
 *
 * Kroger loads open in the modal on this page. Houston and Mondelez loads are
 * separate tables with their own modals, and that markup only exists on their
 * own pages -- so those results navigate to that board, on the load's own
 * date, and it opens there. See openHoustonLoadByDbId / openMondelezLoadByDbId.
 *
 * The search itself is one RPC: search_loads_by_identifier(), SECURITY
 * INVOKER, so it returns exactly the loads the signed-in user may read.
 */

import { supabaseClient, escapeHtml, $, openLoadStandalone } from './loadboard.js';

const KROGER_LOCATION_LABELS = {
  atlanta: 'Atlanta', buildingc: 'Building C', delaware: 'Delaware', houston: 'Houston',
};

function locationLabel(row) {
  const key = String(row.location || '').toLowerCase();
  if (KROGER_LOCATION_LABELS[key]) return KROGER_LOCATION_LABELS[key];
  return String(row.location || 'Unknown').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function resultsPanel() { return $('#acct-load-search-results'); }

function say(html, tone) {
  const panel = resultsPanel();
  if (!panel) return;
  panel.className = `acct-search-results${tone ? ` is-${tone}` : ''}`;
  panel.innerHTML = html;
}

function hideResults() {
  const panel = resultsPanel();
  if (!panel) return;
  panel.className = 'acct-search-results hidden';
  panel.innerHTML = '';
}

function resultRowHtml(row) {
  // Everything needed to tell two hits apart at a glance: which field
  // matched and what it held, whose load it is, and when.
  const where = `${row.customer === 'Mondelez' ? 'Mondelez' : 'Kroger'} · ${locationLabel(row)}`;
  return `<button type="button" class="acct-search-hit"
    data-hit-table="${escapeHtml(row.source_table)}"
    data-hit-id="${escapeHtml(row.source_id)}"
    data-hit-trip="${row.trip_db_id == null ? '' : escapeHtml(row.trip_db_id)}"
    data-hit-date="${escapeHtml(row.shift_date || '')}"
    data-hit-location="${escapeHtml(row.location || '')}">
      <span class="acct-search-hit-main">
        <strong>${escapeHtml(row.load_number || '(no load #)')}</strong>
        <span class="acct-search-hit-driver">${escapeHtml(row.driver_name || 'No driver')}</span>
      </span>
      <span class="acct-search-hit-meta">
        <span>${escapeHtml(row.shift_date || 'no date')}</span>
        <span>${escapeHtml(where)}</span>
        <span class="acct-search-hit-match">${escapeHtml(row.matched_field)}: ${escapeHtml(row.matched_value || '')}</span>
      </span>
    </button>`;
}

async function openHit(hit) {
  const table = hit.dataset.hitTable;
  const id = hit.dataset.hitId;
  const date = hit.dataset.hitDate;

  if (table === 'loads_shifts') {
    hideResults();
    await openLoadStandalone(id, { tripDbId: hit.dataset.hitTrip || null });
    return;
  }
  // Their modals live on their own pages; say so before the page changes
  // rather than appearing to do nothing for a second.
  const params = new URLSearchParams({ load: id });
  if (date) params.set('date', date);
  if (table === 'loads_houston') {
    say('Opening this load on the Houston board…');
    window.location.href = `houston.html?${params}`;
    return;
  }
  if (table === 'mondelez_loads') {
    if (hit.dataset.hitLocation) params.set('loc', hit.dataset.hitLocation);
    say('Opening this load on the Mondelez board…');
    window.location.href = `mondelez.html?${params}`;
    return;
  }
  say(`This load is in a table the search can't open yet (${escapeHtml(table)}).`, 'error');
}

async function runSearch() {
  const input = $('#acct-load-search-input');
  if (!input) return;
  const query = input.value.trim();
  if (!query) { hideResults(); return; }
  if (!supabaseClient) { say('Supabase did not load on this page, so the search cannot run.', 'error'); return; }

  say('Searching…');
  // rpc() returns a thenable, not a Promise -- it has no .catch, so the
  // failure has to be handled off the awaited result. See
  // scripts/accounting-manual-rates.test.mjs for what .catch() here cost us.
  const { data, error } = await supabaseClient.rpc('search_loads_by_identifier', { p_query: query });
  if (error) {
    console.error('Load search failed:', error);
    say(`Couldn't run the search (${escapeHtml(error.message || error)}).`, 'error');
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    say(`Nothing matches <strong>${escapeHtml(query)}</strong>. The search is exact — a Trip ID, Route ID, Load # or PRO # has to match in full.`, 'empty');
    return;
  }
  if (rows.length === 1) {
    const only = rows[0];
    say('Opening…');
    await openHit({ dataset: {
      hitTable: only.source_table,
      hitId: String(only.source_id),
      hitTrip: only.trip_db_id == null ? '' : String(only.trip_db_id),
      hitDate: only.shift_date || '',
      hitLocation: only.location || '',
    } });
    return;
  }

  const total = Number(rows[0].total_matches || rows.length);
  const capped = total > rows.length
    ? ` Showing the ${rows.length} most recent of ${total.toLocaleString()}.`
    : '';
  say(
    `<div class="acct-search-summary">${total.toLocaleString()} loads match <strong>${escapeHtml(query)}</strong>.${capped}</div>`
    + rows.map(resultRowHtml).join(''),
  );
}

export function initAccountingLoadSearch() {
  const box = $('#acct-load-search');
  if (!box) return; // not the Accounting page
  const input = $('#acct-load-search-input');

  $('#acct-load-search-go')?.addEventListener('click', () => void runSearch());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void runSearch(); }
    if (e.key === 'Escape') { input.value = ''; hideResults(); }
  });
  // A search input's own clear (x) fires input with an empty value.
  input?.addEventListener('input', () => { if (!input.value.trim()) hideResults(); });

  resultsPanel()?.addEventListener('click', (e) => {
    const hit = e.target.closest('.acct-search-hit');
    if (hit) void openHit(hit);
  });
}
