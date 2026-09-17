const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const ARCHIVE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/image-archive-onedrive`;

const client = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
});

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit >= 3 ? 2 : unit === 2 ? 1 : 0;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function percent(value, max) {
  const n = Number(value || 0);
  const d = Number(max || 0);
  if (!d) return 0;
  return Math.max(0, Math.min(100, (n / d) * 100));
}

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function injectStyles() {
  if (document.getElementById('archive-image-backup-styles')) return;
  const style = document.createElement('style');
  style.id = 'archive-image-backup-styles';
  style.textContent = `
    .image-backup-panel { border:1px solid var(--line); border-radius:10px; background:#fff; padding:18px; margin:8px 0 18px; }
    .image-backup-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
    .image-backup-head h2 { margin:0 0 4px; font-size:19px; }
    .image-backup-state { display:inline-flex; align-items:center; gap:7px; border-radius:999px; padding:5px 9px; font-size:11px; font-weight:800; white-space:nowrap; }
    .image-backup-state.ok { background:#dcfce7; color:#166534; }
    .image-backup-state.wait { background:#fff7ed; color:#9a3412; }
    .image-backup-state.bad { background:#fee2e2; color:#b91c1c; }
    .image-backup-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:14px; }
    .image-backup-card { border:1px solid #d8dee8; border-radius:8px; padding:12px; min-width:0; }
    .image-backup-card .label { color:#64748b; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; }
    .image-backup-card .value { margin-top:5px; font-size:20px; font-weight:850; color:#172542; }
    .image-backup-card .detail { margin-top:4px; color:#64748b; font-size:11px; line-height:1.35; }
    .image-backup-meter { height:8px; border-radius:999px; background:#e7ebf0; overflow:hidden; margin-top:8px; }
    .image-backup-meter > span { display:block; height:100%; border-radius:inherit; background:#24527a; min-width:0; }
    .image-backup-meter.warn > span { background:#d97706; }
    .image-backup-meter.danger > span { background:#b91c1c; }
    .image-backup-meta { display:flex; align-items:center; gap:10px 18px; flex-wrap:wrap; margin-top:14px; padding-top:12px; border-top:1px solid #e2e8f0; font-size:12px; color:#475569; }
    .image-backup-meta strong { color:#172542; }
    .image-backup-buckets { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .image-backup-bucket { background:#f8fafc; border:1px solid #e2e8f0; border-radius:7px; padding:7px 9px; font-size:11px; color:#475569; }
    .image-backup-note { margin-top:10px; font-size:11px; color:#64748b; line-height:1.45; }
    .image-backup-error { margin-top:10px; padding:9px 10px; border-radius:7px; background:#fff1f2; color:#9f1239; font-size:12px; }
    @media (max-width:900px) { .image-backup-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:560px) { .image-backup-grid { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

function panelShell() {
  const panel = document.createElement('section');
  panel.className = 'image-backup-panel';
  panel.id = 'image-backup-panel';
  panel.innerHTML = `
    <div class="image-backup-head">
      <div>
        <h2>Automatic Image Backup</h2>
        <div class="subtext">Images stay in Supabase for 21 days, then move automatically to OneDrive / SharePoint in the background.</div>
      </div>
      <span class="image-backup-state wait" id="image-backup-state">Checking…</span>
    </div>
    <div class="image-backup-grid">
      <div class="image-backup-card">
        <div class="label">Supabase Image Storage</div>
        <div class="value" id="image-backup-storage">—</div>
        <div class="detail" id="image-backup-storage-detail">—</div>
        <div class="image-backup-meter" id="image-backup-storage-meter"><span></span></div>
      </div>
      <div class="image-backup-card">
        <div class="label">Image Backup Egress</div>
        <div class="value" id="image-backup-egress">—</div>
        <div class="detail" id="image-backup-egress-detail">—</div>
        <div class="image-backup-meter" id="image-backup-egress-meter"><span></span></div>
      </div>
      <div class="image-backup-card">
        <div class="label">Ready To Move</div>
        <div class="value" id="image-backup-ready">—</div>
        <div class="detail" id="image-backup-ready-detail">Older than 21 days</div>
      </div>
      <div class="image-backup-card">
        <div class="label">Last Backup</div>
        <div class="value" id="image-backup-last">—</div>
        <div class="detail" id="image-backup-last-detail">—</div>
      </div>
    </div>
    <div class="image-backup-meta">
      <span><strong>Destination:</strong> <a id="image-backup-destination" target="_blank" rel="noopener">M-J Site Backups ↗</a></span>
      <span><strong>Retention:</strong> <span id="image-backup-retention">21 days</span></span>
      <span><strong>Schedule:</strong> Daily background sweep</span>
      <span><strong>This month:</strong> <span id="image-backup-month">—</span></span>
    </div>
    <div class="image-backup-buckets" id="image-backup-buckets"></div>
    <div class="image-backup-note">“Image Backup Egress” is the traffic used by this automatic image archive, not all Supabase project traffic. The free-plan uncached egress allowance is shown as the comparison limit.</div>
    <div class="image-backup-error hidden" id="image-backup-error"></div>
  `;
  return panel;
}

function mountPanel() {
  if (document.getElementById('image-backup-panel')) return;
  const main = document.querySelector('.archive-wrap');
  if (!main) return;
  const toolbar = main.querySelector('.toolbar');
  const panel = panelShell();
  if (toolbar?.nextSibling) main.insertBefore(panel, toolbar.nextSibling);
  else main.prepend(panel);
}

function setMeter(id, pct) {
  const meter = document.getElementById(id);
  if (!meter) return;
  const value = Math.max(0, Math.min(100, pct));
  const bar = meter.querySelector('span');
  if (bar) bar.style.width = `${value}%`;
  meter.classList.toggle('warn', value >= 70 && value < 90);
  meter.classList.toggle('danger', value >= 90);
}

function setState(label, kind) {
  const el = document.getElementById('image-backup-state');
  if (!el) return;
  el.textContent = label;
  el.className = `image-backup-state ${kind}`;
}

function setError(message) {
  const el = document.getElementById('image-backup-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function renderStatus(status) {
  const storageBytes = Number(status.storage_bytes || 0);
  const storageQuota = Number(status.storage_quota_bytes || 0);
  const storagePct = percent(storageBytes, storageQuota);
  document.getElementById('image-backup-storage').textContent = `${formatBytes(storageBytes)} / ${formatBytes(storageQuota)}`;
  document.getElementById('image-backup-storage-detail').textContent = `${storagePct.toFixed(1)}% used · ${Number(status.storage_objects || 0).toLocaleString()} images`;
  setMeter('image-backup-storage-meter', storagePct);

  const egressBytes = Number(status.backup_egress_this_month_bytes || 0);
  const egressQuota = Number(status.backup_egress_quota_bytes || 0);
  const egressPct = percent(egressBytes, egressQuota);
  document.getElementById('image-backup-egress').textContent = `${formatBytes(egressBytes)} / ${formatBytes(egressQuota)}`;
  document.getElementById('image-backup-egress-detail').textContent = `${egressPct.toFixed(1)}% of free uncached allowance used by image backups`;
  setMeter('image-backup-egress-meter', egressPct);

  document.getElementById('image-backup-ready').textContent = Number(status.eligible_objects || 0).toLocaleString();
  document.getElementById('image-backup-ready-detail').textContent = `${formatBytes(status.eligible_bytes)} older than ${Number(status.retention_days || 21)} days`;

  const run = status.last_run;
  if (run?.started_at) {
    document.getElementById('image-backup-last').textContent = formatDate(run.finished_at || run.started_at);
    document.getElementById('image-backup-last-detail').textContent = `${Number(run.files_archived || 0).toLocaleString()} files · ${formatBytes(run.bytes_archived)} sent · ${esc(run.status || '')}`;
  } else {
    document.getElementById('image-backup-last').textContent = 'Never';
    document.getElementById('image-backup-last-detail').textContent = 'No automatic image backup has run yet.';
  }

  const destination = document.getElementById('image-backup-destination');
  destination.href = status.destination_share_url || '#';
  destination.textContent = `${status.destination_label || 'M-J Site Backups'} ↗`;
  document.getElementById('image-backup-retention').textContent = `${Number(status.retention_days || 21)} days`;
  document.getElementById('image-backup-month').textContent = `${Number(status.archived_this_month_files || 0).toLocaleString()} files / ${formatBytes(status.archived_this_month_bytes)}`;

  const buckets = status.buckets || {};
  const bucketWrap = document.getElementById('image-backup-buckets');
  bucketWrap.innerHTML = Object.entries(buckets).map(([name, info]) => {
    const data = info || {};
    return `<span class="image-backup-bucket"><strong>${esc(name)}</strong> · ${Number(data.objects || 0).toLocaleString()} files · ${formatBytes(data.bytes)}</span>`;
  }).join('') || '<span class="image-backup-bucket">No image objects currently stored.</span>';

  if (!status.microsoft_configured) {
    setState('Microsoft connection required', 'wait');
    setError('Automatic deletion is safely paused until the one-time Microsoft service connection is configured. Nothing will be removed from Supabase before that connection is verified.');
  } else if (!status.enabled) {
    setState('Ready, not enabled', 'wait');
    setError('Microsoft is connected, but the automatic archive is still paused. It must be enabled only after archived-image viewing has been verified.');
  } else if (run?.status === 'failed' || run?.status === 'partial' || run?.status === 'configuration_required') {
    setState(run.status === 'partial' ? 'Backup needs attention' : 'Backup error', 'bad');
    setError(run.error_message || 'The last image backup did not finish cleanly. Supabase originals are retained unless each individual Microsoft upload was verified first.');
  } else {
    setState('Automatic backup active', 'ok');
    setError('');
  }
}

async function loadStatus() {
  if (!client) throw new Error('Supabase client is unavailable.');
  const { data } = await client.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Sign in to view backup status.');

  const response = await fetch(ARCHIVE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'status' }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Backup status failed (${response.status}).`);
  renderStatus(payload);
}

async function init() {
  injectStyles();
  mountPanel();
  try {
    await loadStatus();
  } catch (error) {
    console.error('Automatic image backup status failed:', error);
    setState('Status unavailable', 'bad');
    setError(error instanceof Error ? error.message : String(error));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
