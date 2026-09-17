# Cursor / disappearing-value bug — handoff for Claude

This is the current highest-priority production bug in `rfahrner/M-J-Site`.

## What the user wants

The load board should behave like a very simple spreadsheet:

- Type a value into a cell and it must stay there.
- `Tab` moves to the next visible editable cell.
- `Shift+Tab` moves to the previous visible editable cell.
- Do not jump to another route row.
- Do not move the cursor unexpectedly.
- Do not erase/revert what was just typed.
- Avoid adding more focus/selection machinery unless absolutely necessary.

The user explicitly said: "I just typed a number 3 times and every time it was deleting itself" and "I want to go from one cell to the next — I don't need anything crazy."

LATEST OBSERVATION: the failure now occurs **while the user is still typing**, before Tab. The user gets halfway through entering a number in a lower route row and focus suddenly jumps to the **same column in the row above**. This strongly suggests a realtime/save-triggered rerender or focus restoration is firing mid-edit, not merely bad Tab navigation.

## Reproduction pattern

This has been easiest to reproduce on a standard Kroger board (Atlanta in particular) when one shift has multiple route/trip rows.

Example:

1. Open a load with at least two visible route rows.
2. Click the `Trip ID` input on the SECOND route row.
3. Begin typing a value such as `1293405`.
4. **Without pressing Tab**, continue typing for a moment.
5. Current observed failure: partway through typing, focus jumps to the same Trip ID column on the FIRST route row; the partially typed value may then disappear/revert.
6. Waiting briefly and/or pressing `Tab` has also produced:
   - typed value disappears/reverts,
   - focus jumps to the same column in the FIRST route row,
   - the visible input looked focused in route 2 while row/focus logic behaved as though route 1 was active.

## Current architecture involved

### `loadboard.js`

This owns the main standard-board state, rendering, saves, and Supabase realtime.

Important behavior:

- Input events update the in-memory row/trip immediately.
- Saves are debounced (`SAVE_DEBOUNCE_MS` is 700 ms).
- `scheduleTripSave(row, trip, tripNumber)` schedules `saveTripNow(...)`.
- Realtime listens to `loads_shifts` and `loads_trips` and merges incoming rows back into local state.
- `renderBoardTable()` redraws the table; redraws destroy/recreate inputs.

### Physical DOM layout for multiple trips

The first open route row gets the shift id as its `<tr id>`:

```js
const idAttr = i === 0
  ? ` id="${row.id}"`
  : ` id="${row.id}__${trip.id}" data-parent-row="${row.id}"`;
```

So route 2+ is NOT physically inside `document.getElementById(row.id)`.

All editable route inputs still use logical data attributes such as:

- `data-row="<shift local id>"`
- `data-trip="<trip local id>"`
- `data-field="tripId"` / `routeId` / etc.

Those data attributes are the correct logical identity of a cell.

## Strongly suspected/identified data-loss bug

`currentlyEditedField(rowId, tripId)` in `loadboard.js` starts with:

```js
const tr = document.getElementById(rowId);
const activeEl = document.activeElement;
if (!tr || !tr.contains(activeEl)) return null;
```

That works for the FIRST physical route row, but for route 2+ the active input is in a sibling `<tr id="rowId__tripId">`, not inside the first `<tr id="rowId">`.

Therefore, while editing route 2+, `currentlyEditedField(...)` can incorrectly return `null`.

`handleRealtimeTripChange(payload)` then does roughly:

```js
const idx = dbTrip.trip_number - 1;
const localTrip = parentRow.trips[idx];
const domField = currentlyEditedField(parentRow.id, localTrip.id);
const preserved = domField ? localTrip[domField] : undefined;
const fresh = tripFromDbRow(dbTrip);
Object.assign(localTrip, fresh, { id: localTrip.id });
if (domField) localTrip[domField] = preserved;
```

If `domField` is wrongly `null`, an incoming realtime payload can overwrite the local value that the dispatcher just typed.

The new mid-typing jump makes this even more likely: a realtime event can arrive during the 700ms debounce window, merge stale DB state, redraw the table, and the board's generic focus restore can land on the first physical row for that shift/column.

A minimal correction to investigate is to make `currentlyEditedField` identify the active cell directly from its data attributes instead of requiring the active input to be contained by `document.getElementById(rowId)`, e.g. logically:

```js
function currentlyEditedField(rowId, tripId) {
  const activeEl = document.activeElement;
  if (!activeEl?.dataset) return null;
  if (String(activeEl.dataset.row || '') !== String(rowId)) return null;

  const activeTrip = activeEl.dataset.trip || null;
  const wantedTrip = tripId || null;
  if (activeTrip !== wantedTrip) return null;

  return activeEl.dataset.field || null;
}
```

Please inspect the actual current code before applying this exact snippet.

## Important second race to investigate

Even after fixing `currentlyEditedField`, there may still be a race after the user leaves a cell:

1. User types into a trip field.
2. In-memory state changes immediately.
3. DB save waits ~700 ms.
4. User presses Tab and focus moves to the next cell.
5. A stale/in-flight realtime `loads_trips` payload arrives before the local save is authoritative.
6. Because the previous field is no longer the active field, realtime merge may overwrite the locally dirty value.

There is now also evidence for the same race **before blur**: if `currentlyEditedField` misidentifies route 2+ as not being actively edited, stale realtime can overwrite the field while the user is still typing.

So please inspect whether the robust solution should be a VERY SMALL dirty-field / pending-save guard rather than more focus restoration.

Possible simple directions:

- While a trip field has a pending local save, do not allow an incoming realtime payload to overwrite that locally dirty field.
- Clear the dirty marker only after the local Supabase update/insert resolves successfully.
- Or flush the field/trip save on Tab/blur before allowing stale realtime state to replace it.

Do not disable realtime globally; multiple dispatchers use the board.

## Current Tab/focus code

### `simple-board-grid.js`

This is the currently imported compatibility layer from `loadboard-toolbar-controls.js`.

It was added after earlier focus guards became too complicated. Current intent:

- Capture `Tab` before the old handler.
- Move through visible editable inputs in DOM order.
- Track cell identity by `row + optional trip + field`.
- If a redraw destroys the active input, restore the exact cell and re-feed its typed value through the normal `input` event.

This file is NOT confirmed to have solved the production bug.

### `board-cell-focus-guard.js`

This older, more complicated focus guard still exists in the repository, but it is no longer imported by `loadboard-toolbar-controls.js` on current `main`.

Do not accidentally load both focus systems together.

### Native `handleRowAwareTab` in `loadboard.js`

The older custom Tab handler still exists in `loadboard.js` and is still wired on the board table. `simple-board-grid.js` currently intercepts Tab in capture phase and calls `stopImmediatePropagation()` so the old handler should not handle that Tab.

Please decide whether the cleanest final solution is to simplify/remove the duplicate Tab logic rather than layering yet another handler.

## Recent cursor/focus attempts that did NOT fully solve it

These are useful to inspect/revert/compare, not proof of a working solution:

- `7703510cbd9b702b7600e0d377b5fde3a70bdd9e` — expanded focus restoration to shift-level cells.
- `a60fb7a5c7af79aad2efc71d1335ce78c9f9ba5a` — attempted exact Tab target by `shift + trip + field`.
- `45af3946e5259fdfb637090eaf9ac12c2ab3d8ce` — added `simple-board-grid.js`.
- `a58cc51e34e7f7c2fb045a2b155b00de9856844f` — switched toolbar import from old focus guard to `simple-board-grid.js`.
- `2a581d3a489429f34ac5a85bde543cc64295b347` — updated general `CLAUDE.md` handoff.

The user reports the problem is still present after these attempts.

## Files to inspect first

1. `loadboard.js`
   - `currentlyEditedField`
   - `handleRealtimeTripChange`
   - `handleRealtimeShiftChange`
   - `scheduleTripSave`
   - `saveTripNow`
   - `renderBoardTable`
   - `captureFocusForRerender` / any generic restoreFocus logic
   - `handleRowAwareTab`
   - generation of multi-trip row HTML / `data-row`, `data-trip`, `data-field`
2. `simple-board-grid.js`
3. `board-cell-focus-guard.js` (historical comparison only; currently not imported)
4. `loadboard-toolbar-controls.js`

## Acceptance test

Please do not consider this fixed until all of these work on a load with 2+ open routes:

1. Click route 2 `Trip ID`.
2. Slowly type a new 7+ digit number **without pressing Tab**.
   - Focus must not jump to route 1 midway through typing.
   - Every keystroke remains in route 2.
3. Wait 2+ seconds without touching anything.
   - Value remains exactly as typed.
4. Press Tab repeatedly through Trailer #, Miles, Stops, Dispatch Time.
   - Focus remains on route 2 and moves only to the next visible editable cell.
   - The Trip ID value remains.
5. Shift+Tab walks backward on route 2.
6. Let Supabase realtime/save events fire during this.
   - No value reverts.
   - No jump to route 1.
7. Refresh the page.
   - The typed value is persisted in the correct `loads_trips` row.
8. Repeat on route 1 to ensure the fix does not break the first trip row.
9. Repeat with two browser sessions if possible to ensure legitimate remote changes still sync.

## What NOT to do

- Do not solve this by adding another large cursor/focus observer layer.
- Do not disable realtime entirely.
- Do not key trip editing only by the shift row id.
- Do not use only `document.getElementById(rowId)` to identify a route 2+ editing cell.
- Do not reintroduce the old trip upsert monkey-patch/circular-import fixes.
- Do not touch the shelved Microsoft/OneDrive work for this task.

## Desired implementation philosophy

Prefer fixing the data race / identity bug at the source in `loadboard.js` and then DELETE or reduce compatibility focus code if it becomes unnecessary.

The final behavior should be boring: type, Tab, type, Tab. No surprises.
