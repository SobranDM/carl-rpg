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
  await writeArrayField(document, path, [...current, template]);
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
  await writeArrayField(document, path, current.filter((_, i) => i !== index));
}

/**
 * Write an updated array back to the document through its TOP-LEVEL system
 * field as one whole-array update, not the raw (possibly deeper) `path`
 * itself. For a path that reaches INTO one array element and back OUT to a
 * nested array within it (e.g. "system.upgrades.0.damageTypes" - an
 * Upgrade tier's own damage-type-split list), a direct dotted-path
 * `document.update({[path]: ...})` can silently drop SIBLING elements of
 * the OUTER array (system.upgrades.1, .2, ...) instead of preserving them -
 * confirmed by deleting one entry from an Upgrade tier's own
 * changes/targetEffects/damageTypes list making every OTHER Upgrade tier
 * vanish entirely. Resolving to the top-level field ("upgrades"), cloning
 * its current full value, mutating the clone at the exact same relative
 * path, and submitting that whole top-level field in one update
 * sidesteps the risk regardless of the precise underlying merge behavior -
 * this is the exact same shape of update the already-reliable "add/delete
 * a whole Upgrade tier" action uses (`data-path="system.upgrades"`
 * directly). A path with no further nesting below the top-level field
 * (e.g. "system.conditions") behaves identically either way - this is a
 * strict superset fix, not a special case some paths need and others don't.
 * @param {Actor|Item} document
 * @param {string} path  A dotted path starting with "system."
 * @param {Array} updatedArray
 */
async function writeArrayField(document, path, updatedArray) {
  const match = /^system\.([^.]+)/.exec(path);
  if (!match) {
    // Every array-editor path in this codebase is system-scoped today;
    // fall back to the direct update rather than guessing at a different
    // top-level field to clone if that ever changes.
    await document.update({ [path]: updatedArray });
    return;
  }
  const [, topField] = match;
  const currentTopValue = foundry.utils.getProperty(document, `system.${topField}`);
  const clone = { [topField]: foundry.utils.deepClone(currentTopValue) };
  foundry.utils.setProperty(clone, path.slice('system.'.length), updatedArray);
  await document.update({ [`system.${topField}`]: clone[topField] });
}
