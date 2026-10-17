/* global console, __dirname, Buffer */
/* ── Lab PDF fixture generator (dev-only) ─────────────────────────────── */
/* Run via: node scripts/make-lab-pdf.cjs                                  */
/* Writes: src/pages/design-lab-pdf.ts  (the `?lab=pdf` design lab fixture) */
/*
 * Why a GENERATED fixture instead of a checked-in .pdf next to it:
 *
 *  - The document viewer's behaviour (lazy rasterization, the reading-line
 *    chip, zoom re-rendering at a new width) only exists for a real PDF, so the
 *    lab needs real bytes — a canvas or a data: image would verify nothing.
 *  - A binary in the repo is unreviewable, and a PDF whose xref offsets are
 *    slightly wrong opens in some viewers and renders blank in pdf.js. Here the
 *    bytes are a function of readable page content, and the offsets are
 *    computed, so "regenerate it" is a one-line answer when the fixture is
 *    suspected.
 *  - It is a dev fixture: nothing in the shipped app imports this file except
 *    the design lab, which is behind `/_design?lab=pdf`.
 */

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT = join(__dirname, '..', 'src', 'pages', 'design-lab-pdf.ts');

/** Helvetica is one of the standard 14, so no font has to be embedded; the
 *  filled rectangles mean the page still shows something even where the
 *  standard-font data is unavailable (pdf.js warns about exactly that when
 *  `standardFontDataUrl` is not configured). */
const PAGE_ONE = [
  '0.98 0.98 0.98 rg 0 0 612 792 re f',
  // Text and bars SHARE the fill colour in a content stream, so every text run
  // needs its own `rg` — without one the first lines inherit the page
  // background's near-white and render white-on-white. (Caught by looking at
  // `?lab=pdf`, not by any assertion: the file was valid and the page "blank".)
  '0.10 0.10 0.12 rg',
  'BT /F1 20 Tf 72 720 Td (August document preview) Tj ET',
  '0.30 0.30 0.33 rg',
  'BT /F1 11 Tf 72 690 Td (Page one. Two pages exist so the page chip has something to report,) Tj ET',
  'BT /F1 11 Tf 72 674 Td (and so scrolling has somewhere to go.) Tj ET',
  ...bars([560, 528, 496], [300, 180, 402]),
  '0.30 0.30 0.33 rg',
  'BT /F1 11 Tf 72 440 Td (A wide page, a soft page, and a raster that stops growing at 2400 device px.) Tj ET',
];

const PAGE_TWO = [
  '0.98 0.98 0.98 rg 0 0 612 792 re f',
  '0.10 0.10 0.12 rg',
  'BT /F1 20 Tf 72 720 Td (Page two) Tj ET',
  '0.30 0.30 0.33 rg',
  'BT /F1 11 Tf 72 690 Td (Scroll position decides which card the chip names.) Tj ET',
  ...bars([528, 496], [180, 402]),
];

function bars(tops, widths) {
  return tops.flatMap((y, i) => [
    `0.90 0.90 0.93 rg 72 ${y} 468 12 re f`,
    `0.20 0.34 0.85 rg 72 ${y} ${widths[i]} 12 re f`,
  ]);
}

function stream(lines) {
  const body = `${lines.join('\n')}\n`;
  return `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}endstream`;
}

const objects = [
  null,
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  stream(PAGE_ONE),
  stream(PAGE_TWO),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [0];
for (let i = 1; i < objects.length; i++) {
  offsets[i] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefAt = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
for (let i = 1; i < objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

const base64 = Buffer.from(pdf, 'latin1').toString('base64');
const chunks = base64.match(/.{1,96}/g) ?? [];
const literal = chunks.map((c) => `  '${c}' +`).join('\n').replace(/ \+$/, ';');

writeFileSync(
  OUT,
  `/** A two-page fixture PDF for the \`?lab=pdf\` design lab.
 *
 *  GENERATED — do not edit by hand. \`node scripts/make-lab-pdf.cjs\` writes
 *  this file; the header there says why the fixture is generated rather than
 *  checked in as a binary. ${Buffer.byteLength(pdf, 'latin1')} bytes.
 */
import type { FileAttachment } from '@/types/chat';

/** \`data:application/pdf;base64,…\` for the \`?lab=pdf\` design lab. */
export const LAB_PDF_DATA_URL =
  'data:application/pdf;base64,' +
${literal}

/** The lab's file entry: the pager renders from \`dataUrl\`, and the extracted
 *  text is here so the source toggle has something to show — the same shape a
 *  real attachment has when the backend has already extracted it. */
export const LAB_PDF_FILE: FileAttachment = {
  id: 'design-lab-pdf',
  name: 'lab-report.pdf',
  size: '1.6 KB',
  type: 'text',
  content: [
    '--- Page 1 ---',
    'August document preview',
    'Page one. Two pages exist so the page chip has something to report,',
    'and so scrolling has somewhere to go.',
    '',
    '--- Page 2 ---',
    'Page two',
    'Scroll position decides which card the chip names.',
  ].join('\\n'),
  dataUrl: LAB_PDF_DATA_URL,
};
`,
  'utf8',
);

console.log(`wrote ${OUT} (${Buffer.byteLength(pdf, 'latin1')} bytes of PDF)`);
