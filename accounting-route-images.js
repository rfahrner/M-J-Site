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

    // Keep one group for every Accounting route, even if that route has no
    // image. The Load Details route tabs are in the same route-number order,
    // so retaining the empty groups lets us match an image to the exact tab
    // instead of guessing from the visible label (labels can be duplicated).
    activeRouteGroups = (routes || []).map((route) => ({
      routeNumber: route.route_number,
      sourceTripId: route.source_trip_id,
      label: String(route.route_id || route.trip_id || `Route ${route.route_number || ''}`).trim(),
      paths: parseImagePaths(route.route_image_path),
      urls: [],
    }));

    const refs = [];
    activeRouteGroups.forEach((group, groupIndex) => {
      group.paths.forEach((path, imageIndex) => refs.push({ path, groupIndex, imageIndex }));
    });

    if (!refs.length) {
      injectAccountingImages();
      return;
    }

    const { data: signed, error: signError } = await supabaseClient.storage
      .from(ROUTE_IMAGE_BUCKET)
      .createSignedUrls(refs.map((r) => r.path), SIGNED_URL_SECONDS);
    if (signError) throw signError;
    if (serial !== requestSerial || activeAccountingId !== id) return;

    refs.forEach((ref, index) => {
      const url = signed && signed[index] && signed[index].signedUrl;
      if (!url || !activeRouteGroups[ref.groupIndex]) return;
      activeRouteGroups[ref.groupIndex].urls[ref.imageIndex] = url;
    });
    activeRouteGroups.forEach((group) => { group.urls = group.urls.filter(Boolean); });
    injectAccountingImages();
  } catch (e) {
    console.error('Failed to load Accounting route images:', e);
  }
}

function injectAccountingTripSheetImages() {
  if (injecting || !activeAccountingId || !activeRouteGroups.length) return;
  const activeTab = document.querySelector('#ld-tabs .ld-tab.is-active[data-tab="images"]');
  const gallery = document.getElementById('ld-image-gallery');
  if (!activeTab || !gallery) return;
  if (gallery.querySelector('[data-accounting-route-image="true"]')) return;

  const groupsWithImages = activeRouteGroups.filter((group) => group.urls.length);
  if (!groupsWithImages.length) return;

  injecting = true;
  try {
    [...gallery.children].forEach((child) => {
      if (child.classList.contains('subtext') && /no trip sheet images/i.test(child.textContent || '')) child.remove();
    });

    groupsWithImages.forEach((group) => {
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

function activeRouteGroup() {
  const routeTabs = [...document.querySelectorAll('#ld-tabs .ld-tab[data-tab^="trip-"]')];
  const activeTab = routeTabs.find((tab) => tab.classList.contains('is-active'));
  if (!activeTab) return null;

  const index = routeTabs.indexOf(activeTab);
  if (index >= 0 && activeRouteGroups[index]) return activeRouteGroups[index];

  // Fallback only. Normally the route-number order above is exact; matching
  // by label covers older Accounting rows whose route list is incomplete.
  const label = String(activeTab.textContent || '').trim();
  return activeRouteGroups.find((group) => group.label === label) || null;
}

function injectAccountingRouteTabImages() {
  if (injecting || !activeAccountingId || !activeRouteGroups.length) return;
  const activeTab = document.querySelector('#ld-tabs .ld-tab.is-active[data-tab^="trip-"]');
  const body = document.getElementById('ld-tab-content');
  if (!activeTab || !body) return;

  const group = activeRouteGroup();
  if (!group || !group.urls.length) return;

  // Every route tab already has the normal Image dropzone. Populate that
  // same field with the Accounting copy rather than adding a second image
  // section somewhere else in the modal.
  const dropzone = body.querySelector('.mdz-image-dropzone[data-action="row-image-dropzone"]');
  if (!dropzone) return;
  if (dropzone.querySelector('[data-accounting-route-thumb="true"]')) return;

  // If the core modal already has signed native thumbnails, do not duplicate
  // them. This also makes the helper future-proof if the Accounting opener is
  // later changed to hydrate route URLs directly.
  if (dropzone.querySelector('.mdz-route-thumb')) return;

  injecting = true;
  try {
    const hint = dropzone.querySelector('.mdz-upload-hint');
    if (hint) hint.remove();
    const fileInput = dropzone.querySelector('input[type="file"]');

    group.urls.forEach((url, imageIndex) => {
      const wrap = document.createElement('div');
      wrap.className = 'mdz-thumb-wrap';
      wrap.dataset.accountingRouteThumb = 'true';

      const img = document.createElement('img');
      img.className = 'mdz-route-thumb';
      img.dataset.accountingRouteThumb = 'true';
      img.src = url;
      img.alt = `${group.label} image ${imageIndex + 1}`;
      img.title = 'Click to view full size';
      img.addEventListener('click', (event) => {
        // The parent dropzone normally treats any unhandled click as an
        // upload request. Stop this thumbnail click there and open the viewer.
        event.preventDefault();
        event.stopPropagation();
        viewRowImage(
          { routeImageUrls: group.urls.slice(), routeImageUrl: group.urls[0] || '' },
          group.label,
          imageIndex,
        );
      });

      wrap.appendChild(img);
      dropzone.insertBefore(wrap, fileInput || null);
    });
  } finally {
    injecting = false;
  }
}

function injectAccountingImages() {
  injectAccountingTripSheetImages();
  injectAccountingRouteTabImages();
}

function init() {
  if ((location.pathname.split('/').pop() || '') !== 'accounting.html') return;

  document.addEventListener('click', (event) => {
    const accountingButton = event.target.closest('[data-open-acct-load]');
    if (accountingButton && accountingButton.dataset.openAcctLoad) {
      loadAccountingRouteImages(accountingButton.dataset.openAcctLoad);
      return;
    }

    const loadDetailsTab = event.target.closest('#ld-tabs .ld-tab');
    if (loadDetailsTab) setTimeout(injectAccountingImages, 0);
  }, true);

  const modal = document.getElementById('modal-load-details');
  if (modal) {
    const observer = new MutationObserver(() => injectAccountingImages());
    observer.observe(modal, { childList: true, subtree: true });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
