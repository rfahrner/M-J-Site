/*
 * What counts as an uploadable file, in one place.
 *
 * Every dropzone in the app used to test `file.type.startsWith("image/")`
 * inline, in about ten separate places, with a matching `accept="image/*"` on
 * a dozen file inputs. Adding PDFs meant changing all of them and keeping them
 * in step forever, so the rule lives here instead.
 *
 * This is deliberately a LEAF module: it imports nothing. mondelez.js and
 * load-overview-timesheet-image.js are imported BY loadboard.js, so anything
 * they share with it has to sit below both or it becomes an import cycle --
 * the same reason archive-image-urls.js takes its client as an argument.
 */

// What the OS file picker offers. Kept as one string so every input agrees.
export const UPLOAD_ACCEPT = "image/*,application/pdf,.pdf";

export const PDF_MIME = "application/pdf";

export function isPdfFile(file) {
  if (!file) return false;
  if (String(file.type || "").toLowerCase() === PDF_MIME) return true;
  // Some Windows shells hand over a PDF with an empty or generic type,
  // particularly on paste. The extension is the fallback, not the primary.
  return /\.pdf$/i.test(String(file.name || ""));
}

export function isImageFile(file) {
  return !!file && String(file.type || "").toLowerCase().startsWith("image/");
}

// The single predicate every dropzone filters on.
export function isAcceptedUpload(file) {
  return isImageFile(file) || isPdfFile(file);
}

export function acceptedUploads(files) {
  return Array.from(files || []).filter(isAcceptedUpload);
}

/*
 * Whether a STORED reference points at a PDF.
 *
 * Callers hold either the storage path ("4211/1758..._trip_sheet.pdf") or a
 * signed URL for it, and a signed URL carries a token query string, so the
 * extension has to be read from the path portion only -- "?token=...pdf" in a
 * token would otherwise register as a match.
 */
export function isPdfRef(pathOrUrl) {
  const raw = String(pathOrUrl || "");
  if (!raw) return false;
  let pathPart = raw.split("#")[0].split("?")[0];
  try {
    if (/^https?:\/\//i.test(raw)) pathPart = new URL(raw).pathname;
  } catch (e) {
    void e; // a malformed URL just falls back to the split above
  }
  return /\.pdf$/i.test(pathPart);
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// The filename a stored reference was uploaded under, for labelling a chip.
// Upload paths are built as
//   <dbId>/<Date.now()>_<6 random base36 chars>_<sanitised original name>
// so the original name is whatever follows those two prefix segments. The
// timestamp is matched loosely rather than pinned at 13 digits, but BOTH
// segments are required, so an ordinary filename that merely starts with
// digits -- "20260922_load.pdf" -- is left alone.
export function fileNameFromRef(pathOrUrl) {
  const raw = String(pathOrUrl || "");
  let pathPart = raw.split("#")[0].split("?")[0];
  try {
    if (/^https?:\/\//i.test(raw)) pathPart = new URL(raw).pathname;
  } catch (e) { void e; }
  const base = decodeURIComponent(pathPart.split("/").pop() || "");
  const stripped = base.replace(/^\d{6,}_[a-z0-9]{4,8}_/i, "");
  return stripped || base || "document.pdf";
}

/*
 * A PDF in a cell that otherwise holds photographs.
 *
 * It cannot be an <img> -- that renders as a broken image -- and the app's
 * zoom/rotate viewer is an <img> too, so clicking opens the PDF in a browser
 * tab, where Chrome and Edge render it with their own viewer, zoom and print.
 * dataAttrs lets each board keep whatever identifiers its delete button needs.
 */
export function pdfChipHtml(url, { dataAttrs = "", label = "" } = {}) {
  const name = label || fileNameFromRef(url);
  return `<a class="mdz-pdf-chip" href="${esc(url)}" target="_blank" rel="noopener"` +
    ` title="${esc(name)} — opens in a new tab"${dataAttrs ? " " + dataAttrs : ""}>` +
    `<span class="mdz-pdf-chip-badge">PDF</span>` +
    `<span class="mdz-pdf-chip-name">${esc(name)}</span></a>`;
}
