import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_BATCH = 250;
const PROXY_TTL_SECONDS = 60 * 60;

type Config = {
  enabled: boolean;
  retention_days: number;
  destination_label: string;
  destination_share_url: string;
  cron_secret: string;
};

type Candidate = {
  object_id: string;
  bucket_id: string;
  object_name: string;
  created_at: string;
  bytes: number;
  mime_type: string;
};

function namedKey(envName: string, legacyName: string): string {
  const raw = Deno.env.get(envName);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      if (raw.trim()) return raw.trim();
    }
  }
  const legacy = Deno.env.get(legacyName);
  if (legacy) return legacy;
  throw new Error(`Missing ${envName}/${legacyName}`);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function bearer(req: Request) {
  const value = req.headers.get('authorization') || '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function textToBase64Url(value: string) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeSegment(value: string) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'unnamed').slice(0, 120);
}

async function shortHash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authenticatedUser(admin: ReturnType<typeof createClient>, req: Request) {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function getConfig(admin: ReturnType<typeof createClient>): Promise<Config> {
  const { data, error } = await admin
    .from('archive_backup_config')
    .select('enabled,retention_days,destination_label,destination_share_url,cron_secret')
    .eq('id', true)
    .single();
  if (error) throw error;
  return data as Config;
}

async function graphToken() {
  const tenant = Deno.env.get('MS_TENANT_ID')?.trim();
  const clientId = Deno.env.get('MS_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('MS_CLIENT_SECRET')?.trim();
  if (!tenant || !clientId || !clientSecret) {
    throw new Error('Microsoft connection is not configured. Missing MS_TENANT_ID, MS_CLIENT_ID, or MS_CLIENT_SECRET.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(`Microsoft token request failed (${response.status}): ${payload?.error_description || payload?.error || 'unknown error'}`);
  }
  return String(payload.access_token);
}

async function graphJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error_description || text || response.statusText;
    throw new Error(`Microsoft Graph ${response.status}: ${message}`);
  }
  return payload;
}

async function resolveDestination(shareUrl: string, token: string) {
  const shareId = `u!${textToBase64Url(shareUrl)}`;
  const item = await graphJson(`${GRAPH}/shares/${encodeURIComponent(shareId)}/driveItem?$select=id,name,webUrl,parentReference`, token);
  const driveId = item?.parentReference?.driveId;
  if (!item?.id || !driveId) throw new Error('The M-J Site Backups share link did not resolve to a writable Microsoft folder.');
  return { driveId: String(driveId), folderId: String(item.id), webUrl: String(item.webUrl || shareUrl) };
}

async function ensureChildFolder(driveId: string, parentId: string, name: string, token: string) {
  const wanted = safeSegment(name);
  const children = await graphJson(
    `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}/children?$select=id,name,folder&$top=200`,
    token,
  );
  const existing = (children?.value || []).find((item: any) => item?.folder && String(item.name || '').toLowerCase() === wanted.toLowerCase());
  if (existing?.id) return String(existing.id);

  try {
    const created = await graphJson(
      `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}/children`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wanted, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      },
    );
    return String(created.id);
  } catch (error) {
    const retry = await graphJson(
      `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}/children?$select=id,name,folder&$top=200`,
      token,
    );
    const found = (retry?.value || []).find((item: any) => item?.folder && String(item.name || '').toLowerCase() === wanted.toLowerCase());
    if (found?.id) return String(found.id);
    throw error;
  }
}

async function uploadSimple(driveId: string, parentId: string, fileName: string, blob: Blob, mimeType: string, token: string) {
  const response = await fetch(
    `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(fileName)}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
      body: blob,
    },
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(`Microsoft upload failed (${response.status}): ${payload?.error?.message || 'unknown error'}`);
  return payload;
}

async function uploadLarge(driveId: string, parentId: string, fileName: string, blob: Blob, token: string) {
  const session = await graphJson(
    `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(fileName)}:/createUploadSession`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } }),
    },
  );
  const uploadUrl = String(session?.uploadUrl || '');
  if (!uploadUrl) throw new Error('Microsoft did not return an upload session URL.');

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 10 * 320 * 1024;
  let result: any = null;
  for (let start = 0; start < bytes.byteLength; start += chunkSize) {
    const endExclusive = Math.min(bytes.byteLength, start + chunkSize);
    const chunk = bytes.slice(start, endExclusive);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.byteLength),
        'Content-Range': `bytes ${start}-${endExclusive - 1}/${bytes.byteLength}`,
      },
      body: chunk,
    });
    const payload = await response.json();
    if (!response.ok && response.status !== 202) {
      throw new Error(`Microsoft upload session failed (${response.status}): ${payload?.error?.message || 'unknown error'}`);
    }
    if (response.status !== 202) result = payload;
  }
  if (!result?.id) throw new Error('Microsoft upload session completed without a file result.');
  return result;
}

async function uploadObject(params: {
  admin: ReturnType<typeof createClient>;
  candidate: Candidate;
  driveId: string;
  rootFolderId: string;
  token: string;
  folderCache: Map<string, string>;
}) {
  const { admin, candidate, driveId, rootFolderId, token, folderCache } = params;
  const { data: blob, error } = await admin.storage.from(candidate.bucket_id).download(candidate.object_name);
  if (error || !blob) throw new Error(`Supabase download failed: ${error?.message || 'empty file'}`);

  const created = new Date(candidate.created_at);
  const yyyy = String(created.getUTCFullYear());
  const mm = String(created.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(created.getUTCDate()).padStart(2, '0');
  const folderParts = ['Images', candidate.bucket_id, yyyy, mm, dd];

  let parentId = rootFolderId;
  let cacheKey = rootFolderId;
  for (const part of folderParts) {
    cacheKey += `/${part}`;
    let folderId = folderCache.get(cacheKey);
    if (!folderId) {
      folderId = await ensureChildFolder(driveId, parentId, part, token);
      folderCache.set(cacheKey, folderId);
    }
    parentId = folderId;
  }

  const hash = await shortHash(candidate.object_name);
  const baseName = safeSegment(candidate.object_name.replaceAll('/', '__'));
  const fileName = `${hash}__${baseName}`.slice(0, 220);
  const uploaded = blob.size <= 4 * 1024 * 1024
    ? await uploadSimple(driveId, parentId, fileName, blob, candidate.mime_type, token)
    : await uploadLarge(driveId, parentId, fileName, blob, token);

  if (Number(uploaded?.size || 0) !== blob.size) {
    throw new Error(`Microsoft verification failed: uploaded ${uploaded?.size ?? 'unknown'} bytes, expected ${blob.size}.`);
  }

  const providerPath = `Images/${candidate.bucket_id}/${yyyy}/${mm}/${dd}/${fileName}`;
  return { blobSize: blob.size, uploaded, providerPath };
}

async function cleanupAlreadyArchived(admin: ReturnType<typeof createClient>) {
  const { data } = await admin
    .from('archive_backup_items')
    .select('id,bucket_id,object_name')
    .eq('status', 'archived')
    .is('source_deleted_at', null)
    .limit(100);
  let deleted = 0;
  for (const item of data || []) {
    const { error } = await admin.storage.from(item.bucket_id).remove([item.object_name]);
    if (!error) {
      await admin.from('archive_backup_items').update({ source_deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', item.id);
      deleted += 1;
    }
  }
  return deleted;
}

async function runArchive(admin: ReturnType<typeof createClient>, config: Config) {
  const { data: run, error: runError } = await admin
    .from('archive_backup_runs')
    .insert({ status: 'running', destination_label: config.destination_label })
    .select('id')
    .single();
  if (runError) throw runError;
  const runId = String(run.id);

  if (!config.enabled) {
    await admin.from('archive_backup_runs').update({ status: 'disabled', finished_at: new Date().toISOString() }).eq('id', runId);
    return { status: 'disabled', runId };
  }

  let token: string;
  let destination: { driveId: string; folderId: string; webUrl: string };
  try {
    token = await graphToken();
    destination = await resolveDestination(config.destination_share_url, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from('archive_backup_runs').update({
      status: 'configuration_required',
      finished_at: new Date().toISOString(),
      error_message: message,
    }).eq('id', runId);
    return { status: 'configuration_required', runId, error: message };
  }

  const cleanupDeleted = await cleanupAlreadyArchived(admin);
  const { data: candidates, error: candidateError } = await admin.rpc('archive_backup_candidates', { p_limit: MAX_BATCH });
  if (candidateError) throw candidateError;

  let filesArchived = 0;
  let filesDeleted = cleanupDeleted;
  let bytesArchived = 0;
  let bytesDownloaded = 0;
  let failures = 0;
  const folderCache = new Map<string, string>();

  for (const raw of (candidates || []) as Candidate[]) {
    const candidate = { ...raw, bytes: Number(raw.bytes || 0) };
    try {
      const uploaded = await uploadObject({
        admin,
        candidate,
        driveId: destination.driveId,
        rootFolderId: destination.folderId,
        token,
        folderCache,
      });
      bytesDownloaded += uploaded.blobSize;
      bytesArchived += uploaded.blobSize;
      filesArchived += 1;

      const now = new Date().toISOString();
      const { error: upsertError } = await admin.from('archive_backup_items').upsert({
        bucket_id: candidate.bucket_id,
        object_name: candidate.object_name,
        source_object_id: candidate.object_id,
        source_created_at: candidate.created_at,
        source_bytes: candidate.bytes || uploaded.blobSize,
        provider: 'onedrive',
        provider_drive_id: destination.driveId,
        provider_item_id: String(uploaded.uploaded.id),
        provider_web_url: String(uploaded.uploaded.webUrl || destination.webUrl),
        provider_path: uploaded.providerPath,
        provider_size: Number(uploaded.uploaded.size || uploaded.blobSize),
        archived_at: now,
        status: 'archived',
        last_error: null,
        archive_run_id: runId,
        updated_at: now,
      }, { onConflict: 'bucket_id,object_name' });
      if (upsertError) throw upsertError;

      const { error: removeError } = await admin.storage.from(candidate.bucket_id).remove([candidate.object_name]);
      if (!removeError) {
        filesDeleted += 1;
        await admin.from('archive_backup_items').update({ source_deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('bucket_id', candidate.bucket_id).eq('object_name', candidate.object_name);
      }
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      await admin.from('archive_backup_items').upsert({
        bucket_id: candidate.bucket_id,
        object_name: candidate.object_name,
        source_object_id: candidate.object_id,
        source_created_at: candidate.created_at,
        source_bytes: candidate.bytes,
        provider: 'onedrive',
        status: 'failed',
        last_error: message.slice(0, 2000),
        archive_run_id: runId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'bucket_id,object_name' });
    }
  }

  const status = failures ? (filesArchived ? 'partial' : 'failed') : 'success';
  await admin.from('archive_backup_runs').update({
    finished_at: new Date().toISOString(),
    status,
    files_considered: (candidates || []).length,
    files_archived: filesArchived,
    files_deleted: filesDeleted,
    bytes_archived: bytesArchived,
    bytes_downloaded: bytesDownloaded,
    error_message: failures ? `${failures} file(s) failed. Individual errors are retained on archive_backup_items.` : null,
    details: { destination_web_url: destination.webUrl, cleanup_deleted: cleanupDeleted },
  }).eq('id', runId);

  return { status, runId, filesConsidered: (candidates || []).length, filesArchived, filesDeleted, bytesArchived, failures };
}

async function signedArchiveUrls(admin: ReturnType<typeof createClient>, req: Request, body: any, proxySecret: string) {
  const user = await authenticatedUser(admin, req);
  if (!user) return json({ error: 'Authentication required.' }, 401);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
  if (!items.length) return json({ urls: [] });

  const clauses = items
    .map((item: any) => ({ bucket: String(item?.bucket || ''), path: String(item?.path || '') }))
    .filter((item: any) => item.bucket && item.path);
  const urls: any[] = [];
  const origin = new URL(req.url);
  origin.search = '';
  const exp = Math.floor(Date.now() / 1000) + PROXY_TTL_SECONDS;

  for (const item of clauses) {
    const { data } = await admin.from('archive_backup_items')
      .select('provider_item_id')
      .eq('bucket_id', item.bucket)
      .eq('object_name', item.path)
      .eq('status', 'archived')
      .maybeSingle();
    if (!data?.provider_item_id) {
      urls.push({ bucket: item.bucket, path: item.path, url: null });
      continue;
    }
    const sig = await hmacHex(proxySecret, `${item.bucket}\n${item.path}\n${exp}`);
    const fileUrl = new URL(origin.toString());
    fileUrl.searchParams.set('action', 'file');
    fileUrl.searchParams.set('bucket', item.bucket);
    fileUrl.searchParams.set('path', item.path);
    fileUrl.searchParams.set('exp', String(exp));
    fileUrl.searchParams.set('sig', sig);
    urls.push({ bucket: item.bucket, path: item.path, url: fileUrl.toString() });
  }
  return json({ urls });
}

async function proxyArchivedFile(admin: ReturnType<typeof createClient>, req: Request, proxySecret: string) {
  const url = new URL(req.url);
  const bucket = url.searchParams.get('bucket') || '';
  const path = url.searchParams.get('path') || '';
  const exp = Number(url.searchParams.get('exp') || 0);
  const sig = url.searchParams.get('sig') || '';
  if (!bucket || !path || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !sig) {
    return json({ error: 'Expired or invalid archive link.' }, 403);
  }
  const expected = await hmacHex(proxySecret, `${bucket}\n${path}\n${exp}`);
  if (expected !== sig) return json({ error: 'Invalid archive signature.' }, 403);

  const { data, error } = await admin.from('archive_backup_items')
    .select('provider_drive_id,provider_item_id')
    .eq('bucket_id', bucket)
    .eq('object_name', path)
    .eq('status', 'archived')
    .maybeSingle();
  if (error || !data?.provider_drive_id || !data?.provider_item_id) return json({ error: 'Archived file not found.' }, 404);

  try {
    const token = await graphToken();
    const response = await fetch(
      `${GRAPH}/drives/${encodeURIComponent(data.provider_drive_id)}/items/${encodeURIComponent(data.provider_item_id)}/content`,
      { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' },
    );
    if (!response.ok || !response.body) return json({ error: `Microsoft file retrieval failed (${response.status}).` }, 502);
    const headers = new Headers();
    headers.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    headers.set('Cache-Control', 'private, max-age=300');
    const length = response.headers.get('content-length');
    if (length) headers.set('Content-Length', length);
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
    const serviceKey = namedKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const proxySecret = Deno.env.get('ARCHIVE_PROXY_SECRET')?.trim() || serviceKey;
    const url = new URL(req.url);

    if (req.method === 'GET' && url.searchParams.get('action') === 'file') {
      return await proxyArchivedFile(admin, req, proxySecret);
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'status');

    if (action === 'status') {
      const user = await authenticatedUser(admin, req);
      if (!user) return json({ error: 'Authentication required.' }, 401);
      const { data, error } = await admin.rpc('archive_backup_status');
      if (error) throw error;
      const microsoftConfigured = Boolean(
        Deno.env.get('MS_TENANT_ID')?.trim() && Deno.env.get('MS_CLIENT_ID')?.trim() && Deno.env.get('MS_CLIENT_SECRET')?.trim()
      );
      return json({ ...data, microsoft_configured: microsoftConfigured });
    }

    if (action === 'sign') {
      return await signedArchiveUrls(admin, req, body, proxySecret);
    }

    if (action === 'run') {
      const config = await getConfig(admin);
      const supplied = req.headers.get('x-archive-cron') || '';
      if (!supplied || supplied !== config.cron_secret) return json({ error: 'Archive cron authorization failed.' }, 401);
      const result = await runArchive(admin, config);
      return json(result);
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (error) {
    console.error('image-archive-onedrive failed', error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
