/*
 * A fake Supabase client for the browser sandbox.
 *
 * It is injected BEFORE supabase.min.js runs and simply wins the race:
 * loadboard.js waits for `window.supabase` and calls createClient on whatever
 * it finds. Nothing else in the app is patched, so the real init(), the real
 * renderers and the real event handlers all run against it.
 *
 * The point is LAYOUT. Every test in scripts/ runs in jsdom, which has no
 * layout engine at all -- no scroll position, no element geometry -- so a bug
 * where the page jumps when you click something is invisible to all of them.
 * This runs in real Chromium, where window.scrollY means something.
 *
 * Fixtures come from window.__SANDBOX_ROWS, set per test.
 */
(function () {
  const rows = () => (window.__SANDBOX_ROWS || {});

  function result(data) {
    // A PostgREST builder is a thenable that also answers every filter method
    // by returning itself. Tests care about what comes back, not the WHERE.
    const builder = {
      then: (resolve) => resolve({ data, error: null, count: data.length }),
      catch: undefined, // deliberately absent -- the real builder has none either
    };
    const passthrough = ['select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'gt', 'lt',
      'or', 'order', 'limit', 'range', 'filter', 'contains', 'ilike', 'like', 'match'];
    passthrough.forEach((m) => { builder[m] = () => builder; });
    ['insert', 'update', 'upsert', 'delete'].forEach((m) => {
      builder[m] = () => ({ ...builder, select: () => builder, maybeSingle: async () => ({ data: data[0] || null, error: null }) });
    });
    builder.single = async () => ({ data: data[0] || null, error: null });
    builder.maybeSingle = async () => ({ data: data[0] || null, error: null });
    return builder;
  }

  // Realtime handlers are RECORDED, so a test can play another dispatcher's
  // edit arriving mid-keystroke. That is the condition most of this app's
  // nastiest bugs need, and it cannot be staged any other way.
  const handlers = [];
  const channel = () => {
    const ch = {
      on: (_evt, filter, cb) => { handlers.push({ filter: filter || {}, cb: cb || filter }); return ch; },
      subscribe: (cb) => { if (typeof cb === 'function') cb('SUBSCRIBED'); return ch; },
      unsubscribe: () => {},
      // The board broadcasts presence/typing over the channel; without this
      // every realtime redraw threw "boardChannel.send is not a function"
      // and the handler aborted before the part under test.
      send: async () => ({ status: 'ok' }),
      track: async () => ({ status: 'ok' }),
      untrack: async () => ({ status: 'ok' }),
      presenceState: () => ({}),
    };
    return ch;
  };

  // window.__sandboxEmit('loads_shifts', { eventType: 'UPDATE', new: {...} })
  window.__sandboxEmit = (table, payload) => {
    let delivered = 0;
    handlers.forEach(({ filter, cb }) => {
      if (filter && filter.table && filter.table !== table) return;
      try { cb({ table, ...payload }); delivered++; } catch (e) { console.error('[sandbox] handler threw', e); }
    });
    return delivered;
  };
  window.__sandboxHandlerCount = () => handlers.length;

  window.supabase = {
    createClient() {
      return {
        from: (table) => result(rows()[table] || []),
        rpc: async () => ({ data: null, error: null }),
        channel,
        removeChannel: () => {},
        removeAllChannels: () => {},
        storage: {
          from: () => ({
            createSignedUrl: async () => ({ data: { signedUrl: '' }, error: null }),
            createSignedUrls: async () => ({ data: [], error: null }),
            upload: async () => ({ error: null }),
            remove: async () => ({ error: null }),
            list: async () => ({ data: [], error: null }),
          }),
        },
        auth: {
          // A signed-in dispatcher. requireAuth() does redirect to login.html
          // when this is empty, and a redirect mid-test looks exactly like a
          // crash, so the fake answers it properly.
          getSession: async () => ({ data: { session: { user: { id: 'sandbox-user', email: 'sandbox@dltransport.com' } } }, error: null }),
          getUser: async () => ({ data: { user: { id: 'sandbox-user', email: 'sandbox@dltransport.com' } }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signOut: async () => ({ error: null }),
        },
      };
    },
  };
})();
