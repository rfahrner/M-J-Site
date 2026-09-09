(() => {
  'use strict';

  const API_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co/functions/v1/paperwork-pwa-submit';
  const PRIVACY_URL = '../privacy.html';
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

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  function setHidden(element, hidden) {
    element.classList.toggle('hidden', hidden);
  }

  function showAlert(title, message) {
    window.alert(`${title}\n\n${message}`);
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
    if (!item || !item.blob || !item.name) return null;
    const file = item.blob instanceof File
      ? item.blob
      : new File([item.blob], item.name, {
          type: item.type || item.blob.type || 'image/jpeg',
          lastModified: Number(item.lastModified) || Date.now(),
        });
    return { id: item.id || crypto.randomUUID(), file };
  }

  function buildDraft() {
    return {
      version: 1,
      proNumber: proInput.value.trim(),
      submissionId,
      attemptNumber,
      attempted,
      images: images.map(serializeImage),
      updatedAt: new Date().toISOString(),
    };
  }

  async function saveDraftNow() {
    const draft = buildDraft();
    const hasContent = draft.proNumber || draft.images.length || draft.attempted;
    if (!hasContent) {
      await idbDelete(DRAFT_KEY).catch(() => {});
      return;
    }
    await idbPut(DRAFT_KEY, draft);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveDraftNow().catch((error) => console.warn('Draft autosave failed', error));
    }, 250);
  }

  async function restoreDraft() {
    try {
      const draft = await idbGet(DRAFT_KEY);
      if (!draft || draft.version !== 1) return;

      proInput.value = String(draft.proNumber || '').replace(/\D/g, '').slice(0, MAX_PRO_DIGITS);
      if (typeof draft.submissionId === 'string' && draft.submissionId) submissionId = draft.submissionId;
      attemptNumber = Number.isInteger(draft.attemptNumber) && draft.attemptNumber >= 0 ? draft.attemptNumber : 0;
      attempted = Boolean(draft.attempted);
      images = Array.isArray(draft.images) ? draft.images.map(deserializeImage).filter(Boolean) : [];

      if (proInput.value || images.length || attempted) {
        restoredText.textContent = attempted
          ? `A previous send did not get a confirmed receipt. Attempt #${attemptNumber || 1} is preserved, and Retry will add another linked copy without replacing it.`
          : 'Your Pro number and photos were kept on this device. You can continue the submission.';
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
    if (!SUPPORTED_TYPES.has(type)) {
      throw new Error(`${file.name || 'This photo'} uses an unsupported image type.`);
    }

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
      if (!blob || !blob.size) return file;
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
    if (files.length > available) {
      showAlert('Photo limit', `Only the first ${available} ${available === 1 ? 'photo' : 'photos'} will be added.`);
    }

    processing = true;
    updateUi();
    let failed = 0;

    try {
      for (const file of selected) {
        try {
          const prepared = await prepareFile(file);
          if (prepared.size > MAX_IMAGE_BYTES) {
            throw new Error(`${file.name || 'A photo'} is still larger than 15 MB after preparation.`);
          }
          if (totalBytes() + prepared.size > MAX_TOTAL_BYTES) {
            throw new Error('These photos would exceed the 60 MB submission limit.');
          }
          images.push({ id: crypto.randomUUID(), file: prepared });
          await saveDraftNow();
        } catch (error) {
          console.warn('Could not prepare photo', error);
          failed += 1;
        }
      }
      setHidden(restoredCard, true);
      setHidden(successCard, true);
      if (failed) {
        showAlert('Some photos were skipped', `${failed} ${failed === 1 ? 'photo could' : 'photos could'} not be prepared. Try taking or selecting ${failed === 1 ? 'it' : 'them'} again.`);
      }
    } finally {
      processing = false;
      cameraInput.value = '';
      libraryInput.value = '';
      renderPreviews();
      updateUi();
      scheduleSave();
    }
  }

  function revokePreview(id) {
    const url = previewUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(id);
  }

  function renderPreviews() {
    const activeIds = new Set(images.map((item) => item.id));
    for (const id of previewUrls.keys()) {
      if (!activeIds.has(id)) revokePreview(id);
    }

    previewStrip.replaceChildren();
    images.forEach((item, index) => {
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
        remove.addEventListener('click', () => {
          if (attempted || submitting) return;
          revokePreview(item.id);
          images = images.filter((candidate) => candidate.id !== item.id);
          renderPreviews();
          updateUi();
          scheduleSave();
        });
        wrap.appendChild(remove);
      }
      previewStrip.appendChild(wrap);
    });
  }

  function validPro() {
    return /^\d{1,20}$/.test(proInput.value.trim());
  }

  function updateUi() {
    const offline = !navigator.onLine;
    setHidden(offlineCard, !offline);

    const locked = attempted || submitting;
    proInput.disabled = locked;
    cameraButton.disabled = locked || processing || images.length >= MAX_IMAGES;
    libraryButton.disabled = locked || processing || images.length >= MAX_IMAGES;
    setHidden(processingRow, !processing);
    imageCount.textContent = `${images.length} / ${MAX_IMAGES} ${images.length === 1 ? 'image' : 'images'}${attempted ? ' · locked for retry' : ''}`;

    const canSubmit = !offline && !processing && !submitting && validPro() && images.length > 0;
    submitButton.disabled = !canSubmit;
    submitButton.textContent = submitting
      ? 'Sending…'
      : offline
        ? 'Waiting for Connection'
        : attempted
          ? 'Retry Submission'
          : 'Submit Paperwork';

    setHidden(attemptControls, !attempted || submitting);
    setHidden(retryCard, !attempted || submitting);
    if (attempted) {
      retryText.textContent = `Attempt #${attemptNumber || 1} did not get a confirmed receipt. Anything D&L already received remains preserved. Retry sends attempt #${(attemptNumber || 1) + 1} as a new linked addition.`;
    }
    renderPreviews();
  }

  function buildHeaders(currentSubmissionId, retryOf, retryNumber) {
    const headers = {
      'X-MJ-Install-ID': getInstallId(),
      'X-MJ-Submission-ID': currentSubmissionId,
    };
    if (retryOf) {
      headers['X-MJ-Retry-Of'] = retryOf;
      headers['X-MJ-Retry-Number'] = String(retryNumber);
    }
    return headers;
  }

  async function sendSubmission(currentSubmissionId, retryOf, currentAttemptNumber) {
    const body = new FormData();
    body.append('proNumber', proInput.value.trim());
    images.forEach((item, index) => body.append('images', item.file, item.file.name || `trip-sheet-${index + 1}.jpg`));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: buildHeaders(currentSubmissionId, retryOf, currentAttemptNumber),
        body,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : null;
        if (response.status === 429) throw new Error(message || 'Too many submissions were sent recently. Wait a few minutes and try again.');
        if (response.status === 409) throw new Error(message || 'D&L received part of this attempt. Nothing was deleted; tap Retry Submission to add another copy.');
        throw new Error(message || 'Paperwork submission failed. Your paperwork remains saved on this device.');
      }
      return payload || { status: 'received', submissionId: currentSubmissionId };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('The upload timed out. Anything that reached D&L stays preserved. Tap Retry Submission when your connection is stable.');
      }
      if (error instanceof TypeError) {
        throw new Error('Could not reach the paperwork service. Your paperwork is saved on this device, and anything D&L already received stays preserved.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function submit() {
    if (submitting || processing || !navigator.onLine || !validPro() || !images.length) return;

    const priorSubmissionId = attempted ? submissionId : null;
    const nextAttemptNumber = attempted ? Math.max(1, attemptNumber) + 1 : 1;
    const currentSubmissionId = attempted ? crypto.randomUUID() : submissionId;

    submissionId = currentSubmissionId;
    attemptNumber = nextAttemptNumber;
    attempted = true;
    submitting = true;
    setHidden(successCard, true);
    uploadStatus.textContent = `Sending ${images.length} ${images.length === 1 ? 'image' : 'images'}… Keep M-J App open until receipt is confirmed.`;
    setHidden(uploadStatus, false);
    updateUi();

    try {
      await saveDraftNow();
    } catch (error) {
      console.warn('Could not persist attempt before upload', error);
      submitting = false;
      attempted = Boolean(priorSubmissionId);
      if (priorSubmissionId) {
        submissionId = priorSubmissionId;
        attemptNumber = Math.max(1, nextAttemptNumber - 1);
      } else {
        submissionId = crypto.randomUUID();
        attemptNumber = 0;
      }
      setHidden(uploadStatus, true);
      updateUi();
      showAlert('Could not save paperwork on this device', 'The upload was not started. Free some device storage and try again so the app can preserve a recovery copy first.');
      return;
    }

    try {
      await sendSubmission(currentSubmissionId, priorSubmissionId, nextAttemptNumber);
      await idbDelete(DRAFT_KEY).catch(() => {});
      images.forEach((item) => revokePreview(item.id));
      images = [];
      proInput.value = '';
      submissionId = crypto.randomUUID();
      attemptNumber = 0;
      attempted = false;
      setHidden(restoredCard, true);
      setHidden(retryCard, true);
      setHidden(attemptControls, true);
      setHidden(successCard, false);
      uploadStatus.textContent = 'Paperwork received.';
      setTimeout(() => setHidden(uploadStatus, true), 1600);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Receipt not confirmed. Your paperwork remains saved on this device.';
      await saveDraftNow().catch(() => {});
      showAlert('Receipt not confirmed', `${message}\n\nRetry sends another linked copy. It does not overwrite or delete anything D&L may already have.`);
    } finally {
      submitting = false;
      updateUi();
    }
  }

  async function discardLocalRetry() {
    const confirmed = window.confirm(
      'Start a new submission?\n\nThis removes only the saved retry from this device. It does NOT delete, replace, or change any paperwork D&L may already have received.',
    );
    if (!confirmed) return;

    await idbDelete(DRAFT_KEY).catch(() => {});
    images.forEach((item) => revokePreview(item.id));
    images = [];
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
      installText.textContent = 'Add M-J App to your iPhone Home Screen for one-tap access.';
      installButton.textContent = 'How to Install';
      setHidden(installCard, false);
      installButton.addEventListener('click', () => installDialog.showModal());
    } else {
      setHidden(installCard, true);
    }

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.textContent = 'Install';
      installText.textContent = 'Install M-J App on this device for one-tap access.';
      setHidden(installCard, false);
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      setHidden(installCard, true);
    });
  }

  async function requestInstall() {
    if (!deferredInstallPrompt) return;
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    await prompt.userChoice.catch(() => null);
    setHidden(installCard, true);
  }

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed', error));
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => false);

    configureInstallUi();
    await restoreDraft();
    renderPreviews();
    updateUi();

    proInput.addEventListener('input', () => {
      if (attempted) return;
      proInput.value = proInput.value.replace(/\D/g, '').slice(0, MAX_PRO_DIGITS);
      setHidden(restoredCard, true);
      setHidden(successCard, true);
      scheduleSave();
      updateUi();
    });

    cameraButton.addEventListener('click', () => cameraInput.click());
    libraryButton.addEventListener('click', () => libraryInput.click());
    cameraInput.addEventListener('change', () => addFiles(cameraInput.files));
    libraryInput.addEventListener('change', () => addFiles(libraryInput.files));
    submitButton.addEventListener('click', submit);
    discardButton.addEventListener('click', discardLocalRetry);
    closeInstallDialog.addEventListener('click', () => installDialog.close());
    installButton.addEventListener('click', () => {
      if (deferredInstallPrompt) void requestInstall();
    });

    window.addEventListener('online', updateUi);
    window.addEventListener('offline', updateUi);
    window.addEventListener('pagehide', () => {
      if (!submitting) saveDraftNow().catch(() => {});
    });

    const privacy = document.querySelector('.privacy');
    if (privacy) privacy.href = PRIVACY_URL;
  }

  void init();
})();
