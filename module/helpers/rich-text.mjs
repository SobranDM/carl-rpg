import { esc } from "./html.mjs";
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

/**
 * A document's rich text as its own sheet shows it: links and inline rolls
 * drawn relative to it, with its roll data (an item's includes its actor's -
 * documents/item.mjs getRollData), GM Secret blocks only for its owner.
 * An item's description is enriched against the item wherever it shows
 * (ruled 2026-11-19).
 * @param {string} html
 * @param {foundry.abstract.Document} doc
 * @param {{rollData?: object, secrets?: boolean}} [options]  rollData: already
 *   worked out; secrets: whether GM Secret blocks show (default: to its owner).
 * @returns {Promise<string>}
 */
export function enrichDescription(html, doc, { rollData, secrets } = {}) {
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(html ?? "", {
    relativeTo: doc, secrets: secrets ?? !!doc?.isOwner, rollData: rollData ?? doc?.getRollData?.() ?? {},
  });
}

/**
 * Each item's description as tooltip HTML, by item id - plain HTML as it
 * is; one with links, inline rolls or GM Secrets enriched first
 * (enrichDescription). An item without one isn't listed.
 * @param {Iterable<Item>} items
 * @returns {Promise<Record<string, string>>}
 */
export async function itemDescriptions(items) {
  const out = {};
  await Promise.all([...items].map(async (item) => {
    const html = String(item.system?.description ?? "").trim();
    if (!html) return;
    out[item.id] = /@|\[\[|secret/.test(html) ? await enrichDescription(html, item) : html;
  }));
  return out;
}

/** An item's name as a tooltip's heading. */
function tooltipName(item) {
  return `<strong class="carl-tooltip-name">${esc(item.name)}</strong>`;
}

/**
 * The tooltip shown on hovering an item in a list (the `itemTooltip`
 * Handlebars helper; ruled 2026-11-19): its description - or, for an item
 * without one, its name.
 * @param {Iterable<Item>} items
 * @param {Record<string, string>} descriptions  itemDescriptions' result.
 * @returns {Record<string, string>}  HTML by item id.
 */
export function itemTooltips(items, descriptions) {
  return Object.fromEntries([...items].map((item) => [item.id, descriptions[item.id] ?? tooltipName(item)]));
}

/**
 * The tooltip on the Equipment Doll and the Hotlist, where a name can be
 * cut short (ruled 2026-11-19): the name above the description, or the
 * name alone.
 * @param {Iterable<Item>} items
 * @param {Record<string, string>} descriptions  itemDescriptions' result.
 * @returns {Record<string, string>}  HTML by item id.
 */
export function namedItemTooltips(items, descriptions) {
  return Object.fromEntries([...items].map((item) => [item.id, tooltipName(item) + (descriptions[item.id] ?? "")]));
}
