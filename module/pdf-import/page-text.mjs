/**
 * Turn pdf.js text content into reading-order lines.
 *
 * The rulebooks are two-column, but the gutter moves: a wide Health Bar row
 * can push the right column far past the page middle. So each page's gutter
 * is found from where right-column lines start (the most common item x in
 * the right half), not assumed to sit at width / 2. A page whose text mostly
 * runs across that x is treated as one column.
 *
 * Pure: no Foundry or DOM globals, so the Node preview tool
 * (tools/pdf-import/extract-rulebook.mjs) and the Quench tests share it.
 */

// Running headers, page numbers and the purchase watermark live in the top
// and bottom margins; chapter tabs ("FLOOR 3" set one letter per line) in
// the side margins.
const MARGIN = 40;
const SIDE_MARGIN = 36;
const WATERMARK_RE = /Downloaded by .*Unauthorized distribution prohibited|^©\s?\d{4}/;

/**
 * @param {object} textContent  Result of pdf.js page.getTextContent().
 * @returns {{str: string, x: number, y: number, width: number, size: number, angle: number, font: string}[]}
 */
export function toTextItems(textContent) {
  const items = [];
  for (const item of textContent.items ?? []) {
    if (!item.str?.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    items.push({
      str: item.str,
      x: e,
      y: f,
      width: item.width ?? 0,
      size: Math.hypot(c, d) || Math.hypot(a, b),
      angle: (Math.atan2(b, a) * 180) / Math.PI,
      font: item.fontName ?? "",
    });
  }
  return items;
}

/** True for text that is page furniture (watermark, copyright line). */
export function isBoilerplate(str) {
  return WATERMARK_RE.test(str.trim());
}

/**
 * Find the x where the right column starts, or null for a one-column page.
 * @param {object[]} items  Upright body items.
 * @param {number} width    Page width in points.
 */
export function findGutter(items, width) {
  const counts = new Map();
  for (const item of items) {
    if (item.x < width * 0.4 || item.x > width * 0.85) continue;
    const key = Math.round(item.x);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const key of counts.keys()) {
    const n = (counts.get(key - 1) ?? 0) + counts.get(key) + (counts.get(key + 1) ?? 0);
    if (n > bestCount || (n === bestCount && key < best)) {
      best = key;
      bestCount = n;
    }
  }
  if (bestCount < 4) return null;
  // The column's lines can start a few points left of the busiest x (a
  // name, a bullet). Take the leftmost start that few items run across.
  const crossing = (g) => items.filter((i) => i.x < g - 1 && i.x + i.width > g + 1).length;
  const starts = items
    .filter((i) => i.x >= best - 12 && i.x < best + 1)
    .map((i) => i.x)
    .sort((a, b) => a - b);
  for (const x of starts) {
    if (crossing(x - 2) <= items.length * 0.1) return x - 2;
  }
  return null;
}

/** Join one row's items left to right, adding a space only where there is a gap. */
function joinRow(row) {
  row.sort((a, b) => a.x - b.x);
  let text = "";
  let prev = null;
  for (const item of row) {
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      // Tight headings leave barely a point between words.
      if (gap > prev.size * 0.06 && !text.endsWith(" ") && !item.str.startsWith(" ")) text += " ";
    }
    text += item.str;
    prev = item;
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Group items into rows by baseline, top to bottom. */
function toRows(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - item.y) <= Math.max(2, item.size * 0.4)) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows;
}

/**
 * Lay one page out as reading-order lines: left column top to bottom, then
 * the right column. Rotated text is left out (see parse-achievements.mjs).
 * @param {object[]} items  From toTextItems.
 * @param {{width: number, height: number, page?: number}} page
 * @returns {{text: string, x: number, y: number, size: number, col: number, page: number, gap: number|null}[]}
 */
export function layoutLines(items, { width, height, page = 0 }) {
  const body = items.filter(
    (i) =>
      Math.abs(i.angle) < 1 &&
      i.y > MARGIN &&
      i.y < height - MARGIN &&
      i.x > SIDE_MARGIN / 2 &&
      i.x < width - SIDE_MARGIN &&
      !isBoilerplate(i.str),
  );
  const gutter = findGutter(body, width);
  const columns =
    gutter === null
      ? [body]
      : [body.filter((i) => i.x < gutter), body.filter((i) => i.x >= gutter)];

  const lines = [];
  columns.forEach((colItems, col) => {
    let prevY = null;
    for (const row of toRows(colItems)) {
      const text = joinRow(row.items);
      if (!text) continue;
      lines.push({
        text,
        x: Math.min(...row.items.map((i) => i.x)),
        y: row.y,
        size: Math.max(...row.items.map((i) => i.size)),
        col,
        page,
        gap: prevY === null ? null : prevY - row.y,
      });
      prevY = row.y;
    }
  });
  return lines;
}

/** Median line size: the body text size of a page or run of pages. */
export function bodySize(lines) {
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
}

/** An all-caps line set well above body size (an entry or section heading). */
export function isHeading(line, body) {
  return (
    line.size >= body * 1.35 && /[A-Z]{3}/.test(line.text) && line.text === line.text.toUpperCase()
  );
}

/**
 * Join wrapped lines into one string. A line ending in "-" glues to the
 * next; the hyphen is dropped when the next part starts lowercase (a word
 * split by the layout) and kept otherwise ("Good-Shit-Because-" + "You're").
 * @param {string[]} parts
 */
export function joinText(parts) {
  return parts.reduce((acc, part) => {
    if (!acc) return part;
    if (/[-‑]$/.test(acc))
      return /^[a-z]/.test(part) ? acc.slice(0, -1) + part : acc.slice(0, -1) + "-" + part;
    return `${acc} ${part}`;
  }, "");
}

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

/** "ANKLET OF THE FALLEN OAK" -> "Anklet of the Fallen Oak". */
export function titleCase(text) {
  return text
    .toLowerCase()
    .replace(/(^|[\s(\-“"])(\p{L})(\p{L}*)/gu, (match, before, letter, rest, offset) =>
      offset > 0 && before === " " && SMALL_WORDS.has(letter + rest)
        ? match
        : before + letter.toUpperCase() + rest,
    );
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
