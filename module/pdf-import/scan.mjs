/**
 * Scan a whole rulebook PDF and hand each page's text to the content
 * parsers. Every book shares the same block formats (stat blocks, "Gear
 * Slot:" entries, spell cards, achievement pop-ups), so nothing here is keyed
 * to page numbers: a parser claims whatever pages match its pattern.
 *
 * Takes an open pdf.js document, so it runs both in Foundry and in the Node
 * preview tool. No book text is stored anywhere but the user's own world.
 */

import { isBoilerplate, layoutLines, titleCase, toTextItems } from "./page-text.mjs";
import { parseAchievements } from "./parse-achievements.mjs";
import { parseGear } from "./parse-gear.mjs";
import { parseMobs } from "./parse-mobs.mjs";
import { parseSpells } from "./parse-spells.mjs";

// A page with less real text than this (letters and digits, outside the
// margins) is mostly picture: a possible map.
const MAP_TEXT_LIMIT = 150;
// A page that may hold a Mob's AI Text ("Rat Brute, Level 4"): its
// typefaces are read too (parse-ai-text.mjs tells the AI's voice by them).
const MAY_HAVE_AI_TEXT_RE = /\bLevel\s+\d/;

/**
 * Read every page's text.
 * @param {object} pdfDoc
 * @param {{onProgress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<object[]>} One entry per page: {page, width, height, items, lines}.
 */
export async function readPages(pdfDoc, { onProgress } = {}) {
  const pages = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    // toTextItems drops the per-page download stamp here, item by item, so
    // no parser, map label or achievement reader ever sees it.
    const items = toTextItems(await page.getTextContent()).map((i) => ({
      ...i,
      x: i.x - x0,
      y: i.y - y0,
    }));
    if (MAY_HAVE_AI_TEXT_RE.test(items.map((i) => i.str).join(" "))) await nameFaces(page, items);
    const size = { width: x1 - x0, height: y1 - y0, page: n };
    pages.push({ ...size, items, lines: layoutLines(items, size) });
    page.cleanup();
    onProgress?.(n, pdfDoc.numPages);
  }
  return pages;
}

/**
 * Give each text item its typeface's name ("TextbookNew-Bold"), as `face`.
 * pdf.js only knows a font's name once the page's drawing is loaded, so this
 * costs a little: it's done only where AI Text may be. An item whose font
 * isn't known keeps no face.
 * @param {object} page  A pdf.js page.
 * @param {object[]} items  From toTextItems; `font` is pdf.js's font id.
 */
async function nameFaces(page, items) {
  try {
    await page.getOperatorList();
  } catch {
    return;
  }
  const names = new Map();
  for (const item of items) {
    if (!item.font || names.has(item.font)) continue;
    let name = "";
    try {
      if (page.commonObjs.has(item.font)) name = page.commonObjs.get(item.font)?.name ?? "";
    } catch {
      name = "";
    }
    // "BDIFOQ+TextbookNew-Bold": the six letters name the subset, not the face.
    names.set(item.font, String(name).replace(/^[A-Z]{6}\+/, ""));
  }
  for (const item of items) {
    const face = names.get(item.font);
    if (face) item.face = face;
  }
}

/**
 * Pages that are mostly picture. Whether one really holds a map, and where,
 * is settled later from its images (maps.mjs).
 * @param {object[]} pages  From readPages.
 */
export function findMapPages(pages) {
  return pages
    .filter((p) => {
      const text = p.lines.map((l) => l.text).join("");
      return text.replace(/[^\p{L}\p{N}]/gu, "").length < MAP_TEXT_LIMIT;
    })
    .map((p) => ({ page: p.page, ...mapLabel(p) }));
}

/**
 * Name a map page from its text, and guess whether it is a map at all.
 * Battle maps carry a short title ("BOGBRICKS") or only the running header
 * ("CHAPTER 7: THE OVER CITY"); chapter art carries a huge chapter title or
 * no words at all.
 */
function mapLabel(page) {
  const words = page.items.filter(
    (i) => Math.abs(i.angle) < 1 && !isBoilerplate(i.str) && /\p{L}{3}/u.test(i.str),
  );
  const fallback = `Map (p. ${page.page})`;
  if (!words.length) return { name: fallback, likely: false };
  const biggest = Math.max(...words.map((i) => i.size));
  // Titles are often drawn twice (a shadow under the text).
  const title = [...new Set(words.filter((i) => i.size === biggest).map((i) => i.str.trim()))].join(
    " ",
  );
  // Core Rulebook maps carry only the running header, shared by a whole
  // chapter's maps, so the page number tells them apart.
  const header = title.match(/^CHAPTER \d+:\s*(.+)$/i);
  const name = header ? `${titleCase(header[1])} Map (p. ${page.page})` : titleCase(title);
  return { name, likely: biggest < 30 };
}

/**
 * Run every parser over the book.
 * @param {object[]} pages  From readPages.
 */
export function parseBook(pages) {
  return {
    gear: parseGear(pages),
    mobs: parseMobs(pages),
    spells: parseSpells(pages),
    achievements: parseAchievements(pages),
    maps: findMapPages(pages),
  };
}

// Which book a PDF is comes from its title page (books.mjs), never its file name.

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
