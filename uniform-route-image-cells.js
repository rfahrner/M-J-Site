/*
 * Keep the IMAGE column visually identical on every load board.
 *
 * The underlying uploader already supports multiple images. This file only
 * normalizes the presentation so an occupied cell still leaves an obvious
 * place to add another image. It intentionally does not touch board state,
 * saving, realtime, focus, or cursor behavior.
 */

const DROPZONE_SELECTOR = '.mdz-image-dropzone[data-action="row-image-dropzone"], #mondelez-table .mdz-image-dropzone';
let observer = null;
let scheduled = false;

function installStyles() {
  if (document.getElementById('uniform-route-image-cell-styles')) return;
  const style = document.createElement('style');
  style.id = 'uniform-route-image-cell-styles';
  style.textContent = `
    /* One IMAGE-column footprint everywhere. The paperwork document icon can
       occupy the reserved space at the left without shrinking the dropzone. */
    table.board td.col-routeImage,
    #mondelez-table td.col-mdz-image {
      width: 164px !important;
      min-width: 164px !important;
      max-width: 164px !important;
    }

    table.board td.col-routeImage:has(.mjapp-paperwork-indicator) {
      width: 164px !important;
      min-width: 164px !important;
      max-width: 164px !important;
    }

    .mjapp-image-cell-wrap {
      width: 100% !important;
      display: flex !important;
      align-items: center !important;
      justify-content: flex-end !important;
      gap: 5px !important;
    }

    .mdz-image-dropzone.mj-uniform-route-image-cell {
      box-sizing: border-box !important;
      width: 124px !important;
      min-width: 124px !important;
      max-width: 124px !important;
      min-height: 32px !important;
      padding: 2px 4px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: flex-start !important;
      align-content: center !important;
      flex-wrap: wrap !important;
      gap: 4px !important;
    }

    td.col-routeImage > .mdz-image-dropzone.mj-uniform-route-image-cell,
    td.col-mdz-image > .mdz-image-dropzone.mj-uniform-route-image-cell {
      margin-left: auto !important;
      margin-right: 0 !important;
    }

    .mdz-image-dropzone.mj-uniform-route-image-cell .mdz-thumb-wrap {
      flex: 0 0 26px;
      width: 26px;
      height: 26px;
      margin: 0;
    }

    .mdz-image-dropzone.mj-uniform-route-image-cell .mdz-route-thumb {
      width: 26px !important;
      height: 26px !important;
      display: block;
    }

    /* Persistent add-more area. Empty cells use the same slot for the full
       Drop / paste / click hint; occupied cells keep a compact + Add target. */
    .mdz-image-dropzone.mj-uniform-route-image-cell .mdz-upload-hint.mj-image-add-slot {
      min-width: 30px;
      height: 26px;
      padding: 0 4px;
      flex: 1 1 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      border-left: 1px solid var(--line, #dbe1eb);
      font-size: 9px;
      font-weight: 700;
      color: var(--slate-500, #64748b);
      pointer-events: none;
    }

    .mdz-image-dropzone.mj-uniform-route-image-cell .mdz-upload-hint.mj-image-add-slot.mj-image-empty-slot {
      width: 100%;
      min-width: 100%;
      flex-basis: 100%;
      border-left: 0;
      font-weight: 500;
    }
  `;
  document.head.appendChild(style);
}

function normalizeDropzone(dropzone) {
  if (!(dropzone instanceof HTMLElement)) return;
  dropzone.classList.add('mj-uniform-route-image-cell');

  const hasImages = !!dropzone.querySelector('.mdz-thumb-wrap, .mdz-route-thumb');
  let hint = dropzone.querySelector('.mdz-upload-hint');

  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'mdz-upload-hint';
    const fileInput = dropzone.querySelector('.mdz-hidden-file-input, input[type="file"]');
    dropzone.insertBefore(hint, fileInput || null);
  }

  hint.classList.add('mj-image-add-slot');
  hint.classList.toggle('mj-image-empty-slot', !hasImages);
  hint.textContent = hasImages ? '+ Add' : 'Drop / paste / click';
}

function normalizeAll() {
  scheduled = false;
  document.querySelectorAll(DROPZONE_SELECTOR).forEach(normalizeDropzone);
}

function scheduleNormalize() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(normalizeAll);
}

function init() {
  installStyles();
  normalizeAll();
  observer = new MutationObserver(scheduleNormalize);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

window.addEventListener('beforeunload', () => observer?.disconnect());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
