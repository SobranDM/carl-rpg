/**
 * A sheet's form submits arrays as objects keyed by index, holding only the
 * fields it has inputs for ("system.upgrades.0.changes.1.value"), and Foundry
 * replaces an array outright on update - so every field of an entry without
 * an input would be dropped on any edit (an Upgrade tier's Shield slots, a
 * Bonus condition's id). This merges what was submitted onto the stored
 * value, recursively, before the update:
 *  - an array submitted as an index-keyed object: each submitted entry
 *    merged onto the stored one at that index; entries not submitted (a
 *    part the sheet doesn't draw) kept as stored;
 *  - an array submitted as a real array (a multi-select): replaced, as
 *    that's the whole list;
 *  - an object: each submitted key merged the same way;
 *  - anything else: the submitted value.
 * Adding and removing entries goes through module/helpers/array-editor.mjs
 * (a whole-array write), not the form, so an index here always means the
 * same entry as the stored one.
 */

const isPlainObject = (value) => foundry.utils.getType(value) === "Object";

/**
 * @param {*} stored     The stored value (source data).
 * @param {*} submitted  The value the form submitted for it.
 * @param {boolean} [whole]  Inside an array: the result replaces the stored
 *   value outright, so an object keeps its stored fields the form didn't
 *   submit. Outside one, an object is an update diff and needn't.
 * @returns {*}  What to update with.
 */
export function mergeSubmitted(stored, submitted, whole = false) {
  if (Array.isArray(stored) && isPlainObject(submitted)) {
    const merged = stored.map((entry, i) => (i in submitted ? mergeSubmitted(entry, submitted[i], true) : entry));
    for (const [key, value] of Object.entries(submitted)) {
      const i = Number(key);
      if (Number.isInteger(i) && i >= stored.length) merged[i] = value;
    }
    return merged;
  }
  if (isPlainObject(stored) && isPlainObject(submitted)) {
    const out = whole ? foundry.utils.deepClone(stored) : {};
    for (const [key, value] of Object.entries(submitted)) {
      out[key] = key in stored ? mergeSubmitted(stored[key], value, whole) : value;
    }
    return out;
  }
  return submitted;
}

/**
 * A cleared number input submits null (FormDataExtended), and a number field
 * that can't be null cleans that to its initial value - a blank Level saved
 * as 1, so typing the real Level back counted as a level-up. Such a null is
 * dropped from the submission instead, keeping the stored value, and the
 * input shows that value again. Any number typed (1 included) still saves;
 * a nullable field (an HB slot override) still takes the null.
 * @param {object} flat  The form's flat data (formData.object), changed in place.
 * @param {foundry.abstract.DataModel} system  The document's system model.
 * @param {HTMLFormElement} [form]
 */
export function keepStoredForBlankNumbers(flat, system, form) {
  const schema = system?.schema;
  if (!schema || !flat) return;
  const source = system._source;
  for (const [key, value] of Object.entries(flat)) {
    if (value !== null || !key.startsWith("system.")) continue;
    const path = key.slice("system.".length);
    const field = schema.getField(path, { source });
    if (!(field instanceof foundry.data.fields.NumberField) || field.nullable) continue;
    delete flat[key];
    const stored = foundry.utils.getProperty(source, path);
    const input = form?.elements?.namedItem?.(key);
    if (input instanceof HTMLInputElement && Number.isFinite(stored)) input.value = String(stored);
  }
}

/**
 * A sheet's submitted `system` data merged onto what's stored
 * (mergeSubmitted), so a form that only shows some fields of an entry
 * doesn't wipe the rest. Every sheet's _processFormData uses it.
 * @param {foundry.abstract.DataModel} system  The document's system.
 * @param {object} submitted  The expanded `system` part of the submission.
 * @param {{objectArraysOnly?: boolean}} [options]  objectArraysOnly: merge
 *   only top-level arrays of objects (an actor's Conditions, Sponsors...),
 *   leaving everything else - an array of plain values (the Hotlist's text
 *   slots) - as Foundry submits it. Otherwise the whole tree is merged
 *   (an item's Upgrade tiers, Bonuses...).
 * @returns {object}  The data to save.
 */
export function mergeSystemSubmit(system, submitted, { objectArraysOnly = false } = {}) {
  if (!isPlainObject(submitted)) return submitted;
  const source = system.toObject();
  if (!objectArraysOnly) return mergeSubmitted(source, submitted);
  for (const [key, value] of Object.entries(submitted)) {
    const current = source[key];
    if (!Array.isArray(current) || !isPlainObject(value)) continue;
    if (!current.some((entry) => entry && typeof entry === "object")) continue;
    submitted[key] = mergeSubmitted(current, value);
  }
  return submitted;
}
