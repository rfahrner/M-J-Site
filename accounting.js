/* ---------------- Accounting page ---------------- */
import {
  supabaseClient, TRIPS_TABLE, escapeHtml, $, $all, on, setDriverSyncStatus,
  state, dateKey, addDays, todayDate, keyToDate, openDateDropdown, closeDateDropdown,
  SAVE_DEBOUNCE_MS, closeLoadDetailsModal, loadDetailsState, renderLoadDetailsTabs,
  uploadTripSheetImages, removeTripSheetImage, startLoadDetailsEdit, cancelLoadDetailsEdit,
  saveLoadDetailsEdit, stopFieldsHtml, openLoadDetailsFromAccounting, submitLoadNote,
  commitRateOverride, resetRateToCalculated, changeRouteType, setHostlerHours, commitRateBoxOverride, openEditDriverModal,
  loadLocationNotes, openLocationNotesModal, closeLocationNotesModal, saveLocationNotes,
  showDriverAssignmentWarning, SHIFTS_TABLE,
} from './loadboard.js';
import { ACCOUNTING_TABLE, ACCOUNTING_ROUTES_TABLE, loadPricingData, calcRoute, getPricingTiers, getPricingSettings } from './accountingcalc.js';
import { releaseToAljex } from './aljex-outbox.js';
import { saveAccountingFields } from './accounting-save.js';
const pendingAccountingChecks = new Set();

async function saveAccountingCheckbox(rec, patch, label) {
  const key = String(rec.id);
  if (pendingAccountingChecks.has(key)) return;
  pendingAccountingChecks.add(key);
  renderAccountingTable();
  setDriverSyncStatus(`Saving ${label}…`, '');
  try {
    const saved = await saveAccountingFields(supabaseClient, rec.id, patch);
    // Realtime may have replaced the original record while the save ran.
    const current = getAccountingRecordById(rec.id);
    if (current) for (const field of Object.keys(patch)) current[field] = saved[field];
    accountingRecords.sort(acctSortCompare);
    setDriverSyncStatus(`${label} saved.`, 'success');
  } catch (err) {
    setDriverSyncStatus(`Couldn't save ${label} (${err.message || err}).`, 'error');
  } finally {
    pendingAccountingChecks.delete(key);
    renderAccountingTable();
  }
}
/*
 * Money cells on the Accounting sheet, and why they go through here.
 *
 * These three used to save with
 *   supabaseClient.from(...).update({...}).eq("id", rec.id).catch(...)
 *
 * A PostgREST query builder is a thenable, NOT a Promise: it has `then` and no
 * `catch`. So that line threw "catch is not a function" inside a bare
 * setTimeout -- and because nothing ever awaited the builder, the request was
 * never sent at all. The value sat on screen looking saved, the database never
 * heard about it, and the next page load showed the old number. Nothing
 * surfaced, because the throw had no handler.
 *
 * scripts/accounting-save.test.mjs already asserted `.catch` is undefined on a
 * real builder; that is exactly why saveAccountingFields() exists. These three
 * cells simply never got moved onto it. saveAccountingFields also re-reads the
 * row and compares, so a write blocked by row permissions is reported instead
 * of being assumed.
 */
const ACCOUNTING_MONEY_FIELDS = {
  "acct-carrier-pay": { column: "total_carrier_pay", label: "carrier pay" },
  "acct-customer-rate": { column: "total_revenue", label: "customer rate" },
};

// Number("1,250.00") is NaN and JSON.stringify turns NaN into null, which
// SUCCEEDS while blanking a real figure -- the same trap numOrNull() exists for
// on the board. undefined means "not a number yet", not "clear the column".
function numOrUndefined(raw) {
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

async function saveAccountingMoneyField(rec, field, value) {
  try {
    const saved = await saveAccountingFields(supabaseClient, rec.id, { [field.column]: value });
    const current = getAccountingRecordById(rec.id);
    if (current) current[field.column] = saved[field.column];
  } catch (err) {
    setDriverSyncStatus(`Couldn't save ${field.label} (${err.message || err}).`, "error");
  }
}

/*
 * A push from the load board overwrites what Accounting has -- including a rate
 * they typed. That is deliberate (the board is the operational truth), but it
 * must never be silent: someone who entered 500 and comes back to 740 needs to
 * know it was replaced rather than think they mistyped.
 *
 * push_shift_to_accounting() writes the sentence; this draws it as a sticky
 * beside the driver name. Clicking it clears the note -- the figure stays, the
 * flag is just acknowledged.
 */
function acctPushStickyHtml(rec) {
  if (!rec.push_note) return "";
  const when = rec.pushed_at ? new Date(rec.pushed_at).toLocaleString() : "";
  const title = `${rec.push_note}${when ? `\n${when}` : ""}\n\nClick to dismiss.`;
  return `<button type="button" class="acct-push-sticky" data-acct-dismiss-push="${rec.id}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">!</button>`;
}

async function dismissAccountingPushNote(id) {
  const rec = getAccountingRecordById(id);
  if (!rec) return;
  rec.push_note = null;
  renderAccountingTable();
  try {
    await saveAccountingFields(supabaseClient, id, { push_note: null });
  } catch (err) {
    setDriverSyncStatus(`Couldn't clear that note (${err.message || err}).`, "error");
  }
}

let accountingRecords = [];
const accountingLoadNoteFlags = new Map();
async function refreshAccountingLoadNotes(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    const withNotes = new Set();
    let failed = false;
    for (let page = 0; ; page += 1000) {
      const { data, error } = await supabaseClient.from('load_notes')
        .select('id,shift_id,note_text').in('shift_id', chunk).order('id').range(page, page + 999);
      if (error) { console.error('Could not load accounting note indicators', error); failed = true; break; }
      for (const note of data || []) if (String(note.note_text || '').trim()) withNotes.add(String(note.shift_id));
      if (!data || data.length < 1000) break;
    }
    if (!failed) for (const id of chunk) accountingLoadNoteFlags.set(id, withNotes.has(id));
  }
}
function accountingNoteButton(rec) {
  const hasNotes = accountingLoadNoteFlags.get(String(rec.source_shift_id)) === true;
  return `<button type="button" class="acct-note-button${hasNotes ? ' has-notes' : ''}" data-acct-load-notes="${rec.id}" aria-label="Open load notes" title="${hasNotes ? 'Load has notes' : 'Open load notes'}"><svg width="15" height="17" viewBox="0 0 18 20" aria-hidden="true"><path d="M2 1h10l4 4v14H2z" fill="currentColor" stroke="#64748b"/><path d="M12 1v4h4" fill="none" stroke="#64748b"/></svg></button>`;
}

  let accountingDriverSort = 0;
  function compareAccountingDriverNames(a, b) {
    const left = String(a || "").trim();
    const right = String(b || "").trim();
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    return accountingDriverSort * left.localeCompare(right, "en", { sensitivity: "base", numeric: true });
  }
  function accountingDriverHeaderHtml() {
    const label = accountingDriverSort === 1 ? "A–Z" : accountingDriverSort === -1 ? "Z–A" : "↕";
    return `<button type="button" class="acct-driver-sort" data-acct-driver-sort title="Sort drivers alphabetically">Driver ${label}</button>`;
  }
  // Date descending (most recent first), then status within the same date
  // — active loads before released ones, since those are the ones more
  // likely to still need attention.
  function acctSortCompare(a, b) {
    if (a.shift_date !== b.shift_date) return a.shift_date < b.shift_date ? 1 : -1;
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return 0;
  }
  let acctTripsByShiftId = {}; // source_shift_id -> [trips], used for the Delaware "Routes" column
  // source_shift_id -> boolean, whether the underlying board shift is
  // actually marked complete. Populated for every location (not just
  // Delaware) since this drives the "shift not marked complete" warning
  // on the PRO#/Aljex# link — a load can now reach Accounting via the
  // 12-hour or time-sheet-filled-in triggers without ever being marked
  // complete, and this is how that gets flagged when someone opens it.
  let acctShiftCompleteById = {};
  // accounting_id -> [route rows from loads_accounting_routes], sorted by
  // route_number. Powers both the new Atlanta "Routes" column and the
  // per-route Total Miles / Total Stops breakdown everywhere. There's no
  // real foreign key back to loads_trips here (route_id/trip_id are just
  // text snapshots taken when the shift was completed), so clicking a
  // route chip has to match by that text — see openLoadDetailsFromAccounting.
  let acctRoutesByAccountingId = {};
  // loadboard.js's openLoadDetailsFromAccounting() needs to look up a
  // record from this module-private array — this is the sanctioned way
  // in, rather than exporting the array itself.
  export function getAccountingRecordById(id) {
    return accountingRecords.find((r) => r.id == id) || null;
  }
  // Fetches accounting records (plus their linked Delaware trips and
  // route rows) for a given shift_date range and merges them into
  // accountingRecords — used for both the initial bounded load and for
  // pulling in an earlier window on demand (see loadOlderAccountingRecords).
  // Every fetch stays scoped to a bounded range instead of ever pulling
  // the whole table's history in one shot: unscoped, this table will
  // eventually cross Supabase/PostgREST's 1000-row-per-query cap and
  // start silently dropping older rows with no error at all (the same
  // failure mode we already hit once with the drivers table), on top of
  // just getting slower to load and render as years of history pile up.
  async function loadAccountingRecordsForRange(fromKey, toKey, replaceExisting) {
    const { data, error } = await supabaseClient.from(ACCOUNTING_TABLE).select("*").gte("shift_date", fromKey).lte("shift_date", toKey);
    if (error) { console.error("Failed to load accounting records:", error); setDriverSyncStatus(`Couldn't load Accounting (${error.message}).`, "error"); return; }
    const fresh = data || [];
    accountingRecords = (replaceExisting ? fresh : [...accountingRecords, ...fresh]).sort(acctSortCompare);

    // A single .in() query with a very long id list can silently fail or
    // truncate well before it's obvious something's wrong — and that list
    // only grows now that shifts land in Accounting continuously via the
    // auto-send trigger, not just at explicit Shift Complete clicks.
    // Chunking keeps every one of these queries small and reliable
    // regardless of how large the table gets over time.
    const CHUNK_SIZE = 150;
    function chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    }

    const shiftIds = [...new Set(accountingRecords.filter((r) => r.location === "delaware" && r.source_shift_id).map((r) => r.source_shift_id))];
    if (shiftIds.length) {
      acctTripsByShiftId = {};
      for (const idChunk of chunk(shiftIds, CHUNK_SIZE)) {
        const { data: trips, error: tripsErr } = await supabaseClient.from(TRIPS_TABLE).select("*").in("shift_id", idChunk);
        if (tripsErr) { console.error("Failed to load Delaware trips (chunk):", tripsErr); continue; }
        (trips || []).forEach((t) => {
          if (!acctTripsByShiftId[t.shift_id]) acctTripsByShiftId[t.shift_id] = [];
          acctTripsByShiftId[t.shift_id].push(t);
        });
      }
    }
    const allShiftIds = [...new Set(accountingRecords.filter((r) => r.source_shift_id).map((r) => r.source_shift_id))];
    if (allShiftIds.length) {
      for (const idChunk of chunk(allShiftIds, CHUNK_SIZE)) {
        const { data: shiftRows, error: shiftErr } = await supabaseClient.from(SHIFTS_TABLE).select("id, shift_complete").in("id", idChunk);
        if (shiftErr) { console.error("Failed to load shift-complete status (chunk):", shiftErr); continue; }
        (shiftRows || []).forEach((s) => { acctShiftCompleteById[s.id] = !!s.shift_complete; });
      }
    }
    await refreshAccountingLoadNotes(allShiftIds);
    const accountingIds = accountingRecords.map((r) => r.id);
    if (accountingIds.length) {
      acctRoutesByAccountingId = {};
      for (const idChunk of chunk(accountingIds, CHUNK_SIZE)) {
        const { data: routes, error: routesErr } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").in("accounting_id", idChunk);
        if (routesErr) { console.error("Failed to load accounting routes (chunk):", routesErr); continue; }
        (routes || [])
          .sort((a, b) => (a.route_number || 0) - (b.route_number || 0))
          .forEach((r) => {
            (acctRoutesByAccountingId[r.accounting_id] = acctRoutesByAccountingId[r.accounting_id] || []).push(r);
          });
      }
    }
  }

  export async function loadAccountingRecords() {
    if (!supabaseClient) return;
    await loadAccountingRecordsForRange(state.minDate, state.maxDate, true);
  }

  const ACCT_WINDOW_DAYS = 60; // matches the calendar's existing default lookback

  // Pulls in the next 60-day window further back than what's currently
  // loaded, and extends state.minDate to match — so the calendar's date
  // picker also opens up to let you navigate into that older range.
  export async function loadOlderAccountingRecords() {
    const newMinDate = dateKey(addDays(keyToDate(state.minDate), -ACCT_WINDOW_DAYS));
    const rangeEnd = dateKey(addDays(keyToDate(state.minDate), -1));
    const btn = $("#btn-load-earlier");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    await loadAccountingRecordsForRange(newMinDate, rangeEnd, false);
    state.minDate = newMinDate;
    if (btn) { btn.disabled = false; btn.textContent = `Load Earlier Records (${ACCT_WINDOW_DAYS} more days)`; }
    renderAccountingTable();
    renderAcctDateChrome();
  }
 
  export function acctRoutesChipsHtml(rec) {
    const trips = rec.source_shift_id ? acctTripsByShiftId[rec.source_shift_id] : null;
    if (!trips || !trips.length) return `<span class="subtext" style="font-size:11px;">—</span>`;
    return trips.map((t, i) => {
      const label = t.route_id || t.trip_id || `Route ${i + 1}`;
      const cls = t.complete ? "trip-segment-done" : "";
      return `<button type="button" class="trip-chip ${cls}" data-open-acct-load="${rec.id}" data-open-acct-trip="${t.id}" title="Open this route's details">${escapeHtml(label)}</button>`;
    }).join(" ");
  }
  // Atlanta's own Routes column — sourced from loads_accounting_routes
  // rather than loads_trips (Delaware's source), since that's where each
  // route's Cost/Revenue Level calc actually lives.
  //
  // Each chip carries the route's IDENTITY, not just its label. route_id is a
  // free-text name and is routinely repeated within one load -- two "FRGT"
  // routes, two "Nestle" routes -- so anything downstream that looked a route
  // up by that text got the first one every time. That is what made the Trip ID
  // column repeat a value across two different routes, and what sent a chip
  // click to the wrong route's details. route_number is unique within the load,
  // and source_trip_id is the real loads_trips row.
  export function acctRouteIdsHtml(rec) {
    const routes = acctRoutesByAccountingId[rec.id];
    if (!routes || !routes.length) return `<span class="subtext" style="font-size:11px;">—</span>`;
    return `<div style="display:flex; flex-direction:column; gap:2px; align-items:flex-start;">
      ${routes.map((r) => {
        const label = r.route_id || r.trip_id || "—";
        const routeNumberAttr = r.route_number != null ? ` data-acct-route-number="${escapeHtml(String(r.route_number))}"` : "";
        const sourceTripAttr = r.source_trip_id != null ? ` data-acct-source-trip="${escapeHtml(String(r.source_trip_id))}"` : "";
        return `<button type="button" class="trip-chip" data-open-acct-load="${rec.id}" data-open-acct-route-text="${escapeHtml(r.route_id || "")}"${routeNumberAttr}${sourceTripAttr} title="Open this route's details">${escapeHtml(label)}</button>`;
      }).join("")}
    </div>`;
  }
  // Per-route Miles / Stops, stacked to line up visually with the Routes
  // column's own stacked chips (same array, same order). Falls back to
  // the old single aggregate number when there's no per-route data on
  // file for this load (older/unrecoverable rows, or a shift with zero
  // real routes).
  export function acctMilesStopsHtml(rec) {
    const routes = acctRoutesByAccountingId[rec.id];
    if (!routes || !routes.length) {
      return {
        miles: escapeHtml(rec.total_miles != null ? String(rec.total_miles) : "—"),
        stops: escapeHtml(rec.total_stops != null ? String(rec.total_stops) : "—"),
      };
    }
    const miles = `<div style="display:flex; flex-direction:column; gap:2px;">${routes.map((r) => `<div>${escapeHtml(r.miles != null ? String(r.miles) : "—")}</div>`).join("")}</div>`;
    const stops = `<div style="display:flex; flex-direction:column; gap:2px;">${routes.map((r) => `<div>${escapeHtml(r.stops != null ? String(r.stops) : "—")}</div>`).join("")}</div>`;
    return { miles, stops };
  }
  export function fmtMoney(n) { return n == null ? "—" : `$${Number(n).toFixed(2)}`; }
  const LOCATIONS_WITH_LEVELS = ["atlanta"]; // only these use Cost/Revenue Level tiers — everyone else has a set rate
  const LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST = ["delaware"]; // flat-rate locations: show Routes, hide Total Cost/Revenue/FSC
  const LOCATIONS_WITHOUT_FSC = ["atlanta"]; // Atlanta keeps Total Cost/Revenue but doesn't need its own FSC column
  export function acctTableHeaderHtml() {
    const loc = state.acctLocationTab || "atlanta";
    const showLevels = LOCATIONS_WITH_LEVELS.includes(loc);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(loc);
    const showFsc = !showRoutesInstead && !LOCATIONS_WITHOUT_FSC.includes(loc);
    return `<tr>
      <th>Date</th>
      <th>Aljex #</th>
      <th aria-sort="${accountingDriverSort === 1 ? "ascending" : accountingDriverSort === -1 ? "descending" : "none"}">${accountingDriverHeaderHtml()}</th>
      <th>MC</th>
      ${showLevels ? `<th>Cost Level</th><th>Revenue Rate</th>` : ""}
      ${showLevels ? `<th>Routes</th>` : ""}
      ${showRoutesInstead ? `<th>Routes</th>` : ""}
      <th>Total Miles</th>
      <th>Total Stops</th>
      <th>Carrier Rate</th>
      ${showRoutesInstead ? "" : `<th>Customer Rate</th>${showFsc ? "<th>FSC Payment</th>" : ""}`}
      <th>Day Type</th>
      <th>Sent</th>
      <th>Released</th>
      <th>Hidden</th>
      <th>Highlight</th>
    </tr>`;
  }
  export function accountingRowHtml(rec) {
    const showLevels = LOCATIONS_WITH_LEVELS.includes(rec.location);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(rec.location);
    const showFsc = !showRoutesInstead && !LOCATIONS_WITHOUT_FSC.includes(rec.location);
    /*
     * Say what each level MEANS. These read "1", "2", "3", "4 (Market)", which
     * is unreadable for the one decision this dropdown exists to make: whether
     * a load bills at Kroger Core or at the higher KR Holiday rate.
     *
     * Level 3 is deliberately absent. pricing_settings describes it as
     * "currently unused, no tiers configured", and picking it used to bill zero
     * linehaul revenue. An option that silently empties a customer rate should
     * not be offered; if it is ever configured, add it back here.
     *
     * Anything not in this list -- an older record still carrying some other
     * value -- is shown as-is and kept selectable, so opening the dropdown can
     * never quietly re-bill a load just by rendering it.
     */
    const REVENUE_LEVELS = [[1, "1 — Kroger Core"], [2, "2 — KR Holiday"]];
    const COST_LEVELS = [[1, "1 — Carrier Core"], [2, "2 — Carrier Core Plus"], [3, "3 — Carrier Holiday"]];
    const levelSelect = (choices, selected) => {
      const known = choices.some(([n]) => n === Number(selected));
      const all = known ? choices : [...choices, [Number(selected), `${selected} (not configured)`]];
      return all.map(([n, label]) => `<option value="${n}"${n === Number(selected) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    };
    const dayTypeOptions = ["weekday", "weekend", "holiday"].map((d) => `<option value="${d}" ${d === (rec.day_type || "weekday") ? "selected" : ""}>${d[0].toUpperCase() + d.slice(1)}</option>`).join("");
    const ms = acctMilesStopsHtml(rec);
    const isDimmed = rec.hidden || rec.status === "released";
    // A cancelled load is struck through across the whole row. It carries
    // no money by design, so the only things worth reading on it are the
    // driver, their details, and why it was cancelled -- the reason rides
    // along in the title so it's one hover away without widening the table.
    const isCancelled = rec.status === "cancelled";
    const styleBits = [];
    if (isDimmed) styleBits.push("opacity:0.5;");
    if (isCancelled) styleBits.push("text-decoration:line-through; color:var(--slate-500);");
    const rowStyle = styleBits.length ? ` style="${styleBits.join(" ")}"` : "";
    const cancelTitle = isCancelled
      ? ` title="Load cancelled — ${escapeHtml(rec.cancelled_reason || "no reason recorded")}"`
      : "";
    return `<tr id="acct-${rec.id}" class="${rec.highlighted ? "acct-highlighted" : ""}"${rowStyle}${cancelTitle}>
      <td>${escapeHtml(rec.shift_date)}</td>
      <td>${rec.aljex_load_number ? `<span class="acct-load-reference"><span class="acct-load-text">${escapeHtml(rec.aljex_load_number)}</span><button type="button" class="cell-link-btn" style="width:auto; padding:2px 6px;" data-open-acct-load="${rec.id}" aria-label="Open load ${escapeHtml(rec.aljex_load_number)}" title="Open load">↗</button></span>` : "—"}</td>
      <td>${escapeHtml(rec.driver_name_text || "—")} ${accountingNoteButton(rec)}${acctPushStickyHtml(rec)}${isCancelled ? `<div class="subtext" style="text-decoration:none; color:var(--slate-500);">Cancelled — ${escapeHtml(rec.cancelled_reason || "no reason recorded")}</div>` : ""}</td>
      <td>${escapeHtml(rec.mc_dot || "—")}</td>
      ${showLevels ? `
      <td><select class="cell-input" data-action="acct-cost-level" data-id="${rec.id}" title="What D&L pays the carrier">${levelSelect(COST_LEVELS, rec.cost_level ?? 1)}</select></td>
      <td><select class="cell-input" data-action="acct-revenue-level" data-id="${rec.id}" ${isCancelled ? "disabled" : ""} title="What Kroger is billed. Core unless this load ran at holiday rates.">${levelSelect(REVENUE_LEVELS, rec.revenue_level ?? 1)}</select></td>` : ""}
      ${showLevels ? `<td>${acctRouteIdsHtml(rec)}</td>` : ""}
      ${showRoutesInstead ? `<td>${acctRoutesChipsHtml(rec)}</td>` : ""}
      <td>${ms.miles}</td>
      <td>${ms.stops}</td>
      <td>
        <div style="display:flex; align-items:center; gap:2px;">
          <span class="subtext">$</span>
          <input class="cell-input" style="width:78px;" data-action="acct-carrier-pay" data-id="${rec.id}" value="${rec.total_carrier_pay != null ? Number(rec.total_carrier_pay).toFixed(2) : ""}">
        </div>
      </td>
      ${showRoutesInstead ? "" : `<td>
        <div style="display:flex; align-items:center; gap:2px;">
          <span class="subtext">$</span>
          <input class="cell-input" style="width:78px;" data-action="acct-customer-rate" data-id="${rec.id}" value="${rec.total_revenue != null ? Number(rec.total_revenue).toFixed(2) : ""}">
        </div>
      </td>${showFsc ? `<td>${fmtMoney(rec.fsc_payment)}</td>` : ""}`}
      <td><select class="cell-input" data-action="acct-day-type" data-id="${rec.id}">${dayTypeOptions}</select></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-sent" data-id="${rec.id}" ${pendingAccountingChecks.has(String(rec.id)) ? "disabled" : ""} ${rec.sent ? "checked" : ""} title="Sent"></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-released" data-id="${rec.id}" ${pendingAccountingChecks.has(String(rec.id)) ? "disabled" : ""} ${rec.status === "released" ? "checked" : ""} title="Released"></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-hidden" data-id="${rec.id}" ${pendingAccountingChecks.has(String(rec.id)) ? "disabled" : ""} ${rec.hidden ? "checked" : ""} title="Hidden"></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-highlighted" data-id="${rec.id}" ${pendingAccountingChecks.has(String(rec.id)) ? "disabled" : ""} ${rec.highlighted ? "checked" : ""} title="Highlight row" aria-label="Highlight row"></td>
    </tr>`;
  }
  export function getFilteredAccountingRecords() {
    const loc = state.acctLocationTab || "atlanta";
    let filtered = accountingRecords.filter((r) => r.location === loc);
    if (state.acctDateFilter) filtered = filtered.filter((r) => r.shift_date === state.acctDateFilter);
    if (!state.acctShowHidden) filtered = filtered.filter((r) => !r.hidden);
    if (accountingDriverSort) filtered.sort((a, b) => compareAccountingDriverNames(a.driver_name_text, b.driver_name_text) || acctSortCompare(a, b));
    return filtered;
  }

  // Count of hidden rows for the current location tab — drives the label
  // on the Show Hidden toggle. Deliberately ignores the day filter (shows
  // the total for the whole tab), so the count doesn't flicker as someone
  // clicks through days.
  function hiddenCountForCurrentTab() {
    const loc = state.acctLocationTab || "atlanta";
    return accountingRecords.filter((r) => r.location === loc && r.hidden).length;
  }

  function updateShowHiddenButton() {
    const btn = $("#btn-show-hidden");
    if (!btn) return;
    const count = hiddenCountForCurrentTab();
    btn.textContent = state.acctShowHidden ? "Hide Hidden Again" : `Show Hidden (${count})`;
  }
  export function renderAccountingTable() {
    const body = $("#accounting-table-body");
    if (!body) return;
    const filtered = getFilteredAccountingRecords();
    const loc = state.acctLocationTab || "atlanta";
    if ($("#accounting-table-head")) $("#accounting-table-head").innerHTML = acctTableHeaderHtml();
    const showLevels = LOCATIONS_WITH_LEVELS.includes(loc);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(loc);
    const showFsc = !showRoutesInstead && !LOCATIONS_WITHOUT_FSC.includes(loc);
    const colspan = (showLevels ? (showFsc ? 14 : 13) : (showRoutesInstead ? 10 : (showFsc ? 11 : 10))) + 2;      body.innerHTML = filtered.length
      ? filtered.map(accountingRowHtml).join("")
      : `<tr><td colspan="${colspan}" class="subtext" style="padding:16px;">No completed loads ${state.acctDateFilter ? "for this day" : ""} here yet — mark a shift complete on the ${loc} board and it'll show up here.</td></tr>`;
    renderDriverStatsTable();
    updateShowHiddenButton();
  }
export function renderDriverStatsTable() {
    const body = $("#accounting-driver-table-body");
    if (!body) return;
    const filtered = getFilteredAccountingRecords();
    const byDriver = {};
    filtered.forEach((r) => {
      const key = r.driver_name_text || "(no driver on file)";
      if (!byDriver[key]) byDriver[key] = { name: key, loads: 0, miles: 0, stops: 0, revenue: 0, carrierPay: 0 };
      const d = byDriver[key];
      d.loads += 1;
      d.miles += Number(r.total_miles) || 0;
      d.stops += Number(r.total_stops) || 0;
      d.revenue += Number(r.total_revenue) || 0;
      d.carrierPay += Number(r.total_carrier_pay) || 0;
    });
    const rows = Object.values(byDriver).sort((a, b) => accountingDriverSort ? compareAccountingDriverNames(a.name, b.name) : b.loads - a.loads);
    const driverHeader = document.querySelector('#accounting-driver-table thead th');
    if (driverHeader) {
      driverHeader.innerHTML = accountingDriverHeaderHtml();
      driverHeader.setAttribute('aria-sort', accountingDriverSort === 1 ? 'ascending' : accountingDriverSort === -1 ? 'descending' : 'none');
    }
    body.innerHTML = rows.length
      ? rows.map((d) => `<tr>
          <td>${escapeHtml(d.name)}</td>
          <td>${d.loads}</td>
          <td>${d.miles.toFixed(0)}</td>
          <td>${d.stops.toFixed(0)}</td>
          <td>${fmtMoney(d.carrierPay)}</td>
          <td>${fmtMoney(d.revenue)}</td>
          <td>${fmtMoney(d.loads ? d.carrierPay / d.loads : 0)}</td>
        </tr>`).join("")
      : `<tr><td colspan="7" class="subtext" style="padding:16px;">No completed loads here yet.</td></tr>`;
  }
  export function switchAcctLocationTab(loc) {
    state.acctLocationTab = loc;
    $all(".location-tab", $("#acct-location-tabs")).forEach((btn) => btn.classList.toggle("is-active", btn.dataset.location === loc));
    renderAccountingTable();
  }
  export function setAcctDateFilter(dKey) {
    state.acctDateFilter = dKey;
    state.activeDate = dKey; // reuses the shared calendar's "selected day" highlighting
    renderAcctDateChrome();
    renderAccountingTable();
  }
  async function changeAccountingRevenueRate(accountingId, level) {
    try {
      const { data, error } = await supabaseClient.rpc("set_accounting_revenue_rate", {
        p_accounting_id: Number(accountingId), p_level: level,
      });
      if (error) throw error;
      if (!data) throw new Error("Revenue rate was not saved.");
      const rec = accountingRecords.find(r => Number(r.id) === Number(accountingId));
      if (rec) Object.assign(rec, data);
    } catch (e) {
      setDriverSyncStatus(`Couldn't change Revenue Rate (${e.message || e}).`, "error");
    }
    renderAccountingTable();
  }

  export async function recalcAccountingRecord(accountingId, patch) {
    accountingId = Number(accountingId);
    const rec = accountingRecords.find((r) => Number(r.id) === accountingId);
    if (!rec) return;
    Object.assign(rec, patch);
      if (!getPricingTiers() || !getPricingSettings()) await loadPricingData();
    const { data: routes, error } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").eq("accounting_id", accountingId);
    if (error) { console.error("Failed to load routes for recalc:", error); return; }
    let totalCost = 0, totalRevenue = 0;
    const routeUpdates = (routes || []).map((r) => {
    const calc = calcRoute({ costLevel: rec.cost_level, revenueLevel: rec.revenue_level, miles: Number(r.miles) || 0, stops: Number(r.stops) || 0, contractRate: rec.contract_rate }, getPricingTiers(), getPricingSettings());      totalCost += calc.totalCost; totalRevenue += calc.totalRevenue;
      return { id: r.id, linehaul_cost: calc.linehaulCost, stop_charge: calc.stopCharge, total_cost: calc.totalCost, revenue: calc.revenue, stop_charge_revenue: calc.stopChargeRevenue, total_revenue: calc.totalRevenue };
    });
    rec.total_cost = Math.round(totalCost * 100) / 100;
    rec.total_revenue = Math.round(totalRevenue * 100) / 100;
    if (rec.location === "delaware" && rec.total_miles > 0) {
      rec.total_cost = Math.round(Math.max(1000, rec.total_miles * 4) * 100) / 100;
    }
    try {
      await supabaseClient.from(ACCOUNTING_TABLE).update({ cost_level: rec.cost_level, revenue_level: rec.revenue_level, total_cost: rec.total_cost, total_revenue: rec.total_revenue }).eq("id", accountingId);
      for (const ru of routeUpdates) {
        await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).update(ru).eq("id", ru.id);
      }
    } catch (e) {
      console.error("recalcAccountingRecord failed:", e);
      setDriverSyncStatus(`Couldn't save the recalculated totals (${e.message || e}).`, "error");
    }
    renderAccountingTable();
  }
  export function renderAcctDateChrome() {
    const input = $("#date-input");
    if (!input) return;
    input.value = state.activeDate || state.todayKey;
    input.min = state.minDate;
    input.max = state.maxDate;
    if ($("#date-next")) $("#date-next").disabled = (state.activeDate || state.todayKey) >= state.maxDate;
    if ($("#date-prev")) $("#date-prev").disabled = (state.activeDate || state.todayKey) <= state.minDate;
  }
  export async function initAccountingPage() {
    console.log("accounting.js build marker: 2026-08-13-d"); // confirms THIS version's code actually ran — check DevTools Console for this exact string
    // Accounting looks back further than the boards do — override the
    // shared min/max just for this page's calendar.
    state.minDate = dateKey(addDays(todayDate(), -60));
    state.maxDate = state.todayKey;
    state.acctLocationTab = "atlanta";
    state.acctDateFilter = state.todayKey;
    state.activeDate = state.todayKey;
    state.acctShowHidden = false;
    await loadPricingData();
    const initialSettings = getPricingSettings();
    if (initialSettings && $("#fsc-rate-input")) $("#fsc-rate-input").value = initialSettings.fsc_rate || "";
    await loadAccountingRecords();
    await loadLocationNotes();
    renderAccountingTable();
    setupAccountingRealtimeSync();
    if ($("#acct-location-tabs")) {
      $("#acct-location-tabs").addEventListener("click", (e) => {
        const btn = e.target.closest(".location-tab");
        if (btn) switchAcctLocationTab(btn.dataset.location);
      });
      switchAcctLocationTab("atlanta");
    }
    if ($("#modal-location-notes")) {
      on("btn-location-info", "click", () => {
        const loc = state.acctLocationTab || "atlanta";
        const label = { atlanta: "Atlanta", buildingc: "Building C", delaware: "Delaware", houston: "Houston" }[loc] || loc;
        // Namespaced so this never collides with the real board pages' own
        // notes (which use the bare location key, e.g. "atlanta") — this
        // page gets its own separate row per location instead.
        openLocationNotesModal(`accounting-${loc}`, `Accounting — ${label}`);
      });
      on("ln-close", "click", closeLocationNotesModal);
      on("ln-cancel", "click", closeLocationNotesModal);
      on("ln-save", "click", saveLocationNotes);
      $("#modal-location-notes").addEventListener("click", (e) => { if (e.target.id === "modal-location-notes") closeLocationNotesModal(); });
    }
    if ($("#acct-view-toggle")) {
      $("#acct-view-toggle").addEventListener("click", (e) => {
        const btn = e.target.closest(".location-tab");
        if (!btn) return;
        $all(".location-tab", $("#acct-view-toggle")).forEach((b) => b.classList.toggle("is-active", b === btn));
        $("#acct-byload-view").classList.toggle("hidden", btn.dataset.view !== "byload");
        $("#acct-bydriver-view").classList.toggle("hidden", btn.dataset.view !== "bydriver");
      });
    }
    on("acct-show-all", "click", () => setAcctDateFilter(null));
    for (const selector of ["#accounting-table", "#accounting-driver-table"]) {
      $(selector)?.addEventListener("click", e => {
        if (!e.target.closest("[data-acct-driver-sort]")) return;
        accountingDriverSort = accountingDriverSort === 1 ? -1 : 1;
        renderAccountingTable();
      });
    }
    if ($("#btn-show-hidden")) {
      $("#btn-show-hidden").addEventListener("click", () => {
        state.acctShowHidden = !state.acctShowHidden;
        renderAccountingTable();
      });
    }
    $("#date-prev").addEventListener("click", () => setAcctDateFilter(dateKey(addDays(keyToDate(state.activeDate || state.todayKey), -1))));
    $("#date-next").addEventListener("click", () => setAcctDateFilter(dateKey(addDays(keyToDate(state.activeDate || state.todayKey), 1))));
    $("#date-input").addEventListener("change", (e) => setAcctDateFilter(e.target.value));
    $("#date-input").addEventListener("click", (e) => { e.preventDefault(); state.datesWithData = new Set(accountingRecords.filter((r) => r.location === state.acctLocationTab).map((r) => r.shift_date)); openDateDropdown(); });
    $("#date-dropdown").addEventListener("click", (e) => {
      const btn = e.target.closest(".cal-cell[data-date]:not(:disabled)");
      if (btn) { setAcctDateFilter(btn.dataset.date); closeDateDropdown(); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#date-dropdown") && !e.target.closest("#date-input")) closeDateDropdown();
    });
    if (!state.activeDate) state.activeDate = state.todayKey;
    renderAcctDateChrome();
    on("btn-save-fsc", "click", async () => {
      const val = Number($("#fsc-rate-input").value);
      if (!val || val <= 0) { setDriverSyncStatus("Enter a valid FSC rate first.", "error"); return; }
      try {
        await supabaseClient.from("pricing_settings").update({ value: val }).eq("key", "fsc_rate");
        const settings = getPricingSettings();
        if (settings) settings.fsc_rate = val;
        setDriverSyncStatus("FSC rate saved — used for every load completed from now on.", "success");
      } catch (e) {
        setDriverSyncStatus(`Couldn't save FSC rate (${e.message || e}).`, "error");
      }
    });
    const table = $("#accounting-table");
    if (table) {
      table.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.action === "acct-cost-level") recalcAccountingRecord(t.dataset.id, { cost_level: Number(t.value) });
        else if (t.dataset.action === "acct-revenue-level") {
          t.disabled = true;
          changeAccountingRevenueRate(t.dataset.id, Number(t.value));
        }
        else if (t.dataset.action === "acct-highlighted") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          void saveAccountingCheckbox(rec, { highlighted: t.checked }, 'Highlight');
        }
        else if (t.dataset.action === "acct-hidden") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          void saveAccountingCheckbox(rec, { hidden: t.checked }, 'Hidden');
        }
        else if (t.dataset.action === "acct-sent") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          void saveAccountingCheckbox(rec, { sent: t.checked }, 'Sent');
        }
        else if (t.dataset.action === "acct-released") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;

          // Un-releasing is purely local bookkeeping — it can't recall
          // anything already handed to Aljex, so it never touches the outbox.
          if (!t.checked) {
            void saveAccountingCheckbox(rec, { status: 'active' }, 'Released');
            return;
          }

          // Releasing is the hand-off: Accounting's numbers become the
          // authoritative payload and go out to Aljex.
          if (pendingAccountingChecks.has(String(rec.id))) return;
          pendingAccountingChecks.add(String(rec.id));
          renderAccountingTable();
          setDriverSyncStatus("Releasing to Aljex…", "");
          releaseToAljex(rec.id)
            .then((result) => {
              const current = getAccountingRecordById(rec.id);
              if (current) { current.status = "released"; current.sent = result.failed === 0; }
              accountingRecords.sort(acctSortCompare);
              renderAccountingTable();
              const refs = result.payload.refs.map((r) => r.value).join(", ") || "no route refs";
              setDriverSyncStatus(
                result.mode === "dry-run"
                  ? `Released. DRY RUN — nothing sent to Aljex. Would have sent order ${result.payload.orderNo}: ${refs}.`
                  : `Released to Aljex — order ${result.payload.orderNo}: ${refs}. ${result.sent} sent, ${result.failed} failed.`,
                result.failed ? "error" : "success",
              );
            })
            .catch((err) => {
              t.checked = false;
              setDriverSyncStatus(`Couldn't release to Aljex: ${err.message || err}`, "error");
            })
            .finally(() => { pendingAccountingChecks.delete(String(rec.id)); renderAccountingTable(); });
        }
        else if (t.dataset.action === "acct-day-type") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          rec.day_type = t.value;
          void saveAccountingMoneyField(rec, { column: "day_type", label: "day type" }, t.value);
        }
      });
      table.addEventListener("input", (e) => {
        const t = e.target;
        const field = ACCOUNTING_MONEY_FIELDS[t.dataset.action];
        if (!field) return;
        const rec = accountingRecords.find((r) => r.id == t.dataset.id);
        if (!rec) return;
        const raw = String(t.value).trim();
        const val = raw === "" ? null : numOrUndefined(raw);
        // Halfway through typing "1,2" there is no number yet. Writing NaN
        // would blank the column; leaving the old value alone until the field
        // parses is the same rule the board's cells follow.
        if (val === undefined) return;
        rec[field.column] = val;
        clearTimeout(t._saveTimer);
        t._saveTimer = setTimeout(() => void saveAccountingMoneyField(rec, field, val), SAVE_DEBOUNCE_MS);
      });
        table.addEventListener("focusout", (e) => {
        const t = e.target;
        if ((t.dataset.action === "acct-carrier-pay" || t.dataset.action === "acct-customer-rate") && t.value !== "") {
          const num = Number(t.value);
          if (!isNaN(num)) t.value = num.toFixed(2);
        }
      });
      table.addEventListener("click", (e) => {
        const sticky = e.target.closest("[data-acct-dismiss-push]");
        if (sticky) { void dismissAccountingPushNote(sticky.dataset.acctDismissPush); return; }
        const noteBtn = e.target.closest('[data-acct-load-notes]');
        if (noteBtn) { void openLoadDetailsFromAccounting(noteBtn.dataset.acctLoadNotes, null, null, 'notes'); return; }
        const openBtn = e.target.closest("[data-open-acct-load]");
        if (!openBtn) return;
        // Prefer the exact loads_trips id the chip carries. Falling back to
        // route_id text opened whichever route happened to be named the same
        // first -- wrong whenever a load has two routes sharing a name.
        const exactTripDbId = openBtn.dataset.openAcctTrip || openBtn.dataset.acctSourceTrip || null;
        const openArgs = [openBtn.dataset.openAcctLoad, exactTripDbId, openBtn.dataset.openAcctRouteText || null];
        const rec = accountingRecords.find((r) => r.id == openBtn.dataset.openAcctLoad);
        const shiftIncomplete = rec && rec.source_shift_id && acctShiftCompleteById[rec.source_shift_id] === false;
        if (shiftIncomplete) {
          showDriverAssignmentWarning(
            "Shift Not Marked Complete",
            ["This load reached Accounting automatically, but the shift itself hasn't been marked complete on the board yet.",
             "Make sure the driver has actually finished the shift before proceeding."],
            () => openLoadDetailsFromAccounting(...openArgs)
          );
        } else {
          openLoadDetailsFromAccounting(...openArgs);
        }
      });
    }
    if ($("#modal-load-details")) {
      on("ld-close", "click", closeLoadDetailsModal);
      on("ld-close-btn", "click", closeLoadDetailsModal);
      $("#modal-load-details").addEventListener("click", (e) => { if (e.target.id === "modal-load-details") closeLoadDetailsModal(); });
      $("#ld-tabs").addEventListener("click", (e) => {
        const tabBtn = e.target.closest(".ld-tab");
        if (tabBtn && loadDetailsState) { loadDetailsState.activeTab = tabBtn.dataset.tab; loadDetailsState.editMode = null; renderLoadDetailsTabs(); }
      });
      $("#ld-tab-content").addEventListener("change", (e) => {
        if (e.target.id === "ld-file-input" && e.target.files.length) uploadTripSheetImages(Array.from(e.target.files));
        if (e.target.id === "ld-rate-total") commitRateOverride(e.target.value);
        if (e.target.id === "ld-route-type-select" && loadDetailsState) changeRouteType(loadDetailsState.rowId, e.target.value);
        if (e.target.id === "ld-hostler-hours" && loadDetailsState) setHostlerHours(loadDetailsState.rowId, e.target.value);
        if (e.target.dataset.rateTierId != null && e.target.dataset.rateTierId !== "") commitRateBoxOverride("tier", Number(e.target.dataset.rateTierId), e.target.value);
        if (e.target.dataset.rateSettingKey) commitRateBoxOverride("setting", e.target.dataset.rateSettingKey, e.target.value);
      });
      $("#ld-tab-content").addEventListener("click", (e) => {
        if (e.target.id === 'ld-note-submit') {
          void submitLoadNote().then(async () => {
            await refreshAccountingLoadNotes(accountingRecords.map(r => r.source_shift_id));
            renderAccountingTable();
          });
          return;
        }
        const rmBtn = e.target.closest("[data-remove-attachment]");
        if (rmBtn) removeTripSheetImage(rmBtn.dataset.removeAttachment);
        const editBtn = e.target.closest("[data-ld-edit]");
        if (editBtn) startLoadDetailsEdit(editBtn.dataset.ldEdit);
        const cancelBtn = e.target.closest("[data-ld-cancel]");
        if (cancelBtn) cancelLoadDetailsEdit();
        const saveBtn = e.target.closest("[data-ld-save]");
        if (saveBtn) saveLoadDetailsEdit(saveBtn.dataset.ldSave);
        if (e.target.id === "ld-rate-reset") resetRateToCalculated();
        const profileBtn = e.target.closest('[data-action="edit-driver"]');
        if (profileBtn) openEditDriverModal(profileBtn.dataset.driverId);
      });
      $("#ld-tab-content").addEventListener("input", (e) => {
        if (e.target.id === "ld-tr-stopCount" && loadDetailsState && loadDetailsState.editDraft) {
          loadDetailsState.editDraft.stopCount = e.target.value;
          const container = $("#ld-stop-fields");
          if (container) container.innerHTML = stopFieldsHtml(Math.max(0, parseInt(e.target.value, 10) || 0), loadDetailsState.editDraft.stops);
        }
      });
    }
  }
  export function setupAccountingRealtimeSync() {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel("accounting");
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_accounting" }, async (payload) => {
      if (payload.eventType === "DELETE") return;
      if (payload.new.source_shift_id) await refreshAccountingLoadNotes([payload.new.source_shift_id]);
      const idx = accountingRecords.findIndex((r) => r.id === payload.new.id);
      if (idx !== -1) accountingRecords[idx] = payload.new; else accountingRecords.push(payload.new);
      accountingRecords.sort(acctSortCompare);
      // A record that just arrived via realtime was never part of the
      // original bulk fetch in loadAccountingRecordsForRange — its routes
      // and shift-complete status need to be pulled in separately, or the
      // Routes column renders "—" for it forever even though the routes
      // genuinely exist (this is exactly why the Accounting page's Routes
      // column could disagree with what the Load Details modal shows for
      // the same load — the modal always fetches fresh, this cache didn't).
      if (!acctRoutesByAccountingId[payload.new.id]) {
        const { data: routes } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").eq("accounting_id", payload.new.id);
        if (routes && routes.length) {
          acctRoutesByAccountingId[payload.new.id] = routes.sort((a, b) => (a.route_number || 0) - (b.route_number || 0));
        }
      }
      if (payload.new.source_shift_id && acctShiftCompleteById[payload.new.source_shift_id] === undefined) {
        const { data: shiftRows } = await supabaseClient.from(SHIFTS_TABLE).select("shift_complete").eq("id", payload.new.source_shift_id);
        if (shiftRows && shiftRows[0]) acctShiftCompleteById[payload.new.source_shift_id] = !!shiftRows[0].shift_complete;
      }
      renderAccountingTable();
    });
    // Route rows change without the parent accounting row changing: editing a
    // route's miles or stops on the board fires trg_sync_accounting_after_trip_change,
    // which rewrites loads_accounting_routes only. Without this the Routes
    // column, the per-route miles/stops breakdown and anything recalculated
    // from them kept showing the figures fetched when the page loaded.
    channel.on("postgres_changes", { event: "*", schema: "public", table: ACCOUNTING_ROUTES_TABLE }, async (payload) => {
      const accountingId = payload.new?.accounting_id ?? payload.old?.accounting_id;
      if (accountingId == null) return;
      // Re-read the whole set for that load rather than patching one row: a
      // delete has to remove it, and route_number ordering has to hold.
      const { data: routes } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").eq("accounting_id", accountingId);
      if (routes) acctRoutesByAccountingId[accountingId] = routes.sort((a, b) => (a.route_number || 0) - (b.route_number || 0));
      else delete acctRoutesByAccountingId[accountingId];
      renderAccountingTable();
    });
    channel.on("postgres_changes", { event: "*", schema: "public", table: "load_notes" }, async (payload) => {
      const ids = [payload.new?.shift_id, payload.old?.shift_id].filter(Boolean);
      await refreshAccountingLoadNotes(ids.length ? ids : accountingRecords.map(r => r.source_shift_id));
      renderAccountingTable();
    });
    channel.subscribe();
  }
