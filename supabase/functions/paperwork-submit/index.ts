import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const BUCKET = 'paperwork-submissions';
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_NOTE_LENGTH = 500;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_SUBMISSIONS = 20;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function namedKey(envName: string, legacyName: string): string {
  const raw = Deno.env.get(envName);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      // Local development may provide a plain value instead of a JSON map.
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

type MatchCandidate = {
  sourceTable: string;
  sourceId: number;
  loadNumber: string;
  shiftDate: string | null;
  isArchived: boolean;
};

async function findCandidates(admin: ReturnType<typeof createClient>, proNumber: string): Promise<MatchCandidate[]> {
  const candidates = new Map<string, MatchCandidate>();

  // Direct loads_shifts lookup checks BOTH identifiers. analytics_load_facts_all
  // intentionally coalesces these fields and therefore cannot cover every
  // historical case by itself.
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

  // This view covers live and archived load facts across locations. It is also
  // what lets a late upload be recognized after the operational row was purged.
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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');

    const publishableKey = namedKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
    const secretKey = namedKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Phone verification required.' }, 401);

    const accessToken = authHeader.slice('Bearer '.length).trim();
    const authClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(accessToken);

    if (userError || !user?.id || !user.phone) {
      return json({ error: 'Phone verification required.' }, 401);
    }

    const form = await req.formData();
    const proNumber = String(form.get('proNumber') ?? '').trim();
    const note = String(form.get('note') ?? '').trim();
    const images = form.getAll('images').filter((value): value is File => value instanceof File);

    if (!/^\d{1,20}$/.test(proNumber)) {
      return json({ error: 'Enter a valid Aljex / Pro number.' }, 400);
    }
    if (note.length > MAX_NOTE_LENGTH) {
      return json({ error: `Notes must be ${MAX_NOTE_LENGTH} characters or fewer.` }, 400);
    }
    if (images.length < 1 || images.length > MAX_IMAGES) {
      return json({ error: `Submit between 1 and ${MAX_IMAGES} images.` }, 400);
    }

    for (const image of images) {
      if (!ALLOWED_MIME_TYPES.has(image.type)) {
        return json({ error: `Unsupported image type: ${image.type || 'unknown'}.` }, 400);
      }
      if (image.size > MAX_IMAGE_BYTES) {
        return json({ error: `${image.name || 'An image'} is larger than 15 MB.` }, 400);
      }
    }

    const rateStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count: recentCount, error: rateError } = await admin
      .from('paperwork_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('sender_auth_user_id', user.id)
      .gte('submitted_at', rateStart);
    if (rateError) throw rateError;
    if ((recentCount ?? 0) >= RATE_MAX_SUBMISSIONS) {
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

    const submissionId = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    const { error: submissionError } = await admin.from('paperwork_submissions').insert({
      id: submissionId,
      sender_auth_user_id: user.id,
      sender_phone: user.phone,
      pro_number: proNumber,
      note: note || null,
      status,
      match_reason: matchReason,
      matched_source_table: matched?.sourceTable ?? null,
      matched_source_id: matched?.sourceId ?? null,
      matched_shift_id: matched?.sourceTable === 'loads_shifts' && !matched.isArchived ? matched.sourceId : null,
      matched_load_number: matched?.loadNumber ?? null,
      matched_is_archived: matched?.isArchived ?? false,
      submitted_at: submittedAt,
    });
    if (submissionError) throw submissionError;

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
      status: status === 'archived_match' ? 'needs_review' : status,
      message: status === 'attached'
        ? 'Paperwork received and matched.'
        : 'Paperwork received. The office will review the load match.',
    }, 201);
  } catch (error) {
    console.error('paperwork-submit failed', error);
    return json({ error: 'Could not save paperwork. Please try again.' }, 500);
  }
});
