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
    const items = toTextItems(await page.getTextContent()).map((i) => ({
      ...i,
      x: i.x - x0,
      y: i.y - y0,
    }));
    const size = { width: x1 - x0, height: y1 - y0, page: n };
    pages.push({ ...size, items, lines: layoutLines(items, size) });
    page.cleanup();
    onProgress?.(n, pdfDoc.numPages);
  }
  return pages;
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

/** "Gamemasters Toolkit_Digital_Low-Res_081226.pdf" -> "Gamemasters Toolkit". */
export function bookTitleFromFilename(filename) {
  const base = String(filename)
    .replace(/\.pdf$/i, "")
    .replace(/_Digital.*$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
  return base || "Rulebook";
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
