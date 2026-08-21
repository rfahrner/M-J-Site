/*
 * Analytics read compatibility layer.
 * On analytics pages only, SELECTs against the live operational tables are
 * redirected to combined live + archived history views. Mutations continue to
 * target the original tables.
 */
(function installAnalyticsDataCompat() {
  const tableMap = {
    loads_shifts: 'analytics_shifts_all',
    loads_trips: 'analytics_trips_all',
    loads_accounting: 'analytics_accounting_all',
  };

  function wrapClient(client) {
    const originalFrom = client.from.bind(client);

    client.from = function analyticsAwareFrom(table) {
      const liveBuilder = originalFrom(table);
      const mappedTable = tableMap[table];
      if (!mappedTable) return liveBuilder;

      return new Proxy(liveBuilder, {
        get(target, prop, receiver) {
          if (prop === 'select') {
            return (...args) => originalFrom(mappedTable).select(...args);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    return client;
  }

  function patchCreateClient() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') return false;
    if (window.supabase.createClient.__analyticsCompatWrapped) return true;

    const originalCreateClient = window.supabase.createClient.bind(window.supabase);
    const wrapped = function (...args) {
      return wrapClient(originalCreateClient(...args));
    };
    wrapped.__analyticsCompatWrapped = true;
    window.supabase.createClient = wrapped;
    return true;
  }

  if (patchCreateClient()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (patchCreateClient() || attempts >= 30) clearInterval(timer);
  }, 100);
})();
