/*
 * Makes the temporary Time Sheet Image thumbnail in the Complete Shift modal
 * behave like every other route-image thumbnail: click it to open the shared
 * full-size viewer (zoom / pan / rotate included).
 */
import { viewRowImage } from './loadboard.js';

const STYLE_ID = 'timesheet-image-preview-style';

function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #tsc-timesheet-image-zone .tsc-timesheet-preview .mdz-route-thumb {
      cursor: zoom-in !important;
    }
  `;
  document.head.appendChild(style);
}

function refreshThumbnailHint() {
  const img = document.querySelector('#tsc-timesheet-image-zone .tsc-timesheet-preview .mdz-route-thumb');
  if (!img) return;
  img.title = 'Click to view full size';
  img.setAttribute('role', 'button');
  img.tabIndex = 0;
}

function openPreview(img) {
  const src = img?.currentSrc || img?.src || '';
  if (!src) return;
  viewRowImage(
    { routeImageUrl: src, routeImageUrls: [src] },
    'Time Sheet',
    0,
    () => document.querySelector('#tsc-timesheet-image-zone [data-tsc-delete-image]')?.click(),
  );
}

function handleActivate(event) {
  const img = event.target.closest?.('#tsc-timesheet-image-zone .tsc-timesheet-preview .mdz-route-thumb');
  if (!img) return;
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  openPreview(img);
}

function init() {
  installStyle();
  refreshThumbnailHint();
  document.addEventListener('click', handleActivate);
  document.addEventListener('keydown', handleActivate);
  new MutationObserver(refreshThumbnailHint).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
