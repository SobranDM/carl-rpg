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

/**
 * A CONFIG list of definitions as select choices: key -> its `label`
 * (a lang key, for selectOptions' localize=true).
 * @param {Record<string, {label: string}>} defs
 * @returns {Record<string, string>}
 */
export function labelChoices(defs) {
  return Object.fromEntries(Object.entries(defs ?? {}).map(([key, def]) => [key, def.label]));
}

/**
 * `<option>`s for a dialog built in code, from key -> label (a lang key).
 * @param {Record<string, string>} choices
 * @returns {string}  HTML.
 */
export function optionsHtml(choices) {
  return Object.entries(choices).map(([key, label]) => `<option value="${esc(key)}">${esc(game.i18n.localize(label))}</option>`).join("");
}
