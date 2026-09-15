/*
 * Multi-image route viewer scrolling.
 *
 * The shared image viewer normally treats the mouse wheel as zoom and keeps
 * the stage overflow hidden. That works for one image, but when a route has
 * several images stacked in the gallery the later images are clipped below
 * the viewport and the wheel cannot reach them.
 *
 * Keep the single-image viewer unchanged. For gallery viewers only, stack
 * images vertically, make the stage vertically scrollable, and let an
 * ordinary mouse-wheel gesture scroll the gallery. Zoom buttons and rotate
 * still work exactly as before; Ctrl/Cmd + wheel is left alone for zoom.
 */

(() => {
  const STYLE_ID = 'multi-image-viewer-scroll-style';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .image-viewer-stage:has(.image-viewer-gallery) {
        overflow-y: auto !important;
        overflow-x: hidden !important;
        align-items: flex-start !important;
        justify-content: center !important;
        touch-action: pan-y !important;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
      }
      .image-viewer-stage .image-viewer-gallery {
        flex-direction: column !important;
        flex-wrap: nowrap !important;
        justify-content: flex-start !important;
        align-items: center !important;
        width: 100% !important;
        max-width: 100% !important;
        max-height: none !important;
        overflow: visible !important;
        padding-bottom: 18px;
      }
      .image-viewer-stage .image-viewer-gallery img {
        flex: 0 0 auto;
        max-width: min(94vw, 1100px) !important;
        max-height: calc(100vh - 120px) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // wireImageViewer() normally intercepts every wheel event to zoom. For a
  // gallery, an unmodified wheel should instead perform native vertical
  // scrolling so image 2, image 3, etc. are reachable. Holding Ctrl/Cmd still
  // reaches the existing zoom handler.
  document.addEventListener('wheel', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const stage = target?.closest('.image-viewer-stage');
    if (!stage || !stage.querySelector('.image-viewer-gallery')) return;
    if (event.ctrlKey || event.metaKey) return;
    event.stopImmediatePropagation();
  }, { capture: true, passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureStyles, { once: true });
  } else {
    ensureStyles();
  }
})();
