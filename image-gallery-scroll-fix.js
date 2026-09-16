/*
 * Multi-image route viewer pagination.
 *
 * Each uploaded image gets its own full-screen page. The viewer keeps the
 * original stored image source untouched, so switching between images never
 * introduces any re-encoding/downsampling. Zoom, pan and 90-degree rotation
 * continue to come from the shared wireImageViewer() behavior.
 */

(() => {
  const STYLE_ID = 'multi-image-viewer-pager-style';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .image-viewer-stage:has(.image-viewer-gallery) {
        overflow: hidden !important;
        align-items: center !important;
        justify-content: center !important;
        touch-action: none !important;
      }
      .image-viewer-stage .image-viewer-gallery {
        display: flex !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        justify-content: center !important;
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        max-height: 100% !important;
        overflow: hidden !important;
        padding: 0 !important;
      }
      .image-viewer-stage .image-viewer-gallery img {
        display: none !important;
        width: auto !important;
        height: auto !important;
        max-width: 100% !important;
        max-height: 100% !important;
        object-fit: contain !important;
        flex: 0 0 auto;
      }
      .image-viewer-stage .image-viewer-gallery img.is-active-image {
        display: block !important;
      }
      .image-viewer-pager {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        z-index: 100001;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 7px 10px;
        border: 1px solid rgba(148, 163, 184, .55);
        border-radius: 999px;
        background: rgba(255, 255, 255, .96);
        box-shadow: 0 6px 18px rgba(15, 23, 42, .24);
        backdrop-filter: blur(6px);
      }
      .image-viewer-pager .btn {
        min-width: 36px;
        height: 32px;
        padding: 0 10px !important;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        line-height: 1;
      }
      .image-viewer-page-count {
        min-width: 54px;
        text-align: center;
        font-size: 12px;
        font-weight: 700;
        color: var(--slate-700, #334155);
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }

  function activeIndex(images) {
    const index = images.findIndex((img) => img.classList.contains('is-active-image'));
    return index >= 0 ? index : 0;
  }

  function wirePagedViewer(overlay) {
    if (!overlay || overlay.dataset.galleryPagerWired === '1') return;
    const gallery = overlay.querySelector('.image-viewer-gallery');
    if (!gallery) return;
    const images = [...gallery.querySelectorAll('img')];
    if (images.length < 2) return;

    overlay.dataset.galleryPagerWired = '1';

    const pager = document.createElement('div');
    pager.className = 'image-viewer-pager';
    pager.dataset.viewerPager = '1';

    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'btn btn-ghost';
    previous.dataset.viewerPrevious = '1';
    previous.title = 'Previous image';
    previous.setAttribute('aria-label', 'Previous image');
    previous.textContent = '‹';

    const count = document.createElement('span');
    count.className = 'image-viewer-page-count';
    count.dataset.viewerPageCount = '1';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-ghost';
    next.dataset.viewerNext = '1';
    next.title = 'Next image';
    next.setAttribute('aria-label', 'Next image');
    next.textContent = '›';

    pager.append(previous, count, next);
    overlay.appendChild(pager);

    const refresh = () => {
      const index = activeIndex(images);
      count.textContent = `${index + 1} / ${images.length}`;
      previous.disabled = index <= 0;
      next.disabled = index >= images.length - 1;
    };

    const select = (index) => {
      if (index < 0 || index >= images.length) return;
      // wireImageViewer owns the actual selected index, transform state and
      // reset-on-page-change behavior. A normal image click asks that shared
      // viewer to select this page instead of duplicating that logic here.
      images[index].click();
      requestAnimationFrame(refresh);
    };

    previous.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      select(activeIndex(images) - 1);
    });
    next.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      select(activeIndex(images) + 1);
    });
    gallery.addEventListener('click', () => requestAnimationFrame(refresh));

    refresh();
  }

  function scan() {
    ensureStyles();
    document.querySelectorAll('.image-lightbox-overlay').forEach(wirePagedViewer);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const overlay = [...document.querySelectorAll('.image-lightbox-overlay')].find((el) => el.isConnected && !el.classList.contains('hidden'));
    if (!overlay) return;
    const button = overlay.querySelector(event.key === 'ArrowLeft' ? '[data-viewer-previous]' : '[data-viewer-next]');
    if (button && !button.disabled) {
      event.preventDefault();
      button.click();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scan();
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    }, { once: true });
  } else {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }
})();
