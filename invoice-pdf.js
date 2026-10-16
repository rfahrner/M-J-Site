/* ================================================================
   The Kroger/BGDC weekly invoice, written as real PDF bytes.

   WHY THIS IS NOT window.print()

   The requirement was "EXACTLY how this attached PDF is". A print
   dialog cannot promise that: Chrome adds its own header and footer
   (date, URL, page numbers) unless the operator unticks a box, the page
   breaks move with the print scale, and the saved file is named after the
   document title. The invoice goes to a customer, so the operator should
   not be able to produce a different-looking file by missing a checkbox.

   So this writes the PDF itself. The document only ever needs what the
   sample uses -- Letter pages, Helvetica and Helvetica-Bold, filled and
   stroked rectangles, hairlines, and one image -- which is a few hundred
   lines, no dependency, and nothing to fetch at run time. Every coordinate
   below was measured off the sample with pdfplumber rather than guessed,
   and scripts/invoice-pdf-matches-sample.test.mjs re-extracts the output
   and compares it against those measurements.

   WHY THE LOGO IS AN ASCII85 BLOB

   LOGO_A85 is the image stream lifted out of the sample PDF byte for byte
   (370x220 DeviceRGB, ASCII85 then Flate). Re-encoding images/logo-1@2x.png
   through a canvas at run time would mean a decode, a resample and a
   deflate in the browser, and a logo that drifts with the browser's
   resampling. Reusing the stream makes the mark identical to the sample and
   the whole document deterministic -- the same invoice generated twice is
   the same bytes.

   This module is a LEAF. It imports nothing, touches no DOM and reads no
   Supabase client, so it runs unchanged in Node for the tests.
   ================================================================ */

import { LOGO_A85, LOGO_WIDTH, LOGO_HEIGHT } from './invoice-logo.js';

/* ---------------- Helvetica metrics ----------------
   Widths per 1000 units for ASCII 32..126, from the Adobe AFMs. They are
   here because centring and right-aligning need to measure text, and a
   wrong width shows up as a column that looks almost right. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/*
 * The detail-page title uses an em dash, which is NOT ASCII. Under
 * WinAnsiEncoding it is byte 0x97, and it has to be written as an octal
 * escape and measured from its own width -- left to the ASCII path it would
 * be emitted as raw UTF-8 (two bytes, rendering as mojibake) and measured as
 * a space, which quietly mis-centres the whole heading.
 */
const WIN_ANSI = new Map([
  ['\u2014', { byte: 0o227, reg: 1000, bold: 1000 }],   // em dash
  ['\u2013', { byte: 0o226, reg: 556, bold: 556 }],     // en dash
  ['\u2019', { byte: 0o222, reg: 222, bold: 278 }],     // right single quote
]);

export function textWidth(text, bold, size) {
  const table = bold ? W_BOLD : W_REG;
  let units = 0;
  for (const ch of String(text ?? '')) {
    const special = WIN_ANSI.get(ch);
    if (special) { units += bold ? special.bold : special.reg; continue; }
    const code = ch.codePointAt(0);
    units += (code >= 32 && code <= 126) ? table[code - 32] : table[0];
  }
  return units * size / 1000;
}

/*
 * Helvetica's ascent as a fraction of the point size. Text is positioned in
 * this file by the TOP of its glyphs, because that is what the sample was
 * measured in; this converts to the baseline the PDF actually wants.
 *
 * The value is CALIBRATED against the sample, not taken from the AFM. The
 * obvious 0.718 (Helvetica's cap height) puts every line 0.075 * size too
 * high -- 1.5pt at the 20pt title -- because a PDF reader derives a glyph's
 * top from the font's bounding box, not its cap height. The test re-extracts
 * the output and compares tops against the sample, so a wrong value here
 * fails loudly instead of shifting the whole document by a point.
 */
const ASCENT = 0.793;

const PAGE_W = 612;
const PAGE_H = 792;

/* ---------------- PDF object plumbing ---------------- */

// Backslash and the two parens are escaped; anything outside ASCII is written
// as its WinAnsi octal escape, or dropped if we have no mapping for it rather
// than emitted as UTF-8 that would render as two wrong glyphs.
function pdfString(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (ch === '\\' || ch === '(' || ch === ')') { out += `\\${ch}`; continue; }
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) { out += ch; continue; }
    const special = WIN_ANSI.get(ch);
    if (special) out += `\\${special.byte.toString(8)}`;
  }
  return `(${out})`;
}
function num(value) {
  // Trailing zeros make the content stream noisy and the diffs unreadable.
  return (Math.round(value * 1000) / 1000).toString();
}

class Page {
  constructor() { this.ops = []; this.usesImage = false; }

  /*
   * A filled-and-stroked box is emitted as TWO paths -- fill, then stroke --
   * rather than one `B`. `B` is the same geometry and the same line width, but
   * the two disagree by a pixel along every edge once rasterised, which showed
   * up as a 0.5% pixel difference against the sample on the cover page. Two
   * paths is what the sample does, and it renders identically.
   */
  rect(x, top, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    const y = PAGE_H - top - h;
    const path = `${num(x)} ${num(y)} ${num(w)} ${num(h)} re`;
    if (fill) {
      this.ops.push(`${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg`);
      this.ops.push(path, 'f');
    }
    if (stroke) {
      this.ops.push(`${num(stroke[0])} ${num(stroke[1])} ${num(stroke[2])} RG ${num(lineWidth)} w`);
      this.ops.push(path, 'S');
    }
  }

  line(x0, top0, x1, top1, { width = 0.25, color = [0, 0, 0] } = {}) {
    this.ops.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} RG ${num(width)} w`);
    this.ops.push(`${num(x0)} ${num(PAGE_H - top0)} m ${num(x1)} ${num(PAGE_H - top1)} l S`);
  }

  /*
   * `top` is the top of the glyphs, matching how the sample was measured.
   * align 'left' | 'center' | 'right'; for center/right, x is the centre or
   * the right edge.
   */
  text(x, top, value, { bold = false, size = 9, color = [0, 0, 0], align = 'left' } = {}) {
    const str = String(value ?? '');
    if (!str) return;
    const w = textWidth(str, bold, size);
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const baseline = PAGE_H - top - size * ASCENT;
    this.ops.push('BT');
    this.ops.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} rg`);
    this.ops.push(`/${bold ? 'FB' : 'FR'} ${num(size)} Tf`);
    this.ops.push(`1 0 0 1 ${num(left)} ${num(baseline)} Tm`);
    this.ops.push(`${pdfString(str)} Tj`);
    this.ops.push('ET');
  }

  image(x, top, w, h) {
    this.usesImage = true;
    const y = PAGE_H - top - h;
    this.ops.push('q');
    this.ops.push(`${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm`);
    this.ops.push('/ImLogo Do');
    this.ops.push('Q');
  }

  content() { return this.ops.join('\n'); }
}

function serialize(pages) {
  const objects = [];             // 1-based; objects[i] is object i+1
  const push = (body) => { objects.push(body); return objects.length; };

  const fontReg = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const logo = push(
    `<< /Type /XObject /Subtype /Image /Width ${LOGO_WIDTH} /Height ${LOGO_HEIGHT} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [ /ASCII85Decode /FlateDecode ] `
    + `/Length ${LOGO_A85.length} >>\nstream\n${LOGO_A85}\nendstream`,
  );

  const pagesId = objects.length + 1 + pages.length * 2;   // reserved below
  const kids = [];
  for (const page of pages) {
    const content = page.content();
    const contentId = push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const resources = `<< /Font << /FR ${fontReg} 0 R /FB ${fontBold} 0 R >>`
      + (page.usesImage ? ` /XObject << /ImLogo ${logo} 0 R >>` : '')
      + ' >>';
    kids.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [ 0 0 ${PAGE_W} ${PAGE_H} ] `
      + `/Resources ${resources} /Contents ${contentId} 0 R >>`,
    ));
  }
  const pagesObj = push(`<< /Type /Pages /Count ${kids.length} /Kids [ ${kids.map((k) => `${k} 0 R`).join(' ')} ] >>`);
  if (pagesObj !== pagesId) throw new Error(`page tree id drifted: expected ${pagesId}, got ${pagesObj}`);
  const catalog = push(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  // Assemble, recording byte offsets for the xref table as we go.
  const parts = [];
  let length = 0;
  const write = (text) => {
    const bytes = new TextEncoder().encode(text);
    parts.push(bytes);
    length += bytes.length;
  };

  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    write(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefAt = length;
  write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) write(`${String(offset).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/* ---------------- formatting ---------------- */

const GRAY_HEAD = [0.85, 0.85, 0.85];
const BLACK = [0, 0, 0];
const WHITE = [1, 1, 1];

export function money(value) {
  const n = Number(value) || 0;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
// 2026-08-17 -> 8/17/26. Parsed by hand: new Date('2026-08-17') is UTC
// midnight, which is the previous day in New York and would date every
// invoice line one day early.
export function shortDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}
export function monthDay(iso) {
  const [, m, d] = String(iso).split('-').map(Number);
  return `${m}/${d}`;
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function weekdayName(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/* ---------------- the cover page ---------------- */

function coverPage(inv) {
  const p = new Page();
  p.image(28.8, 32.4, 115.2, 68.5);
  p.text(301.0, 23.7, 'Original Invoice', { bold: true, size: 20 });
  p.text(497.1, 27.9, `PRO # ${inv.proNumber}`, { bold: true, size: 12 });

  // Company block, left.
  const company = ['D & L TRANSPORT, LLC', 'PO BOX 778927', 'CHICAGO, IL 60677-8927'];
  company.forEach((line, i) => p.text(28.8, 100.9 + i * 12, line, { bold: true, size: 9 }));
  p.text(28.8, 144.9, '(866) 559-0203', { bold: true, size: 9 });
  p.text(28.8, 156.9, '(866) 559-9916 Fax', { bold: true, size: 9 });

  // Right-hand info grid. Header bands are filled AND stroked; value rows
  // are stroked only, which is what gives the sample its hairline grid.
  const band = (x, top, w, h, label, textTop, size = 6.5) => {
    p.rect(x, top, w, h, { fill: GRAY_HEAD, stroke: BLACK });
    p.text(x + w / 2, textTop, label, { bold: true, size, align: 'center' });
  };
  const valueCell = (x, top, w, h) => p.rect(x, top, w, h, { stroke: BLACK });

  band(301.0, 60.9, 141.1, 11.1, 'SHIP DATE', 63.6);
  band(442.1, 60.9, 141.1, 11.1, 'DELIVERY DATE', 63.6);
  valueCell(301.0, 72.0, 141.1, 12.1);
  valueCell(442.1, 72.0, 141.1, 12.1);
  p.text(301.0 + 141.1 / 2, 73.0, shortDate(inv.startDate), { bold: true, size: 9, align: 'center' });
  p.text(442.1 + 141.1 / 2, 73.0, shortDate(inv.endDate), { bold: true, size: 9, align: 'center' });

  band(301.0, 84.1, 141.1, 11.1, 'INVOICE DATE', 86.7);
  band(442.1, 84.1, 141.1, 11.1, 'DUE DATE', 86.7);
  valueCell(301.0, 95.2, 141.1, 12.1);
  valueCell(442.1, 95.2, 141.1, 12.1);
  p.text(301.0 + 141.1 / 2, 96.1, shortDate(inv.invoiceDate), { bold: true, size: 9, align: 'center' });
  p.text(442.1 + 141.1 / 2, 96.1, shortDate(inv.dueDate), { bold: true, size: 9, align: 'center' });

  // This band alone is set 6.0pt in the sample; every other grey header is 6.5.
  band(301.0, 107.3, 94.1, 11.1, 'SHIPMENT TYPE', 110.1, 6.0);
  band(395.1, 107.3, 94.1, 11.1, 'CONT / TRAILER #', 110.1, 6.0);
  band(489.1, 107.3, 94.1, 11.1, 'MILES / CLASS', 110.1, 6.0);
  valueCell(301.0, 118.4, 94.1, 12.1);
  valueCell(395.1, 118.4, 94.1, 12.1);
  valueCell(489.1, 118.4, 94.1, 12.1);
  p.text(304.0, 120.1, 'POWER ONLY', { bold: true, size: 8 });

  p.rect(301.0, 130.5, 282.2, 10.1, { fill: GRAY_HEAD, stroke: BLACK });
  p.text(301.0 + 282.2 / 2, 132.6, 'CUSTOMER', { bold: true, size: 6.5, align: 'center' });
  p.rect(301.0, 140.5, 282.2, 44.6, { stroke: BLACK });
  inv.customer.forEach((line, i) => p.text(305.0, 145.6 + i * 10, line, { size: 7.5 }));

  // Pick up / consignee.
  p.rect(28.8, 191.2, 277.2, 10.1, { fill: GRAY_HEAD, stroke: BLACK });
  p.text(28.8 + 277.2 / 2, 193.3, 'PICK UP', { bold: true, size: 6.5, align: 'center' });
  p.rect(306.0, 191.2, 277.2, 10.1, { fill: GRAY_HEAD, stroke: BLACK });
  p.text(306.0 + 277.2 / 2, 193.3, 'CONSIGNEE', { bold: true, size: 6.5, align: 'center' });
  p.rect(28.8, 201.3, 277.2, 39.6, { stroke: BLACK });
  p.rect(306.0, 201.3, 277.2, 39.6, { stroke: BLACK });
  inv.pickUp.forEach((line, i) => p.text(33.8, 206.5 + i * 11, line, { bold: true, size: 8.5 }));
  inv.consignee.forEach((line, i) => p.text(311.0, 206.5 + i * 11, line, { bold: true, size: 8.5 }));

  // References / extra picks.
  p.rect(28.8, 240.9, 277.2, 10.1, { fill: GRAY_HEAD, stroke: BLACK });
  p.text(28.8 + 277.2 / 2, 243.0, 'REFERENCES', { bold: true, size: 6.5, align: 'center' });
  p.rect(306.0, 240.9, 277.2, 10.1, { fill: GRAY_HEAD, stroke: BLACK });
  p.text(306.0 + 277.2 / 2, 243.0, 'EXTRA PICKS & STOPS', { bold: true, size: 6.5, align: 'center' });
  p.rect(28.8, 250.9, 277.2, 50.4, { stroke: BLACK });
  p.rect(306.0, 250.9, 277.2, 50.4, { stroke: BLACK });
  p.text(36.8, 258.2, `${shortDate(inv.startDate)} - ${shortDate(inv.endDate)}`, { size: 8.5 });

  /*
   * Description table.
   *
   * The sample bills a five-day week and its box is 126pt tall, which is
   * exactly five rows at the 23.05pt rhythm. Most weeks are not five days:
   * of 42 Atlanta weeks in 2026, 15 ran six days and 15 ran seven. So the
   * box GROWS by whole rows past five and the total bar and footer move down
   * with it -- a five-day week is laid out identically to the sample, and a
   * seven-day week is the same rhythm on a taller box rather than two lines
   * printed over the total.
   */
  const ROW_STEP = 23.05;
  const BASE_ROWS = 5;
  const extra = Math.max(0, inv.days.length - BASE_ROWS) * ROW_STEP;
  const cols = [
    { x: 28.8, w: 304.9, label: 'DESCRIPTION' },
    { x: 333.7, w: 77.6, label: 'UNITS' },
    { x: 411.3, w: 83.2, label: 'RATE' },
    { x: 494.5, w: 88.7, label: 'TOTAL' },
  ];
  for (const c of cols) {
    p.rect(c.x, 301.3, c.w, 10.1, { fill: GRAY_HEAD, stroke: BLACK });
    p.text(c.x + c.w / 2, 303.5, c.label, { bold: true, size: 6.5, align: 'center' });
    p.rect(c.x, 311.4, c.w, 126.0 + extra, { stroke: BLACK });
  }
  inv.days.forEach((day, i) => {
    const top = 324.4 + i * ROW_STEP;
    p.text(34.8, top, `${monthDay(day.date)}  DSD   Drivers  for  ${inv.locationCode}`, { size: 9 });
    p.text(cols[1].x + cols[1].w / 2, top, String(day.lines.length), { size: 9, align: 'center' });
    p.text(cols[3].x + cols[3].w - 6, top, money(day.subtotal), { bold: true, size: 9, align: 'right' });
  });

  const totalTop = 438.9 + extra;
  p.rect(28.8, totalTop, 465.7, 23.0, { fill: GRAY_HEAD, stroke: BLACK });
  p.rect(494.5, totalTop, 88.7, 23.0, { stroke: BLACK });
  p.text(202.7, totalTop + 3.7, 'TOTAL', { bold: true, size: 13 });
  p.text(507.1, totalTop + 4.5, '$', { bold: true, size: 12 });
  p.text(494.5 + 88.7 - 6, totalTop + 4.5, money(inv.total).slice(1), { bold: true, size: 12, align: 'right' });

  // Remittance footer.
  const footer = ['MAIL PAYMENTS TO:', 'D&L TRANSPORT, LLC', 'PO BOX 778927', 'CHICAGO, IL 60677-8927',
    '** AUDIT INVOICE FOR EMAIL CUSTOMER **  ** AUDIT INVOICE FOR EMAIL CUSTOMER **'];
  footer.forEach((line, i) => p.text(28.8, 491.6 + extra + i * 11, line, { bold: true, size: 8 }));
  inv.remitTo.forEach((line, i) => p.text(40.8, 547.0 + extra + i * 10, line, { size: 7.5 }));
  return p;
}

/* ---------------- a driver-detail page ---------------- */

const TABLE_X = 63.0;
const TABLE_RIGHT = 549.0;
const COL_TRIP = 343.8;       // name | trip id divider
const COL_CHARGE = 451.8;     // trip id | charges divider
const ROW_H = 14.0;
const HAIRLINE = [0.7, 0.7, 0.7];

function detailPage(inv, day) {
  const p = new Page();
  p.text(PAGE_W / 2, 44.5, 'D & L Transport, LLC  —  Kroger/BGDC Driver Detail', { bold: true, size: 12, align: 'center' });
  p.text(PAGE_W / 2, 59.8,
    `PRO # ${inv.proNumber}  |  Week ${shortDate(inv.startDate)} - ${shortDate(inv.endDate)}  |  ${inv.locationCode} (${inv.locationPlace})`,
    { size: 8.5, align: 'center' });

  const headTop = 74.0;
  p.rect(TABLE_X, headTop, TABLE_RIGHT - TABLE_X, ROW_H, { fill: [0.2, 0.2, 0.2] });
  p.text(68.0, 77.0, `${weekdayName(day.date)} ${shortDate(day.date)}`, { bold: true, size: 9.5, color: WHITE });
  p.text(COL_CHARGE - 6, 77.0, 'Trip ID', { bold: true, size: 9.5, color: WHITE, align: 'right' });
  p.text(TABLE_RIGHT - 6, 77.0, 'Total Charges', { bold: true, size: 9.5, color: WHITE, align: 'right' });

  day.lines.forEach((line, i) => {
    const top = headTop + ROW_H * (i + 1);
    // Zebra striping: the sample paints every row, white ones included, so
    // the band is opaque over the page rather than relying on the background.
    p.rect(TABLE_X, top, TABLE_RIGHT - TABLE_X, ROW_H, { fill: i % 2 === 0 ? WHITE : [0.96, 0.96, 0.96] });
    p.text(68.0, top + 2.8, line.driver, { size: 8.5 });
    p.text(COL_CHARGE - 6, top + 2.8, line.tripId, { size: 8.5, align: 'right' });
    p.text(TABLE_RIGHT - 6, top + 2.8, money(line.amount), { size: 8.5, align: 'right' });
  });

  const subTop = headTop + ROW_H * (day.lines.length + 1);
  p.rect(TABLE_X, subTop, TABLE_RIGHT - TABLE_X, ROW_H, { fill: [0.9, 0.9, 0.9] });
  p.text(COL_CHARGE - 6, subTop + 2.8, 'Subtotal', { bold: true, size: 8.5, align: 'right' });
  p.text(TABLE_RIGHT - 6, subTop + 2.8, money(day.subtotal), { bold: true, size: 8.5, align: 'right' });

  // Grid last, so the rules sit on top of the fills.
  const bottom = subTop + ROW_H;
  p.line(TABLE_X, subTop, TABLE_RIGHT, subTop, { width: 0.75, color: BLACK });
  for (let top = headTop; top <= bottom; top += ROW_H) {
    p.line(TABLE_X, top, TABLE_RIGHT, top, { width: 0.25, color: HAIRLINE });
  }
  for (const x of [TABLE_X, COL_TRIP, COL_CHARGE, TABLE_RIGHT]) {
    p.line(x, headTop, x, bottom, { width: 0.25, color: HAIRLINE });
  }
  return p;
}

/*
 * invoice = {
 *   proNumber, startDate, endDate, invoiceDate, dueDate,
 *   locationCode, locationPlace, customer[], pickUp[], consignee[], remitTo[],
 *   days: [{ date, subtotal, lines: [{ driver, tripId, amount }] }],
 *   total,
 * }
 */
export function buildInvoicePdf(invoice) {
  if (!invoice || !Array.isArray(invoice.days) || !invoice.days.length) {
    throw new Error('There are no invoiceable loads in that week.');
  }
  // A week is seven days. Past that the cover's table would run into the
  // remittance footer, so a wider range is refused rather than drawn wrong --
  // an invoice that looks fine and bills the wrong weeks is the worst
  // outcome available here.
  if (invoice.days.length > 7) {
    throw new Error(`An invoice covers one week; that range has ${invoice.days.length} operating days. Pick a single week.`);
  }
  return serialize([coverPage(invoice), ...invoice.days.map((day) => detailPage(invoice, day))]);
}
