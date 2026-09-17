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

`simple-board-grid.js` now replaces `board-cell-focus-guard.js` in `loadboard-toolbar-controls.js`.

Important diagnosis behind the change:
- `loadboard.js` renders multiple route `<tr>` elements for one shift while those route rows share the same shift row id/data-row.
- `currentlyEditedField(rowId, tripId)` historically used `document.getElementById(rowId)` and `tr.contains(document.activeElement)`.
- With multiple route rows, `getElementById(rowId)` resolves the first duplicate row, so a dispatcher typing in the second/third route can be misclassified as not editing that trip.
- A realtime payload can then overwrite the local in-memory trip with the older database value and redraw, making freshly typed numbers disappear.

Current mitigation in `simple-board-grid.js`:
- capture-phase Tab owns navigation before the older row-aware Tab handler;
- visible editable controls are traversed in plain DOM order;
- exact cell identity is `data-row + data-trip + data-field`;
- if a realtime redraw destroys the active input, the module restores the exact replacement control and re-feeds the dispatcher’s typed value through the normal `input` event before refocusing it.

If reviewing this, prefer simplifying further rather than adding more focus heuristics. A good core-code cleanup would be to make `currentlyEditedField` compare `document.activeElement.dataset.row / dataset.trip / dataset.field` directly instead of relying on duplicate DOM row ids. Do not reintroduce complex cursor-restoration logic unless clearly necessary.

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

### IMPORTANT: Microsoft authorization is currently shelved

Do not resume or alter the Microsoft/OneDrive authorization setup unless the user explicitly asks to return to it. The desired destination is a Microsoft 365 SharePoint/OneDrive folder named `M-J Site Backups`, but credentials/secrets must never be committed to GitHub.

## Alerts / texting

The alert widget has a Text button that should open the existing `Send Text` modal via the native board path. Avoid adding duplicate click interception layers that compete with the existing handler.

## Database rules worth preserving

- `loads_shifts` = standard board shifts.
- `loads_trips` = trip/route rows.
- A blank visual route should not receive a database ID until it has meaningful route/trip data.
- There is a database-side safeguard to clear truly blank placeholder trip conflicts before insert, preventing duplicate `(shift_id, trip_number)` errors.
- Do not reintroduce old monkey-patch/upsert guards that created circular startup problems.

## Current user priorities

The current interaction is focused on polishing production behavior rather than redesigning architecture. Prefer fixing the exact observed UI/data-flow issue with the smallest safe change.
