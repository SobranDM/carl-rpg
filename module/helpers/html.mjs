/**
 * HTML text helpers with no imports, for anything building markup.
 */

/**
 * Escape a value for HTML text - the one helper every card and dialog
 * builder uses (null and undefined become "").
 * @param {*} value
 * @returns {string}
 */
export function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}
