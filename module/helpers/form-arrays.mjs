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
