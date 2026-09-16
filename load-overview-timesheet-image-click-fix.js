import './alert-text-button-fix.js';

/*
 * Prevent image dropzones from recursively re-clicking their own hidden file
 * inputs.
 *
 * Both Load Details > Overview Time Sheet Image and the shared route-image
 * dropzones open the browser picker with input.click(). That synthetic click
 * bubbles back through the dropzone handler; without an early guard the same
 * handler calls input.click() again and the picker can fail to open entirely.
 *
 * Stop propagation only for the hidden file input's own click. We do NOT call
 * preventDefault(), so the browser's normal file-picker action still runs.
 */
(() => {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    const isOverviewTimeSheet = target.id === 'ld-overview-timesheet-image-input';
    const isSharedRouteImage = target.matches('input[type="file"][data-action="upload-row-image"]');
    if (!isOverviewTimeSheet && !isSharedRouteImage) return;

    event.stopImmediatePropagation();
  }, true);
})();
