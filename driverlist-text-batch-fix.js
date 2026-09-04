import {
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
