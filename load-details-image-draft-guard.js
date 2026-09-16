/*
 * Preserve unsaved Load Details edits while a route image uploads.
 *
 * The shared image-cell callback redraws #ld-tab-content after an upload so
 * the new thumbnail appears. That redraw used to rebuild the trip form from
 * the last persisted database state, which could wipe values the dispatcher
 * had typed but had not saved yet. Capture the live form immediately before
 * an image upload/drop/paste and restore it after that redraw.
 */

(() => {
  const CONTENT_SELECTOR = '#ld-tab-content';
  const MODAL_SELECTOR = '#modal-load-details';
  const MAX_DRAFT_AGE_MS = 15000;
  let draft = null;
  let clearTimer = null;
  let restoreQueued = false;

  function contentRoot() {
    return document.querySelector(CONTENT_SELECTOR);
  }

  function currentTabKey() {
    const active = document.querySelector('#ld-tabs .ld-tab.is-active, #ld-tabs .ld-tab.active');
    return active?.dataset?.tab || '';
  }

  function keyForControl(el, index) {
    if (el.id) return `id:${el.id}`;
    if (el.dataset?.stopField != null && el.dataset?.stopIndex != null) {
      return `stop:${el.dataset.stopField}:${el.dataset.stopIndex}`;
    }
    if (el.name) return `name:${el.name}`;
    if (el.dataset?.field) return `field:${el.dataset.field}`;
    return `index:${index}:${el.tagName}:${el.type || ''}`;
  }

  function captureDraft() {
    const root = contentRoot();
    if (!root) return null;
    const controls = [...root.querySelectorAll('input, textarea, select')]
      .filter((el) => String(el.type || '').toLowerCase() !== 'file');
    const active = document.activeElement;
    const activeIndex = controls.indexOf(active);
    const modalCard = root.closest('.modal') || document.querySelector(`${MODAL_SELECTOR} .modal`);

    return {
      capturedAt: Date.now(),
      tabKey: currentTabKey(),
      scrollTop: modalCard?.scrollTop || 0,
      controls: controls.map((el, index) => ({
        key: keyForControl(el, index),
        value: el.value,
        checked: !!el.checked,
        isCheckable: el.type === 'checkbox' || el.type === 'radio',
      })),
      activeKey: activeIndex >= 0 ? keyForControl(active, activeIndex) : '',
      selectionStart: activeIndex >= 0 && typeof active.selectionStart === 'number' ? active.selectionStart : null,
      selectionEnd: activeIndex >= 0 && typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    };
  }

  function armClearTimer() {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { draft = null; }, MAX_DRAFT_AGE_MS);
  }

  function rememberDraft() {
    const next = captureDraft();
    if (!next) return;
    draft = next;
    armClearTimer();
  }

  function restoreDraft() {
    restoreQueued = false;
    if (!draft || Date.now() - draft.capturedAt > MAX_DRAFT_AGE_MS) {
      draft = null;
      return;
    }
    const root = contentRoot();
    if (!root) return;
    const tabKey = currentTabKey();
    if (draft.tabKey && tabKey && draft.tabKey !== tabKey) return;

    const controls = [...root.querySelectorAll('input, textarea, select')]
      .filter((el) => String(el.type || '').toLowerCase() !== 'file');
    const byKey = new Map(controls.map((el, index) => [keyForControl(el, index), el]));

    for (const saved of draft.controls) {
      const el = byKey.get(saved.key);
      if (!el) continue;
      if (saved.isCheckable) el.checked = saved.checked;
      else el.value = saved.value;
    }

    const modalCard = root.closest('.modal') || document.querySelector(`${MODAL_SELECTOR} .modal`);
    if (modalCard) modalCard.scrollTop = draft.scrollTop;

    const active = draft.activeKey ? byKey.get(draft.activeKey) : null;
    if (active && typeof active.focus === 'function') {
      try {
        active.focus({ preventScroll: true });
        if (draft.selectionStart != null && typeof active.setSelectionRange === 'function') {
          active.setSelectionRange(draft.selectionStart, draft.selectionEnd ?? draft.selectionStart);
        }
      } catch (_) { /* focus restoration is best-effort */ }
    }

    // Keep the draft briefly in case the image code performs a second redraw
    // (for example after a signed URL refresh). User edits during this window
    // update the snapshot below, so a follow-up redraw still preserves them.
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { draft = null; }, 1200);
  }

  function queueRestore() {
    if (!draft || restoreQueued) return;
    restoreQueued = true;
    requestAnimationFrame(() => requestAnimationFrame(restoreDraft));
  }

  function isLoadDetailsImageTarget(target) {
    if (!(target instanceof Element)) return false;
    const root = contentRoot();
    if (!root || !root.contains(target)) return false;
    return !!target.closest(
      '[data-action="row-image-dropzone"], [data-action="upload-row-image"], .mdz-image-dropzone'
    );
  }

  function clearDraftNow() {
    draft = null;
    clearTimeout(clearTimer);
  }

  function install() {
    // Capture phase is important: remember the form before loadboard.js handles
    // the upload and eventually redraws the tab.
    document.addEventListener('change', (event) => {
      if (isLoadDetailsImageTarget(event.target)) rememberDraft();
    }, true);
    document.addEventListener('drop', (event) => {
      if (isLoadDetailsImageTarget(event.target)) rememberDraft();
    }, true);
    document.addEventListener('paste', (event) => {
      if (isLoadDetailsImageTarget(event.target)) rememberDraft();
    }, true);

    // If the dispatcher continues editing during a follow-up image refresh,
    // keep the draft current rather than restoring an older version.
    document.addEventListener('input', (event) => {
      if (!draft) return;
      const root = contentRoot();
      if (root?.contains(event.target) && !isLoadDetailsImageTarget(event.target)) rememberDraft();
    }, true);

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-ld-save], #ld-tabs .ld-tab, #ld-close, [data-ld-close]')) clearDraftNow();
    }, true);

    const root = contentRoot();
    if (root) new MutationObserver(queueRestore).observe(root, { childList: true, subtree: true });

    // #ld-tab-content itself is stable today, but watch for a future full
    // replacement too so this guard remains effective if the modal evolves.
    new MutationObserver(() => {
      const nextRoot = contentRoot();
      if (draft && nextRoot) queueRestore();
    }).observe(document.body, { childList: true, subtree: true });

    const modal = document.querySelector(MODAL_SELECTOR);
    if (modal) {
      new MutationObserver(() => {
        if (modal.classList.contains('hidden')) clearDraftNow();
      }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
