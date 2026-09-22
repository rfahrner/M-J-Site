import {
  groupSendNowPressed,
  openCurrentGroupBatch,
  openCurrentGroupBatchInWeb,
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

function initDriverListTextBatchFix() {
  const modal = document.getElementById('modal-text-group');
  const openBtn = document.getElementById('btn-text-group');
  if (!modal || !openBtn) return;

  const setup = document.getElementById('tg-setup-step');
  const progress = document.getElementById('tg-progress-step');
  const sendBtn = document.getElementById('tg-send-now');
  const outlookBtn = document.getElementById('tg-open-batch');
  const outlookWebBtn = document.getElementById('tg-open-web');
  const confirmBtn = document.getElementById('tg-confirm-sent');
  const finishBtn = document.getElementById('tg-finish');
  const errorEl = document.getElementById('tg-error');

  function resetSetupButtons() {
    if (!isVisible(setup)) return;
    // Start stays hidden: it is only a binding point for this page's starter
    // now, and Send Now is what triggers it.
    if (sendBtn) {
      sendBtn.classList.remove('hidden');
      sendBtn.disabled = false;
    }
    if (outlookBtn) outlookBtn.classList.add('hidden');
    if (outlookWebBtn) outlookWebBtn.classList.add('hidden');
    if (confirmBtn) confirmBtn.classList.add('hidden');
    if (finishBtn) finishBtn.classList.add('hidden');
  }

  // openTextGroupModal() resets the data state, but historically did not
  // reset all footer buttons. Run after its normal click handler so a reopened
  // modal cannot show stale Send/Confirm buttons from the prior batch.
  openBtn.addEventListener('click', () => {
    setTimeout(resetSetupButtons, 0);
  });

  modal.addEventListener('click', async (event) => {
    const btn = event.target.closest('#tg-send-now, #tg-open-web, #tg-open-batch, #tg-confirm-sent');
    if (!btn || btn.classList.contains('hidden') || btn.disabled) return;

    // Stop the two pre-existing target listeners from both running.
    event.preventDefault();
    event.stopImmediatePropagation();

    // Send Now legitimately runs from the setup step now: it builds the batch
    // and then sends it.
    if (!isVisible(progress) && btn.id !== 'tg-send-now') {
      if (errorEl) {
        errorEl.textContent = 'Press Send Now to build the recipient batch first.';
        errorEl.classList.remove('hidden');
      }
      resetSetupButtons();
      return;
    }

    try {
      if (btn.id === 'tg-send-now') {
        await groupSendNowPressed();
      } else if (btn.id === 'tg-open-web') {
        openCurrentGroupBatchInWeb();
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
