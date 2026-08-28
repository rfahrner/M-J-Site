/* Volume -> Week picker enhancement.
   analytics-volume.js already supports applying multiple week-start date keys;
   this keeps that calculation path intact and only upgrades the Week modal's
   single-year radio UI to a multi-year checkbox UI. */

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, days) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function startOfWeek(d) {
  const out = new Date(d);
  out.setDate(out.getDate() - out.getDay()); // Sunday
  return out;
}

function weeksInYear(year) {
  const weeks = [];
  let cursor = startOfWeek(new Date(year, 0, 1));
  if (cursor.getFullYear() < year) cursor = addDays(cursor, 7);
  while (cursor.getFullYear() === year) {
    weeks.push(new Date(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function upgradeWeekPicker() {
  const body = document.getElementById('vrp-body');
  const title = document.getElementById('vrp-title');
  if (!body || !title || title.textContent.trim() !== 'Select Week(s)') return;

  const originalRadios = Array.from(body.querySelectorAll('input[name="vrp-week-year"]'));
  if (!originalRadios.length) return; // already upgraded, or a different picker is open

  const yearField = originalRadios[0].closest('.field');
  const weekList = document.getElementById('vrp-week-list');
  if (!yearField || !weekList) return;

  const years = originalRadios.map((radio) => Number(radio.value));
  const initiallyChecked = Number((originalRadios.find((radio) => radio.checked) || originalRadios[0]).value);

  yearField.innerHTML = `
    <label>Year(s)</label>
    <div class="checkbox-row" style="flex-wrap:wrap;">
      ${years.map((year) => `<label><input type="checkbox" class="vrp-week-year-cb" value="${year}" ${year === initiallyChecked ? 'checked' : ''}> ${year}</label>`).join('')}
    </div>
  `;

  function renderSelectedYears() {
    // Preserve week choices from years that remain selected while the year
    // checkbox set changes.
    const selectedWeeks = new Set(
      Array.from(weekList.querySelectorAll('.vrp-week-cb:checked')).map((el) => el.value)
    );
    const selectedYears = Array.from(body.querySelectorAll('.vrp-week-year-cb:checked'))
      .map((el) => Number(el.value))
      .sort((a, b) => b - a);

    if (!selectedYears.length) {
      weekList.innerHTML = '<div class="subtext" style="padding:4px;">Select one or more years to choose weeks.</div>';
      return;
    }

    weekList.innerHTML = selectedYears.map((year) => {
      const weekRows = weeksInYear(year).map((start) => {
        const key = localDateKey(start);
        const checked = selectedWeeks.has(key) ? ' checked' : '';
        return `<label style="display:block; padding:2px 0;"><input type="checkbox" class="vrp-week-cb" value="${key}"${checked}> Week of ${key}</label>`;
      }).join('');
      return `
        <div class="vrp-week-year-group" data-year="${year}" style="margin-bottom:10px;">
          <div style="font-weight:700; margin:4px 0;">${year}</div>
          ${weekRows}
        </div>
      `;
    }).join('');
  }

  body.querySelectorAll('.vrp-week-year-cb').forEach((checkbox) => {
    checkbox.addEventListener('change', renderSelectedYears);
  });

  renderSelectedYears();
}

function installWeekPickerUpgrade() {
  const body = document.getElementById('vrp-body');
  if (!body) return;
  const observer = new MutationObserver(() => upgradeWeekPicker());
  observer.observe(body, { childList: true, subtree: true });
  upgradeWeekPicker();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installWeekPickerUpgrade, { once: true });
} else {
  installWeekPickerUpgrade();
}
