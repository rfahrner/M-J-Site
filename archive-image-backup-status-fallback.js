const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const client = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dl-dispatch-auth' },
});

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  const digits = unit >= 3 ? 2 : unit === 2 ? 1 : 0;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function pct(value, max) {
  const a = Number(value || 0);
  const b = Number(max || 0);
  return b ? Math.max(0, Math.min(100, (a / b) * 100)) : 0;
}

function formatDate(value) {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleString('en-US', { month:'2-digit', day:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setMeter(id, value) {
  const meter = document.getElementById(id);
  const bar = meter?.querySelector('span');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function render(status) {
  if (!status) return;
  const storagePct = pct(status.storage_bytes, status.storage_quota_bytes);
  setText('image-backup-storage', `${formatBytes(status.storage_bytes)} / ${formatBytes(status.storage_quota_bytes)}`);
  setText('image-backup-storage-detail', `${storagePct.toFixed(1)}% used · ${Number(status.storage_objects || 0).toLocaleString()} images`);
  setMeter('image-backup-storage-meter', storagePct);

  const egressPct = pct(status.backup_egress_this_month_bytes, status.backup_egress_quota_bytes);
  setText('image-backup-egress', `${formatBytes(status.backup_egress_this_month_bytes)} / ${formatBytes(status.backup_egress_quota_bytes)}`);
  setText('image-backup-egress-detail', `${egressPct.toFixed(1)}% of monthly image-backup allowance used`);
  setMeter('image-backup-egress-meter', egressPct);

  setText('image-backup-ready', Number(status.eligible_objects || 0).toLocaleString());
  setText('image-backup-ready-detail', `${formatBytes(status.eligible_bytes)} older than ${Number(status.retention_days || 21)} days`);

  const run = status.last_run;
  setText('image-backup-last', run?.started_at ? formatDate(run.finished_at || run.started_at) : 'Never');
  setText('image-backup-last-detail', run?.started_at
    ? `${Number(run.files_archived || 0).toLocaleString()} files · ${formatBytes(run.bytes_archived)} sent · ${run.status || ''}`
    : 'No automatic image backup has run yet.');

  const destination = document.getElementById('image-backup-destination');
  if (destination) {
    destination.href = status.destination_share_url || '#';
    destination.textContent = `${status.destination_label || 'M-J Site Backups'} ↗`;
  }
  setText('image-backup-retention', `${Number(status.retention_days || 21)} days`);
  setText('image-backup-month', `${Number(status.archived_this_month_files || 0).toLocaleString()} files / ${formatBytes(status.archived_this_month_bytes)}`);

  const bucketWrap = document.getElementById('image-backup-buckets');
  if (bucketWrap) {
    bucketWrap.innerHTML = Object.entries(status.buckets || {}).map(([name, info]) => {
      const data = info || {};
      return `<span class="image-backup-bucket"><strong>${name}</strong> · ${Number(data.objects || 0).toLocaleString()} files · ${formatBytes(data.bytes)}</span>`;
    }).join('');
  }

  const state = document.getElementById('image-backup-state');
  if (state) {
    state.textContent = status.enabled ? 'Automatic backup active' : 'Tracking online · backup paused';
    state.className = `image-backup-state ${status.enabled ? 'ok' : 'wait'}`;
  }

  const error = document.getElementById('image-backup-error');
  if (error) {
    error.textContent = status.enabled
      ? ''
      : 'Storage tracking is working. Automatic transfer remains paused until the Microsoft service connection is configured and verified.';
    error.classList.toggle('hidden', !!status.enabled);
  }
}

async function refreshDirect() {
  if (!client || !document.getElementById('image-backup-panel')) return;
  const { data, error } = await client.rpc('archive_backup_status');
  if (error) throw error;
  render(data);
}

async function init() {
  // The main widget currently calls an Edge Function. Browsers preflight that
  // cross-origin request, so use the database RPC as a reliable status path as
  // well. This contains metrics only; the backup job itself still runs server-side.
  try {
    await refreshDirect();
  } catch (error) {
    console.error('Direct archive status fallback failed:', error);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 150), { once:true });
else setTimeout(init, 150);
