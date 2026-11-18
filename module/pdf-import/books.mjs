/**
 * Which book a PDF is, read from its title page - never from its file name,
 * which can be anything (ruled 2026-11-18: "derive which book it is by
 * reading the title on one of the first pages. If it doesn't match one of
 * the two expected, we reject it").
 *
 * The importer takes two books: the Core Rulebook and the Starter Set's
 * Game Master's Campaign Toolkit. Each has a fixed id, used for its
 * compendiums, folders, flags and map folder, so the same book always lands
 * in the same place. Any other PDF (another game, the Starter Set's
 * Crawlers & Customization booklet) is refused.
 *
 * A book is recognised by the big title text on one of its first pages
 * (the cover: "CORE RULEBOOK", "GAME MASTER'S / CAMPAIGN TOOLKIT"), and the
 * game's name somewhere in those pages, so another game's "Core Rulebook"
 * isn't taken for ours. Only text items from page-text.mjs toTextItems are
 * read (the download stamp is already dropped there), and nothing read is
 * shown or stored: only the id.
 *
 * Imports made before this (0.7.0 development builds) were keyed by a slug
 * of the file name; bookIdOf reads the known ones as the book's id, so a
 * re-import finds and updates them.
 *
 * Pure apart from readTitlePages, which takes an open pdf.js document, so
 * it runs in Foundry and in the Node preview tool.
 */

import { isBoilerplate, toTextItems } from "./page-text.mjs";

/** How many pages from the front are read to identify a book. */
export const IDENTIFY_PAGES = 10;
// Title text: within this share of the page's biggest text, and at least this big.
const TITLE_SHARE = 0.75;
const TITLE_MIN_SIZE = 24;
// Cover titles are set at a slant (the Core Rulebook's 7 degrees, the
// Toolkit's 4.5); text turned further is a sidebar or chapter tab.
const TITLE_MAX_TILT = 15;
const GAME_NAME_RE = /DUNGEON CRAWLER CARL/;

/**
 * The books the importer takes. `title` is a lang/en.json key; `cover`
 * matches the cover title as normalised by titleText; `legacy` lists the
 * file-name slugs earlier development builds stored for it.
 */
export const BOOKS = Object.freeze({
  core: Object.freeze({
    id: "core",
    title: "CARLRPG.PdfImport.Books.core",
    cover: /\bCORE RULEBOOK\b/,
    legacy: Object.freeze(["carl-rpg", "carl-rpg-lq", "core-rulebook", "carl-rpg-core-rulebook", "dungeon-crawler-carl-core-rulebook"]),
  }),
  toolkit: Object.freeze({
    id: "toolkit",
    title: "CARLRPG.PdfImport.Books.toolkit",
    cover: /\bGAME ?MASTERS? (?:CAMPAIGN )?TOOLKIT\b/,
    legacy: Object.freeze([
      "starter-set-gamemaster-s-toolkit", "starter-set-gamemaster-s-toolkit-lq", "gamemasters-toolkit",
      "gamemaster-s-toolkit", "game-master-s-toolkit", "game-master-s-campaign-toolkit",
    ]),
  }),
});

/** Thrown when a PDF is neither book. Carries nothing read from it. */
export class UnknownBookError extends Error {
  constructor() {
    super("Not the Core Rulebook or the Game Master's Campaign Toolkit");
    this.name = "UnknownBookError";
  }
}

/** Upper case, curly apostrophes and the possessive's apostrophe dropped, words single-spaced. */
function normalize(text) {
  return String(text ?? "")
    .toUpperCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * A page's title: its big, roughly level text (within TITLE_SHARE of its biggest,
 * and at least TITLE_MIN_SIZE), top to bottom, each string once (titles are
 * often drawn twice, as a shadow), normalised.
 * @param {{str: string, x: number, y: number, size: number, angle: number}[]} items  From toTextItems.
 * @returns {string}  "" when the page has no big text.
 */
export function titleText(items) {
  const level = (items ?? []).filter((i) => Math.abs(i.angle ?? 0) <= TITLE_MAX_TILT && !isBoilerplate(i.str) && /\p{L}/u.test(i.str));
  if (!level.length) return "";
  const biggest = Math.max(...level.map((i) => i.size));
  if (biggest < TITLE_MIN_SIZE) return "";
  const big = level
    .filter((i) => i.size >= biggest * TITLE_SHARE)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((i) => i.str.trim());
  return normalize([...new Set(big)].join(" "));
}

/**
 * Which book these first pages are from.
 * @param {object[][]} pages  Each page's text items (toTextItems), from the front.
 * @returns {typeof BOOKS[keyof typeof BOOKS]|null}  null: neither.
 */
export function identifyBook(pages) {
  const front = (pages ?? []).slice(0, IDENTIFY_PAGES);
  const allText = normalize(front.flatMap((items) => (items ?? []).map((i) => i.str)).join(" "));
  if (!GAME_NAME_RE.test(allText)) return null;
  for (const items of front) {
    const title = titleText(items);
    if (!title) continue;
    const book = Object.values(BOOKS).find((b) => b.cover.test(title));
    if (book) return book;
  }
  return null;
}

/**
 * Read the first pages' text items of an open pdf.js document.
 * @param {object} pdfDoc
 * @returns {Promise<object[][]>}
 */
export async function readTitlePages(pdfDoc) {
  const pages = [];
  for (let n = 1; n <= Math.min(IDENTIFY_PAGES, pdfDoc.numPages); n++) {
    const page = await pdfDoc.getPage(n);
    pages.push(toTextItems(await page.getTextContent()));
    page.cleanup?.();
  }
  return pages;
}

/**
 * Identify an open PDF, or throw UnknownBookError.
 * @param {object} pdfDoc
 * @returns {Promise<typeof BOOKS[keyof typeof BOOKS]>}
 */
export async function identifyPdf(pdfDoc) {
  const book = identifyBook(await readTitlePages(pdfDoc));
  if (!book) throw new UnknownBookError();
  return book;
}

/**
 * A stored book key (a pack's, folder's or document's flag) as a book id:
 * a known pre-0.7.0-release file-name slug reads as its book's id; anything
 * else is itself (a test book's id).
 * @param {string|null|undefined} key
 * @returns {string|null|undefined}
 */
export function bookIdOf(key) {
  if (!key || BOOKS[key]) return key;
  const book = Object.values(BOOKS).find((b) => b.legacy.includes(key));
  return book ? book.id : key;
}
