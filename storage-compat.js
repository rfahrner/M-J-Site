/* Private Supabase Storage compatibility for Load Details trip-sheet images.
   loadboard.js historically renders these attachments using getPublicUrl().
   The trip-sheets bucket is now private, so refresh gallery thumbnails with
   authenticated signed URLs whenever the gallery is rendered or re-rendered. */
import { supabaseClient, loadDetailsState } from './loadboard.js';

const TRIP_SHEETS_BUCKET = 'trip-sheets';
const SIGNED_URL_EXPIRY_SECONDS = 3600;
let signing = false;
let queued = false;

async function refreshPrivateTripSheetGallery() {
  if (signing || !supabaseClient || !loadDetailsState) return;
  const gallery = document.querySelector('#ld-image-gallery');
  const attachments = loadDetailsState.attachments || [];
  if (!gallery || !attachments.length) return;

  const signable = attachments.filter((attachment) => attachment && attachment.file_path);
  if (!signable.length) return;

  signing = true;
  try {
    const { data, error } = await supabaseClient.storage
      .from(TRIP_SHEETS_BUCKET)
      .createSignedUrls(signable.map((attachment) => attachment.file_path), SIGNED_URL_EXPIRY_SECONDS);
    if (error) throw error;

    (data || []).forEach((entry, index) => {
      if (entry && entry.signedUrl && signable[index]) {
        signable[index].publicUrl = entry.signedUrl;
      }
    });

    const thumbnails = gallery.querySelectorAll('.ld-image-thumb');
    thumbnails.forEach((img, index) => {
      const attachment = attachments[index];
      if (attachment && attachment.publicUrl) img.src = attachment.publicUrl;
    });
  } catch (error) {
    console.error('Failed to sign private trip-sheet images:', error);
  } finally {
    signing = false;
    if (queued) {
      queued = false;
      refreshPrivateTripSheetGallery();
    }
  }
}

function scheduleGalleryRefresh() {
  if (signing) {
    queued = true;
    return;
  }
  queueMicrotask(refreshPrivateTripSheetGallery);
}

function initPrivateTripSheetCompat() {
  const target = document.querySelector('#ld-tab-content');
  if (!target) return;
  const observer = new MutationObserver(scheduleGalleryRefresh);
  observer.observe(target, { childList: true, subtree: true });
  scheduleGalleryRefresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPrivateTripSheetCompat, { once: true });
} else {
  initPrivateTripSheetCompat();
}
