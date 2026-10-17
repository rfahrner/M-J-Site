/* Blank visitor tour. Server authorization is the boundary; this adapter keeps
 * the normal pages usable without fetching records or enabling live actions. */
(() => {
  if (!window.supabase?.createClient || window.DLVisitorAccess) return;
  const nativeFetch = window.fetch.bind(window);
  const createClient = window.supabase.createClient.bind(window.supabase);
  let rolePromise, role = null, bootstrapClient;
  const blocked = () => ({ message: 'Visitor access is view-only. Live data and changes are unavailable.', code: 'VISITOR_READ_ONLY' });
  function getRole() {
    if (!rolePromise) rolePromise = (async () => {
      const { data } = await bootstrapClient.auth.getSession();
      if (!data?.session) return null;
      const { data: value, error } = await bootstrapClient.rpc('current_app_role');
      if (error) throw error; // Never assume a failed role lookup grants access.
      role = value;
      if (role === 'visitor') activate();
      return role;
    })().catch(error => { rolePromise = null; throw error; });
    return rolePromise;
  }
  function activate() {
    const mount = () => {
      if (document.getElementById('visitor-banner')) return;
      document.documentElement.dataset.visitor = 'true';
      const banner = document.createElement('div');
      banner.id = 'visitor-banner'; banner.setAttribute('role', 'status');
      banner.textContent = 'Visitor access — explore the pages. Business data is hidden and changes are disabled.';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;height:36px;z-index:10000;background:#e8f1ff;color:#173b63;padding:9px 16px;font:600 12px system-ui;border-bottom:1px solid #b6cde9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const style = document.createElement('style');
      style.textContent = 'html[data-visitor] .topbar{top:36px}html[data-visitor] body{padding-top:36px}html[data-visitor] #board-view{max-height:calc(100vh - 88px)}';
      document.head.appendChild(style);
      document.body.prepend(banner);
    };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, {once:true});
  }
  // A deferred query preserves the SDK's chain interface. Only non-visitors
  // execute the real builder, including requests begun before auth settles.
  function query(client, table, operations = []) {
    return new Proxy({}, {get(_, method) {
      if (method === 'then') return (resolve, reject) => getRole().then(async current => {
        if (current !== 'visitor') {
          let builder = client.from(table);
          for (const [name, args] of operations) builder = builder[name](...args);
          return await builder;
        }
        const mutation = operations.some(([name]) => ['insert','update','upsert','delete'].includes(name));
        const single = operations.some(([name]) => ['single','maybeSingle'].includes(name));
        const ownRole = table === 'user_roles' ? [{role:'visitor'}] : [];
        return {data:mutation ? null : single ? ownRole[0] || null : ownRole,error:mutation ? blocked() : null,count:0,status:mutation ? 403 : 200,statusText:mutation ? 'Forbidden' : 'OK'};
      }).then(resolve, reject);
      if (typeof method !== 'string' || method === 'catch') return undefined;
      return (...args) => query(client, table, [...operations, [method, args]]);
    }});
  }
  function wrap(client) {
    const original = {from:client.from.bind(client),rpc:client.rpc.bind(client)};
    client.from = table => query(original, table);
    client.rpc = async (...args) => (await getRole()) === 'visitor' ? {data:null,error:blocked()} : original.rpc(...args);
    if (client.storage?.from) {
      const storageFrom = client.storage.from.bind(client.storage);
      client.storage.from = (...args) => {
        const bucket = storageFrom(...args);
        return new Proxy(bucket,{get(target,method){
          const value = target[method];
          if (typeof value !== 'function') return value;
          if (method === 'getPublicUrl') return (...values) => role === 'visitor' ? {data:{publicUrl:''}} : value.apply(target,values);
          return async (...values) => await getRole() === 'visitor' ? {data:null,error:blocked()} : value.apply(target,values);
        }});
      };
    }
    if (client.functions?.invoke) {
      const invoke = client.functions.invoke.bind(client.functions);
      client.functions.invoke = async (...args) => await getRole() === 'visitor' ? {data:null,error:blocked()} : invoke(...args);
    }
    const originalChannel = client.channel.bind(client);
    client.channel = (...args) => {
      const channel = originalChannel(...args), subscribe = channel.subscribe.bind(channel);
      channel.subscribe = callback => {
        getRole().then(current => {if(current !== 'visitor') subscribe(callback);}).catch(()=>{});
        return channel;
      };
      for (const method of ['send','track','untrack']) {
        const originalMethod = channel[method]?.bind(channel);
        if (originalMethod) channel[method] = async (...values) => await getRole() === 'visitor' ? 'ok' : originalMethod(...values);
      }
      return channel;
    };
    return client;
  }
  window.supabase = {...window.supabase, createClient(...args) {
    const raw = createClient(...args);
    if (!bootstrapClient) bootstrapClient = {auth:raw.auth,rpc:raw.rpc.bind(raw)};
    queueMicrotask(() => getRole().catch(() => {}));
    return wrap(raw);
  }};
  window.DLVisitorAccess = {getRole, isVisitor:()=>role === 'visitor'};
  // Also cover modules that use fetch directly and Storage/Functions clients.
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const service = url.hostname.endsWith('.supabase.co');
    if (!bootstrapClient || !service || url.pathname.startsWith('/auth/v1/') || url.pathname === '/rest/v1/rpc/current_app_role') return nativeFetch(input, init);
    if (await getRole() !== 'visitor') return nativeFetch(input, init);
    return new Response(JSON.stringify(blocked()), {status:403,headers:{'Content-Type':'application/json'}});
  };
  // Keep navigation, filters, date pickers, tabs, and informational dialogs.
  // Prevent commit/upload/send actions before any page handler can run.
  const actionWords = /\b(save|add|create|delete|remove|upload|import|send|text|dispatch|push|release|purge|back up now|backup now|generate email|enable|disable|reset password|change password|assign|tonu|cancellation|cancelled shift|shift complete|mark .*incomplete)\b/i;
  document.addEventListener('click', event => {
    if (role !== 'visitor') return;
    const target = event.target.closest('button,a,input[type=submit]');
    if (!target) return;
    const label = `${target.textContent || ''} ${target.title || ''} ${target.dataset.action || ''}`;
    if (/^(mailto:|sms:|tel:)/i.test(target.getAttribute('href') || '') || actionWords.test(label)) {
      event.preventDefault(); event.stopImmediatePropagation();
      const banner = document.getElementById('visitor-banner');
      if (banner) banner.textContent = 'Visitor access — this action is disabled. You can explore every page without accessing live data.';
    }
  }, true);
  document.addEventListener('submit', event => { if (role === 'visitor' && !/login|password/.test(location.pathname)) {event.preventDefault();event.stopImmediatePropagation();} }, true);
  document.addEventListener('drop', event => {if(role === 'visitor'){event.preventDefault();event.stopImmediatePropagation();}}, true);
})();
