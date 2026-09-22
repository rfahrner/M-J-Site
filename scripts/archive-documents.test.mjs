import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../archive-documents.js', import.meta.url), 'utf8');
const { archivePaths, exportRouteDocuments, archivedDocumentsPresent } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const safeName = value => value.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120);

test('normalizes legacy paths, JSON lists and arrays across several trips', () => {
  assert.deepEqual(archivePaths([null, 'a/photo.jpg', '["b/photo.jpg","c/sheet.pdf"]', ['a/photo.jpg']]), ['a/photo.jpg', 'b/photo.jpg', 'c/sheet.pdf']);
  assert.deepEqual(archivePaths(''), []);
  assert.throws(() => archivePaths('["broken"'), /Invalid image list/);
});

test('exports every original image/PDF without same-name overwrites', async () => {
  const stored = new Map();
  const downloaded = [];
  const paths = ['a/photo.jpg', 'b/photo.jpg', 'c/sheet.pdf'];
  const results = await exportRouteDocuments({}, JSON.stringify(paths), {
    bucket: 'routes', safeName,
    download: async (bucket, path) => { downloaded.push(path); return new Blob([path]); },
    write: async (_, file, blob) => stored.set(file, await blob.text()),
  });
  assert.deepEqual(downloaded, paths);
  assert.equal(stored.size, 3);
  assert.deepEqual([...stored.values()], paths);
  assert.equal(results[2].file.endsWith('.pdf'), true);
  assert.equal(results[0].size, new Blob([paths[0]]).size);
});

test('download or local-write failures reject export instead of reporting completion', async () => {
  await assert.rejects(exportRouteDocuments({}, ['a', 'b'], {
    bucket: 'routes', safeName, download: async () => { throw new Error('missing object'); }, write: async () => {},
  }), /missing object/);
  await assert.rejects(exportRouteDocuments({}, 'a', {
    bucket: 'routes', safeName, download: async () => new Blob(['data']), write: async () => { throw new Error('disk full'); },
  }), /disk full/);
});

test('resume rejects older manifests, missing files and partial files', async () => {
  const files = new Map([['one.jpg', 12], ['two.pdf', 24]]);
  const dir = { getDirectoryHandle: async () => ({ getFileHandle: async name => {
    if (!files.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return { getFile: async () => ({ size: files.get(name) }) };
  } }) };
  const manifest = { archive_format_version: 2, documents: [{ file: 'one.jpg', size: 12 }, { file: 'two.pdf', size: 24 }] };
  assert.equal(await archivedDocumentsPresent(dir, manifest), true);
  assert.equal(await archivedDocumentsPresent(dir, { ...manifest, archive_format_version: 1 }), false);
  files.set('two.pdf', 2);
  assert.equal(await archivedDocumentsPresent(dir, manifest), false);
  files.delete('two.pdf');
  assert.equal(await archivedDocumentsPresent(dir, manifest), false);
});
