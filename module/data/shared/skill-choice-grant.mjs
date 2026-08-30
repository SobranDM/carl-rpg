/**
 * "+X in a [category] Skill of your choice" (common on both Race and Class
 * grants - roughly half of all authored entries). Unlike a ChangeEntry, this
 * has no fixed `target` at authoring time: the player picks a real Skill at
 * ownership time, and that pick gets materialized into a real ChangeEntry on
 * this same item (see module/sheets/item-sheet.mjs's resolveSkillChoice
 * action) - after which this entry is removed, since it's been "spent".
 */

/** @returns {Record<string, foundry.data.fields.DataField>} */
export function defineSkillChoiceGrantSchema() {
  const fields = foundry.data.fields;
  return {
    id: new fields.StringField({
      required: true, blank: false,
      initial: () => foundry.utils.randomID(),
    }),
    /** Free-text hint from the book, e.g. "crafting", "Weapon", "Reach Weapon". Not a closed category list. */
    category: new fields.StringField({ required: false, blank: true, initial: "" }),
    amount: new fields.NumberField({ required: true, integer: true, initial: 1, min: 1 }),
  };
}

/**
 * @param {object} [options] Extra ArrayField options (e.g. initial).
 * @returns {foundry.data.fields.ArrayField}
 */
export function defineSkillChoiceGrantsField(options = {}) {
  const fields = foundry.data.fields;
  return new fields.ArrayField(new fields.SchemaField(defineSkillChoiceGrantSchema()), {
    required: false,
    initial: [],
    ...options,
  });
}
