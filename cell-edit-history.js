// A cell edit is one user interaction, not a series of autosaves. This leaf
// module never observes data changes and never moves focus or writes values.
export function createCellEditHistory({ describe, commit }) {
  let active = null;
  function finish() {
    const edit = active;
    active = null;
    if (edit?.touched && edit.valid !== false && edit.before !== edit.value) commit(edit);
  }
  function focus(element) {
    const cell = describe(element);
    if (active && active.key !== cell?.key) finish();
    if (cell && !active) active = { ...cell, before: cell.value, touched: false };
  }
  function input(element) {
    const cell = describe(element);
    if (!cell || active?.key !== cell.key) return;
    active.value = cell.value;
    active.valid = cell.valid;
    active.touched = true;
  }
  function blur(element, activeElement) {
    const cell = describe(element);
    if (active?.key !== cell?.key) return;
    // Redrawing and restoring this same cell does not commit partial text.
    if (describe(activeElement)?.key === active.key) return;
    finish();
  }
  return { focus, input, blur };
}
