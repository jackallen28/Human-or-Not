/**
 * The printable login cards: one card per student, "Student N" and their code,
 * ten to an A4 page with cut lines.
 *
 * A hand-written PDF rather than a dependency: the standard fonts (Helvetica,
 * Courier) are built into every PDF reader, so the file needs no embedded
 * fonts, and the whole thing is a few rectangles and lines of text.
 */

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 36;
const COLS = 2;
const ROWS = 5;
const HEADER = 56;

/** PDF string literal, Latin-1 only (WinAnsi). Anything else becomes "?". */
function pdfText(value) {
  const latin = String(value ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\xFF]/g, '?');
  return `(${latin.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

/** Rough Helvetica width, good enough to centre a line. */
function textWidth(text, size, mono = false) {
  return String(text).length * size * (mono ? 0.6 : 0.52);
}

function pageStream({ title, joinUrl, cards, pageNo, pageCount }) {
  const ops = [];
  const text = (x, y, size, font, value) => ops.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfText(value)} Tj ET`);
  const centred = (cx, y, size, font, value, mono = false) => text(cx - textWidth(value, size, mono) / 2, y, size, font, value);

  // Page header
  ops.push('0.93 0.54 0.16 rg');
  text(MARGIN, PAGE_H - MARGIN - 14, 16, 'F2', title);
  ops.push('0.35 0.35 0.35 rg');
  text(MARGIN, PAGE_H - MARGIN - 32, 9, 'F1', `Human or Not? - login cards. Cut along the dotted lines. Students go to ${joinUrl} and enter their code.`);
  text(PAGE_W - MARGIN - 60, PAGE_H - MARGIN - 14, 9, 'F1', `Page ${pageNo} of ${pageCount}`);

  const gridTop = PAGE_H - MARGIN - HEADER;
  const cardW = (PAGE_W - MARGIN * 2) / COLS;
  const cardH = (gridTop - MARGIN) / ROWS;

  // Dashed cut lines
  ops.push('0.7 0.7 0.7 RG 0.6 w [3 3] 0 d');
  for (let c = 0; c <= COLS; c++) {
    const x = MARGIN + c * cardW;
    ops.push(`${x.toFixed(2)} ${MARGIN.toFixed(2)} m ${x.toFixed(2)} ${gridTop.toFixed(2)} l S`);
  }
  for (let r = 0; r <= ROWS; r++) {
    const y = gridTop - r * cardH;
    ops.push(`${MARGIN.toFixed(2)} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
  }
  ops.push('[] 0 d');

  cards.forEach((card, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = MARGIN + col * cardW;
    const top = gridTop - row * cardH;
    const cx = x + cardW / 2;
    ops.push('0.45 0.45 0.45 rg');
    centred(cx, top - 22, 8.5, 'F1', title);
    ops.push('0.1 0.1 0.1 rg');
    centred(cx, top - 50, 17, 'F2', card.label);
    ops.push('0.93 0.54 0.16 rg');
    centred(cx, top - 86, 26, 'F3', card.code, true);
    ops.push('0.45 0.45 0.45 rg');
    centred(cx, top - cardH + 18, 8, 'F1', `Go to ${joinUrl}`);
  });
  return ops.join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.title     class name
 * @param {string} opts.joinUrl   where students go
 * @param {Array<{label: string, code: string}>} opts.cards
 * @returns {Buffer}
 */
export function buildCardsPdf({ title, joinUrl, cards }) {
  const perPage = COLS * ROWS;
  const pages = [];
  for (let i = 0; i < Math.max(cards.length, 1); i += perPage) pages.push(cards.slice(i, i + perPage));

  // Object numbers: 1 catalog, 2 pages, 3-5 fonts, then (page, content) pairs.
  const objects = [];
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((cardsOnPage, i) => {
    const stream = pageStream({ title, joinUrl, cards: cardsOnPage, pageNo: i + 1, pageCount: pages.length });
    const pageId = pageIds[i];
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ------------------------------------------------------------------ codes

// No I, O, 0 or 1: these are read off a card and called across a room.
const CONSONANTS = 'BCDFGHJKLMNPRSTVWXZ';
const VOWELS = 'AEU';
const DIGITS = '23456789';
const pick = (set) => set[Math.floor(Math.random() * set.length)];

/** Pronounceable, unambiguous, unique codes like BAKE2739. */
export function generateCodes(count, taken = new Set()) {
  const out = [];
  const seen = new Set(taken);
  while (out.length < count) {
    const code = pick(CONSONANTS) + pick(VOWELS) + pick(CONSONANTS) + pick(VOWELS)
      + Array.from({ length: 4 }, () => pick(DIGITS)).join('');
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}
