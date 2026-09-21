/*
 * Layout regression test for the Available list on the four board pages.
 *
 * Two things this pins, both of which were wrong at some point:
 *
 *  1. The five-row cap. The box is sized in CSS from two hand-measured
 *     constants (--avail-row-h, --avail-head-h) plus its own borders. Get any
 *     of them wrong and the list shows four rows, or shows five but is
 *     scrollable by two pixels so it drifts under the cursor. Five drivers
 *     must fit exactly and not scroll; six must scroll.
 *  2. One line per driver. The phone, dispatcher phone, email, MC and rating
 *     cells must each render on a single line -- when the table was too narrow
 *     they wrapped and every row doubled in height, which is what made the
 *     list unreadable in the first place.
 *
 * It also checks the description line under the heading stays gone (it was
 * removed for vertical space) and that the columns do not shift sideways when
 * the scrollbar appears.
 *
 * Because the CSS does all of this, the test renders the real stylesheet and
 * the real markup lifted out of index.html in a real browser -- estimating the
 * numbers instead of measuring them is exactly the mistake that shipped a
 * four-row box.
 *
 * Run: npm i --no-save playwright && node scripts/available-list-layout.test.mjs
 *
 * Not wired into ci.yml: it needs playwright, which is deliberately not a
 * dependency of the site.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BOARD_PAGES = ['index.html', 'buildingc.html', 'dalaware.html', 'houston.html'];
const read = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : ` -- expected ${expected}, got ${actual}`));
}

// The <div id="available-section"> block, balanced by counting divs.
function extractSection(html) {
  const start = html.indexOf('<div id="available-section">');
  if (start < 0) throw new Error('no #available-section');
  let depth = 0;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = start;
  for (let m; (m = re.exec(html)); ) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error('#available-section is not balanced');
}

// ---- 1. the description line is gone from every board page ----
console.log('1. the heading is not followed by a description line');
for (const page of BOARD_PAGES) {
  const section = extractSection(read(page));
  check(`${page} has no subtext div`, /class="subtext"/.test(section), false);
  check(`${page} still wraps the table in .available-scroll`, section.includes('available-scroll'), true);
}

// ---- rows, mirroring availableRowHtml() and sizeAvailableNotes() ----
const DRIVERS = [
  ['Marcus Whitfield',  '$1,250.00', '(313) 555-0142', '(313) 555-0199', 'marcus.whitfield@midwestcarrier.com', 'MC-884512', '4.8', 'Prefers overnight runs out of Detroit'],
  ['Tanisha Rodriguez', '$980.00',   '(216) 555-0177', '(216) 555-0103', 't.rodriguez@clevelandfreight.net',    'MC-771209', '4.6', 'Reefer only'],
  ['Dmitri Kovalenko',  '$1,410.00', '(773) 555-0188', '(773) 555-0121', 'dkovalenko@northlinetrucking.com',    'MC-660341', '5.0', 'Hazmat endorsed, TWIC current'],
  ['Priya Raghunathan', '$1,075.00', '(614) 555-0155', '(614) 555-0166', 'praghunathan@buckeyelogistics.com',   'MC-903874', '4.9', 'No NYC boroughs'],
  ['Jamal Okonkwo',     '$1,320.00', '(317) 555-0134', '(317) 555-0187', 'jokonkwo@crossroadshaul.com',         'MC-512088', '4.7', 'Available after 14:00'],
  ['Sofia Castellanos', '$890.00',   '(502) 555-0193', '(502) 555-0110', 'scastellanos@bluegrassexpress.org',   'MC-448921', '4.4', 'Dry van, 53ft'],
  ['Henrik Vandenberg', '$1,505.00', '(414) 555-0128', '(414) 555-0174', 'hvandenberg@lakeshorecarriers.com',   'MC-317654', '4.9', 'Team driver'],
];

function rowHtml([name, rate, cell, dispatcher, email, mc, rating, notes], i) {
  const id = `av${i}`;
  return `<tr id="${id}">
    <td class="col-availDriver"><input class="cell-input" data-driver-ac="true" data-avail-field="driverName" data-avail-row="${id}" value="${name}"></td>
    <td class="col-availCarrierRate"><span class="static-text">${rate}</span></td>
    <td class="col-cell"><span class="static-text">${cell}</span></td>
    <td class="col-dispatcherPhone"><span class="static-text">${dispatcher}</span></td>
    <td class="col-email"><span class="static-text">${email}</span></td>
    <td class="col-mc"><span class="static-text">${mc}</span></td>
    <td class="col-rating"><span class="static-text">${rating}</span></td>
    <td class="col-availNotes"><textarea class="cell-input" data-avail-row="${id}" data-avail-field="notes" rows="1">${notes}</textarea></td>
    <td class="col-availRemove"><button type="button" class="available-remove-btn" data-avail-remove="${id}">&times;</button></td>
  </tr>`;
}

const CSS = read('loadboard.css');
const SECTION = extractSection(read('index.html'));

function pageWith(rowCount) {
  const body = DRIVERS.slice(0, rowCount).map(rowHtml).join('');
  const section = SECTION.replace('<tbody id="available-table-body"></tbody>',
    `<tbody id="available-table-body">${body}</tbody>`);
  if (rowCount && !section.includes('col-availDriver"><input')) throw new Error('rows were not injected');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style>
<style>body{margin:0;padding:0}#available-section{margin-top:0 !important}</style></head><body>
${section}
<script>
/* mirrors sizeAvailableNotes() in loadboard.js */
document.querySelectorAll('[data-avail-field="notes"]').forEach(function (el) {
  el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px';
});
<\/script></body></html>`;
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });

async function measure(rowCount, width = 1600) {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  await page.setContent(pageWith(rowCount));
  await page.waitForTimeout(80);
  const out = await page.evaluate(() => {
    const box = document.querySelector('.available-scroll');
    const head = document.querySelector('.available-table thead');
    const rows = [...document.querySelectorAll('.available-table tbody tr')];
    const rect = (el) => el.getBoundingClientRect();
    // getClientRects() returns one rect per line box, so >1 means it wrapped.
    const wrapped = [...document.querySelectorAll('.available-table tbody .static-text, .available-table tbody input')]
      .filter((el) => el.getClientRects().length !== 1)
      .map((el) => (el.value || el.textContent).trim().slice(0, 30));
    const lastCell = rows.length
      ? rect(rows[rows.length - 1].querySelector('td:last-child')) : null;
    return {
      boxHeight: Math.round(rect(box).height),
      scrolls: box.scrollHeight > box.clientHeight + 1,
      scrollsSideways: box.scrollWidth > box.clientWidth + 1,
      rowHeight: rows.length ? Math.round(rect(rows[1] || rows[0]).height) : null,
      headHeight: Math.round(rect(head).height),
      firstCellLeft: rows.length ? Math.round(rect(rows[0].querySelector('td')).left) : null,
      lastColumnInView: lastCell ? lastCell.right <= rect(box).right + 0.5 : null,
      wrapped,
    };
  });
  await page.close();
  return out;
}

// ---- 2. five rows fit exactly, six scroll ----
console.log('\n2. the box holds five drivers and then scrolls');
const five = await measure(5);
const six = await measure(6);
const four = await measure(4);
check('a row is 37px, as the CSS constant claims', five.rowHeight, 37);
check('the header is 29px, as the CSS constant claims', five.headHeight, 29);
check('five drivers do not scroll', five.scrolls, false);
check('six drivers scroll', six.scrolls, true);
check('four drivers shrink the box', four.boxHeight < five.boxHeight, true);
check('six drivers do not grow it past five', six.boxHeight, five.boxHeight);

// ---- 3. nothing wraps onto a second line ----
console.log('\n3. one line per driver');
const seven = await measure(7);
check('no wrapped cells at five drivers', five.wrapped.join(' | '), '');
check('no wrapped cells at seven drivers', seven.wrapped.join(' | '), '');
check('every column is in view on a 1366px screen', (await measure(5, 1366)).lastColumnInView, true);

// ---- 4. the scrollbar does not shove the columns sideways ----
console.log('\n4. columns hold still when the scrollbar appears');
check('first column at the same offset either side of the threshold',
  four.firstCellLeft, six.firstCellLeft);

// ---- 5. the header survives scrolling ----
console.log('\n5. the header stays put while scrolling');
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
await page.setContent(pageWith(7));
await page.waitForTimeout(80);
const sticky = await page.evaluate(() => {
  const box = document.querySelector('.available-scroll');
  const th = document.querySelector('.available-table thead th');
  const offset = () => Math.round(th.getBoundingClientRect().top - box.getBoundingClientRect().top);
  const before = offset();
  box.scrollTop = 90;
  return { before, after: offset(), scrolled: box.scrollTop > 0 };
});
check('the list actually scrolled', sticky.scrolled, true);
check('the header did not move with it', sticky.after, sticky.before);
await page.close();

await browser.close();
console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
