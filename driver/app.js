(() => {
  'use strict';

  const API_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co/functions/v1/paperwork-pwa-submit';
  const MAX_IMAGES = 12;
  const MAX_PRO_DIGITS = 20;
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
  const UPLOAD_TIMEOUT_MS = 90_000;
  const DB_NAME = 'mj-paperwork-pwa-v1';
  const DB_VERSION = 1;
  const STORE_NAME = 'drafts';
  const DRAFT_KEY = 'active';
  const INSTALL_ID_KEY = 'mj-pwa-install-id-v1';
  const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

  const $ = (id) => document.getElementById(id);
  const driverNameInput = $('driverName');
  const locationSelect = $('locationSelect');
  const proInput = $('proNumber');
  const cameraButton = $('cameraButton');
  const libraryButton = $('libraryButton');
  const cameraInput = $('cameraInput');
  const libraryInput = $('libraryInput');
  const previewStrip = $('previewStrip');
  const imageCount = $('imageCount');
  const submitButton = $('submitButton');
  const uploadStatus = $('uploadStatus');
  const attemptControls = $('attemptControls');
  const discardButton = $('discardButton');
  const offlineCard = $('offlineCard');
  const restoredCard = $('restoredCard');
  const restoredText = $('restoredText');
  const successCard = $('successCard');
  const retryCard = $('retryCard');
  const retryText = $('retryText');
  const installCard = $('installCard');
  const installText = $('installText');
  const installButton = $('installButton');
  const installDialog = $('installDialog');
  const closeInstallDialog = $('closeInstallDialog');

  let dbPromise;
  let deferredInstallPrompt = null;
  let images = [];
  let submissionId = crypto.randomUUID();
  let attemptNumber = 0;
  let attempted = false;
  let submitting = false;
  let saveTimer = null;
  const previewUrls = new Map();

  const setHidden = (el, hidden) => el?.classList.toggle('hidden', hidden);
  const showAlert = (title, message) => window.alert(`${title}\n\n${message}`);
  const cleanName = () => driverNameInput.value.trim().replace(/\s+/g, ' ');
  const validName = () => cleanName().length >= 1 && cleanName().length <= 120;
  const validLocation = () => ['kroger_atlanta', 'kroger_delaware'].includes(locationSelect.value);
  const validPro = () => !proInput.value.trim() || /^\d{1,20}$/.test(proInput.value.trim());

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function openDb() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local storage.'));
    });
    return dbPromise;
  }
  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read saved paperwork.'));
    });
  }
  async function idbPut(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not save paperwork.'));
    });
  }
  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  function serializeImage(item) {
    return { id: item.id, name: item.file.name, type: item.file.type, lastModified: item.file.lastModified, blob: item.file };
  }
  function deserializeImage(item) {
    if (!item?.blob || !item?.name) return null;
    const file = item.blob instanceof File ? item.blob : new File([item.blob], item.name, {
      type: item.type || item.blob.type || 'image/jpeg', lastModified: item.lastModified || Date.now(),
    });
    return { id: item.id || crypto.randomUUID(), file };
  }
  function draft() {
    return {
      version: 2,
      driverName: cleanName(),
      location: locationSelect.value,
      proNumber: proInput.value.trim(),
      submissionId,
      attemptNumber,
      attempted,
      images: images.map(serializeImage),
      updatedAt: new Date().toISOString(),
    };
  }
  async function saveDraftNow() {
    const value = draft();
    if (!value.driverName && !value.location && !value.proNumber && !value.images.length && !value.attempted) return idbDelete(DRAFT_KEY);
    return idbPut(DRAFT_KEY, value);
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraftNow().catch(() => {}), 200);
  }
  async function restoreDraft() {
    const saved = await idbGet(DRAFT_KEY).catch(() => null);
    if (!saved) return;
    driverNameInput.value = String(saved.driverName || '');
    locationSelect.value = String(saved.location || '');
    proInput.value = String(saved.proNumber || '').replace(/\D/g, '').slice(0, MAX_PRO_DIGITS);
    if (saved.submissionId) submissionId = saved.submissionId;
    attemptNumber = Number(saved.attemptNumber) || 0;
    attempted = Boolean(saved.attempted);
    images = Array.isArray(saved.images) ? saved.images.map(deserializeImage).filter(Boolean) : [];
    if (driverNameInput.value || locationSelect.value || proInput.value || images.length || attempted) {
      restoredText.textContent = attempted
        ? `Attempt #${attemptNumber || 1} is preserved. Retry will send another linked copy without replacing the earlier attempt.`
        : 'Your saved name, location, Pro number, and photos were restored.';
      setHidden(restoredCard, false);
    }
  }

  function getInstallId() {
    let id = localStorage.getItem(INSTALL_ID_KEY);
    if (!id || id.length < 16) {
      id = crypto.randomUUID();
      localStorage.setItem(INSTALL_ID_KEY, id);
    }
    return id;
  }

  function totalBytes() { return images.reduce((sum, item) => sum + item.file.size, 0); }
  async function addFiles(list) {
    if (attempted || submitting) return;
    const files = [...(list || [])].slice(0, MAX_IMAGES - images.length);
    for (const file of files) {
      const type = (file.type || '').toLowerCase();
      if (!SUPPORTED_TYPES.has(type)) { showAlert('Unsupported image', `${file.name} cannot be uploaded.`); continue; }
      if (file.size < 1 || file.size > MAX_IMAGE_BYTES) { showAlert('Image too large', `${file.name} must be under 15 MB.`); continue; }
      if (totalBytes() + file.size > MAX_TOTAL_BYTES) { showAlert('Submission too large', 'The selected photos would exceed 60 MB.'); break; }
      images.push({ id: crypto.randomUUID(), file });
      await saveDraftNow().catch(() => {});
    }
    cameraInput.value = '';
    libraryInput.value = '';
    renderPreviews();
    updateUi();
  }

  function revokePreview(id) {
    const url = previewUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(id);
  }
  function renderPreviews() {
    previewStrip.replaceChildren();
    for (const [index, item] of images.entries()) {
      let url = previewUrls.get(item.id);
      if (!url) { url = URL.createObjectURL(item.file); previewUrls.set(item.id, url); }
      const wrap = document.createElement('div');
      wrap.className = 'preview-wrap';
      const img = document.createElement('img');
      img.className = 'preview'; img.src = url; img.alt = `Selected paperwork image ${index + 1}`;
      wrap.appendChild(img);
      if (!attempted) {
        const remove = document.createElement('button');
        remove.className = 'remove-photo'; remove.type = 'button'; remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove image ${index + 1}`);
        remove.onclick = () => {
          revokePreview(item.id); images = images.filter((x) => x.id !== item.id); renderPreviews(); updateUi(); scheduleSave();
        };
        wrap.appendChild(remove);
      }
      previewStrip.appendChild(wrap);
    }
  }

  function updateUi() {
    const locked = attempted || submitting;
    driverNameInput.disabled = locked;
    locationSelect.disabled = locked;
    proInput.disabled = locked;
    cameraButton.disabled = locked || images.length >= MAX_IMAGES;
    libraryButton.disabled = locked || images.length >= MAX_IMAGES;
    setHidden(offlineCard, navigator.onLine);
    imageCount.textContent = `${images.length} / ${MAX_IMAGES} ${images.length === 1 ? 'image' : 'images'}${attempted ? ' · locked for retry' : ''}`;
    submitButton.disabled = !navigator.onLine || submitting || !validName() || !validLocation() || !validPro() || !images.length;
    submitButton.textContent = submitting ? 'Sending…' : !navigator.onLine ? 'Waiting for Connection' : attempted ? 'Retry Submission' : 'Submit Paperwork';
    setHidden(attemptControls, !attempted || submitting);
    setHidden(retryCard, !attempted || submitting);
    if (attempted) retryText.textContent = `Attempt #${attemptNumber || 1} did not get a confirmed receipt. Anything the office already received remains preserved. Retry sends attempt #${(attemptNumber || 1) + 1} as a new linked addition.`;
    renderPreviews();
  }

  function headers(currentId, retryOf, retryNumber) {
    const out = { 'X-MJ-Install-ID': getInstallId(), 'X-MJ-Submission-ID': currentId };
    if (retryOf) { out['X-MJ-Retry-Of'] = retryOf; out['X-MJ-Retry-Number'] = String(retryNumber); }
    return out;
  }
  async function sendSubmission(currentId, retryOf, retryNumber) {
    const body = new FormData();
    body.append('driverName', cleanName());
    body.append('location', locationSelect.value);
    body.append('proNumber', proInput.value.trim());
    images.forEach((item, index) => body.append('images', item.file, item.file.name || `trip-sheet-${index + 1}.jpg`));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(API_URL, { method: 'POST', headers: headers(currentId, retryOf, retryNumber), body, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Paperwork submission failed. Your paperwork remains saved on this device.');
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The upload timed out. Anything that reached the office stays preserved.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function submit() {
    if (submitButton.disabled || submitting) return;
    const priorId = attempted ? submissionId : null;
    const currentId = attempted ? crypto.randomUUID() : submissionId;
    const currentAttempt = attempted ? Math.max(1, attemptNumber) + 1 : 1;
    submissionId = currentId; attemptNumber = currentAttempt; attempted = true; submitting = true;
    setHidden(successCard, true);
    uploadStatus.textContent = `Sending ${images.length} ${images.length === 1 ? 'image' : 'images'}… Keep Carrier Docs open until receipt is confirmed.`;
    setHidden(uploadStatus, false); updateUi();
    try {
      await saveDraftNow();
      await sendSubmission(currentId, priorId, currentAttempt);
      await idbDelete(DRAFT_KEY);
      images.forEach((item) => revokePreview(item.id));
      images = []; driverNameInput.value = ''; locationSelect.value = ''; proInput.value = '';
      submissionId = crypto.randomUUID(); attemptNumber = 0; attempted = false;
      setHidden(restoredCard, true); setHidden(retryCard, true); setHidden(attemptControls, true); setHidden(successCard, false);
      uploadStatus.textContent = 'Paperwork received.';
    } catch (error) {
      await saveDraftNow().catch(() => {});
      showAlert('Receipt not confirmed', `${error.message || error}\n\nRetry sends another linked copy. It does not overwrite or delete anything already received.`);
    } finally { submitting = false; updateUi(); }
  }

  async function discardLocalRetry() {
    if (!window.confirm('Start a new submission?\n\nThis clears only the saved retry on this device. It does not delete or change paperwork already received.')) return;
    await idbDelete(DRAFT_KEY);
    images.forEach((item) => revokePreview(item.id));
    images = []; driverNameInput.value = ''; locationSelect.value = ''; proInput.value = '';
    submissionId = crypto.randomUUID(); attemptNumber = 0; attempted = false;
    setHidden(restoredCard, true); setHidden(successCard, true); setHidden(uploadStatus, true); updateUi();
  }

  function configureInstallUi() {
    if (isStandalone()) return setHidden(installCard, true);
    if (isIos()) {
      installText.textContent = 'Add Carrier Docs to your iPhone Home Screen for one-tap access.';
      installButton.textContent = 'How to Install'; setHidden(installCard, false);
      installButton.onclick = () => installDialog.showModal();
    }
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); deferredInstallPrompt = event; installButton.textContent = 'Install';
      installText.textContent = 'Install Carrier Docs on this device for one-tap access.'; setHidden(installCard, false);
    });
  }

  async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    configureInstallUi();
    await restoreDraft(); updateUi();
    for (const input of [driverNameInput, locationSelect, proInput]) input.addEventListener('input', () => {
      if (attempted) return;
      if (input === proInput) proInput.value = proInput.value.replace(/\D/g, '').slice(0, MAX_PRO_DIGITS);
      setHidden(restoredCard, true); setHidden(successCard, true); scheduleSave(); updateUi();
    });
    locationSelect.addEventListener('change', () => { scheduleSave(); updateUi(); });
    cameraButton.onclick = () => cameraInput.click(); libraryButton.onclick = () => libraryInput.click();
    cameraInput.onchange = () => addFiles(cameraInput.files); libraryInput.onchange = () => addFiles(libraryInput.files);
    submitButton.onclick = submit; discardButton.onclick = discardLocalRetry; closeInstallDialog.onclick = () => installDialog.close();
    installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      const prompt = deferredInstallPrompt; deferredInstallPrompt = null; await prompt.prompt(); await prompt.userChoice.catch(() => null);
    });
    window.addEventListener('online', updateUi); window.addEventListener('offline', updateUi);
    window.addEventListener('pagehide', () => { if (!submitting) saveDraftNow().catch(() => {}); });
  }

  void init();
})();
