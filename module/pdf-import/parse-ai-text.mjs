/**
 * A Mob's AI Text: what the System AI tells crawlers who look at it (ruled
 * 2026-11-21). Both books print it near the stat block - usually just
 * before it, sometimes a page away or after - set in the stat blocks'
 * typeface (TextbookNew), where the book's own prose is in another
 * (ClassicoURW):
 *
 *   Brain Boiler. Level 10.           <- the header: a name, then its Level
 *   Ever see that movie where ...     <- the text, while the typeface and
 *   ... boil your brain!                 size hold
 *   Brain Boiler                      <- the stat block (a bigger name)
 *
 * A header starts a block (a wider gap above it, or the top of a column)
 * and is printed several ways: "Rat Brute, Level 4", "Mayor Mordhau.
 * Skyfowl Official. Level 18.", "Sprites Level 7", a name that wraps onto
 * "Past, Level 7", or the name on its own lines above "Level 8
 * Neighborhood Boss!" - sometimes after "Krakaren Clone, Level 10" too.
 * A blurb runs on into the next column or page while it keeps the
 * typeface.
 *
 * Each Mob takes the blurb that names it - by its whole name or the part
 * before the title ("Mick Moran" of "Mick Moran, Hulking Crocodilian
 * Chef") - from its own Floor and Neighborhood or Quest first, then the
 * nearest. Failing that, a blurb whose name begins the Mob's, at the
 * Mob's Level ("Troglodyte, Level 6" for the Level 6 Troglodyte Basher).
 * A blurb naming no Mob (a Guide's, a crawler's) is left out.
 *
 * scan.mjs names each line's typeface (`face`) on the pages that may hold
 * AI Text; a line without one is never read as AI Text.
 */

import { escapeHtml, joinText } from "./page-text.mjs";

// The AI's typeface, in any style but the ExtraBold of a section label.
const AI_FACE_RE = /^TextbookNew-(?!ExtraBold)/;
// AI Text is body-sized; the stat block's name under it is bigger.
const MAX_SIZE = 11.2;
const LEVEL_RE = /\bLevel\s+(\d+)\b/;
// After "Level 10": at most a tier or "NPC", and closing punctuation.
const AFTER_LEVEL_RE =
  /^\s*(?:(?:NPC|Pet|Elite|Mob|Crawler|(?:Neighborhood|Borough|Burrough|City|Province|Country|Floor|Quest) Boss)\b)?\s*[.!]?\s*$/i;
// A line starting "Level 6." - its name is on the lines above; it may
// carry the text's first words ("Level 6. Basically harmless...").
const LEVEL_FIRST_RE = /^Level\s+(\d+)\b([^.!]{0,40}[.!])?\s*(.*)$/;
const MAX_NAME_WORDS = 20;
const MAX_NAME_LINES = 3;
// A stat block's own lines, never AI Text ("13+F to hit", not "falls to
// hit the ground").
const STAT_LINE_RE = /\d\s*(?:\+\s*[\dF]+\s*)*to hit\b|^Level Surprise|^Str\b|^Notes:/;
// Where a name's title starts: "Name—Title", "Name. Title", "Name, Title".
const TITLE_SPLIT_RE = /\s*[.—–]\s+|\s*[—–]\s*|\s*,\s+|\s+--\s+|--/;

/**
 * Mobs the core rulebook names one way on the stat block and another on
 * its AI Text (ruled 2026-11-21): the stat block's name, then the blurb's,
 * each as printed. Tried before any other match.
 */
const BLURB_NAMES = {
  Demon: "Grampus. Justice Demon",
  "Concierge Wereshark": "Concierge Wereshark (Shark Form)",
  "Clurichaun Aspirant Super Duper Star": "Clurichaun Aspirant Super Star",
  "Pterolykos Elder": "Elder Silkpaw. Pterolykos",
};
const BLURB_KEYS = new Map(
  Object.entries(BLURB_NAMES).map(([mob, blurb]) => [nameKey(mob), nameKey(blurb)]),
);

/**
 * Every AI Text blurb in the book.
 * @param {object[]} pages  From scan.mjs readPages.
 * @param {(page: number, at: number) => object} [sectionAt]  sections.mjs
 * @returns {{whole: string, primary: string, level: number, header: string,
 *   html: string, order: number, section: object, lines: Set<string>}[]}
 *   lines: "page:at" keys of the lines it took, so a stat block's flavor
 *   leaves them out.
 */
export function findAiTexts(pages, sectionAt) {
  const lines = [];
  for (const page of pages) {
    page.lines.forEach((line, at) => lines.push({ ...line, page: page.page, at }));
  }
  const isAi = (k) =>
    !!lines[k] &&
    AI_FACE_RE.test(lines[k].face ?? "") &&
    lines[k].size <= MAX_SIZE &&
    !STAT_LINE_RE.test(lines[k].text);
  const afterOther = (k) =>
    !isAi(k - 1) || lines[k - 1].col !== lines[k].col || lines[k - 1].page !== lines[k].page;
  // A paragraph starts at a wider gap (about 1.7 lines), the top of a
  // column, or after a line that isn't the AI's.
  const startsBlock = (k) =>
    lines[k].gap === null || lines[k].gap >= lines[k].size * 1.4 || afterOther(k);
  // A header starts a bigger break than a paragraph does (2 lines and more
  // in both books), or after a line that isn't the AI's (the core book sets
  // an "AI" mark right above): so a Level the text mentions after a
  // paragraph break never starts another blurb.
  const startsHeader = (k) =>
    lines[k].gap === null || lines[k].gap >= lines[k].size * 1.9 || afterOther(k);
  const ctx = { lines, isAi, startsBlock, startsHeader };

  const blurbs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isAi(i)) continue;
    const head = readHeader(ctx, i);
    if (!head) continue;
    let j = i + 1;
    // "Krakaren Clone, Level 10" / "Level 10 Neighborhood Boss!" - a tier
    // at most, not "Level 3 crawlers should run".
    while (isAi(j) && headerContinues(lines[j].text)) {
      head.header += ` ${lines[j].text.trim()}`;
      j++;
    }
    const body = head.rest ? [{ text: head.rest, gap: null, size: lines[i].size }] : [];
    // On until the next header, or the next header's name lines.
    while (isAi(j) && !readHeader(ctx, j) && !namesNextHeader(ctx, j)) body.push(lines[j++]);
    if (!body.length) continue;
    const used = [...head.from, ...range(i, j)];
    blurbs.push({
      whole: nameKey(head.name),
      primary: nameKey(primaryName(head.name)),
      parts: nameParts(head.name).map(nameKey).filter(Boolean),
      level: head.level,
      header: head.header,
      html: toHtml(head.header, body),
      order: i,
      section: sectionAt?.(lines[i].page, lines[i].at) ?? null,
      lines: new Set(used.map((k) => `${lines[k].page}:${lines[k].at}`)),
    });
    i = j - 1;
  }
  return blurbs;
}

/**
 * A blurb's header at line i, if it is one.
 * @returns {{name: string, header: string, level: number, rest: string,
 *   from: number[]}|null}  rest: the text's first words on a "Level 6.
 *   Basically..." line; from: the name's own lines above.
 */
function readHeader({ lines, isAi, startsBlock, startsHeader }, i) {
  const text = lines[i].text.trim();
  let prefix;
  let level;
  let rest = "";
  const first = text.match(LEVEL_FIRST_RE);
  if (first) {
    prefix = "";
    level = Number(first[1]);
    rest = first[3] ?? "";
  } else {
    const m = text.match(LEVEL_RE);
    if (!m || !AFTER_LEVEL_RE.test(text.slice(m.index + m[0].length))) return null;
    prefix = text.slice(0, m.index).trim();
    level = Number(m[1]);
  }
  // The name's lines above, back to where the header starts. A name all on
  // this line needs this line to start it. Meeting a paragraph break
  // first, it's text that mentions a Level, not a header.
  const from = [];
  if (first || !startsHeader(i)) {
    for (let k = i - 1; k >= 0 && from.length < MAX_NAME_LINES; k--) {
      if (!isAi(k) || lines[k].page !== lines[i].page || LEVEL_RE.test(lines[k].text)) return null;
      from.unshift(k);
      if (startsHeader(k)) break;
      if (startsBlock(k)) return null;
    }
    if (!from.length || !startsHeader(from[0])) return null;
  }
  const name = joinText([...from.map((k) => lines[k].text.trim()), prefix].filter(Boolean))
    .replace(/[.,]$/, "")
    .trim();
  if (!name || !/^[A-Z“"']/.test(name) || wordCount(name) > MAX_NAME_WORDS) return null;
  const levelPart = first ? `Level ${first[1]}${first[2] ?? "."}` : text;
  const header = joinText([...from.map((k) => lines[k].text.trim()), levelPart]);
  return { name, header, level, rest, from };
}

/** A line that only adds the tier to a header: "Level 10 Neighborhood Boss!". */
function headerContinues(text) {
  const m = text.trim().match(/^Level\s+\d+\b(.*)$/);
  return !!m && AFTER_LEVEL_RE.test(m[1]);
}

/**
 * Whether line j is the first of the next header's name lines - "The Bar
 * Render. Former Lawyer, Current" above "Level 8 Neighborhood Boss!" - so a
 * blurb before it stops there.
 */
function namesNextHeader(ctx, j) {
  if (!ctx.startsHeader(j)) return false;
  for (let k = j + 1; k <= j + MAX_NAME_LINES && ctx.isAi(k); k++) {
    const head = readHeader(ctx, k);
    if (head) return head.from[0] === j;
  }
  return false;
}

// "Dr. Bones" is one name, not "Dr", titled "Bones".
const HONORIFIC_RE = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|Lt|Sgt|Capt|Prof|Gen|Col|Rev)\.\s+/g;

/** A name's parts: "Stoker. Non-Sparkly Vampire" is "Stoker", "Non-Sparkly Vampire". */
function nameParts(name) {
  return String(name).replace(HONORIFIC_RE, "$1 ").split(TITLE_SPLIT_RE);
}

/** A name's part before its title: "Mick Moran" of "Mick Moran, Hulking Chef". */
function primaryName(name) {
  return nameParts(name)[0];
}

/**
 * A name as a match key: lower case, plain quotes, hyphens as spaces, no
 * leading "The", a plural "s" dropped ("Brain Boilers" is "Brain Boiler").
 * @param {string} name
 * @returns {string}
 */
export function nameKey(name) {
  return (
    String(name ?? "")
      .toLowerCase()
      .replace(/[“”"’‘`]/g, "'")
      .replace(/[^\p{L}\p{N}'#()]+/gu, " ")
      .trim()
      .replace(/^the\s+/, "")
      .split(" ")
      // Both sides go through this, so "Torpedoes"/"Torpedo" and
      // "Gumshoes"/"Gumshoe" each meet.
      .map((w) => (w.length > 3 ? w.replace(/(?<!s)s$/, "").replace(/oe$/, "o") : w))
      .join(" ")
  );
}

/**
 * Each line's place in the book, by "page:at" - the order findAiTexts and
 * blurbFor count in.
 * @param {object[]} pages
 * @returns {Map<string, number>}
 */
export function lineOrder(pages) {
  const order = new Map();
  let n = 0;
  for (const page of pages) page.lines.forEach((_, at) => order.set(`${page.page}:${at}`, n++));
  return order;
}

/**
 * The blurb that names a Mob (see the file's comment), trying in turn: its
 * whole name exactly; its whole name or the part before its title, either
 * way; any part of the blurb's name
 * ("Stoker. Non-Sparkly Vampire."); a blurb's name that begins the Mob's,
 * at its Level; a name a letter or two off - a misprint - at its Level.
 * @param {{name: string, level?: number, order: number, section?: object}} mob
 *   order: its class line's place among the book's lines (lineOrder).
 * @param {object[]} blurbs  From findAiTexts.
 * @returns {object|null}
 */
export function blurbFor(mob, blurbs) {
  const whole = nameKey(mob.name);
  const mobKeys = new Set([whole, nameKey(primaryName(mob.name))]);
  const sameLevel = (b) => b.level === mob.level;
  const shim = BLURB_KEYS.get(whole);
  const tries = [
    (b) => !!shim && (b.whole === shim || (b.parts ?? []).includes(shim)) && sameLevel(b),
    (b) => b.whole === whole,
    (b) => mobKeys.has(b.whole) || mobKeys.has(b.primary),
    (b) => (b.parts ?? []).some((p) => mobKeys.has(p)),
    (b) => sameLevel(b) && b.primary.length > 3 && whole.startsWith(`${b.primary} `),
    (b) => sameLevel(b) && whole.length >= 8 && editDistance(whole, b.whole) <= 2,
  ];
  for (const fits of tries) {
    const named = blurbs.filter(fits);
    if (!named.length) continue;
    const same = (b) => sameSection(b.section, mob.section);
    const pool = named.some(same) ? named.filter(same) : named;
    const distance = (b) => Math.abs(mob.order - b.order) + (b.order > mob.order ? 0.5 : 0);
    return pool.reduce((best, b) => (distance(b) < distance(best) ? b : best));
  }
  return null;
}

/** Letters to change, add or drop to turn a into b (3 for "more than 2"). */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function sameSection(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The header in bold, then the text's paragraphs (a wider gap starts one). */
function toHtml(header, body) {
  const paras = [];
  let current = [];
  for (const line of body) {
    if (current.length && line.gap !== null && line.gap >= line.size * 1.4) {
      paras.push(current);
      current = [];
    }
    current.push(line.text.trim());
  }
  if (current.length) paras.push(current);
  return [
    `<p><strong>${escapeHtml(header)}</strong></p>`,
    ...paras.map((p) => `<p>${escapeHtml(joinText(p))}</p>`),
  ].join("");
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function range(from, to) {
  return Array.from({ length: to - from }, (_, k) => from + k);
}
