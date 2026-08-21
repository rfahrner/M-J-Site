// Node-side compatibility wrapper for Supabase server API keys.
// New sb_secret_* keys are API keys, not JWTs. Keep them in the `apikey`
// header and remove a redundant `Authorization: Bearer sb_secret_*` header
// if a client library adds one. Legacy service_role JWT keys are unchanged.

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function supabaseCompatibleFetch(input, init = {}) {
  const sourceHeaders = init.headers || (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(sourceHeaders);
  const apiKey = headers.get('apikey');
  const authorization = headers.get('authorization');

  if (
    apiKey?.startsWith('sb_secret_') &&
    authorization === `Bearer ${apiKey}`
  ) {
    headers.delete('authorization');
  }

  try {
    return await nativeFetch(input, { ...init, headers });
  } catch (error) {
    const cause = error?.cause || error;
    console.error('Underlying Node fetch error:');
    console.error(cause);
    throw error;
  }
};
