import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

// The Edge Function intentionally uses an ungenerated service-role client. Bind
// the generic Database parameter to `any` so helper functions do not collapse
// table rows/RPC args to `never` during standalone `deno check`.
export type AdminSupabaseClient = ReturnType<typeof createClient<any>>;
