import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const ALLOWED_LOCATIONS = new Set(['kroger_atlanta', 'kroger_delaware']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORWARDED_HEADERS = [
  'x-mj-install-id',
  'x-mj-submission-id',
  'x-mj-retry-of',
  'x-mj-retry-number',
  'x-mj-receipt-check',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

function coreHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');

    const requestedId = (req.headers.get('x-mj-submission-id') || '').trim();
    if (requestedId && !UUID_RE.test(requestedId)) {
      return json({ error: 'This saved paperwork submission ID is invalid.' }, 400);
    }

    // Legacy receipt checks contain no multipart sender fields. Keep them on
    // the original hardened core path unchanged.
    if (req.headers.get('x-mj-receipt-check') === '1') {
      const upstream = await fetch(`${supabaseUrl}/functions/v1/paperwork-submit`, {
        method: 'POST', headers: coreHeaders(req), body: req.body,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      });
    }

    const secretKey = namedKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const form = await req.formData();
    const driverName = String(form.get('driverName') ?? '').trim().replace(/\s+/g, ' ');
    const submittedLocation = String(form.get('location') ?? '').trim();
    const proNumber = String(form.get('proNumber') ?? '').trim();

    if (driverName.length < 1 || driverName.length > 120) return json({ error: 'Enter the driver name.' }, 400);
    if (!ALLOWED_LOCATIONS.has(submittedLocation)) return json({ error: 'Choose Kroger Atlanta or Kroger Delaware.' }, 400);
    if (proNumber && !/^\d{1,20}$/.test(proNumber)) return json({ error: 'If you enter a Pro number, use digits only.' }, 400);

    // Keep the hardened core upload/rate-limit/retry pipeline unchanged.
    // Blank Pro uses a guaranteed non-match sentinel only while traversing
    // that core and is normalized back to NULL immediately afterward.
    const forwarded = new FormData();
    forwarded.set('proNumber', proNumber || '0');
    for (const value of form.getAll('images')) forwarded.append('images', value);

    const upstream = await fetch(`${supabaseUrl}/functions/v1/paperwork-submit`, {
      method: 'POST', headers: coreHeaders(req), body: forwarded,
    });

    const payload = await upstream.clone().json().catch(() => null) as { submissionId?: string } | null;
    const submissionId = payload?.submissionId || requestedId || null;

    // Annotate anything that reached the core, including an incomplete intake,
    // so office staff still get the submitted driver/location and unread state.
    if (submissionId && UUID_RE.test(submissionId)) {
      const patch: Record<string, unknown> = {
        driver_name: driverName,
        submitted_location: submittedLocation,
        inbox_status: 'unread',
      };
      if (!proNumber) patch.pro_number = null;
      const { error: updateError } = await admin.from('paperwork_submissions').update(patch).eq('id', submissionId);
      if (updateError) console.error('paperwork metadata update failed', updateError);

      if (!proNumber && upstream.ok) {
        await admin.from('paperwork_notes').insert({
          submission_id: submissionId,
          note_text: 'No Pro number was provided with this Carrier Docs submission. The intake placeholder was normalized to blank after receipt.',
        });
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });
  } catch (error) {
    console.error('paperwork-intake-v2 failed', error);
    return json({ error: 'Could not save paperwork. Please try again.' }, 500);
  }
});
