/*
 * Prevent the Load Details > Overview Time Sheet Image picker from
 * recursively re-clicking its own hidden file input.
 *
 * load-overview-timesheet-image.js listens for clicks on the whole dropzone.
 * A programmatic input.click() produces another click whose target is the
 * hidden input inside that same dropzone. Without this early capture guard,
 * that second click is treated like another dropzone click and the picker can
 * fail to open (or recurse). Stop propagation for the input's own click while
 * leaving the browser's default file-picker action intact.
 */
(() => {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id !== 'ld-overview-timesheet-image-input') return;
    event.stopImmediatePropagation();
  }, true);
})();
