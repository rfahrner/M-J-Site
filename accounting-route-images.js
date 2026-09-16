import { supabaseClient, viewRowImage } from './loadboard.js';

const ACCOUNTING_ROUTES_TABLE = 'loads_accounting_routes';
const ROUTE_IMAGE_BUCKET = 'mondelez-routes';
const SIGNED_URL_SECONDS = 3600;

let activeAccountingId = null;
let activeRouteGroups = [];
let requestSerial = 0;
let injecting = false;

function parseImagePaths(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (e) {
      console.warn('Could not parse Accounting route image list:', e);
    }
  }
  return [raw];
}

async function loadAccountingRouteImages(accountingId) {
  const id = String(accountingId || '').trim();
  if (!id || !supabaseClient) return;

  activeAccountingId = id;
  activeRouteGroups = [];
  const serial = ++requestSerial;

  try {
    const { data: routes, error } = await supabaseClient
      .from(ACCOUNTING_ROUTES_TABLE)
      .select('route_number, route_id, trip_id, source_trip_id, route_image_path')
      .eq('accounting_id', id)
      .order('route_number', { ascending: true });
    if (error) throw error;
    if (serial !== requestSerial || activeAccountingId !== id) return;

    const refs = [];
    (routes || []).forEach((route) => {
      const paths = parseImagePaths(route.route_image_path);
      if (!paths.length) return;
      const label = String(route.route_id || route.trip_id || `Route ${route.route_number || ''}`).trim();
      paths.forEach((path, imageIndex) => refs.push({
        path,
        routeNumber: route.route_number,
        label,
        imageIndex,
      }));
    });

    if (!refs.length) {
      activeRouteGroups = [];
      injectAccountingRouteImages();
      return;
    }

    const { data: signed, error: signError } = await supabaseClient.storage
      .from(ROUTE_IMAGE_BUCKET)
      .createSignedUrls(refs.map((r) => r.path), SIGNED_URL_SECONDS);
    if (signError) throw signError;
    if (serial !== requestSerial || activeAccountingId !== id) return;

    const byRoute = new Map();
    refs.forEach((ref, index) => {
      const url = signed && signed[index] && signed[index].signedUrl;
      if (!url) return;
      const key = `${ref.routeNumber ?? ''}|${ref.label}`;
      if (!byRoute.has(key)) byRoute.set(key, { label: ref.label, routeNumber: ref.routeNumber, urls: [] });
      byRoute.get(key).urls.push(url);
    });
    activeRouteGroups = [...byRoute.values()].filter((group) => group.urls.length);
    injectAccountingRouteImages();
  } catch (e) {
    console.error('Failed to load Accounting route images:', e);
  }
}

function injectAccountingRouteImages() {
  if (injecting || !activeAccountingId || !activeRouteGroups.length) return;
  const activeTab = document.querySelector('#ld-tabs .ld-tab.is-active[data-tab="images"]');
  const gallery = document.getElementById('ld-image-gallery');
  if (!activeTab || !gallery) return;
  if (gallery.querySelector('[data-accounting-route-image="true"]')) return;

  injecting = true;
  try {
    [...gallery.children].forEach((child) => {
      if (child.classList.contains('subtext') && /no trip sheet images/i.test(child.textContent || '')) child.remove();
    });

    activeRouteGroups.forEach((group) => {
      group.urls.forEach((url, imageIndex) => {
        const item = document.createElement('div');
        item.className = 'ld-image-item';
        item.dataset.accountingRouteImage = 'true';

        const img = document.createElement('img');
        img.className = 'ld-image-thumb';
        img.src = url;
        img.alt = `${group.label}${group.urls.length > 1 ? ` — Image ${imageIndex + 1}` : ''}`;
        img.title = 'Click to enlarge';
        img.addEventListener('click', () => {
          viewRowImage(
            { routeImageUrls: group.urls.slice(), routeImageUrl: group.urls[0] || '' },
            group.label,
            imageIndex,
          );
        });

        const label = document.createElement('div');
        label.className = 'subtext';
        label.textContent = `${group.label}${group.urls.length > 1 ? ` — Image ${imageIndex + 1}` : ''}`;

        item.append(img, label);
        gallery.appendChild(item);
      });
    });
  } finally {
    injecting = false;
  }
}

function init() {
  if ((location.pathname.split('/').pop() || '') !== 'accounting.html') return;

  document.addEventListener('click', (event) => {
    const accountingButton = event.target.closest('[data-open-acct-load]');
    if (accountingButton && accountingButton.dataset.openAcctLoad) {
      loadAccountingRouteImages(accountingButton.dataset.openAcctLoad);
      return;
    }

    const imagesTab = event.target.closest('#ld-tabs .ld-tab[data-tab="images"]');
    if (imagesTab) setTimeout(injectAccountingRouteImages, 0);
  }, true);

  const modal = document.getElementById('modal-load-details');
  if (modal) {
    const observer = new MutationObserver(() => injectAccountingRouteImages());
    observer.observe(modal, { childList: true, subtree: true });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
