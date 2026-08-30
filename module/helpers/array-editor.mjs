/**
 * Generic add/delete handlers for editable array-of-object fields in sheets
 * (ChangeEntry lists, Upgrade tiers, condition checklists, string lists like
 * Damage Effect parentSkills or Spell favoredClasses...). One pair of
 * handlers covers all of them since they all just operate on a dotted path
 * to an array on the document - see templates/item/parts/changes-editor.hbs
 * and ranked-fields.hbs for the data-action="addArrayItem"/"deleteArrayItem"
 * markup convention (data-path, and data-index for delete).
 */

/**
 * @param {PointerEvent} event
 * @param {HTMLElement} target
 * @param {Actor|Item} document
 */
export async function onAddArrayItem(event, target, document) {
  event.preventDefault();
  const path = target.dataset.path;
  if (!path) return;
  let template = {};
  try {
    template = JSON.parse(target.dataset.template ?? '{}');
  } catch (e) {
    template = {};
  }
  const current = foundry.utils.getProperty(document, path) ?? [];
  await document.update({ [path]: [...current, template] });
}

/**
 * @param {PointerEvent} event
 * @param {HTMLElement} target
 * @param {Actor|Item} document
 */
export async function onDeleteArrayItem(event, target, document) {
  event.preventDefault();
  const path = target.dataset.path;
  const index = Number(target.dataset.index);
  if (!path || !Number.isInteger(index)) return;
  const current = foundry.utils.getProperty(document, path) ?? [];
  await document.update({ [path]: current.filter((_, i) => i !== index) });
}
