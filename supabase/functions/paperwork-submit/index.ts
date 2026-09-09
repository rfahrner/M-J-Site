import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const BUCKET = 'paperwork-submissions';
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 60 * 1024 * 1024;
const INSTALL_RATE_WINDOW_SECONDS = 10 * 60;
const INSTALL_RATE_MAX = 20;
const GLOBAL_RATE_WINDOW_SECONDS = 10 * 60;
const GLOBAL_RATE_MAX = 2000;
const RECEIPT_RATE_MAX = 60;
const GLOBAL_RECEIPT_RATE_MAX = 10000;
const STALE_INTAKE_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

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

function extensionFor(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;

  switch (file.type) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    default: return 'jpg';
  }
}

async function sha256Hex(value: string): Promise<string> {
  const input = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type MatchCandidate = {
  sourceTable: string;
  sourceId: number;
  loadNumber: string;
  shiftDate: string | null;
  isArchived: boolean;
};

type ExistingSubmission = {
  id: string;
  submitted_at: string;
};

async function findCandidates(admin: ReturnType<typeof createClient>, proNumber: string): Promise<MatchCandidate[]> {
  const candidates = new Map<string, MatchCandidate>();

  const { data: directRows, error: directError } = await admin
    .from('loads_shifts')
    .select('id,shift_date,pro_number,aljex_load_number')
    .or(`pro_number.eq.${proNumber},aljex_load_number.eq.${proNumber}`)
    .limit(25);
  if (directError) throw directError;

  for (const row of directRows ?? []) {
    candidates.set(`loads_shifts:${row.id}`, {
      sourceTable: 'loads_shifts',
      sourceId: Number(row.id),
      loadNumber: String(row.aljex_load_number || row.pro_number || proNumber),
      shiftDate: row.shift_date ?? null,
      isArchived: false,
    });
  }

  const { data: factRows, error: factError } = await admin
    .from('analytics_load_facts_all')
    .select('source_table,original_id,load_number,shift_date,is_archived')
    .eq('load_number', proNumber)
    .limit(25);
  if (factError) throw factError;

  for (const row of factRows ?? []) {
    const key = `${row.source_table}:${row.original_id}`;
    candidates.set(key, {
      sourceTable: String(row.source_table),
      sourceId: Number(row.original_id),
      loadNumber: String(row.load_number || proNumber),
      shiftDate: row.shift_date ?? null,
      isArchived: Boolean(row.is_archived),
    });
  }

  return [...candidates.values()].sort((a, b) =>
    String(b.shiftDate ?? '').localeCompare(String(a.shiftDate ?? '')),
  );
}

async function consumeRateLimit(
  admin: ReturnType<typeof createClient>,
  keyHash: string,
  windowSeconds: number,
  maxSubmissions: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc('consume_paperwork_rate_limit', {
    p_key_hash: keyHash,
    p_window_seconds: windowSeconds,
    p_max_submissions: maxSubmissions,
  });
  if (error) throw error;
  return data === true;
}

async function cleanupStaleSubmission(
  admin: ReturnType<typeof createClient>,
  submissionId: string,
): Promise<void> {
  const paths = new Set<string>();

  const { data: imageRows, error: imageError } = await admin
    .from('paperwork_images')
    .select('storage_path')
    .eq('submission_id', submissionId);
  if (imageError) throw imageError;
  for (const row of imageRows ?? []) {
    if (row.storage_path) paths.add(String(row.storage_path));
  }

  // Also inspect the submission prefix so a hard runtime interruption between
  // Storage upload and paperwork_images insert cannot leave an orphan behind.
  const { data: objects, error: listError } = await admin.storage
    .from(BUCKET)
    .list(submissionId, { limit: 100 });
  if (!listError) {
    for (const object of objects ?? []) {
      if (object.name) paths.add(`${submissionId}/${object.name}`);
    }
  }

  if (paths.size) {
    const { error: removeError } = await admin.storage.from(BUCKET).remove([...paths]);
    if (removeError) throw removeError;
  }

  const { error: deleteError } = await admin
    .from('paperwork_submissions')
    .delete()
    .eq('id', submissionId);
  if (deleteError) throw deleteError;
}

async function existingSubmissionResponse(
  admin: ReturnType<typeof createClient>,
  submissionId: string,
): Promise<Response | null> {
  const { data, error } = await admin
    .from('paperwork_submissions')
    .select('id,submitted_at')
    .eq('id', submissionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const existing = data as ExistingSubmission;
  const { data: completedEvents, error: eventError } = await admin
    .from('paperwork_submission_events')
    .select('id')
    .eq('submission_id', submissionId)
    .in('event_type', ['auto_attached', 'archived_matched', 'needs_review'])
    .limit(1);
  if (eventError) throw eventError;

  if ((completedEvents ?? []).length > 0) {
    return json({
      submissionId,
      receivedAt: existing.submitted_at,
      status: 'received',
      message: 'Paperwork received.',
    }, 200);
  }

  const submittedAtMs = new Date(existing.submitted_at).getTime();
  const ageMs = Number.isFinite(submittedAtMs) ? Date.now() - submittedAtMs : 0;
  if (ageMs < STALE_INTAKE_MS) {
    return json(
      { error: 'This paperwork is still being saved. Wait a moment and tap Retry Submission again.' },
      409,
      { 'Retry-After': '3' },
    );
  }

  await cleanupStaleSubmission(admin, submissionId);
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');

    const secretKey = namedKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const installId = (req.headers.get('x-mj-install-id') || '').trim();
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(installId)) {
      return json({ error: 'This app installation could not be identified. Restart the app and try again.' }, 400);
    }

    const requestedSubmissionId = (req.headers.get('x-mj-submission-id') || '').trim();
    if (requestedSubmissionId && !UUID_RE.test(requestedSubmissionId)) {
      return json({ error: 'This saved paperwork retry is invalid. Start a new submission and try again.' }, 400);
    }

    const receiptProbe = req.headers.get('x-mj-receipt-check') === '1';
    if (receiptProbe && !requestedSubmissionId) {
      return json({ error: 'A submission ID is required to check a receipt.' }, 400);
    }

    const submissionId = requestedSubmissionId || crypto.randomUUID();

    if (receiptProbe) {
      // Receipt probes are deliberately separate from submission limits. They
      // carry no paperwork and return no Pro/load/driver details, but still get
      // their own abuse throttle because this is a public zero-login endpoint.
      const installHash = await sha256Hex(`receipt:${installId}`);
      const [installAllowed, globalAllowed] = await Promise.all([
        consumeRateLimit(admin, installHash, INSTALL_RATE_WINDOW_SECONDS, RECEIPT_RATE_MAX),
        consumeRateLimit(admin, await sha256Hex('paperwork-receipt-global-v1'), GLOBAL_RATE_WINDOW_SECONDS, GLOBAL_RECEIPT_RATE_MAX),
      ]);
      if (!installAllowed || !globalAllowed) {
        return json({ error: 'Too many receipt checks in a short period. Wait a moment and try again.' }, 429);
      }

      const existingResponse = await existingSubmissionResponse(admin, submissionId);
      if (existingResponse) return existingResponse;

      // No completed or active intake exists for this UUID. The mobile app may
      // safely continue with the normal full upload using the SAME UUID.
      return json({ status: 'not_found' }, 404);
    }

    // Backward-compatible full retry fast path. Older idempotent app versions
    // may resend multipart data directly; acknowledge an existing result before
    // parsing that multipart body.
    if (requestedSubmissionId) {
      const existingResponse = await existingSubmissionResponse(admin, submissionId);
      if (existingResponse) return existingResponse;
    }

    const form = await req.formData();
    const proNumber = String(form.get('proNumber') ?? '').trim();
    const images = form.getAll('images').filter((value): value is File => value instanceof File);

    if (!/^\d{1,20}$/.test(proNumber)) {
      return json({ error: 'Enter a valid Aljex / Pro number.' }, 400);
    }
    if (images.length < 1 || images.length > MAX_IMAGES) {
      return json({ error: `Submit between 1 and ${MAX_IMAGES} images.` }, 400);
    }

    let totalImageBytes = 0;
    for (const image of images) {
      if (!ALLOWED_MIME_TYPES.has(image.type)) {
        return json({ error: `Unsupported image type: ${image.type || 'unknown'}.` }, 400);
      }
      if (image.size < 1) {
        return json({ error: `${image.name || 'An image'} is empty.` }, 400);
      }
      if (image.size > MAX_IMAGE_BYTES) {
        return json({ error: `${image.name || 'An image'} is larger than 15 MB.` }, 400);
      }
      totalImageBytes += image.size;
    }
    if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      return json({ error: 'This submission is too large. Send fewer photos and try again.' }, 400);
    }

    const installHash = await sha256Hex(`install:${installId}`);
    const [installAllowed, globalAllowed] = await Promise.all([
      consumeRateLimit(admin, installHash, INSTALL_RATE_WINDOW_SECONDS, INSTALL_RATE_MAX),
      consumeRateLimit(admin, await sha256Hex('paperwork-global-v1'), GLOBAL_RATE_WINDOW_SECONDS, GLOBAL_RATE_MAX),
    ]);
    if (!installAllowed || !globalAllowed) {
      return json({ error: 'Too many submissions in a short period. Try again shortly.' }, 429);
    }

    const candidates = await findCandidates(admin, proNumber);
    let status: 'attached' | 'needs_review' | 'archived_match' = 'needs_review';
    let matchReason: 'exact_unique' | 'no_match' | 'ambiguous' | 'archived_unique' = 'no_match';
    let matched: MatchCandidate | null = null;

    if (candidates.length === 1) {
      matched = candidates[0];
      if (matched.isArchived) {
        status = 'archived_match';
        matchReason = 'archived_unique';
      } else {
        status = 'attached';
        matchReason = 'exact_unique';
      }
    } else if (candidates.length > 1) {
      matchReason = 'ambiguous';
    }

    const submittedAt = new Date().toISOString();
    const { error: submissionError } = await admin.from('paperwork_submissions').insert({
      id: submissionId,
      pro_number: proNumber,
      status,
      match_reason: matchReason,
      matched_source_table: matched?.sourceTable ?? null,
      matched_source_id: matched?.sourceId ?? null,
      matched_shift_id: matched?.sourceTable === 'loads_shifts' && !matched.isArchived ? matched.sourceId : null,
      matched_load_number: matched?.loadNumber ?? null,
      matched_is_archived: matched?.isArchived ?? false,
      submitted_at: submittedAt,
    });
    if (submissionError) {
      // A simultaneous retry may race the first request to the insert. Resolve
      // the winner through the normal idempotency path instead of returning 500.
      if (requestedSubmissionId && String((submissionError as { code?: string }).code || '') === '23505') {
        const existingResponse = await existingSubmissionResponse(admin, submissionId);
        if (existingResponse) return existingResponse;
      }
      throw submissionError;
    }

    const uploadedPaths: string[] = [];
    try {
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        const imageId = crypto.randomUUID();
        const path = `${submissionId}/${String(index + 1).padStart(2, '0')}-${imageId}.${extensionFor(image)}`;
        const bytes = await image.arrayBuffer();

        const { error: uploadError } = await admin.storage
          .from(BUCKET)
          .upload(path, bytes, { contentType: image.type, upsert: false });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);

        const { error: imageError } = await admin.from('paperwork_images').insert({
          id: imageId,
          submission_id: submissionId,
          storage_bucket: BUCKET,
          storage_path: path,
          original_file_name: image.name || `paperwork-${index + 1}.${extensionFor(image)}`,
          mime_type: image.type,
          byte_size: image.size,
          sort_order: index,
        });
        if (imageError) throw imageError;
      }

      const eventType = status === 'attached' ? 'auto_attached' : status === 'archived_match' ? 'archived_matched' : 'needs_review';
      const { error: eventError } = await admin.from('paperwork_submission_events').insert({
        submission_id: submissionId,
        event_type: eventType,
        to_source_table: matched?.sourceTable ?? null,
        to_source_id: matched?.sourceId ?? null,
        event_note: matchReason,
      });
      if (eventError) throw eventError;
    } catch (error) {
      if (uploadedPaths.length) await admin.storage.from(BUCKET).remove(uploadedPaths);
      await admin.from('paperwork_submissions').delete().eq('id', submissionId);
      throw error;
    }

    return json({
      submissionId,
      receivedAt: submittedAt,
      status: 'received',
      message: 'Paperwork received.',
    }, 201);
  } catch (error) {
    console.error('paperwork-submit failed', error);
    return json({ error: 'Could not save paperwork. Please try again.' }, 500);
  }
});
