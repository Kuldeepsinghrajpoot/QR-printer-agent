'use strict';
/**
 * "Pages per sheet": lays several pages of a PDF onto one sheet (2, 4, 6, 9 or 16 per side), the same idea as the
 * browser's print dialog. SumatraPDF and most drivers can't do this reliably, so we build the sheets ourselves and
 * print the result as a normal PDF. Pure JavaScript (pdf-lib), nothing native to install.
 */
import pdfLib from 'pdf-lib';

const { PDFDocument, rgb } = pdfLib;

/** columns x rows for each choice. 2-up and 6-up use a landscape sheet so the pages stay upright and as big as possible. */
const GRID = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };
const SUPPORTED = Object.keys(GRID).map(Number);

const isPdf = (buf) => buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * Returns a new PDF (Buffer) with `perSheet` source pages per sheet, left-to-right then top-to-bottom.
 * The sheet has the size of the first page (swapped to landscape for 2-up and 6-up).
 */
async function imposeNUp(pdfBuffer, perSheet) {
  const grid = GRID[perSheet];
  if (!grid) throw new Error(`Pages per sheet must be one of ${SUPPORTED.join(', ')}`);
  const [cols, rows] = grid;

  const src = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const srcPages = src.getPages();
  if (srcPages.length === 0) throw new Error('The PDF has no pages');

  const out = await PDFDocument.create();
  const embedded = await out.embedPages(srcPages);

  // Sheet size: the first page's paper, portrait, turned sideways when the layout is wider than tall.
  const first = srcPages[0].getSize();
  const short = Math.min(first.width, first.height);
  const long = Math.max(first.width, first.height);
  const landscape = cols > rows;
  const sheetW = landscape ? long : short;
  const sheetH = landscape ? short : long;

  const margin = 18; // outer margin so nothing is lost at the printer's unprintable edge
  const gap = perSheet >= 9 ? 4 : 8;
  const cellW = (sheetW - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (sheetH - margin * 2 - gap * (rows - 1)) / rows;

  for (let i = 0; i < embedded.length; i += perSheet) {
    const sheet = out.addPage([sheetW, sheetH]);
    for (let k = 0; k < perSheet && i + k < embedded.length; k++) {
      const emb = embedded[i + k];
      const scale = Math.min(cellW / emb.width, cellH / emb.height);
      const w = emb.width * scale;
      const h = emb.height * scale;
      const col = k % cols;
      const row = Math.floor(k / cols);
      const cellX = margin + col * (cellW + gap);
      const cellTop = sheetH - margin - row * (cellH + gap);
      const x = cellX + (cellW - w) / 2;
      const y = cellTop - cellH + (cellH - h) / 2;
      sheet.drawPage(emb, { x, y, width: w, height: h });
      // hairline frame so the page edges are visible when pages have white backgrounds
      sheet.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.4 });
    }
  }
  return Buffer.from(await out.save());
}

export { imposeNUp, isPdf, SUPPORTED };
