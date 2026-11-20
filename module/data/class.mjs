import CarlRPGItemBase from "./item-base.mjs";
import { defineSkillChoiceGrantsField } from "./shared/skill-choice-grant.mjs";

/**
 * Class (Race & Class Selection, p. ~127-158): a flat, one-time, permanent
 * grant chosen (alongside a Race) starting at the Third Floor milestone.
 * Unlike Skills/Spells/Damage Effects, a Class has no Rank progression or
 * Upgrade tiers - its `changes` (inherited from CarlRPGItemBase) are simply
 * always active while the Class item is owned.
 */
export default class CarlRPGClass extends CarlRPGItemBase {
  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // Categorical tags (e.g. "Barbarian", "Fighter") - a Class can carry
    // more than one. Free text, not a closed enum: new categories could
    // exist beyond the book's 12. Blank entries are allowed in the source
    // (the sheet's Add makes an empty row) and dropped from the prepared
    // list (prepareBaseData).
    schema.classTypes = new fields.ArrayField(
      new fields.StringField({ required: true, blank: true }),
      { required: false, initial: [] },
    );

    schema.prerequisites = new fields.StringField({ required: false, blank: true, initial: "" });

    // Earth Classes are locked out to Alien Races and vice versa (p. 127-141).
    // Not enforced - just surfaced so a future selection UI can check it.
    schema.isEarthBased = new fields.BooleanField({ required: false, initial: false });

    // "+X in a [category] Skill of your choice" - see shared/skill-choice-grant.mjs.
    schema.skillChoiceGrants = defineSkillChoiceGrantsField();

    return schema;
  }

  /** A blank Class Type row (see the schema) is no category. */
  prepareBaseData() {
    super.prepareBaseData();
    this.classTypes = (this.classTypes ?? []).filter((name) => name);
  }
}
