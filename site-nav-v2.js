const OTR_LABELS = new Set(['Racetrac', 'Carlstar', 'Global Pallets']);
const MEGABOARD_HREF = 'megaboard.html';

let patchObserver = null;
let hideTimer = null;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function installStyles() {
  if (document.getElementById('site-nav-v2-styles')) return;
  const style = document.createElement('style');
  style.id = 'site-nav-v2-styles';
  style.textContent = `
    .site-nav-dropdown-trigger {
      border: 0 !important;
      background: transparent !important;
      font-family: inherit !important;
      cursor: pointer !important;
    }
    #site-nav-v2-portal {
      display:none;
      position:fixed;
      z-index:2100;
      min-width:180px;
      padding:4px 0;
      background:#fff;
      border:1px solid #d1d9e0;
      border-radius:6px;
      box-shadow:0 4px 12px rgba(0,0,0,.15);
    }
    #site-nav-v2-portal .nav-dropdown-item {
      display:block;
      padding:8px 14px;
      color:#172542;
      text-decoration:none;
      font-size:13px;
      white-space:nowrap;
    }
    #site-nav-v2-portal a.nav-dropdown-item:hover { background:#eef1f6; }
    #site-nav-v2-portal .nav-dropdown-item.active { font-weight:700; color:#006495; }
    #site-nav-v2-portal .nav-dropdown-item.site-nav-disabled {
      opacity:.45;
      cursor:default;
      color:#000;
    }
  `;
  document.head.appendChild(style);
}

function portal() {
  let el = document.getElementById('site-nav-v2-portal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'site-nav-v2-portal';
  document.body.appendChild(el);
  el.addEventListener('mouseenter', () => {
    if (hideTimer) clearTimeout(hideTimer);
  });
  el.addEventListener('mouseleave', hidePortalSoon);
  return el;
}

function hidePortalSoon() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    const el = document.getElementById('site-nav-v2-portal');
    if (el) el.style.display = 'none';
  }, 150);
}

function childActive(child) {
  if (!child.href) return false;
  const currentFile = location.pathname.split('/').pop() || 'index.html';
  const [file, query] = child.href.split('?');
  if (file !== currentFile) return false;
  if (!query) return true;
  const wanted = new URLSearchParams(query);
  const current = new URLSearchParams(location.search);
  return wanted.get('loc') === current.get('loc');
}

function showDropdown(trigger, children) {
  if (hideTimer) clearTimeout(hideTimer);
  const el = portal();
  el.innerHTML = children.map((child) => {
    if (child.disabled) {
      return `<span class="nav-dropdown-item site-nav-disabled" title="Coming soon">${esc(child.label)}</span>`;
    }
    return `<a class="nav-dropdown-item${childActive(child) ? ' active' : ''}" href="${esc(child.href)}">${esc(child.label)}</a>`;
  }).join('');
  const rect = trigger.getBoundingClientRect();
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.bottom}px`;
  el.style.display = 'block';
}

function wireDropdown(trigger, children) {
  if (!trigger || trigger.dataset.siteNavDropdownWired === 'true') return;
  trigger.dataset.siteNavDropdownWired = 'true';
  trigger.addEventListener('mouseenter', () => showDropdown(trigger, children));
  trigger.addEventListener('mouseleave', hidePortalSoon);
  trigger.addEventListener('click', (event) => {
    if (trigger.tagName === 'BUTTON' || trigger.getAttribute('href') === '#') event.preventDefault();
  });
}

function exactChildByText(tabs, label) {
  return [...tabs.children].find((el) => (el.textContent || '').trim() === label) || null;
}

function patchExistingNav() {
  const tabs = document.getElementById('tabs');
  if (!tabs || !tabs.children.length || tabs.dataset.siteNavStandalone === 'true') return;
  installStyles();

  [...tabs.children].forEach((el) => {
    const text = (el.textContent || '').trim();
    if (OTR_LABELS.has(text)) el.remove();
  });

  const mondelez = exactChildByText(tabs, 'Mondelez');
  if (!mondelez) return;

  let otr = document.getElementById('nav-otr-v2');
  if (!otr) {
    otr = document.createElement('button');
    otr.type = 'button';
    otr.id = 'nav-otr-v2';
    otr.className = 'tab-btn site-nav-dropdown-trigger';
    otr.textContent = 'OTR';
  }

  let mega = [...tabs.children].find((el) => (el.getAttribute?.('href') || '').endsWith(MEGABOARD_HREF));
  if (!mega) {
    mega = document.createElement('a');
    mega.className = 'tab-btn';
    mega.href = MEGABOARD_HREF;
    mega.textContent = 'Megaboard';
  }

  const afterMondelez = mondelez.nextSibling;
  if (otr.parentElement !== tabs || mondelez.nextElementSibling !== otr) {
    tabs.insertBefore(otr, afterMondelez);
  }
  if (otr.nextElementSibling !== mega) {
    tabs.insertBefore(mega, otr.nextSibling);
  }

  wireDropdown(otr, [
    { label: 'Racetrac', disabled: true },
    { label: 'Carlstar', disabled: true },
    { label: 'Global Pallets', disabled: true },
  ]);
}

const STANDALONE_NAV = [
  {
    label: 'Kroger',
    children: [
      { label: 'Atlanta', href: 'index.html' },
      { label: 'Delaware', href: 'dalaware.html' },
      { label: 'Building C', href: 'buildingc.html' },
      { label: 'Houston', href: 'houston.html' },
    ],
  },
  {
    label: 'Mondelez',
    children: [
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
    ],
  },
  {
    label: 'OTR',
    children: [
      { label: 'Racetrac', disabled: true },
      { label: 'Carlstar', disabled: true },
      { label: 'Global Pallets', disabled: true },
    ],
  },
  { label: 'Megaboard', href: MEGABOARD_HREF },
  { label: 'LTL', disabled: true },
  { label: 'Paperwork', href: 'paperwork.html' },
  { label: 'Driver List', href: 'driverlist.html' },
  { label: 'Accounting', href: 'accounting.html', accountingOnly: true },
  {
    label: 'Analytics',
    children: [
      { label: 'Driver Analytics', href: 'analytics-drivers.html' },
      { label: 'Volume', href: 'analytics-volume.html' },
      { label: 'Location Analytics', href: 'location-analytics.html', adminOnly: true },
    ],
  },
];

export function renderStandaloneSiteNav(role, onLogout) {
  const tabs = document.getElementById('tabs');
  if (!tabs) return;
  installStyles();
  tabs.dataset.siteNavStandalone = 'true';
  const currentFile = location.pathname.split('/').pop() || 'index.html';

  const visible = (item) => {
    if (item.accountingOnly && !['accounting', 'admin'].includes(role)) return false;
    if (item.adminOnly && role !== 'admin') return false;
    return true;
  };

  const entries = STANDALONE_NAV.map((item, index) => {
    if (!visible(item)) return '';
    if (item.disabled) return `<span class="tab-btn-disabled" title="Coming soon">${esc(item.label)}</span>`;
    if (item.children) {
      const children = item.children.filter(visible);
      const active = children.some(childActive);
      const firstHref = children.find((child) => !child.disabled && child.href)?.href || '#';
      return `<a class="tab-btn${active ? ' active' : ''}" href="${esc(firstHref)}" data-site-nav-index="${index}">${esc(item.label)}</a>`;
    }
    return `<a class="tab-btn${item.href === currentFile ? ' active' : ''}" href="${esc(item.href)}">${esc(item.label)}</a>`;
  }).join('');

  tabs.innerHTML = entries + '<button type="button" class="tab-btn" id="nav-logout" style="margin-left:auto;">Log Out</button>';
  tabs.querySelectorAll('[data-site-nav-index]').forEach((trigger) => {
    const item = STANDALONE_NAV[Number(trigger.dataset.siteNavIndex)];
    wireDropdown(trigger, (item.children || []).filter(visible));
  });
  const logout = document.getElementById('nav-logout');
  if (logout && onLogout) logout.addEventListener('click', onLogout);
}

function installPatchObserver() {
  if (patchObserver) return;
  patchObserver = new MutationObserver(() => patchExistingNav());
  patchObserver.observe(document.documentElement, { childList: true, subtree: true });
  patchExistingNav();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPatchObserver);
else installPatchObserver();
