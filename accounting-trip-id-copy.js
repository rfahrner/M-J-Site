/* ================================================================
   Right-click a Trip ID pill on Accounting to copy it

   The Trip ID is the number that gets read out on the phone and pasted
   into Aljex, and left-click on the pill is already spoken for -- it
   opens the route's details. So the copy lives on the context menu,
   which is otherwise unused on this page.

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

   A pill with no Trip ID recorded is disabled by accounting-columns.js,
   and a disabled button fires no mouse events, so those fall through to
   the browser's own menu. That is deliberate -- offering "Copy" on a
   dash would be a worse answer than offering nothing.
   ================================================================ */
import { escapeHtml, setDriverSyncStatus } from './loadboard.js';

const MENU_ID = 'acct-context-menu';
const PILL_SELECTOR = 'button.trip-chip[data-open-acct-route-text]';

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

function openCopyMenu(value, x, y) {
  closeAccountingContextMenu();
  const label = idLabel();
  const menu = document.createElement('div');
  menu.className = 'row-context-menu';
  menu.id = MENU_ID;
  menu.innerHTML = `<button class="context-menu-item" data-action="acct-copy-trip-id">Copy ${escapeHtml(label)} ${escapeHtml(value)}</button>`;
  document.body.appendChild(menu);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 8)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 8)}px`;

  menu.querySelector('[data-action="acct-copy-trip-id"]').addEventListener('click', async () => {
    closeAccountingContextMenu();
    const ok = await copyText(value);
    if (ok) setDriverSyncStatus(`${label} ${value} copied.`, 'success');
    else setDriverSyncStatus(`Couldn't copy ${label} ${value} — copy it by hand.`, 'error');
  });
}

export function initAccountingTripIdCopy() {
  const table = document.getElementById('accounting-table');
  if (!table) return;

  table.addEventListener('contextmenu', (e) => {
    const pill = e.target.closest(PILL_SELECTOR);
    if (!pill) return; // anywhere else on the sheet keeps the browser's own menu
    const value = (pill.textContent || '').trim();
    if (!value || value === '—') return;
    e.preventDefault();
    openCopyMenu(value, e.clientX, e.clientY);
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
