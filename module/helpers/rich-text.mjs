/**
 * Building rich-text (HTML) notes out of plain lines - used to fold the
 * Character's old single-line slot lists into the Details tab's text boxes
 * (CarlRPGCharacter.migrateData) and by importers writing those boxes. In a
 * rich editor a new line is a paragraph, so each non-empty line becomes one
 * escaped <p>; a literal "\n" wouldn't show.
 */

/**
 * Localize with an English fallback - migrateData can run before i18n is
 * ready.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function label(key, fallback) {
  const text = game.i18n?.localize?.(key);
  return text && text !== key ? text : fallback;
}

/**
 * One <p> per non-empty line.
 * @param {Array<string|null|undefined>|string} lines  Lines, or one string split on new lines.
 * @returns {string}
 */
export function linesToHtml(lines) {
  const list = typeof lines === "string" ? lines.split(/\r?\n/) : (lines ?? []);
  return list
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .map((line) => `<p>${foundry.utils.escapeHTML(line)}</p>`)
    .join("");
}

/**
 * Headed sections: for each with text, a bold heading paragraph, then its
 * lines. Sections without text are left out.
 * @param {Array<{key: string, fallback: string, text: Array<string>|string}>} sections
 *   `key`/`fallback` name the heading (a lang key and its English).
 * @returns {string}
 */
export function headedSectionsToHtml(sections) {
  return sections.map(({ key, fallback, text }) => {
    const body = linesToHtml(text);
    return body ? `<p><strong>${foundry.utils.escapeHTML(label(key, fallback))}</strong></p>${body}` : "";
  }).join("");
}

/** The Story box's headings, in order (the old story.* fields). */
export const STORY_SECTIONS = [
  { field: "pastTrauma", key: "CARLRPG.Actor.PastTrauma", fallback: "Past Trauma" },
  { field: "looseEnds", key: "CARLRPG.Actor.LooseEnds", fallback: "Loose Ends" },
  { field: "regrets", key: "CARLRPG.Actor.Regrets", fallback: "Regrets" },
  { field: "notes", key: "CARLRPG.Actor.Notes", fallback: "Notes" },
];

/**
 * The Story box from its parts (the old story object, or an importer's).
 * @param {Object<string, string>} parts  pastTrauma / looseEnds / regrets / notes.
 * @returns {string}
 */
export function storyToHtml(parts) {
  return headedSectionsToHtml(STORY_SECTIONS.map((s) => ({ ...s, text: parts?.[s.field] ?? "" })));
}
