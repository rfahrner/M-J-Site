import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const ALLOWED_ORIGINS = new Set([
  'https://rfahrner.github.io',
  'https://app.carrierdocs.com',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

const FORWARDED_HEADERS = [
  'content-type',
  'x-mj-install-id',
  'x-mj-submission-id',
  'x-mj-retry-of',
  'x-mj-retry-number',
  'x-mj-receipt-check',
];

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': FORWARDED_HEADERS.join(', '),
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

Deno.serve(async (req: Request) => {
  const origin = (req.headers.get('origin') || '').trim();
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response('Origin not allowed.', { status: 403 });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, origin);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }

    const upstream = await fetch(`${supabaseUrl}/functions/v1/paperwork-intake-v2`, {
      method: 'POST',
      headers,
      body: req.body,
    });

    const responseHeaders = new Headers(corsHeaders(origin));
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) responseHeaders.set('Retry-After', retryAfter);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('paperwork-pwa-submit failed', error);
    return json({ error: 'Could not reach the paperwork service. Please try again.' }, 502, origin);
  }
});