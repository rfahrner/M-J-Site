import {
  state,
  sendCurrentGroupBatchDirect,
  openCurrentGroupBatch,
  confirmGroupBatchSent,
} from './loadboard.js';

// Driver List's Text Group modal is also seen by loadboard.js's shared
// "text selected rows" modal wiring. On driverlist.html that leaves the
// batch buttons with two click handlers, so Send Now can submit twice and
// Sent — Next Batch can advance twice (or throw after the last batch).
// This small page-only guard owns those three batch actions in capture phase
// and lets exactly one shared action run.

function isVisible(el) {
  return !!el && !el.classList.contains('hidden');
}

function isDnuDriver(driver) {
  return String(driver?.rating || '').trim().toUpperCase().includes('DNU');
}

function mcKey(value) {
  return String(value || '').trim();
}

function phoneKeys(value) {
  const text = String(value || '');
  const matches = text.match(/\d[\d\s().-]{8,}\d/g) || [];
  const out = new Set();
  matches.forEach((match) => {
    let digits = match.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length === 10) out.add(digits);
  });
  return out;
}

function intersects(a, b) {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

// A DNU applies to more than the one driver record during mass texting:
//   1) the DNU driver is excluded;
//   2) the DNU driver's MC/carrier is excluded;
//   3) if the DNU driver's cell number is used as another driver's dispatcher
//      number, that other driver is excluded too.
// This is intentionally a texting rule only; it does not rewrite unrelated
// driver profiles just because they share an MC.
function usableDriversForMassText(drivers) {
  const directDnu = drivers.filter(isDnuDriver);
  if (!directDnu.length) return drivers;

  const blockedMcs = new Set();
  const blockedDriverPhones = new Set();
  directDnu.forEach((driver) => {
    const mc = mcKey(driver.mc);
    if (mc) blockedMcs.add(mc);
    phoneKeys(driver.phone).forEach((phone) => blockedDriverPhones.add(phone));
  });

  return drivers.filter((driver) => {
    if (isDnuDriver(driver)) return false;

    const mc = mcKey(driver.mc);
    if (mc && blockedMcs.has(mc)) return false;

    const dispatcherPhones = phoneKeys(driver.dispatcherPhone);
    if (intersects(dispatcherPhones, blockedDriverPhones)) return false;

    // Duplicate driver records can exist under slightly different names. If a
    // non-DNU duplicate carries the exact cell number of a DNU record, treat
    // it as the same do-not-text contact.
    if (intersects(phoneKeys(driver.phone), blockedDriverPhones)) return false;

    return true;
  });
}

function initDriverListTextBatchFix() {
  const modal = document.getElementById('modal-text-group');
  const openBtn = document.getElementById('btn-text-group');
  if (!modal || !openBtn) return;

  const setup = document.getElementById('tg-setup-step');
  const progress = document.getElementById('tg-progress-step');
  const startBtn = document.getElementById('tg-start');
  const sendBtn = document.getElementById('tg-send-now');
  const outlookBtn = document.getElementById('tg-open-batch');
  const confirmBtn = document.getElementById('tg-confirm-sent');
  const finishBtn = document.getElementById('tg-finish');
  const errorEl = document.getElementById('tg-error');

  function resetSetupButtons() {
    if (!isVisible(setup)) return;
    if (startBtn) startBtn.classList.remove('hidden');
    if (sendBtn) {
      sendBtn.classList.add('hidden');
      sendBtn.disabled = false;
    }
    if (outlookBtn) outlookBtn.classList.add('hidden');
    if (confirmBtn) confirmBtn.classList.add('hidden');
    if (finishBtn) finishBtn.classList.add('hidden');
  }

  // openTextGroupModal() resets the data state, but historically did not
  // reset all footer buttons. Run after its normal click handler so a reopened
  // modal cannot show stale Send/Confirm buttons from the prior batch.
  openBtn.addEventListener('click', () => {
    setTimeout(resetSetupButtons, 0);
  });

  // "All Drivers" means all usable drivers. Build the batch from a temporary
  // filtered list so DNU contacts, their MC/carrier, and drivers whose
  // dispatcher number belongs to a DNU driver can never slip into the group.
  // Restore the complete Driver List immediately after loadboard.js has built
  // its recipient copy; the visible Driver List itself remains unchanged.
  modal.addEventListener('click', (event) => {
    if (!event.target.closest('#tg-start')) return;
    const groupSelect = document.getElementById('tg-group-select');
    if (groupSelect?.value !== 'ALL' || !Array.isArray(state.drivers)) return;

    const fullDriverList = state.drivers;
    const usableDrivers = usableDriversForMassText(fullDriverList);
    if (usableDrivers.length === fullDriverList.length) return;

    state.drivers = usableDrivers;
    queueMicrotask(() => {
      if (state.drivers === usableDrivers) state.drivers = fullDriverList;
    });
  }, true);

  // Once Start successfully creates batches, it belongs to the setup step
  // and should not remain beside the active batch actions.
  modal.addEventListener('click', (event) => {
    if (!event.target.closest('#tg-start')) return;
    setTimeout(() => {
      if (startBtn) startBtn.classList.toggle('hidden', isVisible(progress));
    }, 0);
  });

  modal.addEventListener('click', async (event) => {
    const btn = event.target.closest('#tg-send-now, #tg-open-batch, #tg-confirm-sent');
    if (!btn || btn.classList.contains('hidden') || btn.disabled) return;

    // Stop the two pre-existing target listeners from both running.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (!isVisible(progress)) {
      if (errorEl) {
        errorEl.textContent = 'Click Start first to build the recipient batch.';
        errorEl.classList.remove('hidden');
      }
      resetSetupButtons();
      return;
    }

    try {
      if (btn.id === 'tg-send-now') {
        await sendCurrentGroupBatchDirect();
      } else if (btn.id === 'tg-open-batch') {
        openCurrentGroupBatch();
      } else if (btn.id === 'tg-confirm-sent') {
        confirmGroupBatchSent();
      }
    } catch (error) {
      console.error('Driver List group-text batch action failed:', error);
      const status = document.getElementById('tg-batch-status');
      if (status) status.textContent = `That batch action failed: ${error?.message || error}`;
    }
  }, true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDriverListTextBatchFix, { once: true });
} else {
  initDriverListTextBatchFix();
}
