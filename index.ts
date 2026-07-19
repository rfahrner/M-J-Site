// Supabase Edge Function: send-text
//
// Sends a text message by emailing TextBetter's email-to-SMS gateway
// (recipientnumber@textbetter.com), using Microsoft Graph API to send
// the email as memppw@dltransport.com. Because the FROM address is
// memppw@dltransport.com, TextBetter delivers any reply back to that
// same inbox automatically -- no separate reply-routing config needed.
//
// Required secrets (set via `supabase secrets set`):
//   MS_TENANT_ID       - Azure AD tenant ID
//   MS_CLIENT_ID       - App registration client ID
//   MS_CLIENT_SECRET   - App registration client secret
//   SENDER_MAILBOX      - defaults to memppw@dltransport.com if unset
//
// The Azure AD app registration needs the Microsoft Graph APPLICATION
// permission "Mail.Send" (admin-consented), and the sending mailbox
// must be memppw@dltransport.com (or whatever SENDER_MAILBOX is set to).

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

const TENANT_ID = Deno.env.get("MS_TENANT_ID") || "";
const CLIENT_ID = Deno.env.get("MS_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET") || "";
const SENDER_MAILBOX = Deno.env.get("SENDER_MAILBOX") || "memppw@dltransport.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizePhoneToTextBetter(raw: string): string | null {
  // Matches the existing formatTextAddress() logic used elsewhere in the app
  // for the mailto: fallback, so both paths treat phone numbers identically.
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return null;
  const withCountryCode = digits.length === 10 ? "1" + digits : digits;
  if (withCountryCode.length < 10) return null; // too short to be a real number
  return `${withCountryCode}@textbetter.com`;
}

async function getGraphAccessToken(): Promise<string> {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

const MAX_RECIPIENTS_PER_EMAIL = 9; // TextBetter's limit -- anything larger must go as separate emails

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendGraphMail(accessToken: string, toAddresses: string[], bodyText: string) {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_MAILBOX)}/sendMail`;
  const payload = {
    message: {
      subject: "", // TextBetter ignores/strips the subject line -- leaving it blank per their docs
      body: { contentType: "Text", content: bodyText },
      toRecipients: toAddresses.map((addr) => ({ emailAddress: { address: addr } })),
    },
    saveToSentItems: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Graph sendMail failed: ${res.status} ${await res.text()}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const message = body.message;
    // Accepts either a single `phone` (one recipient) or `phones` (an array,
    // for group sends) -- both funnel into the same batched-send logic below.
    const rawPhones: string[] = Array.isArray(body.phones) ? body.phones : (body.phone ? [body.phone] : []);
    if (!rawPhones.length || !message || !String(message).trim()) {
      return new Response(JSON.stringify({ error: "phone (or phones) and message are required" }), { status: 400, headers: CORS_HEADERS });
    }
    const gateways: string[] = [];
    const invalid: string[] = [];
    for (const p of rawPhones) {
      const g = normalizePhoneToTextBetter(p);
      if (g) gateways.push(g); else invalid.push(p);
    }
    if (!gateways.length) {
      return new Response(JSON.stringify({ error: `None of the provided numbers were valid: ${invalid.join(", ")}` }), { status: 400, headers: CORS_HEADERS });
    }
    if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
      return new Response(JSON.stringify({ error: "Server is missing MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET secrets" }), { status: 500, headers: CORS_HEADERS });
    }
    const token = await getGraphAccessToken();
    const batches = chunk(gateways, MAX_RECIPIENTS_PER_EMAIL);
    for (const batch of batches) {
      await sendGraphMail(token, batch, String(message).trim());
    }
    return new Response(JSON.stringify({
      ok: true,
      sentTo: gateways,
      batches: batches.length,
      skipped: invalid,
    }), { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    console.error("send-text error:", e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: CORS_HEADERS });
  }
});