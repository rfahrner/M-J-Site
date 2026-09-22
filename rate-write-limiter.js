/*
 * A circuit breaker for automatic carrier_rate writes.
 *
 * The board recalculates a load's rate and saves it whenever the inputs look
 * like they changed. Two clients that disagree about the answer therefore
 * write alternately, forever: each one's save echoes over realtime, the other
 * recalculates, disagrees, and writes back. On 2026-09-22 two loads did that
 * roughly twice a second for an hour -- 9,443 rows of carrier_rate churn in
 * load_change_history across 22 shifts -- and the dispatcher saw the Rate cell
 * flicker between two numbers.
 *
 * The specific disagreement that caused it is fixed (see isBoardRateDataReady
 * in boardrates.js), but any future one would do the same, and a fight between
 * two browsers is not something either browser can win. So: after a load's
 * automatic rate has been rewritten more times than any genuine sequence of
 * edits would explain, this client stops writing that load's rate and says so
 * once. The dispatcher can still type a rate by hand -- a manual rate does not
 * come through here.
 *
 * Deliberately a leaf module: it is imported by loadboard.js and by the rate
 * decorators that load after it, so it must not import any of them.
 */

// Enough for a dispatcher revising a load repeatedly; far below a fight.
const LIMIT = 12;
const WINDOW_MS = 60 * 1000;

const writes = new Map(); // key -> { count, windowStartedAt, stopped }

/*
 * A blanket stop, used when this whole tab has no business making calculated
 * writes any more -- currently only when site-version-watch.js finds the site
 * has been redeployed under it. An old tab left running overnight is the one
 * that starts these fights, and it is the one nobody is sitting at to refresh.
 *
 * Only automatic writes are blocked. A rate the dispatcher types goes straight
 * to the database as it always did; losing someone's typing because a deploy
 * landed mid-shift would be a worse bug than the one this prevents.
 */
let blockedReason = null;

export function setAutomaticWritesBlocked(blocked, reason) {
  blockedReason = blocked ? (reason || 'this tab is out of date') : null;
  if (blockedReason) {
    console.warn(`[rate-write-limiter] Calculated rate writes are off: ${blockedReason}.`);
  }
}

export function automaticWritesBlocked() { return blockedReason; }

function bucket(key) {
  const now = Date.now();
  const seen = writes.get(key);
  if (!seen || now - seen.windowStartedAt > WINDOW_MS) {
    const fresh = { count: 0, windowStartedAt: now, stopped: false };
    writes.set(key, fresh);
    return fresh;
  }
  return seen;
}

/*
 * Call immediately before persisting an automatically calculated rate.
 * Returns false when this client has given up on the load, in which case the
 * caller must not write.
 */
export function allowRateWrite(key, describe) {
  if (blockedReason) return false;
  if (key == null) return true;
  const id = String(key);
  const seen = bucket(id);
  if (seen.stopped) return false;
  seen.count += 1;
  if (seen.count <= LIMIT) return true;
  seen.stopped = true;
  console.warn(
    `[rate-write-limiter] ${describe || `load ${id}`} has had its calculated rate rewritten ` +
    `${seen.count} times in under a minute. Something else is writing a different number, so this ` +
    `tab has stopped saving it. Reload to try again, and check that every open board is on the ` +
    `same version of the site.`,
  );
  return false;
}

// A rate the dispatcher typed, or any other deliberate reset, clears the
// count: the load is being worked on, not fought over.
export function forgetRateWrites(key) {
  if (key != null) writes.delete(String(key));
}

// Test seam.
export function rateWriteState(key) {
  return writes.get(String(key)) || null;
}
