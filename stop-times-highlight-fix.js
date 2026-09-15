/*
 * Load Details stop-time highlight compatibility fix.
 *
 * The Load Details modal re-fetches trip_stops and renders the current In/Out
 * values, but the missing-field class can still be based on an older
 * trip.hasStopTimes value. That leaves the Stop In/Out Times fieldset red even
 * though the modal is visibly showing completed stop times.
 *
 * Keep the visual validation tied to the values currently rendered in the
 * modal. This is intentionally DOM-scoped so it cannot affect board cells or
 * other fieldsets.
 */

function stopRowIsComplete(row) {
  const inputs = row.querySelectorAll('[data-stop-field]');
  if (inputs.length) {
    const inInput = row.querySelector('[data-stop-field="timeIn"]');
    const outInput = row.querySelector('[data-stop-field="timeOut"]');
    return !!(inInput?.value.trim() && outInput?.value.trim());
  }

  const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
  if (!/^Stop\s+\d+/i.test(text)) return false;

  const inMatch = text.match(/\bIn:\s*([^\s]+)/i);
  const outMatch = text.match(/\bOut:\s*([^\s]+)/i);
  const present = (match) => !!match && !['—', '--', '--:--'].includes(match[1]);
  return present(inMatch) && present(outMatch);
}

function syncStopTimesHighlight() {
  const modal = document.getElementById('modal-load-details');
  if (!modal || modal.classList.contains('hidden')) return;

  const fieldsets = modal.querySelectorAll('fieldset.field-box');
  for (const fieldset of fieldsets) {
    const legend = fieldset.querySelector(':scope > legend');
    if ((legend?.textContent || '').trim() !== 'Stop In/Out Times') continue;

    const stopRows = [...fieldset.querySelectorAll('.ld-stop-row')]
      .filter((row) => /^Stop\s+\d+/i.test((row.textContent || '').trim()));

    if (stopRows.length && stopRows.every(stopRowIsComplete)) {
      fieldset.classList.remove('field-box-missing');
    }
  }
}

let scheduled = false;
function scheduleSync() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    syncStopTimesHighlight();
  });
}

const observer = new MutationObserver(scheduleSync);

function install() {
  const modal = document.getElementById('modal-load-details');
  if (!modal) return;
  observer.observe(modal, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'value'] });
  modal.addEventListener('input', scheduleSync, true);
  modal.addEventListener('change', scheduleSync, true);
  scheduleSync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install, { once: true });
} else {
  install();
}
