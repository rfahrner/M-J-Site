/*
 * The generated invoice has to be the approved invoice.
 *
 * "it needs to be EXACTLY how this attached PDF is."
 *
 * scripts/fixtures/kroger-invoice-sample.json is that PDF, extracted word by
 * word with pdfplumber: for all 535 words, the text, the face, the point size,
 * the left edge and the top. This test rebuilds the same week from the same
 * figures and checks every one of them against it.
 *
 * WHY THE GOLDEN IS WORD POSITIONS AND NOT A FILE HASH
 *
 * A byte comparison would fail on things nobody can see -- object order,
 * whitespace in the content stream -- and pass on nothing extra. What has to
 * hold is that each word lands in the same place on the same page in the same
 * face, which is what a customer looking at the two documents would compare.
 *
 * ASCENT IS DUPLICATED HERE ON PURPOSE
 *
 * Tops are computed from the content stream's baselines, which needs the same
 * ascent fraction the writer used. Reading that constant OUT of
 * invoice-pdf.js makes the check circular: both sides move together, and
 * putting the value back to 0.718 -- the mistake that first shifted every
 * line 0.075 * size too high -- leaves the test green. It was green, when
 * that mutation was tried. So the calibrated value is written out again
 * below, as a fact measured from the owner's file rather than a reference to
 * the code under test.
 *
 * Run: node scripts/invoice-matches-approved-sample.test.mjs
 */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// The repo is "type": "commonjs", so these .js modules cannot be imported.
// Same approach every other test here uses: read the source, drop the module
// keywords, run it. The code under test is the shipped text, not a copy.
const strip = (f) => read(f).replace(/^import[^;]*;\s*$/gm, '').replace(/^export /gm, '');
const api = new Function(
  strip('invoice-logo.js') + '\n' + strip('invoice-pdf.js') + '\n' + strip('invoice-data.js')
  + '\nreturn { buildInvoicePdf, textWidth, money, shortDate, weekdayName, buildInvoiceData,'
  + ' addDays, weekStart, lastCompletedWeek, invoiceFileName, INVOICE_LOCATIONS, LOGO_A85, LOGO_WIDTH, LOGO_HEIGHT };',
)();

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

/* ---------------------------------------------------------------- *
 * The week the approved sample bills, as the database holds it.     *
 * ---------------------------------------------------------------- */
const WEEK = {
  '2026-08-17': [['Atiba Ward', '1274441', 582.27], ['James Terrell', '1274895', 2296.24], ['Jontavious Caslin', '1274442', 1908.52], ['Justin Freeman', '1274436', 594.43], ['Rodney Reid- Reids Trans - c', '1274440', 1819.77]],
  '2026-08-18': [['Abdinasir- A trucking', '1274984', 926.26], ['Abdinur - A Taylor', '1274985', 708.64], ['Atiba Ward', '1274983', 1733.55], ['Charles Osborne', '1275075', 1297.69], ['Henry Coleman', '1275560', 1773.67], ['James Terrell', '1275078', 1449.94], ['Jason Converson(Coverson)-GA ONLY', '1275086', 1039.62], ['Jontavious Caslin', '1275082', 1031.06], ['Justin Freeman', '1275080', 1125.03], ['Leteisha Jacobs', '1275090', 1020.77], ['Marcus Smith-Mag', '1274982', 1305.71], ['Michael Allen', '1275076', 1097.12], ['Mike Worrell', '1275180', 1361.39], ['Rodney Louissaint', '1275077', 1075.17], ['Rodney Reid- Reids Trans - c', '1275088', 1966.07]],
  '2026-08-20': [['Atiba Ward', 'TONU', 250], ['Charles Osborne', '1276138', 1105.85], ['James Terrell', '1276677', 1446.46], ['Jason Converson(Coverson)-GA ONLY', 'TONU', 250], ['Jontavious Caslin', '1276676', 1025.88], ['Justin Freeman', 'TONU', 250], ['Marcus Smith-Mag', 'TONU', 250], ['Michael Allen', '1276173', 1260.04], ['Tabiyon Marshall', '1276209', 1055.14], ['William Austin-c (GA Only)', 'TONU', 250]],
  '2026-08-22': [['David Williams', '1277540', 906.03], ['Franco Garrison- B&L', '1277476', 998.15], ['Jontavious Caslin', '1277462', 1112.03], ['Justin Freeman', '1277480', 543.76], ['Leteisha Jacobs', '1277482', 1166.08], ['Rodney Reid- Reids Trans - c', '1277483', 1462.72], ['Ronald Grey-C', '1277485', 872.19], ['Tabiyon Marshall', '1277459', 442.38]],
  '2026-08-23': [['Franco Garrison- B&L', '1277982', 550.28], ['Jason Converson(Coverson)-GA ONLY', '1278002', 666.46], ['Jontavious Caslin', '1277988', 1186.06], ['Justin Freeman', '1278004', 708.71], ['Leteisha Jacobs', '1277932', 1805.71], ['Marcus Smith-Mag', '1277926', 1225.76], ['Michael Collins-c', '1278061', 2275.44], ['Q Barber- Bowles Jr', '1278037', 2242.99], ['Renardo Harmon-Ready Frgt', '1277993', 1183.13], ['Rodney Reid- Reids Trans - c', '1278052', 1744.13]],
};
const place = api.INVOICE_LOCATIONS.atlanta;
const days = Object.keys(WEEK).sort().map((date) => {
  const lines = WEEK[date].map(([driver, tripId, amount]) => ({ driver, tripId, amount }));
  return { date, lines, subtotal: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 };
});
const invoice = {
  proNumber: '1958081', startDate: '2026-08-17', endDate: '2026-08-23',
  invoiceDate: '2026-10-16', dueDate: '2026-11-15',
  locationCode: place.code, locationPlace: place.place,
  customer: place.customer, pickUp: place.pickUp, consignee: place.consignee, remitTo: place.remitTo,
  days, total: Math.round(days.reduce((s, d) => s + d.subtotal, 0) * 100) / 100,
};

/* ---------------------------------------------------------------- *
 * Read the words back out of the PDF this code just wrote.          *
 * ---------------------------------------------------------------- */
const PAGE_H = 792;
// Measured against the approved sample, NOT read from invoice-pdf.js -- see
// the header. A change to the writer's constant has to fail this file.
const ASCENT = 0.793;

function wordsFromPdf(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const pages = [];
  // Content streams in page order; the page tree is written after them.
  for (const m of text.matchAll(/\n(\d+) 0 obj\n<< \/Length \d+ >>\nstream\n([^]*?)\nendstream/g)) {
    pages.push(m[2]);
  }
  return pages.map((stream) => {
    const out = [];
    const re = /BT\n[\d.]+ [\d.]+ [\d.]+ rg\n\/(FR|FB) ([\d.]+) Tf\n1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\n\((.*)\) Tj\nET/g;
    for (const m of stream.matchAll(re)) {
      const size = Number(m[2]);
      const left = Number(m[3]);
      const top = PAGE_H - Number(m[4]) - size * ASCENT;
      /*
       * A PDF string is one run; pdfplumber splits runs on spaces, so this
       * does too. An octal escape is ONE character, and it is a WinAnsi byte
       * rather than a code point -- \227 is the em dash, not U+0097. Decoding
       * it as a raw char code silently produces a control character that
       * measures as a space, which drifts every word after it on that line.
       */
      const WIN_ANSI_BACK = { 0x97: '\u2014', 0x96: '\u2013', 0x92: '\u2019' };
      const raw = m[5]
        .replace(/\\(\d{3})/g, (_, o) => WIN_ANSI_BACK[parseInt(o, 8)] ?? String.fromCharCode(parseInt(o, 8)))
        .replace(/\\([\\()])/g, '$1');
      const face = m[1] === 'FB' ? 'B' : 'R';
      let x = left;
      for (const piece of raw.split(' ')) {
        if (piece) out.push({ t: Math.round(top * 10) / 10, x: Math.round(x * 10) / 10, f: face, s: size, w: piece });
        x += api.textWidth(`${piece} `, face === 'B', size);
      }
    }
    out.sort((a, b) => (a.t - b.t) || (a.x - b.x));
    return out;
  });
}

const golden = JSON.parse(read('scripts/fixtures/kroger-invoice-sample.json'));
const mine = wordsFromPdf(api.buildInvoicePdf(invoice));

console.log('\n1. the same pages, with the same words on them');
check('page count', mine.length, golden.pages.length);
for (let i = 0; i < Math.min(mine.length, golden.pages.length); i += 1) {
  check(`page ${i + 1} word count`, mine[i].length, golden.pages[i].length);
}

console.log('\n2. every word, in the same face, size and position');
// Half a point. The sample's own numbers are rounded to 0.1 and the extractor
// measures a glyph box rather than the text origin, so demanding exactness
// would fail on rounding; half a point is a fifth of a millimetre.
const TOLERANCE = 0.5;
let worstDy = 0, worstDx = 0, mismatches = 0, firstBad = null;
for (let i = 0; i < Math.min(mine.length, golden.pages.length); i += 1) {
  for (let j = 0; j < Math.min(mine[i].length, golden.pages[i].length); j += 1) {
    const a = golden.pages[i][j];
    const b = mine[i][j];
    const dy = Math.abs(a.t - b.t);
    const dx = Math.abs(a.x - b.x);
    worstDy = Math.max(worstDy, dy);
    worstDx = Math.max(worstDx, dx);
    if (a.w !== b.w || a.f !== b.f || a.s !== b.s || dy > TOLERANCE || dx > TOLERANCE) {
      mismatches += 1;
      if (!firstBad) firstBad = `page ${i + 1} word ${j}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    }
  }
}
check('words that do not match the approved sample', mismatches, 0);
if (firstBad) console.log(`       first: ${firstBad}`);
console.log(`       worst drift: ${worstDy.toFixed(2)}pt vertical, ${worstDx.toFixed(2)}pt horizontal`);

console.log('\n3. the document itself');
const bytes = api.buildInvoicePdf(invoice);
const asText = Buffer.from(bytes).toString('latin1');
check('it is a PDF', asText.slice(0, 8), '%PDF-1.4');
check('it ends properly', asText.trimEnd().endsWith('%%EOF'), true);
check('Letter, portrait', /\/MediaBox \[ 0 0 612 792 \]/.test(asText), true);
check('only the two Helvetica faces are used',
  [...new Set([...asText.matchAll(/\/BaseFont \/([\w-]+)/g)].map((m) => m[1]))].sort().join(','),
  'Helvetica,Helvetica-Bold');
check('the logo is embedded once', (asText.match(/\/Subtype \/Image/g) || []).length, 1);
check('generating twice gives identical bytes',
  Buffer.from(api.buildInvoicePdf(invoice)).equals(Buffer.from(bytes)), true);

console.log('\n4. the logo is the approved mark');
check('370x220', `${api.LOGO_WIDTH}x${api.LOGO_HEIGHT}`, '370x220');
check('the stream is intact ASCII85', api.LOGO_A85.endsWith('~>'), true);
check('and is the expected length', api.LOGO_A85.length, 10077);

console.log('\n5. the file is named the way the approved one is');
check('file name', api.invoiceFileName('2026-08-17', '2026-08-23'), '8-17-26_to_8-23-26_Kroger_Invoice.pdf');

console.log('\n6. a range that is not one week is refused, not drawn wrong');
// Eight operating days would run the cover's table into the remittance block.
const tooMany = { ...invoice, days: [...days, ...days.slice(0, 3)].map((d, i) => ({ ...d, date: `2026-08-${10 + i}` })) };
let refused = '';
try { api.buildInvoicePdf(tooMany); } catch (e) { refused = e.message; }
check('eight days is refused', /one week/.test(refused), true);
let empty = '';
try { api.buildInvoicePdf({ ...invoice, days: [] }); } catch (e) { empty = e.message; }
check('an empty week is refused', /no invoiceable loads/i.test(empty), true);

console.log('\n7. a seven-day week still fits');
/*
 * The sample bills five days and its table is exactly five rows tall, but 30
 * of 42 Atlanta weeks in 2026 ran six or seven days. A cap at five would have
 * refused most real weeks, so the table grows and the total bar moves with it.
 */
const sevenDays = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-09-${14 + i}`,
  lines: [{ driver: 'A Driver', tripId: '1234567', amount: 100 }],
  subtotal: 100,
}));
const seven = wordsFromPdf(api.buildInvoicePdf({ ...invoice, days: sevenDays, total: 700 }));
check('one cover plus seven detail pages', seven.length, 8);
const coverWords = seven[0];
const totalWord = coverWords.find((w) => w.w === 'TOTAL' && w.s === 13);
const mailWord = coverWords.find((w) => w.w === 'MAIL');
check('the TOTAL bar cleared the seventh line', totalWord.t > coverWords.filter((w) => w.w === 'DSD').pop().t, true);
check('and the remittance block cleared the TOTAL bar', mailWord.t > totalWord.t, true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
