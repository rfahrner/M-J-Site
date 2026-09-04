/* ================================================================
   Aljex transport adapter.

   This is the ONLY file that needs to change when Aljex API access is
   granted. Everything upstream (payload building, the outbox, the
   Accounting release gate) talks to this one interface:

       client.sendOrderUpdate(payload) -> { ok, detail, raw }

   Modes:
   - "dry-run"  (default) — validates and logs, sends nothing. Lets the
                  whole pipeline be exercised and watched today.
   - "csv"      — accumulates rows for a batch file, for the flat-file
                  import path if that lands before API access does.
   - "api"      — the real call. Deliberately throws a specific,
                  actionable error until it's configured, rather than
                  guessing at an endpoint shape.

   NOTE ON route.php: https://dandl.aljex.com/route.php is the Aljex
   agent web UI, not an API. Driving it by scripted form posts would
   break on any vendor UI change and would ride on a human's session
   cookie. It is not implemented here on purpose.
   ================================================================ */

import { describePayload, isSendable } from './aljex-payload.js';

export const ALJEX_MODES = ["dry-run", "csv", "api"];

// Flipped from the Archive/admin settings once credentials exist. Kept
// in localStorage rather than hardcoded so IT can switch a single
// browser to "api" for a controlled first live test without a deploy.
const MODE_STORAGE_KEY = "dl-aljex-mode";

export function getAljexMode() {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved && ALJEX_MODES.includes(saved)) return saved;
  } catch (e) { /* private window / storage blocked — fall through */ }
  return "dry-run";
}

export function setAljexMode(mode) {
  if (!ALJEX_MODES.includes(mode)) throw new Error(`Unknown Aljex mode: ${mode}`);
  try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch (e) { /* ignore quota errors */ }
}

/* ---------------- dry run ---------------- */

const dryRunLog = [];

export function getDryRunLog() { return [...dryRunLog]; }
export function clearDryRunLog() { dryRunLog.length = 0; }

function sendDryRun(payload) {
  const entry = { at: new Date().toISOString(), summary: describePayload(payload), payload };
  dryRunLog.push(entry);
  if (dryRunLog.length > 500) dryRunLog.shift();
  console.info("[Aljex dry-run] would send:", entry.summary, payload);
  return { ok: true, detail: `Dry run — not sent. ${entry.summary}`, raw: null };
}

/* ---------------- csv batch ---------------- */

// One line per ref slot, because that is how every flat-file TMS
// import we'd plausibly be handed expects repeating references: the
// order number repeats and the ref column varies.
export function payloadToCsvRows(payload) {
  const base = {
    order_no: payload.orderNo || "",
    location: payload.location || "",
    shift_date: payload.shiftDate || "",
    driver_name: payload.driver.name || "",
    mc_dot: payload.driver.mc || "",
    customer_rate: payload.rates.customerRate ?? "",
    carrier_rate: payload.rates.carrierRate ?? "",
    total_miles: payload.totals.miles ?? "",
    total_stops: payload.totals.stops ?? "",
    authority: payload.authority,
  };
  if (!payload.refs.length) return [{ ...base, ref_slot: "", ref_value: "" }];
  return payload.refs.map((r) => ({ ...base, ref_slot: r.slot, ref_value: r.value }));
}

const csvBatch = [];

export function getCsvBatch() { return [...csvBatch]; }
export function clearCsvBatch() { csvBatch.length = 0; }

export function csvBatchToText() {
  if (!csvBatch.length) return "";
  const headers = Object.keys(csvBatch[0]);
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...csvBatch.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\r\n");
}

function sendCsv(payload) {
  const rows = payloadToCsvRows(payload);
  csvBatch.push(...rows);
  return { ok: true, detail: `Queued ${rows.length} CSV row(s) for batch import.`, raw: rows };
}

/* ---------------- real API ---------------- */

// Everything this needs from Descartes/Aljex before it can be written.
// Surfaced as a thrown error rather than a silent no-op so a premature
// switch to "api" fails loudly instead of dropping loads on the floor.
export const ALJEX_API_REQUIREMENTS = [
  "Base URL for the Aljex/Descartes REST endpoint (route.php is the agent UI, not an API)",
  "Auth method and credentials (API key, OAuth client, or a service account)",
  "The order-update operation: how to look up an existing order by our Aljex/PRO number",
  "The Ref# field's exact representation — repeating reference rows, their type codes and slot limit",
  "Which rate fields on the Aljex order map to our carrier rate vs customer rate",
  "Rate limits, and whether updates are idempotent on repeat",
];

function sendApi() {
  throw new Error(
    "Aljex API mode is not configured yet. Still needed:\n  - " +
    ALJEX_API_REQUIREMENTS.join("\n  - ")
  );
}

/* ---------------- factory ---------------- */

export function createAljexClient({ mode = getAljexMode() } = {}) {
  if (!ALJEX_MODES.includes(mode)) throw new Error(`Unknown Aljex mode: ${mode}`);
  return {
    mode,
    isDryRun: mode === "dry-run",
    async sendOrderUpdate(payload) {
      if (!isSendable(payload)) {
        return { ok: false, detail: "Nothing to send: payload has no Aljex order number, refs, or rates.", raw: null };
      }
      if (mode === "dry-run") return sendDryRun(payload);
      if (mode === "csv") return sendCsv(payload);
      return sendApi(payload);
    },
  };
}
