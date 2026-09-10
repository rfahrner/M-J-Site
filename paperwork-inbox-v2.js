const PW_SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const PW_SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const pwClient = window.supabase.createClient(PW_SUPABASE_URL, PW_SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dl-dispatch-auth' },
});

const locationLabels = {
  kroger_atlanta: 'Kroger Atlanta',
  kroger_delaware: 'Kroger Delaware',
  unassigned: 'Unassigned',
};
let metadata = new Map();
let activeLocation = 'all';
let decorating = false;

function ensureUi() {
  if (!document.getElementById('pw-location-tabs')) {
    const tabs = document.createElement('div');
    tabs.id = 'pw-location-tabs';
    tabs.className = 'location-tabs pw-location-tabs';
    tabs.innerHTML = `
      <button class="location-tab is-active" data-pw-location="all" type="button">All</button>
      <button class="location-tab" data-pw-location="kroger_atlanta" type="button">Kroger Atlanta</button>
      <button class="location-tab" data-pw-location="kroger_delaware" type="button">Kroger Delaware</button>
      <button class="location-tab" data-pw-location="unassigned" type="button">Unassigned</button>`;
    document.getElementById('pw-summary')?.before(tabs);
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-pw-location]');
      if (!button) return;
      activeLocation = button.dataset.pwLocation;
      tabs.querySelectorAll('.location-tab').forEach((item) => item.classList.toggle('is-active', item === button));
      decorateRows();
    });
  }

  if (!document.getElementById('paperwork-v2-style')) {
    const style = document.createElement('style');
    style.id = 'paperwork-v2-style';
    style.textContent = `
      .pw-location-tabs { margin:0 0 14px; padding:0; }
      .paperwork-table tr.needs-review:not(.inbox-needs-review):not(.inbox-unread) { background:#fff; }
      .paperwork-table tr.inbox-unread { background:#eaf3ff !important; }
      .paperwork-table tr.inbox-needs-review { background:#fff6cf !important; }
      .paperwork-table tr.pw-location-hidden { display:none; }
      .pw-inbox-select { height:30px; border:1px solid var(--line,#dbe1eb); border-radius:6px; background:#fff; padding:0 7px; font-size:12px; font-weight:700; }
      .pw-sender-meta { font-size:11px; color:#64748b; margin-top:3px; }
    `;
    document.head.appendChild(style);
  }
}

async function refreshMetadata() {
  const { data, error } = await pwClient
    .from('paperwork_submissions')
    .select('id,driver_name,submitted_location,inbox_status,pro_number')
    .is('deleted_at', null)
    .order('submitted_at', { ascending: false })
    .limit(500);
  if (error) {
    console.error('Could not load paperwork inbox metadata', error);
    return;
  }
  metadata = new Map((data || []).map((row) => [row.id, row]));
  decorateRows();
}

function locationKey(row) { return row?.submitted_location || 'unassigned'; }

function ensureHeader() {
  const header = document.querySelector('.paperwork-table thead tr');
  if (!header || header.querySelector('[data-pw-v2-header]')) return;
  const cells = header.querySelectorAll('th');
  if (cells[3]) cells[3].textContent = 'Match';
  const sender = document.createElement('th'); sender.textContent = 'Driver / Location'; sender.dataset.pwV2Header = 'sender';
  const inbox = document.createElement('th'); inbox.textContent = 'Inbox Status'; inbox.dataset.pwV2Header = 'status';
  cells[1]?.after(sender);
  cells[3]?.before(inbox);
}

function decorateRows() {
  if (decorating) return;
  decorating = true;
  try {
    ensureHeader();
    document.querySelectorAll('#pw-body tr').forEach((tr) => {
      const view = tr.querySelector('[data-view]');
      const id = view?.dataset.view;
      if (!id) return;
      const row = metadata.get(id);
      if (!row) return;

      tr.classList.remove('inbox-unread', 'inbox-needs-review', 'pw-location-hidden');
      if (row.inbox_status === 'unread') tr.classList.add('inbox-unread');
      if (row.inbox_status === 'needs_review') tr.classList.add('inbox-needs-review');
      if (activeLocation !== 'all' && locationKey(row) !== activeLocation) tr.classList.add('pw-location-hidden');

      if (!tr.querySelector('[data-pw-sender-cell]')) {
        const cells = tr.querySelectorAll('td');
        const td = document.createElement('td');
        td.dataset.pwSenderCell = '1';
        cells[1]?.after(td);
      }
      const senderCell = tr.querySelector('[data-pw-sender-cell]');
      if (senderCell) senderCell.innerHTML = `<strong>${escapeHtml(row.driver_name || '—')}</strong><div class="pw-sender-meta">${escapeHtml(locationLabels[locationKey(row)] || 'Unassigned')}</div>`;

      if (!tr.querySelector('[data-pw-inbox-cell]')) {
        const cells = tr.querySelectorAll('td');
        const matchCell = [...cells].find((cell) => cell.querySelector('.status-badge'));
        const td = document.createElement('td');
        td.dataset.pwInboxCell = '1';
        matchCell?.before(td);
      }
      const inboxCell = tr.querySelector('[data-pw-inbox-cell]');
      if (inboxCell) {
        inboxCell.innerHTML = `<select class="pw-inbox-select" data-pw-inbox-status="${id}" aria-label="Inbox status">
          <option value="unread"${row.inbox_status === 'unread' ? ' selected' : ''}>Unread</option>
          <option value="read"${row.inbox_status === 'read' ? ' selected' : ''}>Read</option>
          <option value="needs_review"${row.inbox_status === 'needs_review' ? ' selected' : ''}>Needs Review</option>
        </select>`;
      }
    });
  } finally { decorating = false; }
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

async function setInboxStatus(id, status) {
  const previous = metadata.get(id);
  if (!previous) return;
  metadata.set(id, { ...previous, inbox_status: status });
  decorateRows();
  const { error } = await pwClient.rpc('paperwork_set_inbox_status', { p_submission_id: id, p_inbox_status: status });
  if (error) {
    metadata.set(id, previous);
    decorateRows();
    alert(`Couldn't update inbox status: ${error.message || error}`);
  }
}

function installEvents() {
  document.addEventListener('change', (event) => {
    const select = event.target.closest('[data-pw-inbox-status]');
    if (select) void setInboxStatus(select.dataset.pwInboxStatus, select.value);
  });
  document.addEventListener('click', (event) => {
    const view = event.target.closest('[data-view]');
    if (!view) return;
    const row = metadata.get(view.dataset.view);
    if (row?.inbox_status === 'unread') void setInboxStatus(row.id, 'read');
  }, true);
  document.getElementById('pw-refresh')?.addEventListener('click', () => setTimeout(refreshMetadata, 150));
  const body = document.getElementById('pw-body');
  if (body) new MutationObserver(() => decorateRows()).observe(body, { childList: true });
}

function init() {
  ensureUi();
  installEvents();
  void refreshMetadata();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
