/* Trusted application-role compatibility layer.
   loadboard.js historically reads user.user_metadata.role for UI routing.
   Authorization is now enforced by public.user_roles + RLS, so this wrapper
   replaces only the role value returned by auth.getUser() with the trusted
   database role. Raw user metadata is never treated as authoritative.

   IT remains a distinct database role, but the existing UI currently has
   only admin/accounting checks. Until the UI is refactored, IT is presented
   to those UI checks as "admin" so IT/Security gets admin-equivalent access.
   The database still sees the real "it" role and enforces it independently.
*/

const INSTALL_FLAG = '__dlTrustedRoleCompatInstalled';
const ROLE_TABLE = 'user_roles';

function installTrustedRoleCompat() {
  const sdk = typeof window !== 'undefined' ? window.supabase : null;
  if (!sdk || typeof sdk.createClient !== 'function' || sdk[INSTALL_FLAG]) return false;

  const originalCreateClient = sdk.createClient.bind(sdk);

  sdk.createClient = function trustedRoleCreateClient(...args) {
    const client = originalCreateClient(...args);
    if (!client || !client.auth || typeof client.auth.getUser !== 'function') return client;

    const originalGetUser = client.auth.getUser.bind(client.auth);
    client.auth.getUser = async function trustedRoleGetUser(...getUserArgs) {
      const result = await originalGetUser(...getUserArgs);
      const user = result && result.data && result.data.user;
      if (!user || result.error) return result;

      let trustedRole = null;
      try {
        const { data: roleRows, error: roleError } = await client
          .from(ROLE_TABLE)
          .select('role')
          .eq('user_id', user.id)
          .limit(1);

        if (roleError) {
          console.error('Trusted role lookup failed:', roleError);
        } else if (roleRows && roleRows[0]) {
          trustedRole = roleRows[0].role || null;
        }
      } catch (error) {
        console.error('Trusted role lookup threw:', error);
      }

      // Fail closed: if the trusted lookup is missing or fails, never fall
      // back to user-editable metadata. IT maps to admin for current UI only.
      const uiRole = trustedRole === 'it' ? 'admin' : trustedRole;
      return {
        ...result,
        data: {
          ...result.data,
          user: {
            ...user,
            user_metadata: {
              ...(user.user_metadata || {}),
              role: uiRole,
            },
          },
        },
      };
    };

    return client;
  };

  Object.defineProperty(sdk, INSTALL_FLAG, { value: true, configurable: false });
  return true;
}

if (!installTrustedRoleCompat() && typeof window !== 'undefined') {
  // loadboard.js waits briefly for the Supabase CDN bundle. Mirror that
  // tolerance here so the wrapper is installed before initSupabaseClient()
  // creates the application client, even on a slower CDN load.
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    if (installTrustedRoleCompat() || Date.now() - startedAt > 4500) {
      window.clearInterval(timer);
    }
  }, 25);
}
