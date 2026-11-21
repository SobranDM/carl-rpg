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
import { looksLikeHeader } from "./parse-ai-text.mjs";
import { parseSpells } from "./parse-spells.mjs";

// A page with less real text than this (letters and digits, outside the
// margins) is mostly picture: a possible map.
const MAP_TEXT_LIMIT = 150;
// A page with a line that could head a Mob's AI Text ("Rat Brute, Level
// 4"): its typefaces are read too (parse-ai-text.mjs tells the AI's voice
// by them), and the next page's, where a blurb may run on.
// How long to wait for one font to load before going without its name.
const FONT_WAIT_MS = 3000;

/**
 * Read every page's text.
 * @param {object} pdfDoc
 * @param {{onProgress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<object[]>} One entry per page: {page, width, height, items, lines}.
 */
export async function readPages(pdfDoc, { onProgress } = {}) {
  const pages = [];
  // Fonts are the document's, shared by its pages: each named once.
  const fontNames = new Map();
  let lastMayHave = false;
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
    const size = { width: x1 - x0, height: y1 - y0, page: n };
    let lines = layoutLines(items, size);
    const mayHave = lines.some((l) => looksLikeHeader(l.text));
    if (mayHave || lastMayHave) {
      await nameFaces(page, items, fontNames);
      lines = layoutLines(items, size);
    }
    lastMayHave = mayHave;
    pages.push({ ...size, items, lines });
    page.cleanup();
    onProgress?.(n, pdfDoc.numPages);
  }
  return pages;
}

/**
 * Give each text item its typeface's name ("TextbookNew-Bold"), as `face`.
 * pdf.js only knows a font's name once the page's drawing is loaded and the
 * font itself has loaded (which can finish after the drawing), so this costs
 * a little: it's done only where AI Text may be. An item whose font isn't
 * known in time keeps no face.
 * @param {object} page  A pdf.js page.
 * @param {object[]} items  From toTextItems; `font` is pdf.js's font id.
 * @param {Map<string, string>} names  Font names already known, by id (pdf.js's
 *   font ids are the document's): a page whose fonts are all known needn't
 *   be drawn, and a font that didn't load in time isn't waited for again.
 */
async function nameFaces(page, items, names) {
  const ids = [...new Set(items.map((i) => i.font).filter(Boolean))].filter((id) => !names.has(id));
  let drawn = ids.length > 0;
  if (drawn) {
    try {
      await page.getOperatorList();
    } catch {
      // This page's new fonts go unnamed; those already known still apply.
      drawn = false;
    }
  }
  if (drawn) {
    const fonts = await Promise.all(ids.map((id) => loadedFont(page, id)));
    ids.forEach((id, k) => {
      // "BDIFOQ+TextbookNew-Bold": the six letters name the subset, not the face.
      names.set(id, String(fonts[k]?.name ?? "").replace(/^[A-Z]{6}\+/, ""));
    });
  }
  for (const item of items) {
    const face = names.get(item.font);
    if (face) item.face = face;
  }
}

/**
 * A page's font, once loaded - or null if it isn't within FONT_WAIT_MS.
 * @param {object} page
 * @param {string} id  pdf.js's font id.
 * @returns {Promise<object|null>}
 */
function loadedFont(page, id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FONT_WAIT_MS);
    try {
      page.commonObjs.get(id, (font) => {
        clearTimeout(timer);
        resolve(font ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
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
