/* ================================================================
   Aljex outbox — queue, dedupe, and drain.

   Nothing on the board or in Accounting calls Aljex directly. Every
   change is written to public.aljex_outbox first, then a drain pass
   hands pending rows to the transport adapter. That indirection buys
   three things that matter here:

   1. Typing a route ID fires a change per keystroke. Debouncing plus
      a payload hash means "PA3090" queues one row, not six.
   2. If Aljex is down (or, right now, simply not connected yet), the
      work is durable and replayable instead of lost.
   3. Every attempt is auditable — who queued it, what exactly we
      intended to send, and what came back.

   A newer pending row for the same Aljex order supersedes older ones,
   so a load that gets corrected three times before the drain runs
   sends its final state once rather than replaying stale intermediates.
   ================================================================ */

import { supabaseClient, currentUserName } from './loadboard.js';
import { buildOrderPayload, payloadHash, isSendable, describePayload, resolveAljexOrderNo } from './aljex-payload.js';
import { createAljexClient, getAljexMode } from './aljex-client.js';

export const OUTBOX_TABLE = "aljex_outbox";
const SHIFTS_TABLE = "loads_shifts";
const TRIPS_TABLE = "loads_trips";
const ACCOUNTING_TABLE = "loads_accounting";

const DEBOUNCE_MS = 1500; // a beat longer than a fast typist's gap between characters

/* ---------------- assembling one load ---------------- */

async function fetchLoadContext(shiftId) {
  const [{ data: shift, error: sErr }, { data: trips, error: tErr }, { data: acct, error: aErr }] = await Promise.all([
    supabaseClient.from(SHIFTS_TABLE).select("*").eq("id", shiftId).maybeSingle(),
    supabaseClient.from(TRIPS_TABLE).select("*").eq("shift_id", shiftId),
    supabaseClient.from(ACCOUNTING_TABLE).select("*").eq("source_shift_id", shiftId).maybeSingle(),
  ]);
  if (sErr) throw new Error(`loads_shifts: ${sErr.message}`);
  if (tErr) throw new Error(`loads_trips: ${tErr.message}`);
  // A load that hasn't reached Accounting yet is normal, not an error.
  if (aErr && aErr.code !== "PGRST116") throw new Error(`loads_accounting: ${aErr.message}`);
  if (!shift) throw new Error(`No shift ${shiftId}`);
  return { shift, trips: trips || [], accounting: acct || null };
}

/* ---------------- queueing ---------------- */

// Returns { queued: boolean, reason?, payload, hash }.
export async function enqueueLoadUpdate(shiftId, { kind = "live_update", authority = "dispatch" } = {}) {
  if (!supabaseClient) return { queued: false, reason: "no Supabase client" };

  const { shift, trips, accounting } = await fetchLoadContext(shiftId);
  const payload = buildOrderPayload({ shift, trips, accounting, authority });
  const hash = payloadHash(payload);

  if (!isSendable(payload)) {
    // Most often this is a load with no Aljex/PRO number yet — expected
    // early in a shift, so it's a skip rather than a failure.
    return { queued: false, reason: payload.orderNo ? "nothing to send yet" : "no Aljex/PRO number on this load", payload, hash };
  }

  // Already queued or already delivered in this exact shape — don't
  // write Aljex the same values twice.
  const { data: recent, error: rErr } = await supabaseClient
    .from(OUTBOX_TABLE)
    .select("id, status, payload_hash")
    .eq("aljex_order_no", payload.orderNo)
    .in("status", ["pending", "sent"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (rErr) throw new Error(`${OUTBOX_TABLE}: ${rErr.message}`);
  if (recent && recent[0] && recent[0].payload_hash === hash && kind !== "release") {
    return { queued: false, reason: "unchanged since last queued/sent", payload, hash };
  }

  // A release is authoritative; supersede anything still pending for
  // this order so the board's in-flight guesses can't land after it.
  const { error: supErr } = await supabaseClient
    .from(OUTBOX_TABLE)
    .update({ status: "superseded" })
    .eq("aljex_order_no", payload.orderNo)
    .eq("status", "pending");
  if (supErr) console.error("Couldn't supersede pending Aljex rows:", supErr);

  const { data: inserted, error: iErr } = await supabaseClient.from(OUTBOX_TABLE).insert({
    kind,
    source_table: kind === "release" ? ACCOUNTING_TABLE : SHIFTS_TABLE,
    shift_id: shift.id,
    accounting_id: accounting?.id ?? null,
    location: shift.location,
    aljex_order_no: payload.orderNo,
    payload,
    payload_hash: hash,
    dry_run: getAljexMode() === "dry-run",
    created_by_label: currentUserName(),
  }).select("id").maybeSingle();
  if (iErr) throw new Error(`${OUTBOX_TABLE}: ${iErr.message}`);

  return { queued: true, id: inserted?.id ?? null, payload, hash };
}

/* ---------------- debounced board hook ---------------- */

const pendingTimers = new Map();

// Called from board field handlers. Safe to call on every keystroke.
export function queueLoadUpdateDebounced(shiftId, opts = {}) {
  if (!shiftId) return;
  const key = String(shiftId);
  if (pendingTimers.has(key)) clearTimeout(pendingTimers.get(key));
  pendingTimers.set(key, setTimeout(() => {
    pendingTimers.delete(key);
    enqueueLoadUpdate(shiftId, opts)
      .then((r) => { if (r.queued) console.info("[Aljex] queued:", describePayload(r.payload)); })
      .catch((e) => console.error("[Aljex] queue failed:", e));
  }, DEBOUNCE_MS));
}

// Flush before navigating away so an in-flight debounce isn't lost.
export function flushQueuedUpdates() {
  const ids = [...pendingTimers.keys()];
  pendingTimers.forEach((t) => clearTimeout(t));
  pendingTimers.clear();
  return Promise.all(ids.map((id) => enqueueLoadUpdate(id).catch((e) => console.error("[Aljex] flush failed:", e))));
}

/* ---------------- draining ---------------- */

export async function drainOutbox({ limit = 25 } = {}) {
  if (!supabaseClient) return { sent: 0, failed: 0, results: [] };

  const client = createAljexClient();
  const { data: rows, error } = await supabaseClient
    .from(OUTBOX_TABLE)
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`${OUTBOX_TABLE}: ${error.message}`);

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const row of rows || []) {
    let outcome;
    try {
      outcome = await client.sendOrderUpdate(row.payload);
    } catch (e) {
      outcome = { ok: false, detail: e.message || String(e) };
    }

    const patch = outcome.ok
      ? { status: "sent", sent_at: new Date().toISOString(), attempts: row.attempts + 1, last_error: null }
      : { status: "failed", attempts: row.attempts + 1, last_error: outcome.detail };

    const { error: uErr } = await supabaseClient.from(OUTBOX_TABLE).update(patch).eq("id", row.id);
    if (uErr) console.error("Couldn't update Aljex outbox row:", uErr);

    // Mirror the result onto the load so the board and Accounting can
    // show sync state without joining the outbox on every render.
    const syncPatch = {
      aljex_last_sync_at: new Date().toISOString(),
      aljex_sync_state: outcome.ok ? (client.isDryRun ? "dry-run" : "sent") : "failed",
    };
    if (row.shift_id) {
      await supabaseClient.from(SHIFTS_TABLE).update(syncPatch).eq("id", row.shift_id)
        .then(({ error: e }) => { if (e) console.error("shift sync-state update failed:", e); });
    }
    if (row.accounting_id) {
      await supabaseClient.from(ACCOUNTING_TABLE).update(syncPatch).eq("id", row.accounting_id)
        .then(({ error: e }) => { if (e) console.error("accounting sync-state update failed:", e); });
    }

    outcome.ok ? sent++ : failed++;
    results.push({ id: row.id, orderNo: row.aljex_order_no, ...outcome });
  }

  return { sent, failed, mode: client.mode, results };
}

/* ---------------- accounting release ---------------- */

// The final say. Accounting has already edited whatever it needed to;
// this stamps who released it, queues the authoritative payload, and
// drains immediately so the operator sees the result in context.
export async function releaseToAljex(accountingId) {
  if (!supabaseClient) throw new Error("No Supabase client");

  const { data: acct, error } = await supabaseClient
    .from(ACCOUNTING_TABLE).select("*").eq("id", accountingId).maybeSingle();
  if (error) throw new Error(`${ACCOUNTING_TABLE}: ${error.message}`);
  if (!acct) throw new Error(`No accounting record ${accountingId}`);
  if (!acct.source_shift_id) throw new Error("This accounting row isn't linked to a board shift, so there's nothing to assemble.");
  if (!resolveAljexOrderNo(acct)) throw new Error("No Aljex/PRO number on this load — set one before releasing.");

  const queued = await enqueueLoadUpdate(acct.source_shift_id, { kind: "release", authority: "accounting" });
  if (!queued.queued) throw new Error(`Not released: ${queued.reason}`);

  const drained = await drainOutbox({ limit: 5 });

  const { error: uErr } = await supabaseClient.from(ACCOUNTING_TABLE).update({
    status: "released",
    sent: drained.failed === 0,
    aljex_released_at: new Date().toISOString(),
    aljex_released_by: currentUserName(),
  }).eq("id", accountingId);
  if (uErr) throw new Error(`Couldn't stamp release: ${uErr.message}`);

  return { ...drained, payload: queued.payload };
}
