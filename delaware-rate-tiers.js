/* Delaware mileage-tier rate UI.
   Delaware now follows the same rate-card shape as Atlanta: editable mileage
   bands, date-specific overrides, and an over-tier per-mile value. */

const IS_DELAWARE = (location.pathname.split('/').pop() || '') === 'dalaware.html';
let lb = null;
let rates = null;
let initialized = false;
let decorateTimer = null;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function currentDate() {
  return document.getElementById('date-input')?.value || lb?.state?.activeDate || '';
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—';
}

function tiers() {
  return rates?.getBoardRateTiers()?.delaware || [];
}

function fieldBox(label, inputHtml, note = '', overridden = false) {
  return `<fieldset class="rate-tier-box${overridden ? ' is-overridden' : ''}">
    <legend>${esc(label)}${overridden ? ' <span class="rate-override-dot" title="Different from the permanent Delaware rate">●</span>' : ''}</legend>
    ${inputHtml}
    ${note ? `<div class="subtext" style="margin-top:4px;font-size:10px;">${esc(note)}</div>` : ''}
  </fieldset>`;
}

function activeRows() {
  if (!lb?.state?.sheets) return [];
  const date = currentDate();
  const out = [];
  for (const rows of Object.values(lb.state.sheets)) {
    for (const row of rows || []) {
      if ((row.location || lb.state.activeLocation) === 'delaware' && (row.shiftDate || date) === date) out.push(row);
    }
  }
  return out;
}

async function recalcAll() {
  if (!lb || !rates) return;
  for (const row of activeRows()) {
    if (row.rateManual) continue;
    const breakdown = rates.calcLoadRateBreakdown('delaware', row);
    const numericRate = Number(breakdown.total) || 0;
    const next = numericRate ? String(Math.round(numericRate * 100) / 100) : '';
    row.rate = next;
    document.querySelectorAll(`input[data-row="${CSS.escape(String(row.id))}"][data-field="rate"]`).forEach((input) => {
      if (document.activeElement !== input) input.value = next;
    });
    if (row.dbId && lb.supabaseClient) {
      const { error } = await lb.supabaseClient.from('loads_shifts')
        .update({ rate: numericRate > 0 ? numericRate : null, rate_manual: false })
        .eq('id', row.dbId);
      if (error) console.error('Could not persist recalculated Delaware rate', error);
    }
  }
  touchLoadDetails();
}

function touchLoadDetails() {
  const body = document.getElementById('ld-tab-content');
  if (!body) return;
  const marker = document.createElement('span');
  marker.hidden = true;
  body.appendChild(marker);
  marker.remove();
}

function todayTierMarkup(date) {
  const card = rates.getDailyRateCard('delaware', date);
  return tiers().map((tier) => {
    const override = card.tiers[String(tier.id)];
    return fieldBox(
      `${tier.min}-${tier.max}MI`,
      `<input type="number" step="0.01" data-de-daily-tier="${tier.id}" value="${override != null ? esc(override) : ''}" placeholder="Base ${esc(tier.rate)}">`,
      `Permanent base: ${tier.rate}`,
      override != null
    );
  }).join('');
}

function baseTierMarkup() {
  return tiers().map((tier) => fieldBox(
    `${tier.min}-${tier.max}MI`,
    `<input type="number" step="0.01" data-de-base-tier="${tier.id}" value="${esc(tier.rate)}">`
  )).join('');
}

function overTierTodayMarkup(date) {
  const card = rates.getDailyRateCard('delaware', date);
  const base = rates.getBaseSetting('delaware', 'over_tier_per_mile', 4);
  const override = card.settings.over_tier_per_mile;
  return fieldBox(
    'Over 250MI ($/mi)',
    `<input type="number" step="0.01" data-de-daily-over value="${override != null ? esc(override) : ''}" placeholder="Base ${esc(base)}">`,
    `Permanent base: ${base}`,
    override != null
  );
}

function overTierBaseMarkup() {
  const base = rates.getBaseSetting('delaware', 'over_tier_per_mile', 4);
  return fieldBox('Over 250MI ($/mi)', `<input type="number" step="0.01" data-de-base-over value="${esc(base)}">`);
}

function openDelawareRateSettings() {
  if (!rates) return;
  document.getElementById('modal-delaware-tier-rates')?.remove();
  const date = currentDate();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'modal-delaware-tier-rates';
  overlay.innerHTML = `
    <div class="modal modal-large" style="max-width:760px;">
      <div class="modal-header">
        <h3>Delaware Rate Settings — ${esc(date)}</h3>
        <button class="modal-close" data-de-rate-close>&times;</button>
      </div>
      <div class="modal-body">
        <div class="calc-note" style="margin-bottom:14px;">
          Delaware pays by mileage tier: 0–25, 26–75, 76–150, 151–200, and 201–250 miles. Anything over 250 miles is paid per mile.
          A manual Rate-cell entry still overrides the automatic calculation.
        </div>
        <h4 style="margin:0 0 8px;">Today's Delaware rate</h4>
        <div class="subtext" style="margin-bottom:8px;">Only enter a value here when today's rate differs from the permanent Delaware rate. Blank fields use the permanent base.</div>
        <div class="rate-tier-grid">${todayTierMarkup(date)}${overTierTodayMarkup(date)}</div>
        <h4 style="margin:20px 0 8px;">Permanent Delaware rate</h4>
        <div class="subtext" style="margin-bottom:8px;">These are the normal Delaware rates used on dates with no daily override.</div>
        <div class="rate-tier-grid">${baseTierMarkup()}${overTierBaseMarkup()}</div>
        <div id="delaware-rate-status" class="subtext" style="min-height:18px;margin-top:12px;"></div>
      </div>
      <div class="modal-footer"><button class="btn" data-de-rate-close>Done</button></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-de-rate-close]')) overlay.remove();
  });

  overlay.addEventListener('change', async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const status = document.getElementById('delaware-rate-status');
    if (status) status.textContent = 'Saving…';
    let ok = false;
    if (input.dataset.deDailyTier) {
      ok = await rates.saveDailyTierRate('delaware', date, input.dataset.deDailyTier, input.value);
    } else if (input.hasAttribute('data-de-daily-over')) {
      ok = await rates.saveDailySetting('delaware', date, 'over_tier_per_mile', input.value);
    } else if (input.dataset.deBaseTier) {
      ok = input.value.trim() !== '' && await rates.saveTierRate(Number(input.dataset.deBaseTier), Number(input.value));
    } else if (input.hasAttribute('data-de-base-over')) {
      ok = input.value.trim() !== '' && await rates.saveSetting('delaware', 'over_tier_per_mile', Number(input.value));
    } else {
      return;
    }
    if (status) status.textContent = ok ? 'Rate saved.' : "Couldn't save that rate.";
    if (!ok) return;
    await recalcAll();
    if (input.dataset.deBaseTier || input.hasAttribute('data-de-base-over')) openDelawareRateSettings();
  });
}

function findLoadDetailsRow() {
  const rowId = lb?.loadDetailsState?.rowId;
  if (!rowId || !lb?.state?.sheets) return null;
  for (const rows of Object.values(lb.state.sheets)) {
    const row = rows?.find((item) => String(item.id) === String(rowId));
    if (row) return row;
  }
  return null;
}

function decorateLoadDetails() {
  if (!IS_DELAWARE || !rates || !lb?.loadDetailsState) return;
  const row = findLoadDetailsRow();
  if (!row || (row.location || 'delaware') !== 'delaware') return;
  const section = document.querySelector('#ld-tab-content .rate-section');
  const grid = section?.querySelector('.rate-tier-grid');
  if (!section || !grid) return;

  const date = row.shiftDate || currentDate();
  const card = rates.getDailyRateCard('delaware', date);
  const signature = JSON.stringify({
    date,
    tiers: tiers().map((tier) => [tier.id, tier.min, tier.max, tier.rate, card.tiers[String(tier.id)]]),
    over: [rates.getBaseSetting('delaware', 'over_tier_per_mile', 4), card.settings.over_tier_per_mile],
  });
  if (grid.dataset.delawareTierSignature === signature) return;

  grid.innerHTML = tiers().map((tier) => {
    const overridden = card.tiers[String(tier.id)] != null;
    const value = rates.getDailyTierValue('delaware', date, tier);
    return fieldBox(
      `${tier.min}-${tier.max}MI`,
      `<input type="number" step="0.01" data-rate-tier-id="${tier.id}" value="${esc(value)}">`,
      '',
      overridden
    );
  }).join('') + fieldBox(
    'Over 250MI ($/mi)',
    `<input type="number" step="0.01" data-rate-setting-key="over_tier_per_mile" value="${esc(rates.getDailySettingValue('delaware', date, 'over_tier_per_mile', 4))}">`,
    '',
    card.settings.over_tier_per_mile != null
  );
  grid.dataset.delawareTierSignature = signature;

  const explanation = section.querySelector(':scope > .subtext');
  if (explanation) explanation.textContent = `Delaware rate card for ${date}. Mileage selects the tier; over 250 miles pays the configured per-mile rate. A manual total overrides the calculation.`;
}

function installStyles() {
  if (document.getElementById('delaware-tier-rate-style')) return;
  const style = document.createElement('style');
  style.id = 'delaware-tier-rate-style';
  style.textContent = `
    #modal-delaware-tier-rates .rate-tier-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
    #modal-delaware-tier-rates .rate-tier-box input { width:100%; min-width:0; }
    @media (max-width:620px) { #modal-delaware-tier-rates .rate-tier-grid { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

// Register before daily-rate-hierarchy.js so Delaware gets its tier modal
// instead of the old flat-minimum / per-mile settings window.
if (IS_DELAWARE) {
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('#btn-atlanta-rate-settings');
    if (!button || !rates) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openDelawareRateSettings();
  }, true);
}

async function init() {
  if (!IS_DELAWARE || initialized) return;
  initialized = true;
  lb = await import('./loadboard.js');
  rates = await import('./boardrates.js');
  for (let i = 0; i < 120 && !lb.supabaseClient; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  await rates.loadBoardRateData();
  installStyles();

  const modalBody = document.getElementById('ld-tab-content');
  if (modalBody) {
    new MutationObserver(() => {
      clearTimeout(decorateTimer);
      decorateTimer = setTimeout(decorateLoadDetails, 40);
    }).observe(modalBody, { childList: true, subtree: true });
  }
  setTimeout(decorateLoadDetails, 200);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
else setTimeout(() => void init(), 0);
