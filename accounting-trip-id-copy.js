/* ================================================================
   Accounting row context menu: copy identifiers or delete from Accounting

   The Trip ID is the number that gets read out on the phone and pasted
   into Aljex, and left-click on the pill is already spoken for -- it
   opens the route's details. So the copy lives on the context menu,
   alongside Delete from Accounting on every load row.

   Two things about this page decide the shape of the code:

   - The board's context menu (loadboard.js) is wired inside
     initBoardPage(), which Accounting never runs. Its close-on-click,
     Escape and scroll handlers do not exist here, so this owns its own.
     Only the CSS classes are shared, out of loadboard.css.

   - What the pill SAYS is what should land on the clipboard. Atlanta's
     pill is relabelled to the trip_id by accounting-columns.js after the
     routes come back; Delaware's stays the route_id, and the column
     header changes with it. Reading textContent instead of a dataset
     value keeps the menu honest about which of those you are looking at.

   Empty identifier cells still offer Delete from Accounting. Deletion is
   dispatched to accounting.js through a DOM event to avoid an import cycle.

   ADDING DELETE TOOK RIGHT-CLICK COPY AWAY FROM THE REST OF THE SHEET.

   This handler used to open with

       const pill = e.target.closest(PILL_SELECTOR);
       if (!pill) return; // anywhere else on the sheet keeps the browser's own menu

   so a right-click on Rate Customer, Rate Carrier or Aljex # fell through to
   the browser and its Cut/Copy/Paste. Offering Delete on every load row meant
   preventDefault() on every load row, which took that menu away and put
   nothing in its place: measured on the real page, right-clicking Rate Carrier
   produced exactly one item, "Delete from Accounting".

   Restoring the browser's menu alone would NOT have fixed it. A right-click
   leaves no selection -- measured as selectionStart === selectionEnd on both
   rate inputs, and a zero-length document selection on the Aljex cell -- and
   Chrome greys Copy out when nothing is selected. "Right-click, Copy" in one
   gesture has to be an item of our own.

   So both halves:

   - every editable cell in COPYABLE_CELLS offers "Copy <column> <value>",
     named by the column header the dispatcher is reading;
   - if text IS selected inside the row, the browser's menu is let through
     untouched, because its Copy takes exactly what was highlighted -- part of
     a value, or text in a plain cell such as Driver or MC that has no field of
     its own. That is the half of the regression nobody had reported yet.
   ================================================================ */
import { escapeHtml, setDriverSyncStatus } from './loadboard.js';

const MENU_ID = 'acct-context-menu';

/*
 * The cells whose value the menu offers to copy, keyed by data-action and
 * named by their column HEADER -- "Rate Carrier", not "carrier pay" -- so the
 * item reads as the column being pointed at. acct-aljex-number also carries
 * .acct-load-text, which is what this selector used to match; its label moves
 * from "Load #" to the column's own name.
 *
 * The checkboxes (Highlight, Sent, Released) and the Revenue Rate <select> are
 * deliberately absent: there is no text on them to copy.
 */
const COPYABLE_CELLS = {
  'acct-aljex-number': 'Aljex #',
  'acct-customer-rate': 'Rate Customer',
  'acct-carrier-pay': 'Rate Carrier',
};

// An <input>'s text is in .value and its textContent is EMPTY; the Aljex cell
// is a contenteditable <span>, where it is the other way round. Reading the
// wrong one is a silent blank -- a menu item reading "Copy Rate Carrier" with
// nothing after it, which copies nothing.
function cellText(el) {
  if (!el) return '';
  const raw = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.textContent;
  return String(raw ?? '').trim();
}

/*
 * Has the dispatcher highlighted something inside this row?
 *
 * An <input>'s internal selection is NOT visible to window.getSelection() in
 * Chrome, so the two cases are genuinely different and both have to be asked.
 */
function hasSelectionInside(row, target) {
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      && target.selectionStart != null && target.selectionStart !== target.selectionEnd) return true;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (row.contains(selection.getRangeAt(i).commonAncestorContainer)) return true;
  }
  return false;
}

function activeLocation() {
  return document.querySelector('#acct-location-tabs .location-tab.is-active')?.dataset.location || 'atlanta';
}

// Matches the column header, which accounting-columns.js renames per
// location. "Copy Trip ID" over a cell headed "Route ID" would be wrong.
function idLabel() {
  return activeLocation() === 'atlanta' ? 'Trip ID' : 'Route ID';
}

export function closeAccountingContextMenu() {
  document.getElementById(MENU_ID)?.remove();
}

/*
 * navigator.clipboard is the whole story on the deployed site (https), but
 * it is absent over plain http and rejects when the document is not
 * focused, so the textarea fallback stays. Returns whether it worked --
 * silently doing nothing is the one outcome worth ruling out, since the
 * user's next move is to paste.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the textarea */ }
  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

function openCopyMenu(value, x, y, accountingId, label = idLabel()) {
  closeAccountingContextMenu();
  const menu = document.createElement('div');
  menu.className = 'row-context-menu';
  menu.id = MENU_ID;
  menu.innerHTML = (value ? `<button class="context-menu-item" data-action="acct-copy-trip-id">Copy ${escapeHtml(label)} ${escapeHtml(value)}</button>` : '')
    + '<button class="context-menu-item context-menu-item-danger" data-action="acct-delete">Delete from Accounting</button>';
  document.body.appendChild(menu);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 8)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 8)}px`;

  menu.querySelector('[data-action="acct-copy-trip-id"]')?.addEventListener('click', async () => {
    closeAccountingContextMenu();
    const ok = await copyText(value);
    if (ok) setDriverSyncStatus(`${label} ${value} copied.`, 'success');
    else setDriverSyncStatus(`Couldn't copy ${label} ${value} — copy it by hand.`, 'error');
  });
  menu.querySelector('[data-action="acct-delete"]').addEventListener('click', () => {
    closeAccountingContextMenu();
    document.dispatchEvent(new CustomEvent('accounting:delete-request', { detail: { accountingId } }));
  });
}

export function initAccountingTripIdCopy() {
  const table = document.getElementById('accounting-table');
  if (!table || table.dataset.accountingRowMenu === 'ready') return;
  table.dataset.accountingRowMenu = 'ready';

  table.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('tr[id^="acct-"]');
    if (!row || !table.contains(row)) return;
    const accountingId = row.id.slice(5);
    if (!/^\d+$/.test(accountingId)) return;

    // Something is highlighted: the browser's Copy is the better answer,
    // because it takes that and not the whole cell. Delete stays available
    // from an ordinary right-click anywhere else on the row.
    if (hasSelectionInside(row, e.target)) { closeAccountingContextMenu(); return; }

    const field = e.target.closest('[data-action]');
    const column = field ? COPYABLE_CELLS[field.dataset.action] : undefined;
    const copyTarget = column ? field : e.target.closest('.trip-chip');
    const value = cellText(copyTarget);
    e.preventDefault();
    openCopyMenu(value === '—' ? '' : value, e.clientX, e.clientY, accountingId, column || idLabel());
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest(`#${MENU_ID}`)) closeAccountingContextMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccountingContextMenu(); });
  document.addEventListener('scroll', closeAccountingContextMenu, true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountingTripIdCopy, { once: true });
} else {
  initAccountingTripIdCopy();
}
