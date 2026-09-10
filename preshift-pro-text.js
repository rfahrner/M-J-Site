import { supabaseClient, openSendTextModal } from './loadboard.js';

let expanding = false;
const expandedKeys = new Set();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function clockLabel(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '').trim() || 'scheduled time';
  const hour24 = Number(match[1]);
  const minute = match[2];
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour = hour24 % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}

async function driverPhones(rows) {
  const ids = [...new Set(rows.map((row) => row.driver_id).filter((id) => id != null))];
  const phones = new Map();
  if (!ids.length || !supabaseClient) return phones;
  const { data, error } = await supabaseClient
    .from('atlanta_drivers')
    .select('id,"Driver Name","Driver Cell"')
    .in('id', ids);
  if (!error) {
    for (const row of data || []) {
      phones.set(String(row.id), {
        name: String(row['Driver Name'] || '').trim(),
        phone: String(row['Driver Cell'] || '').trim(),
      });
    }
  }
  return phones;
}

async function expandGroup(button) {
  if (!supabaseClient) return;
  const key = button.dataset.alertActionKey;
  if (!/^preshift-\d+$/.test(key || '') || expandedKeys.has(key)) return;
  const item = button.closest('.alert-chat-item');
  if (!item) return;
  const ids = String(item.dataset.alertJumpIds || '')
    .split(',').map((value) => Number(value)).filter(Number.isFinite);
  if (!ids.length) return;

  expandedKeys.add(key);
  const { data: rows, error } = await supabaseClient
    .from('loads_shifts')
    .select('id,shift_start,pro_number,aljex_load_number,driver_id,driver_name_text,driver_cell_snapshot')
    .in('id', ids);
  if (error || !rows?.length || !item.isConnected) {
    expandedKeys.delete(key);
    return;
  }

  const phoneMap = await driverPhones(rows);
  if (!item.isConnected) return;
  const order = new Map(ids.map((id, index) => [Number(id), index]));
  rows.sort((a, b) => (order.get(Number(a.id)) ?? 999) - (order.get(Number(b.id)) ?? 999));

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const driver = phoneMap.get(String(row.driver_id)) || {};
    const name = String(driver.name || row.driver_name_text || 'Unnamed driver').trim();
    const phone = String(driver.phone || row.driver_cell_snapshot || '').trim();
    const pro = String(row.pro_number || row.aljex_load_number || '').trim();
    const shift = clockLabel(row.shift_start);
    const child = document.createElement('div');
    child.className = 'alert-chat-item';
    child.dataset.alertJumpIds = String(row.id);
    child.innerHTML = `
      <span class="alert-chat-icon">📋</span>
      <span class="alert-chat-text">${escapeHtml(name)} — ${escapeHtml(shift)} pre-shift text${pro ? ` · PRO#${escapeHtml(pro)}` : ' · PRO missing'}</span>
      ${phone && pro ? `<button type="button" class="alert-action-btn" data-pro-preshift-shift="${row.id}" data-pro-preshift-name="${escapeHtml(name)}" data-pro-preshift-phone="${escapeHtml(phone)}" data-pro-preshift-time="${escapeHtml(shift)}" data-pro-preshift-pro="${escapeHtml(pro)}" title="Text this driver">Text</button>` : ''}
    `;
    fragment.appendChild(child);
  }
  item.replaceWith(fragment);
}

async function expandVisibleGroups() {
  if (expanding) return;
  expanding = true;
  try {
    const buttons = [...document.querySelectorAll('[data-alert-action-key]')]
      .filter((button) => /^preshift-\d+$/.test(button.dataset.alertActionKey || ''));
    for (const button of buttons) await expandGroup(button);
  } finally {
    expanding = false;
  }
}

function personalizedMessage(button) {
  return `This is D&L, we have you scheduled for ${button.dataset.proPreshiftTime}. Please reply with your ETA. Please use PRO#${button.dataset.proPreshiftPro} as a reference for today's load.`;
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pro-preshift-shift]');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openSendTextModal(
    [{ name: button.dataset.proPreshiftName, phone: button.dataset.proPreshiftPhone }],
    personalizedMessage(button),
    [Number(button.dataset.proPreshiftShift)],
  );
}, true);

function init() {
  void expandVisibleGroups();
  const target = document.getElementById('alert-widget-body') || document.body;
  new MutationObserver(() => {
    expandedKeys.clear();
    queueMicrotask(() => void expandVisibleGroups());
  }).observe(target, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
