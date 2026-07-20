// Supabase Edge Function: send-text
//
// Sends a text via TextBetter's direct REST API -- no email involved at
// all, which means no Microsoft 365 / Graph / admin consent requirement.
//
// Required secrets (set via `supabase secrets set`):
//   TEXTBETTER_API_KEY   - from your TextBetter account settings
//   TEXTBETTER_ENDPOINT  - the full SendOutgoingMessages URL including
//                          the ?code=... query param, from TextBetter's
//                          API docs/account (this is TextBetter's own
//                          endpoint auth, separate from TEXTBETTER_API_KEY)
//
// TEXTBETTER_FROM_NUMBER is hardcoded below rather than a secret -- it's
// not sensitive the way the key/endpoint are, just the number already
// paired to memppw@dltransport.com in TextBetter (same number drivers
// see today). Update it directly here if that pairing ever changes.

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

const TEXTBETTER_API_KEY: string = Deno.env.get("TEXTBETTER_API_KEY") || "";
const TEXTBETTER_ENDPOINT: string = Deno.env.get("TEXTBETTER_ENDPOINT") || "";
const TEXTBETTER_FROM_NUMBER: string = "19133364699"; // number paired to memppw@dltransport.com in TextBetter

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_RECIPIENTS_PER_MESSAGE = 100; // TextBetter API v2's documented limit (the email gateway's old 9-recipient cap doesn't apply here)

function normalizeToTextBetterNumber(raw: unknown): string | null {
  // Same logic as the app's existing formatTextAddress() (minus the
  // @textbetter.com suffix, since the API wants a bare number).
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const withCountryCode = digits.length === 10 ? "1" + digits : digits;
  if (withCountryCode.length < 10) return null;
  return withCountryCode;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendViaTextBetter(toNumbers: string[], body: string): Promise<void> {
  const res = await fetch(TEXTBETTER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromNumber: TEXTBETTER_FROM_NUMBER,
      toNumber: toNumbers,
      body,
      APIKey: TEXTBETTER_API_KEY,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TextBetter send failed: ${res.status} ${text}`);
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const payload: { message?: string; phones?: unknown[]; phone?: unknown } = await req.json();
    const message = payload.message;
    const rawPhones: unknown[] = Array.isArray(payload.phones)
      ? payload.phones
      : (payload.phone ? [payload.phone] : []);

    if (!rawPhones.length || !message || !String(message).trim()) {
      return new Response(JSON.stringify({ error: "phone (or phones) and message are required" }), { status: 400, headers: CORS_HEADERS });
    }

    const numbers: string[] = [];
    const invalid: string[] = [];
    for (const p of rawPhones) {
      const n = normalizeToTextBetterNumber(p);
      if (n) numbers.push(n); else invalid.push(String(p));
    }
    if (!numbers.length) {
      return new Response(JSON.stringify({ error: `None of the provided numbers were valid: ${invalid.join(", ")}` }), { status: 400, headers: CORS_HEADERS });
    }
    if (!TEXTBETTER_API_KEY || !TEXTBETTER_ENDPOINT || !TEXTBETTER_FROM_NUMBER) {
      return new Response(JSON.stringify({ error: "Server is missing TEXTBETTER_API_KEY / TEXTBETTER_ENDPOINT / TEXTBETTER_FROM_NUMBER secrets" }), { status: 500, headers: CORS_HEADERS });
    }

    const batches = chunk(numbers, MAX_RECIPIENTS_PER_MESSAGE);
    for (const batch of batches) {
      await sendViaTextBetter(batch, String(message).trim());
    }
    return new Response(
      JSON.stringify({ ok: true, sentTo: numbers, batches: batches.length, skipped: invalid }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (e: unknown) {
    console.error("send-text error:", e);
    return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: CORS_HEADERS });
  }
});