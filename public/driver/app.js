(() => {
  'use strict';

  const API_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co/functions/v1/paperwork-pwa-submit';
  const MAX_IMAGES = 12;
  const MAX_PRO_DIGITS = 20;
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
  const MAX_LONG_EDGE = 2000;
  const JPEG_QUALITY = 0.82;
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
  const processingRow = $('processingRow');
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
  let processing = false;
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
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open local storage.'));
      });
    }
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
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not save paperwork on this device.'));
      tx.onabort = () => reject(tx.error || new Error('Could not save paperwork on this device.'));
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not clear saved paperwork.'));
      tx.onabort = () => reject(tx.error || new Error('Could not clear saved paperwork.'));
    });
  }

  function serializeImage(item) {
    return {
      id: item.id,
      name: item.file.name,
      type: item.file.type,
      lastModified: item.file.lastModified,
      blob: item.file,
    };
  }

  function deserializeImage(item) {
    if (!item?.blob || !item?.name) return null;
    const file = item.blob instanceof File ? item.blob : new File([item.blob], item.name, {
      type: item.type || item.blob.type || 'image/jpeg',
      lastModified: Number(item.lastModified) || Date.now(),
    });
    return { id: item.id || crypto.randomUUID(), file };
  }

  function buildDraft() {
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
    const value = buildDraft();
    const hasContent = value.driverName || value.location || value.proNumber || value.images.length || value.attempted;
    if (!hasContent) {
      await idbDelete(DRAFT_KEY).catch(() => {});
      return;
    }
    await idbPut(DRAFT_KEY, value);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveDraftNow().catch((error) => console.warn('Draft autosave failed', error));
    }, 250);
  }

  async function restoreDraft() {
    try {
      const saved = await idbGet(DRAFT_KEY);
      if (!saved) return;
      driverNameInput.value = String(saved.driverName || '');
      locationSelect.value = String(saved.location || '');
      proInput.value = String(saved.proNumber || '').replace(/\D/g, '').slice(0, MAX_PRO_DIGITS);
      if (typeof saved.submissionId === 'string' && saved.submissionId) submissionId = saved.submissionId;
      attemptNumber = Number.isInteger(saved.attemptNumber) && saved.attemptNumber >= 0 ? saved.attemptNumber : 0;
      attempted = Boolean(saved.attempted);
      images = Array.isArray(saved.images) ? saved.images.map(deserializeImage).filter(Boolean) : [];
      if (driverNameInput.value || locationSelect.value || proInput.value || images.length || attempted) {
        restoredText.textContent = attempted
          ? `Attempt #${attemptNumber || 1} is preserved. Retry will send another linked copy without replacing the earlier attempt.`
          : 'Your saved name, location, Pro number, and photos were restored.';
        setHidden(restoredCard, false);
      }
    } catch (error) {
      console.warn('Could not restore saved paperwork', error);
    }
  }

  function getInstallId() {
    let value = localStorage.getItem(INSTALL_ID_KEY);
    if (!value || value.length < 16) {
      value = crypto.randomUUID();
      localStorage.setItem(INSTALL_ID_KEY, value);
    }
    return value;
  }

  function totalBytes(list = images) {
    return list.reduce((sum, item) => sum + item.file.size, 0);
  }

  async function decodeImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  async function prepareFile(file) {
    const type = (file.type || '').toLowerCase();
    if (!SUPPORTED_TYPES.has(type)) throw new Error(`${file.name || 'This photo'} uses an unsupported image type.`);
    try {
      const img = await decodeImage(file);
      const sourceWidth = img.naturalWidth || img.width;
      const sourceHeight = img.naturalHeight || img.height;
      if (!sourceWidth || !sourceHeight) return file;
      const scale = Math.min(1, MAX_LONG_EDGE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return file;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (!blob?.size) return file;
      const base = (file.name || 'paperwork').replace(/\.[^.]+$/, '');
      return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    } catch (error) {
      console.warn('Image compression skipped', error);
      return file;
    }
  }

  async function addFiles(fileList) {
    if (attempted || processing || submitting) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const available = Math.max(0, MAX_IMAGES - images.length);
    if (!available) {
      showAlert('Photo limit reached', `You can submit up to ${MAX_IMAGES} images at a time.`);
      return;
    }
    const selected = files.slice(0, available);
    if (files.length > available) showAlert('Photo limit', `Only the first ${available} ${available === 1 ? 'photo' : 'photos'} will be added.`);

    processing = true;
    setHidden(processingRow, false);
    updateUi();
    try {
      for (const original of selected) {
        if (!SUPPORTED_TYPES.has((original.type || '').toLowerCase())) {
          showAlert('Unsupported image', `${original.name || 'This photo'} cannot be uploaded.`);
          continue;
        }
        const file = await prepareFile(original);
        if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
          showAlert('Image too large', `${file.name || 'This photo'} must be under 15 MB.`);
          continue;
        }
        if (totalBytes() + file.size > MAX_TOTAL_BYTES) {
          showAlert('Submission too large', 'The selected photos would exceed the 60 MB submission limit.');
          break;
        }
        images.push({ id: crypto.randomUUID(), file });
        try {
          await saveDraftNow();
        } catch (error) {
          images.pop();
          showAlert('Could not save photo', 'This photo could not be safely saved on the device, so it was not added. Free some storage and try again.');
          console.error('Draft image save failed', error);
          break;
        }
      }
    } finally {
      processing = false;
      setHidden(processingRow, true);
      cameraInput.value = '';
      libraryInput.value = '';
      renderPreviews();
      updateUi();
    }
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
      if (!url) {
        url = URL.createObjectURL(item.file);
        previewUrls.set(item.id, url);
      }
      const wrap = document.createElement('div');
      wrap.className = 'preview-wrap';
      const img = document.createElement('img');
      img.className = 'preview';
      img.src = url;
      img.alt = `Selected paperwork image ${index + 1}`;
      wrap.appendChild(img);
      if (!attempted) {
        const remove = document.createElement('button');
        remove.className = 'remove-photo';
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove image ${index + 1}`);
        remove.onclick = async () => {
          const oldImages = images;
          images = images.filter((x) => x.id !== item.id);
          try {
            await saveDraftNow();
            revokePreview(item.id);
          } catch (error) {
            images = oldImages;
            showAlert('Could not update saved paperwork', 'The photo was not removed because the updated draft could not be safely saved.');
          }
          renderPreviews();
          updateUi();
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
    cameraButton.disabled = locked || processing || images.length >= MAX_IMAGES;
    libraryButton.disabled = locked || processing || images.length >= MAX_IMAGES;
    setHidden(offlineCard, navigator.onLine);
    imageCount.textContent = `${images.length} / ${MAX_IMAGES} ${images.length === 1 ? 'image' : 'images'}${attempted ? ' · locked for retry' : ''}`;
    submitButton.disabled = !navigator.onLine || processing || submitting || !validName() || !validLocation() || !validPro() || !images.length;
    submitButton.textContent = submitting ? 'Sending…' : !navigator.onLine ? 'Waiting for Connection' : attempted ? 'Retry Submission' : 'Submit Paperwork';
    setHidden(attemptControls, !attempted || submitting);
    setHidden(retryCard, !attempted || submitting);
    if (attempted) retryText.textContent = `Attempt #${attemptNumber || 1} did not get a confirmed receipt. Anything the office already received remains preserved. Retry sends attempt #${(attemptNumber || 1) + 1} as a new linked addition.`;
    renderPreviews();
  }

  function requestHeaders(currentId, retryOf, retryNumber) {
    const out = { 'X-MJ-Install-ID': getInstallId(), 'X-MJ-Submission-ID': currentId };
    if (retryOf) {
      out['X-MJ-Retry-Of'] = retryOf;
      out['X-MJ-Retry-Number'] = String(retryNumber);
    }
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
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: requestHeaders(currentId, retryOf, retryNumber),
        body,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Paperwork submission failed. Your paperwork remains saved on this device.');
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The upload timed out. Anything that reached the office stays preserved.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function submit() {
    if (submitButton.disabled || submitting) return;
    const priorId = attempted ? submissionId : null;
    const currentId = attempted ? crypto.randomUUID() : submissionId;
    const currentAttempt = attempted ? Math.max(1, attemptNumber) + 1 : 1;
    const priorState = { submissionId, attemptNumber, attempted };
    submissionId = currentId;
    attemptNumber = currentAttempt;
    attempted = true;

    // Persist the exact locked attempt before any network I/O. If this fails,
    // do not upload because we could no longer guarantee a safe additive retry.
    try {
      await saveDraftNow();
    } catch (error) {
      submissionId = priorState.submissionId;
      attemptNumber = priorState.attemptNumber;
      attempted = priorState.attempted;
      showAlert('Could not save submission safely', 'Carrier Docs could not preserve this attempt on the device, so nothing was uploaded. Free some storage and try again.');
      updateUi();
      return;
    }

    submitting = true;
    setHidden(successCard, true);
    uploadStatus.textContent = `Sending ${images.length} ${images.length === 1 ? 'image' : 'images'}… Keep Carrier Docs open until receipt is confirmed.`;
    setHidden(uploadStatus, false);
    updateUi();
    try {
      await sendSubmission(currentId, priorId, currentAttempt);
      await idbDelete(DRAFT_KEY).catch((error) => console.warn('Could not clear successful local draft', error));
      images.forEach((item) => revokePreview(item.id));
      images = [];
      driverNameInput.value = '';
      locationSelect.value = '';
      proInput.value = '';
      submissionId = crypto.randomUUID();
      attemptNumber = 0;
      attempted = false;
      setHidden(restoredCard, true);
      setHidden(retryCard, true);
      setHidden(attemptControls, true);
      setHidden(successCard, false);
      uploadStatus.textContent = 'Paperwork received.';
    } catch (error) {
      await saveDraftNow().catch(() => {});
      showAlert('Receipt not confirmed', `${error.message || error}\n\nRetry sends another linked copy. It does not overwrite or delete anything already received.`);
    } finally {
      submitting = false;
      updateUi();
    }
  }

  async function discardLocalRetry() {
    if (!window.confirm('Start a new submission?\n\nThis clears only the saved retry on this device. It does not delete or change paperwork already received.')) return;
    try {
      await idbDelete(DRAFT_KEY);
    } catch (error) {
      showAlert('Could not clear local draft', 'Carrier Docs could not safely clear the saved retry on this device.');
      return;
    }
    images.forEach((item) => revokePreview(item.id));
    images = [];
    driverNameInput.value = '';
    locationSelect.value = '';
    proInput.value = '';
    submissionId = crypto.randomUUID();
    attemptNumber = 0;
    attempted = false;
    setHidden(restoredCard, true);
    setHidden(successCard, true);
    setHidden(uploadStatus, true);
    updateUi();
  }

  function configureInstallUi() {
    if (isStandalone()) {
      setHidden(installCard, true);
      return;
    }
    if (isIos()) {
      installText.textContent = 'Add Carrier Docs to your iPhone Home Screen for one-tap access.';
      installButton.textContent = 'How to Install';
      setHidden(installCard, false);
      installButton.onclick = () => installDialog.showModal();
    }
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.textContent = 'Install';
      installText.textContent = 'Install Carrier Docs on this device for one-tap access.';
      setHidden(installCard, false);
    });
  }

  async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
    configureInstallUi();
    await restoreDraft();
    updateUi();

    driverNameInput.addEventListener('input', () => {
      if (attempted) return;
      setHidden(restoredCard, true);
      setHidden(successCard, true);
      scheduleSave();
      updateUi();
    });
    locationSelect.addEventListener('change', () => {
      if (attempted) return;
      setHidden(restoredCard, true);
      setHidden(successCard, true);
      scheduleSave();
      updateUi();
    });
    proInput.addEventListener('input', () => {
      if (attempted) return;
      proInput.value = proInput.value.replace(/\D/g, '').slice(0, MAX_PRO_DIGITS);
      setHidden(restoredCard, true);
      setHidden(successCard, true);
      scheduleSave();
      updateUi();
    });

    cameraButton.onclick = () => cameraInput.click();
    libraryButton.onclick = () => libraryInput.click();
    cameraInput.onchange = () => addFiles(cameraInput.files);
    libraryInput.onchange = () => addFiles(libraryInput.files);
    submitButton.onclick = submit;
    discardButton.onclick = discardLocalRetry;
    closeInstallDialog.onclick = () => installDialog.close();
    installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      await prompt.prompt();
      await prompt.userChoice.catch(() => null);
    });
    window.addEventListener('online', updateUi);
    window.addEventListener('offline', updateUi);
    window.addEventListener('pagehide', () => {
      if (!submitting) saveDraftNow().catch(() => {});
    });
  }

  void init();
})();
