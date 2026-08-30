import CarlRPGRankedItemBase from "./ranked-item-base.mjs";

/**
 * Hand-to-Hand Damage Effect (Skills, Spells & Gear, p. ~180): a special
 * Passive Skill selected at the moment of making a hand-to-hand Attack that
 * modifies a parent Attack Skill's outcome. Many-to-one: e.g. Powerful
 * Strike attaches to Foot Soldier, Noggin Nocker, OR Pugilism.
 *
 * "When you make an Attack that adds a Damage Effect, place a mark for later
 * Skill Advancement in either the Attack Skill or the Damage Effect, not
 * both" - that selection-and-marking logic lives in the attack-roll flow,
 * not here.
 */
export default class CarlRPGDamageEffect extends CarlRPGRankedItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // Names (or UUIDs) of the Attack Skills this Damage Effect can attach to.
    schema.parentSkills = new fields.ArrayField(
      new fields.StringField({ required: true, blank: false }),
      { required: false, initial: [] }
    );

    schema.cooldown = new fields.StringField({ required: false, blank: true, initial: "" });

    return schema;
  }
}
