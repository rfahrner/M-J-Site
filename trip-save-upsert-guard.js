/*
 * Trip save idempotency guard.
 *
 * The load board keeps a local trip.dbId, but realtime/modal redraws can
 * occasionally leave that local id blank even though the trip row already
 * exists in Supabase. loadboard.js then takes its INSERT path and PostgreSQL
 * correctly rejects the duplicate (shift_id, trip_number).
 *
 * A trip number is already the canonical slot within a shift, so an attempted
 * insert into that occupied slot should update the existing trip rather than
 * fail. Patch only loads_trips INSERT calls into an UPSERT on the table's
 * existing unique key. All other tables and all explicit UPDATE calls are
 * untouched.
 */
import { supabaseClient, TRIPS_TABLE } from './loadboard.js';

const PATCH_FLAG = Symbol.for('mj.loadsTripsInsertUpsertGuard');

function install() {
  if (!supabaseClient || supabaseClient[PATCH_FLAG]) return;

  const originalFrom = supabaseClient.from.bind(supabaseClient);
  supabaseClient.from = function patchedFrom(relation) {
    const builder = originalFrom(relation);
    if (relation !== TRIPS_TABLE || !builder || typeof builder.insert !== 'function' || typeof builder.upsert !== 'function') {
      return builder;
    }

    // Each call to from() returns a fresh query builder, so patch this builder's
    // insert only. The returned upsert builder preserves normal chaining such
    // as .select() and .limit().
    builder.insert = function idempotentTripInsert(values, options) {
      const upsertOptions = {
        ...(options || {}),
        onConflict: 'shift_id,trip_number',
        ignoreDuplicates: false,
      };
      return builder.upsert(values, upsertOptions);
    };
    return builder;
  };

  Object.defineProperty(supabaseClient, PATCH_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

install();
