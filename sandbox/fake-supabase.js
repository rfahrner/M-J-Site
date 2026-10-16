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

  // window.__SANDBOX_LATENCY_MS makes queries take time, which some bugs need.
  // With an instant database every re-render looks seamless; a dispatcher's
  // does not. A gap measured at 0ms latency is the FLOOR, not the experience.
  const latency = () => Number(window.__SANDBOX_LATENCY_MS || 0);

  function result(data) {
    // A PostgREST builder is a thenable that also answers every filter method
    // by returning itself. Tests care about what comes back, not the WHERE.
    const builder = {
      then: (resolve) => {
        const ms = latency();
        const payload = { data, error: null, count: data.length };
        if (ms > 0) { setTimeout(() => resolve(payload), ms); return; }
        resolve(payload);
      },
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

  /*
   * The two additions below are DECORATORS, wrapped around the client after it
   * is built, and that is deliberate.
   *
   * Four specs (accounting-refresh, accounting-clear-rate,
   * accounting-row-delete, mondelez-row-menu) install their own stubs by
   * string-replacing exact lines of THIS FILE's source: the `result` function
   * signature, the `from:` line that calls it, the line inside result() that
   * assigns the insert/update/upsert/delete methods, and the one-line default
   * `rpc` in the client literal. Editing any of those in place makes their
   * .replace() calls match nothing, silently leaves their stubs uninstalled,
   * and the spec fails thirty seconds later on an unrelated timeout. That is
   * how it failed the first time this file was extended.
   *
   * Those four lines are an API now: wrap, do not edit -- and do not quote any
   * of them in a comment either, because .replace() takes the FIRST match and
   * a copy in a comment above the real line steals it.
   *
   * Because the wrapping happens after the spec's replacement, a spec's own
   * rpc becomes the delegate below, which composes correctly.
   */
  const writes = [];
  window.__sandboxWrites = (table) => (table ? writes.filter((w) => w.table === table) : writes.slice());
  window.__sandboxClearWrites = () => { writes.length = 0; };
  const rpcs = [];
  window.__sandboxRpcs = (fn) => (fn ? rpcs.filter((r) => r.fn === fn) : rpcs.slice());

  // Writes are RECORDED. Without this a spec can watch an alert disappear
  // from the screen and never learn whether the column behind it was written
  // -- and a forgotten write looks exactly like a cleared alert until the next
  // dispatcher reloads the board.
  function recordWrites(builder, table) {
    ['insert', 'update', 'upsert', 'delete'].forEach((op) => {
      const inner = builder[op];
      if (typeof inner !== 'function') return;
      builder[op] = (values) => { writes.push({ table, op, values }); return inner(values); };
    });
    return builder;
  }

  // log_alert_text_click is answered properly. Every alert Text button in the
  // app calls logAlertTextClick() before opening the modal, and
  // writeAlertTextClick() throws "The alert history entry was not confirmed."
  // unless the RPC returns one row per load id -- which the click handler
  // catches, so the button showed a status line and opened nothing. A spec saw
  // a dead button and no error. Anything other than that one function is
  // passed straight through to whatever rpc the client already had.
  function decorate(client) {
    const innerFrom = client.from, innerRpc = client.rpc;
    client.from = (table) => recordWrites(innerFrom(table), table);
    client.rpc = (fn, params) => {
      rpcs.push({ fn, params });
      if (fn !== 'log_alert_text_click') return innerRpc(fn, params);
      const ids = (params && params.p_load_ids) || [];
      return Promise.resolve({
        data: ids.map((id, i) => ({
          id: 90000 + i, source: params.p_source, shift_id: id, trip_id: params.p_trip_id,
          alert_label: params.p_alert_label, message: params.p_message,
          clicked_at: new Date().toISOString(), note: '',
        })),
        error: null,
      });
    };
    return client;
  }

  window.supabase = {
    createClient() {
      return decorate({
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
      });
    },
  };
})();
