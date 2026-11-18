/**
 * Size read from text - a stat block's "Large (5)", a Race's "Medium (4)",
 * the old free-text Size - as a Table 9 value (p.92). No imports and no
 * Foundry globals, so the PDF parsers (module/pdf-import - also run under
 * Node by tools/pdf-import) can use it. module/helpers/size.mjs builds on it
 * (adding the localized size names).
 */

/** Table 9's values and their English names (CONFIG.CARLRPG.sizes' keys, 1-8). */
export const SIZE_NAMES = Object.freeze({
  1: "tiny",
  2: "small",
  3: "petite",
  4: "medium",
  5: "large",
  6: "huge",
  7: "colossal",
  8: "gargantuan",
});

/**
 * A size value from text: a number ("5"), a size name ("Large", "huge"), or
 * both ("Large (5)", "Medium (4), mostly due to wings"). null if it's
 * neither.
 * @param {string} text
 * @param {Record<string, string[]>} [moreNames]  Extra names per value (e.g. localized).
 * @returns {number|null}
 */
export function parseSizeText(text, moreNames = {}) {
  if (text === null || text === undefined || !String(text).trim()) return null;
  const s = String(text).trim();
  const number = s.match(/\d+/);
  if (number && SIZE_NAMES[Number(number[0])]) return Number(number[0]);
  const words = s.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const word of words) {
    for (const [value, name] of Object.entries(SIZE_NAMES)) {
      const names = [name, ...(moreNames[value] ?? []).map((n) => String(n).toLowerCase())];
      if (names.includes(word)) return Number(value);
    }
  }
  return null;
}
