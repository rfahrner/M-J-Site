# Historical Import Contract

This document is the required workflow for importing historical operational data into the M-J Site Supabase project.

## Goal

Import historical data into the same operational schema used by the live site, preserve a uniform permanent analytics history, export full historical detail to the local archive, verify the archive, and only then remove old operational detail from Supabase.

The required order is:

1. Create an import batch.
2. Load data into live operational tables with the batch ID attached.
3. Validate counts, dates, locations, relationships, and duplicates.
4. Stage lightweight permanent analytics facts.
5. Export full detail with the Archive page.
6. Verify the local archive and its manifests.
7. Purge only the exact verified batch/record IDs.

Never purge by a broad date condition alone.

## Safety rules

- Do not delete any source row until its full archive has been exported and verified.
- Do not expose a Supabase service-role/secret key in browser code or committed repository files.
- Do not manually provide values for identity `id` columns unless a specific migration/import plan explicitly requires `OVERRIDING SYSTEM VALUE` and collision checks first.
- Every imported operational row must carry the same `import_batch_id` for the import run it belongs to.
- A failed or partial import must remain identifiable by `import_batch_id` so it can be inspected or rolled back deliberately.
- Do not reuse an import batch ID for a different source file/run.
- Run validation before analytics staging and again before purge.

## Source tables

### Kroger — Atlanta / Building C / Delaware

Primary load table:

- `public.loads_shifts`

Related detail:

- `public.loads_trips`
- `public.trip_stops`
- `public.load_notes`
- `public.load_change_history`
- `public.load_attachments`
- `public.loads_accounting`
- `public.loads_accounting_routes`

Use location keys exactly:

- `atlanta`
- `buildingc`
- `delaware`

### Kroger — Houston

Primary table:

- `public.loads_houston`

Accounting may be linked through:

- `public.loads_accounting.source_houston_id`

Houston is intentionally a flat load table and should not be forced into the `loads_shifts` + `loads_trips` shape during import.

### Mondelez

Primary table:

- `public.mondelez_loads`

Known location keys:

- `westchester`
- `morris`
- `addison`
- `indianapolis`
- `louisville`
- `spokane`
- `lasvegas`
- `boise`
- `kent`
- `saltlakecity`
- `newberlin`

Do not invent a new location spelling when an existing canonical key applies.

## Import batch tracking

Batch metadata is stored privately in:

- `archive_ops.import_batches`

Operational tables with batch tracking:

- `loads_shifts.import_batch_id`
- `loads_houston.import_batch_id`
- `mondelez_loads.import_batch_id`
- `loads_accounting.import_batch_id`

Create one batch before loading rows and record expected row counts per source/location in `expected_counts`.

Suggested status progression:

`planned -> loading -> loaded -> validated -> analytics_staged -> archive_verified -> purged`

Use `failed` if the run cannot be completed cleanly.

## Identity IDs

The primary IDs on the main operational tables are `GENERATED ALWAYS AS IDENTITY`.

For normal historical imports:

- omit the `id` column,
- let Postgres generate IDs,
- capture generated IDs when constructing child relationships.

Do not assume IDs from a spreadsheet/source system can safely become Supabase row IDs.

External load identifiers belong in fields such as `aljex_load_number`, `pro_number`, or `aljex_number` as appropriate.

## Duplicate protection during import

The current schema does not define a universal business-key uniqueness rule for every load source. Therefore the importer must perform explicit duplicate checks before insert/upsert.

At minimum compare the source-appropriate combination of:

- customer/source table,
- location,
- `shift_date`,
- Aljex/load number when present,
- driver when useful for disambiguation,
- route/trip number for child routes.

Do not perform a blind upsert on `id`.

If duplicate rules for the historical source are ambiguous, stop that subset and review it rather than guessing.

## Required validation

Before marking a batch `validated`, record at least:

- expected vs loaded rows by source and location,
- minimum and maximum `shift_date`,
- null/blank load-number counts,
- duplicate candidate counts,
- orphan child records,
- invalid/unrecognized locations,
- route counts and stop counts where applicable,
- accounting linkage counts,
- rows missing expected parent relationships.

For Kroger internal loads specifically verify:

- each `loads_trips.shift_id` resolves to `loads_shifts.id`,
- each `trip_stops.trip_id` resolves to `loads_trips.id`,
- `(shift_id, trip_number)` remains unique.

## Permanent analytics history

Uniform cross-location analytics facts live in:

- `public.analytics_load_fact_history`
- `public.analytics_financial_fact_history`

Combined live + archived views:

- `public.analytics_load_facts_all`
- `public.analytics_financial_facts_all`

These use `(source_table, original_id)` so IDs from Kroger shifts, Houston, and Mondelez cannot collide with one another.

Before any purge, run the private analytics-staging operation for the batch/cutoff. Staging is idempotent: existing facts are updated rather than duplicated.

The older Kroger-only analytics history tables remain in place for compatibility with existing analytics pages until those pages are fully migrated.

## Archive layout

Full operational detail is exported locally as:

```text
Archive/
  Kroger/
    Atlanta/
      YYYY-MM-DD/
        Daily Summary.csv
        Load .../
    Building C/
    Delaware/
    Houston/
  Mondelez/
    <Location>/
      YYYY-MM-DD/
        Daily Summary.csv
        Load .../
```

The local archive is the complete historical record. Supabase permanent-history tables are intentionally lightweight analytics facts, not a replacement for the full archive.

## Large import/archive guidance

A roughly 40,000-row historical load should be processed in identifiable batches rather than as one opaque operation.

Recommended batch size depends on source shape, but use batches small enough that:

- validation can be completed quickly,
- failures can be isolated,
- the Archive page can export a manageable set,
- one bad mapping does not contaminate the entire import.

Do not start a destructive purge while another import batch is still `loading`, `loaded`, or awaiting validation.

## Purge gate

Deletion is permitted only when all of these are true for the exact batch/record set:

- import validation passed,
- analytics facts were staged,
- local archive export completed,
- archive files/manifests were verified,
- expected archived counts equal verified archived counts,
- the batch has been explicitly marked `archive_verified`.

Storage files are non-transactional relative to database deletes and must be tracked separately. Storage cleanup candidates belong in `archive_ops.storage_cleanup_items`.

Do not rely on FK cascades for all data:

- `load_notes` requires explicit handling,
- accounting source FKs can use `SET NULL`, so accounting deletion/history must be deliberate,
- Supabase Storage objects do not cascade when database rows are deleted.

## Claude instruction

When Claude performs an import, it should first read this file and report:

1. the source files/data being imported,
2. the target source table(s),
3. the batch ID,
4. expected counts by location,
5. duplicate-detection strategy,
6. child-row relationship strategy,
7. validation results.

Claude must not purge historical rows as part of the import task unless the user separately authorizes purge after archive verification.
