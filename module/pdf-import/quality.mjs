/**
 * Refuse the low-quality ("LQ") editions of the books. The store offers each
 * book at full quality and as a small low-quality download; only the full
 * one is supported - the LQ files mangle the text the parsers read (doubled
 * text, lost glyphs) and their maps are low resolution.
 *
 * Told apart by their pictures, not by file name (a file can be called
 * anything) nor by the download stamp (guest or account download is a
 * separate choice): the full books embed their art at 200 pixels per inch,
 * the LQ files at 72 (Core Rulebook) or 100 (Starter Set). The median over a
 * sample of pages is compared with LOW_QUALITY_PPI, midway between.
 *
 * Pure apart from checkImageQuality, which takes an open pdf.js document, so
 * it runs in Foundry and in the Node preview tool.
 */

import { drawRect, imageDraws } from "./maps.mjs";

/** Below this median pixels-per-inch a book is the low-quality edition. */
export const LOW_QUALITY_PPI = 150;
// An image covering less of the page than this is an icon or ornament.
const MIN_IMAGE_SHARE = 0.02;
// Too few pictures to judge: let the import go ahead.
const MIN_IMAGES = 8;
const SAMPLE_PAGES = 30;

/** Thrown when the PDF is a low-quality edition. */
export class LowQualityPdfError extends Error {
  /** @param {number} ppi  The book's measured median pixels per inch. */
  constructor(ppi) {
    super(`Low-quality PDF edition (images at about ${Math.round(ppi)} ppi)`);
    this.name = "LowQualityPdfError";
    this.ppi = ppi;
  }
}

/**
 * Pixels per inch of each sizeable picture a page draws.
 * @param {object[]} draws  From maps.mjs imageDraws.
 * @param {number[]} view   The page's view box.
 * @returns {number[]}
 */
export function imagePpis(draws, view) {
  const pageArea = (view[2] - view[0]) * (view[3] - view[1]);
  const out = [];
  for (const draw of draws) {
    const rect = drawRect(draw.ctm, view);
    const visible = Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
    if (visible / pageArea < MIN_IMAGE_SHARE || !draw.pixelWidth || !draw.pixelHeight) continue;
    // Drawn size in points, by area so a turned image gives the same answer.
    const [a, b, c, d] = draw.ctm;
    const drawn = Math.hypot(a, b) * Math.hypot(c, d);
    if (drawn) out.push(Math.sqrt((draw.pixelWidth * draw.pixelHeight) / drawn) * 72);
  }
  return out;
}

/**
 * Whether measured pictures make a book the low-quality edition.
 * @param {number[]} ppis
 * @returns {{ppi: number|null, images: number, lowQuality: boolean}}
 */
export function judgeImageQuality(ppis) {
  if (ppis.length < MIN_IMAGES) return { ppi: null, images: ppis.length, lowQuality: false };
  const sorted = [...ppis].sort((x, y) => x - y);
  const ppi = sorted[Math.floor(sorted.length / 2)];
  return { ppi, images: ppis.length, lowQuality: ppi < LOW_QUALITY_PPI };
}

/** Up to `count` page numbers spread evenly through the book. */
export function samplePages(numPages, count = SAMPLE_PAGES) {
  if (numPages <= count) return Array.from({ length: numPages }, (_, i) => i + 1);
  return [
    ...new Set(
      Array.from({ length: count }, (_, i) => 1 + Math.round((i * (numPages - 1)) / (count - 1))),
    ),
  ];
}

/**
 * Measure a sample of the book's pages.
 * @param {object} pdfDoc  An open pdf.js document.
 * @param {object} OPS     pdf.js OPS table.
 * @returns {Promise<{ppi: number|null, images: number, lowQuality: boolean}>}
 */
export async function checkImageQuality(pdfDoc, OPS) {
  const ppis = [];
  for (const n of samplePages(pdfDoc.numPages)) {
    const page = await pdfDoc.getPage(n);
    ppis.push(...imagePpis(imageDraws(await page.getOperatorList(), OPS), page.view));
    page.cleanup();
  }
  return judgeImageQuality(ppis);
}
