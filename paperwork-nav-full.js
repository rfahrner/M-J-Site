const PW_NAV_SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const PW_NAV_SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const pwNavClient = window.supabase.createClient(PW_NAV_SUPABASE_URL, PW_NAV_SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dl-dispatch-auth' },
});

const escNav = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

let navRole = null;
let navHideTimer = null;

function installNavStyles() {
  if (document.getElementById('paperwork-full-nav-styles')) return;
  const style = document.createElement('style');
  style.id = 'paperwork-full-nav-styles';
  style.textContent = `
    #paperwork-nav-portal{display:none;position:fixed;background:#fff;border:1px solid #d1d9e0;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:180px;z-index:1200;padding:4px 0}
    #paperwork-nav-portal a{display:block;padding:8px 14px;color:#172542;text-decoration:none;font-size:13px;white-space:nowrap}
    #paperwork-nav-portal a:hover{background:#eef1f6}
    .pw-nav-disabled{border:0;background:transparent;color:#000;opacity:.45;padding:0 16px;height:100%;display:inline-flex;align-items:center;font-size:13px;font-weight:600;white-space:nowrap;cursor:default}
  `;
  document.head.appendChild(style);
}

function portal() {
  let el = document.getElementById('paperwork-nav-portal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'paperwork-nav-portal';
    document.body.appendChild(el);
    el.addEventListener('mouseenter', () => clearTimeout(navHideTimer));
    el.addEventListener('mouseleave', hidePortalSoon);
  }
  return el;
}

function hidePortalSoon() {
  clearTimeout(navHideTimer);
  navHideTimer = setTimeout(() => { const el = portal(); el.style.display = 'none'; }, 140);
}

function showPortal(trigger, children) {
  clearTimeout(navHideTimer);
  const el = portal();
  el.innerHTML = children.map((item) => `<a href="${escNav(item.href)}">${escNav(item.label)}</a>`).join('');
  const rect = trigger.getBoundingClientRect();
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.bottom}px`;
  el.style.display = 'block';
}

async function resolveRole() {
  const { data } = await pwNavClient.auth.getSession();
  const userId = data?.session?.user?.id;
  if (!userId) return null;
  const { data: row } = await pwNavClient.from('user_roles').select('role').eq('user_id', userId).maybeSingle();
  return row?.role || null;
}

function renderFullNav() {
  const tabs = document.getElementById('tabs');
  if (!tabs) return;
  const kroger = [
    { label: 'Atlanta', href: 'index.html' },
    { label: 'Delaware', href: 'dalaware.html' },
    { label: 'Building C', href: 'buildingc.html' },
    { label: 'Houston', href: 'houston.html' },
  ];
  const mondelez = [
    { label: 'West Chester', href: 'mondelez.html?loc=westchester' },
    { label: 'Morris', href: 'mondelez.html?loc=morris' },
    { label: 'Addison', href: 'mondelez.html?loc=addison' },
    { label: 'Indianapolis', href: 'mondelez.html?loc=indianapolis' },
    { label: 'Louisville', href: 'mondelez.html?loc=louisville' },
    { label: 'Spokane', href: 'mondelez.html?loc=spokane' },
    { label: 'Las Vegas', href: 'mondelez.html?loc=lasvegas' },
    { label: 'Boise', href: 'mondelez.html?loc=boise' },
    { label: 'Kent', href: 'mondelez.html?loc=kent' },
    { label: 'Salt Lake City', href: 'mondelez.html?loc=saltlakecity' },
    { label: 'New Berlin', href: 'mondelez.html?loc=newberlin' },
    { label: 'All Locations', href: 'mondelez.html?loc=combined' },
  ];
  const analytics = [
    { label: 'Driver Analytics', href: 'analytics-drivers.html' },
    { label: 'Volume', href: 'analytics-volume.html' },
  ];
  if (navRole === 'admin') analytics.push({ label: 'Location Analytics', href: 'location-analytics.html' });

  tabs.innerHTML = `
    <a class="tab-btn" href="index.html" data-pw-nav-menu="kroger">Kroger</a>
    <a class="tab-btn" href="mondelez.html?loc=westchester" data-pw-nav-menu="mondelez">Mondelez</a>
    <span class="pw-nav-disabled" title="Coming soon">Racetrac</span>
    <span class="pw-nav-disabled" title="Coming soon">Carlstar</span>
    <span class="pw-nav-disabled" title="Coming soon">Global Pallets</span>
    <span class="pw-nav-disabled" title="Coming soon">LTL</span>
    <a class="tab-btn active" href="paperwork.html">Paperwork</a>
    <a class="tab-btn" href="driverlist.html">Driver List</a>
    ${['accounting','admin','it'].includes(navRole) ? '<a class="tab-btn" href="accounting.html">Accounting</a>' : ''}
    <a class="tab-btn" href="analytics-drivers.html" data-pw-nav-menu="analytics">Analytics</a>
    <a class="tab-btn" href="archive.html">Archive</a>
    <button type="button" class="tab-btn" id="paperwork-nav-logout" style="margin-left:auto;">Log Out</button>`;

  const menus = { kroger, mondelez, analytics };
  tabs.querySelectorAll('[data-pw-nav-menu]').forEach((trigger) => {
    trigger.addEventListener('mouseenter', () => showPortal(trigger, menus[trigger.dataset.pwNavMenu] || []));
    trigger.addEventListener('mouseleave', hidePortalSoon);
  });
  document.getElementById('paperwork-nav-logout')?.addEventListener('click', async () => {
    await pwNavClient.auth.signOut();
    window.location.replace('login.html');
  });
}

async function initPaperworkFullNav() {
  installNavStyles();
  navRole = await resolveRole();
  renderFullNav();
  const tabs = document.getElementById('tabs');
  if (tabs) {
    new MutationObserver(() => {
      if (!document.getElementById('paperwork-nav-logout')) renderFullNav();
    }).observe(tabs, { childList: true });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void initPaperworkFullNav());
else void initPaperworkFullNav();
