# M-J Site — Claude Project Context

Read this file before making changes. This is a live dispatch/load-board application in active use. Inspect the current implementation and database behavior before editing; do not assume older comments or summaries are still accurate.

## Repository / deployment

- Repo: `rfahrner/M-J-Site`
- Default branch: `main`
- Production: GitHub Pages
- Backend: Supabase project `ygsapysqzwrpcimgvaqx`
- Main board logic is concentrated in `loadboard.js`; several compatibility/helper modules are deliberately loaded dynamically from `loadboard-toolbar-controls.js` to avoid circular-import startup failures.

## Working style

- Make narrow, reversible changes.
- Preserve current production behavior unless the requested change explicitly replaces it.
- Before changing a large file, inspect the relevant current code and any helper modules already addressing that behavior.
- Avoid introducing new static import cycles around `loadboard.js`, `alerts.js`, `paperwork-*`, or toolbar modules.
- After changes, verify GitHub CI/Pages status.
- Do not put secrets in frontend JavaScript or in this repository.

## CURRENT PRIORITY: keep spreadsheet editing simple

The user explicitly wants ordinary spreadsheet behavior: type a value, Tab to the next editable cell, continue. No clever row-selection/focus system should be allowed to move the cursor or erase active input.

Fixed at the source in `loadboard.js` (see `scripts/board-cell-editing.test.mjs`).
No focus layer is imported any more: `board-cell-focus-guard.js` and
`simple-board-grid.js` are both still on disk but unimported. Do not wire either
back in without first showing that the three causes below have returned.

What was actually wrong -- three separate things, none of them Tab navigation:

1. `currentlyEditedField(rowId, tripId)` used `document.getElementById(rowId)` and
   `tr.contains(document.activeElement)`. A shift's routes past the first render as
   SIBLING rows with `id="<row.id>__<trip.id>"`, so they are not inside
   `getElementById(row.id)` at all and editing route 2 reported "nothing is being
   edited". It now reads `dataset.row` / `dataset.trip` / `dataset.field` directly.
2. `captureFocusForRerender()` built its restore selector from row + field only.
   Routes share `data-row` and reuse field names, so `querySelector` returned the
   first match -- route 1. That was the cursor jumping to the row above after a
   redraw. It now includes `data-trip`, and `:not([data-trip])` for shift-level
   cells.
3. Preservation was keyed on what had focus, but saves are debounced 700 ms. The
   moment the dispatcher Tabbed on, the cell just left was no longer focused, so a
   realtime echo carrying the pre-save value overwrote it and the debounced save
   wrote that stale value to the database.

Point 3 is the one worth protecting. `loadboard.js` keeps a dirty-field registry
(`dirtyShiftFields` / `dirtyTripFields`): a locally changed field is exempt from
the realtime merge until the database acknowledges the exact value still on
screen, and stays exempt if the dispatcher typed again mid-flight. Genuine remote
changes apply as soon as the local edit is confirmed, so multi-dispatcher sync is
unaffected. Anything added here should reduce this machinery, not layer onto it --
and cursor position is not the right signal for which copy of a value is newer.

### Driver autocomplete

The floating driver picker is `#driver-ac-floating`. Enter should accept a driver and close the dropdown. Do not set permanent inline `display:none`; reopening relies on toggling `.hidden`.

### Shift completion / time sheets

`timesheet-completion-flow.js` extends the native completion modal.

Requirements:
- Time Sheet Received + Start + Finish are required to complete a shift.
- Time Sheet Image is optional.
- Trailer Drop Location is legacy and should remain hidden/not operationally required.
- Bulk completion must process selected loads one at a time. Each selected load must collect its own time-sheet data.
- The completion modal should show current load context, including driver name and PRO#, plus `Load X of Y` when multiple shifts are queued.
- After confirming one selected load, the native queue advances to the next selected load and the fields reset.

## Megaboard

Megaboard is a live operational view, not a historical report.

Relevant files include:
- `megaboard.js`
- `megaboard-live-view.js`
- `megaboard-rolling-window.js`
- `megaboard-current-focus.js`
- `megaboard-running-cap.js`
- `megaboard-driver-status.js`
- `megaboard-driver-status-groups.js`

Current intent:
- Show the current/live route per load.
- Hide Rate and Rating in Megaboard presentation.
- Operational day includes overnight carryover plus next-day 00:00–04:00 handoff work.
- A driver/load should not be considered running indefinitely. Standard maximum operating window is 12 hours unless the shift is marked complete sooner.
- Driver status cards are ordered Active -> Upcoming -> Ended.
- Cards themselves already say RUNNING / UPCOMING / ENDED and are color-coded. Do **not** add redundant section labels such as `UPCOMING DRIVERS`, `ACTIVE DRIVERS`, or `ENDED SHIFTS` above them.
- Driver status cards should not show PRO or Trip/Route IDs.
- Card time format is military with month/day, e.g. `09/16 2300`.
- Prior-day shifts should only remain visible while genuinely running; once complete or outside the 12-hour window they disappear from current carryover.
- For an existing location/day table, early-AM/overnight operational rows should merge into the same day's table instead of rendering as a separate duplicate table/block. A small EARLY AM / OVERNIGHT badge is fine to retain context.

## Images / archival work

Images currently live in Supabase Storage buckets including:
- `mondelez-routes`
- `trip-sheets`

The Accounting and load-detail views reuse references; do not duplicate image objects just to display them in multiple screens.

The user wants an automated archive lifecycle:
- Supabase keeps recent images for roughly 21 days.
- Older images will eventually be archived to Microsoft OneDrive/SharePoint.
- Archive dashboard should show storage usage, backup egress used, eligible/ready-to-move files, last backup time, and amount sent.
- Background archive process should verify the destination copy before deleting the Supabase object.
- High-volume planning target: up to ~200 images/day.
- Database archive candidate batching was increased to support 250 files/run, and an emergency high-water rule can move files older than 7 days once image storage reaches ~80% of the 1 GB free-tier limit.

### How the archive runs

- `image-archive-onedrive` takes `status`, `sign`, `run`, and a GET `action=file`
  proxy. `run` accepts either the cron secret (scheduled sweep, obeys the
  `enabled` flag) or a signed-in **admin/IT** session (the Archive page's
  "Back Up Now", which may run before `enabled` is turned on). Role is checked
  server-side against `user_roles`; never trust anything the browser asserts.
- `archive_backup_config.delete_after_archive` is the copy-first switch. While
  it is false the sweep uploads and records but deletes nothing. Turning it on
  later lets `cleanupAlreadyArchived()` collect the originals it already has
  verified copies of -- nothing is re-uploaded. **Do not turn it on until
  archived images have been confirmed viewable in the app.**
- A run stops itself at `RUN_BUDGET_MS` (75s) between files, because the cron
  caller only waits 120s and a run killed mid-file can leave an original with no
  recorded copy. It reports `remaining`; the button loops on that, so one press
  moves everything however many passes it takes.
- Archived images stay viewable through `action:'sign'`, wired into
  `batchSignImageUrls()` in `loadboard.js`, `accounting-route-images.js`, and the
  Load Details attachment list. Anything storage cannot sign is looked up in the
  archive before the slot is given up as empty. `archive-image-urls.js` is
  deliberately a leaf module (takes the client as an argument) -- do not make it
  import `loadboard.js`.

### IMPORTANT: Microsoft authorization is currently shelved

Do not resume or alter the Microsoft/OneDrive authorization setup unless the user explicitly asks to return to it. The desired destination is a Microsoft 365 SharePoint/OneDrive folder named `M-J Site Backups`, but credentials/secrets must never be committed to GitHub.

## Alerts / texting

The alert widget has a Text button that should open the existing `Send Text` modal via the native board path. Avoid adding duplicate click interception layers that compete with the existing handler.

An alert clears itself once its text goes out. `openSendTextModal()` takes an
optional `{ onSent }`, fired by `finishSendTextModalAsSent()` on BOTH exits --
the gateway accepting the message, and the dispatcher choosing "Open in email
instead". `alerts.js` keeps a dismissed-key set (localStorage, scoped to today)
and filters it out of every scan. Repeating rules roll a tier into their key, so
the next reminder is a new key and still arrives; dismissing never switches a
rule off.

## Deleting a load vs. deleting a route

The ROUTES column's pills are rendered inside a load's FIRST `<tr>`, and routes
past the first render as sibling `<tr id="row__trip">` rows. `tr.id` alone
therefore says "shift" even when the pointer is on one specific route -- which
is how a right-click meant for a route pill deleted an entire load. The
contextmenu handler reads `data-trip`/`data-row` off whatever was clicked, and
the menu now carries two clearly named entries ("Delete route X only" /
"Delete entire load PRO# ..."). Never ship an unlabelled `Delete`.

## Board cells: no injected wrappers from document-wide observers

`paperwork-load-integration.js` used to draw a small paper icon beside every
route-image dropzone from a document-wide MutationObserver. Every board redraw
destroyed it and re-created it ~120ms later, wrapping the dropzone in an extra
flex container and changing the IMAGE column's width each time -- the column
visibly flickered. The icon is gone (the user asked for it removed) and that
module now observes `#modal-load-details` only. Do not reintroduce a board-cell
injector driven off a whole-document observer.

The Rate panel inside Load Details is rendered by `loadboard.js` and then
re-decorated by `daily-rate-hierarchy.js` about 20ms later. The two must agree
exactly or the box visibly resizes right after it draws: `money()` there is
byte-for-byte `fmtRateMoney()` here, and `RATE_PANEL_EXPLANATION` is declared
identically in both files. Change either in both files or in neither. The
decorator compares the panel's rendered leaf text before writing, so an already
-correct box is left alone.

`#modal-load-details` has a fixed height envelope in `loadboard.css` with the
body scrolling inside it. Load Details fills in piece by piece as its queries
return; sized to its contents, the centered card moved on screen with every
arrival, which read as the modal shaking while it opened.

## Writing to Supabase: rules learned the hard way

Every bug in this section failed **silently** -- the screen kept showing what
was typed while the database held something else. When touching the write path,
assume a wrong write will not announce itself. `scripts/supabase-write-path.test.mjs`
pins all of it.

- **`loads_shifts` has `carrier_rate`, not `rate`.** Three modules wrote `rate`.
  PostgREST rejects the whole request, so the rate *and* `rate_manual:false`
  were both dropped and only `console.error` knew. (`board_rate_tiers.rate` is
  a real column -- that one is fine.)
- **`trip_number` is an identity, not an array position.** Deleting a route
  closes the gap in `row.trips` while the surviving rows keep their numbers, and
  `loads_trips` is `UNIQUE (shift_id, trip_number)`. `saveTripNow` therefore
  strips `trip_number` from every UPDATE, and an INSERT asks
  `nextFreeTripNumber()` rather than using `indexOf + 1`.
- **Free-text numeric cells must go through `numOrNull()`.** `Number("1,250.00")`
  is NaN, `JSON.stringify` turns NaN into `null`, and the request then SUCCEEDS
  while blanking a real value. `numOrNull` returns `null` only for a genuinely
  empty field and `undefined` for anything unparseable; `withoutUndefined()`
  drops those keys so the column is left alone. Never call `Number()` directly
  in a `*ToDbRow` mapper.
- **Deleting cancels pending writes.** Saves are debounced 700ms, so
  `deleteRow`/`deleteTrip` call `cancelPendingSaves()` first -- otherwise the
  timer fires against a row that no longer exists and the INSERT path recreates
  it, invisibly.
- **A row saves under its own `shiftDate`**, never `state.activeDate` alone.
  Date navigation is instant and the save is 700ms late, so the active date
  belongs to a different day by the time it fires.
- **`trip_stops` is upserted on `trip_id,stop_number`,** never inserted -- it
  has a unique constraint and two dispatchers routinely hold stale stop lists.

## route_id is a name, not a key

A route's `route_id` is free text a dispatcher types, and the same value
repeats inside one load constantly -- two "FRGT" legs, two "Nestle" legs. Any
lookup of the form `routes.find(r => r.route_id === text)` returns the first
match and is therefore wrong for exactly those loads. That is what made the
Accounting page print one route's Trip ID against another, colour the second
route's pill from the first route's paperwork, and open the wrong route on
click -- while the database held the correct values the whole time.

Identify an accounting route by `route_number` (unique within the load) or
`source_trip_id` (the real `loads_trips` row). The chips in `acctRouteIdsHtml`
carry both as `data-acct-route-number` / `data-acct-source-trip`;
`routeForChip()` and `findLiveTripForRoute()` in `accounting-columns.js` consume
them. Matching on the text is a last-resort fallback for rows old enough to
predate `route_number`, and only when the name is unambiguous.

## Database rules worth preserving

- `loads_shifts` = standard board shifts.
- `loads_trips` = trip/route rows.
- A blank visual route should not receive a database ID until it has meaningful route/trip data.
- There is a database-side safeguard to clear truly blank placeholder trip conflicts before insert, preventing duplicate `(shift_id, trip_number)` errors.
- Do not reintroduce old monkey-patch/upsert guards that created circular startup problems.

## Current user priorities

The current interaction is focused on polishing production behavior rather than redesigning architecture. Prefer fixing the exact observed UI/data-flow issue with the smallest safe change.
