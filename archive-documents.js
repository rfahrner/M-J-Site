export const ARCHIVE_FORMAT_VERSION = 2;

export function archivePaths(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(archivePaths))];
  if (typeof value !== 'string') throw new Error('Invalid archive document path');
  const path = value.trim();
  if (!path) return [];
  if (path.startsWith('[')) {
    let paths;
    try { paths = JSON.parse(path); }
    catch { throw new Error('Invalid image list; export stopped to avoid missing documents.'); }
    if (!Array.isArray(paths)) throw new Error('Invalid archive image list');
    return archivePaths(paths);
  }
  return [path];
}

export async function exportRouteDocuments(dir, value, { bucket, download, write, safeName }) {
  const results = [];
  const paths = archivePaths(value);
  for (const [index, path] of paths.entries()) {
    const blob = await download(bucket, path);
    // Number comes first so sanitizing/truncating duplicate base names cannot
    // overwrite another image. Each load passes its complete route-image list.
    const file = safeName(`Route Image ${String(index + 1).padStart(4, '0')} - ${path.split('/').pop()}`);
    await write(dir, file, blob);
    results.push({ bucket, path, file, size: blob.size });
  }
  return results;
}

export async function archivedDocumentsPresent(loadDir, manifest) {
  if (manifest.archive_format_version !== ARCHIVE_FORMAT_VERSION || !Array.isArray(manifest.documents)) return false;
  try {
    const docs = await loadDir.getDirectoryHandle('Documents');
    const names = new Set();
    for (const document of manifest.documents) {
      if (!document.file || names.has(document.file) || !Number.isSafeInteger(document.size) || document.size < 0) return false;
      names.add(document.file);
      const handle = await docs.getFileHandle(document.file);
      if ((await handle.getFile()).size !== document.size) return false;
    }
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') return false;
    throw error;
  }
}
