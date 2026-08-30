import CarlRPGItemBase from "./item-base.mjs";

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
    // exist beyond the book's 12.
    schema.classTypes = new fields.ArrayField(
      new fields.StringField({ required: true, blank: false }),
      { required: false, initial: [] }
    );

    schema.prerequisites = new fields.StringField({ required: false, blank: true, initial: "" });

    // Earth Classes are locked out to Alien Races and vice versa (p. 127-141).
    // Not enforced - just surfaced so a future selection UI can check it.
    schema.isEarthBased = new fields.BooleanField({ required: false, initial: false });

    return schema;
  }
}
