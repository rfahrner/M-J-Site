/*
 * Viewing images that have already moved to the archive.
 *
 * Once a file has been copied to the destination and its Supabase original
 * removed, storage.createSignedUrl() has nothing left to sign: the entry comes
 * back with an error and a null url, and every place that shows route images
 * silently renders an empty slot. Nothing in the app noticed, because a missing
 * signed url and a genuinely image-less route look identical downstream.
 *
 * The edge function already knows how to hand back a short-lived signed link
 * that streams the archived copy through itself (action:'sign'). This module is
 * the client half of that: give it the paths that failed to sign, and it gives
 * back a url for the ones it can find in the archive.
 *
 * Deliberately a leaf: it takes the Supabase client as an argument rather than
 * importing loadboard.js, so it can be used from the board, Accounting, or
 * anywhere else without creating an import cycle.
 */

const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const ARCHIVE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/image-archive-onedrive`;

// The proxy links the function issues last an hour. Expiring the cache sooner
// means a long-lived board tab re-signs before its links go stale rather than
// after, which would look like images vanishing mid-shift.
const CACHE_TTL_MS = 45 * 60 * 1000;
const MAX_PER_REQUEST = 200;

const cache = new Map(); // `${bucket}\n${path}` -> { url: string|null, at: number }

const keyFor = (bucket, path) => `${bucket}\n${path}`;

function cached(bucket, path) {
  const hit = cache.get(keyFor(bucket, path));
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(keyFor(bucket, path));
    return undefined;
  }
  return hit.url;
}

/*
 * items: [{ bucket, path }]
 * Returns a Map of `${bucket}\n${path}` -> url, containing ONLY the paths that
 * were found in the archive. A path that is genuinely gone is recorded as a
 * miss so the next render does not ask about it again.
 */
export async function resolveArchivedImageUrls(client, items) {
  const found = new Map();
  if (!client || !Array.isArray(items) || !items.length) return found;

  const wanted = [];
  for (const item of items) {
    const bucket = String(item?.bucket || '');
    const path = String(item?.path || '');
    if (!bucket || !path) continue;
    const hit = cached(bucket, path);
    if (hit === undefined) wanted.push({ bucket, path });
    else if (hit) found.set(keyFor(bucket, path), hit);
  }
  if (!wanted.length) return found;

  let token = null;
  try {
    const { data } = await client.auth.getSession();
    token = data?.session?.access_token || null;
  } catch (error) {
    console.error('Archived image lookup could not read the session:', error);
  }
  if (!token) return found; // signed out: nothing to show, and nothing to cache

  for (let i = 0; i < wanted.length; i += MAX_PER_REQUEST) {
    const batch = wanted.slice(i, i + MAX_PER_REQUEST);
    try {
      const response = await fetch(ARCHIVE_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'sign', items: batch }),
      });
      if (!response.ok) throw new Error(`archive sign failed (${response.status})`);
      const payload = await response.json();
      const now = Date.now();
      // Record misses too. A path with no archived copy is a permanent answer
      // for this session, and without caching it every redraw would ask again.
      batch.forEach((item) => cache.set(keyFor(item.bucket, item.path), { url: null, at: now }));
      (payload?.urls || []).forEach((entry) => {
        const bucket = String(entry?.bucket || '');
        const path = String(entry?.path || '');
        if (!bucket || !path) return;
        const url = entry?.url || null;
        cache.set(keyFor(bucket, path), { url, at: now });
        if (url) found.set(keyFor(bucket, path), url);
      });
    } catch (error) {
      // A failed lookup must not be cached as "no such image" -- that would
      // hide a picture that is really there until the tab is reloaded.
      console.error('Archived image lookup failed:', error);
    }
  }
  return found;
}

// Convenience for the single-image call sites.
export async function resolveArchivedImageUrl(client, bucket, path) {
  const found = await resolveArchivedImageUrls(client, [{ bucket, path }]);
  return found.get(keyFor(bucket, path)) || null;
}

// Called after a backup run so freshly archived files are looked up again
// instead of being served from a cache that predates them.
export function forgetArchivedImageUrls() {
  cache.clear();
}
