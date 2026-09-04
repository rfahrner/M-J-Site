/* ================================================================
   Aljex outbound payload builder — pure functions only.

   No network, no DOM, no Supabase. Everything here is a plain
   transform from our row shapes to the canonical object we intend to
   hand Aljex, so the mapping can be unit-tested and eyeballed in a
   dry run long before any API credentials exist.

   Cardinality, decided against the real data:
   - One Aljex order per SHIFT, keyed by the Aljex/PRO number.
   - A shift averages 2.62 routes (max 7). Aljex's Ref# field holds a
     LIST of reference entries, so each route on that shift gets its
     own ref slot on that one order — routes are never concatenated
     into a single string and never split into separate orders.

   Authority:
   - "dispatch" payloads come off the board as a dispatcher types.
   - "accounting" payloads come from the Accounting page and win on
     every overlapping field. Accounting has the final say, so a
     release payload is the authoritative snapshot of the load.
   ================================================================ */

export const ALJEX_PAYLOAD_VERSION = 1;

/* ---------------- identity ---------------- */

// pro_number and aljex_load_number hold the same Aljex order number;
// the duplication is historical. aljex_load_number is the explicitly
// named column so it wins when both are set, but it's only ~11%
// populated, which is why pro_number is the fallback rather than the
// other way round.
export function resolveAljexOrderNo(row) {
  if (!row) return null;
  const explicit = String(row.aljex_load_number ?? "").trim();
  if (explicit) return explicit;
  const pro = String(row.pro_number ?? "").trim();
  return pro || null;
}

/* ---------------- small helpers ---------------- */

function text(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function quantity(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- ref# list ---------------- */

// One ref slot per route on the shift, in trip order. Blank route IDs
// are dropped rather than sent as empty refs, and a route ID repeated
// across two trips only occupies one slot — Aljex would otherwise show
// the same reference twice on the order.
export function buildRefList(trips) {
  const seen = new Set();
  const refs = [];
  [...(trips || [])]
    .sort((a, b) => (a.trip_number ?? 0) - (b.trip_number ?? 0))
    .forEach((trip) => {
      const value = text(trip.route_id);
      if (!value) return;
      const key = value.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({
        slot: refs.length + 1,
        type: "route",
        value,
        tripNumber: trip.trip_number ?? null,
        tripId: text(trip.trip_id),
        trailer: text(trip.trailer_out),
      });
    });
  return refs;
}

/* ---------------- payload ---------------- */

/**
 * @param {object}   args
 * @param {object}   args.shift       loads_shifts row
 * @param {object[]} args.trips       loads_trips rows for that shift
 * @param {object}  [args.accounting] loads_accounting row, when one exists
 * @param {"dispatch"|"accounting"} [args.authority]
 */
export function buildOrderPayload({ shift, trips, accounting = null, authority = "dispatch" }) {
  if (!shift) throw new Error("buildOrderPayload: shift is required");

  const orderNo = resolveAljexOrderNo(accounting) || resolveAljexOrderNo(shift);
  const refs = buildRefList(trips);

  // Accounting's numbers override the board's wherever both exist.
  const rates = {
    customerRate:    money(shift.customer_rate),
    carrierRate:     money(shift.carrier_rate),
    contractRate:    money(accounting?.contract_rate),
    totalCarrierPay: money(accounting?.total_carrier_pay),
    fscRate:         money(accounting?.fsc_rate_snapshot),
    fscPayment:      money(accounting?.fsc_payment),
    totalCost:       money(accounting?.total_cost),
    totalRevenue:    money(accounting?.total_revenue),
  };
  if (authority === "accounting") {
    if (rates.contractRate !== null) rates.customerRate = rates.contractRate;
    if (rates.totalCarrierPay !== null) rates.carrierRate = rates.totalCarrierPay;
  }

  return {
    version: ALJEX_PAYLOAD_VERSION,
    authority,
    orderNo,
    location: text(shift.location),
    shiftDate: text(shift.shift_date),
    refs,
    rates,
    driver: {
      name: text(accounting?.driver_name_text) || text(shift.driver_name_text),
      mc:   text(accounting?.mc_dot) || text(shift.mc_snapshot),
      cell: text(accounting?.driver_cell) || text(shift.driver_cell_snapshot),
      email: text(accounting?.carrier_email) || text(shift.email_snapshot),
    },
    totals: {
      miles: quantity(accounting?.total_miles),
      stops: quantity(accounting?.total_stops),
    },
    flags: {
      tonu: !!shift.tonu,
      calledOff: !!shift.called_off,
      shiftComplete: !!shift.shift_complete,
      released: accounting?.status === "released",
    },
    source: {
      shiftId: shift.id ?? null,
      accountingId: accounting?.id ?? null,
    },
  };
}

/* ---------------- change detection ---------------- */

// Stable stringify: key order must not affect the hash, or every
// payload looks "changed" and we spam Aljex with identical writes.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// FNV-1a. Deliberately synchronous — crypto.subtle.digest is async and
// this runs inside keystroke handlers on the board, where an await per
// character would reorder writes under fast typing.
export function payloadHash(payload) {
  const str = stableStringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// A payload with no order number can't be matched to anything in
// Aljex, and one with no refs and no rates has nothing to say.
export function isSendable(payload) {
  if (!payload || !payload.orderNo) return false;
  if (payload.refs.length) return true;
  return Object.values(payload.rates).some((v) => v !== null);
}

export function describePayload(payload) {
  if (!payload) return "(empty payload)";
  const refs = payload.refs.map((r) => r.value).join(", ") || "no refs";
  const rate = payload.rates.carrierRate ?? payload.rates.customerRate;
  return `Aljex ${payload.orderNo || "(no order #)"} — ${refs}${rate !== null && rate !== undefined ? ` @ $${rate}` : ""}`;
}
