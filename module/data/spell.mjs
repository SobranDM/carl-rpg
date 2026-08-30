import CarlRPGRankedItemBase from "./ranked-item-base.mjs";

export default class CarlRPGSpell extends CarlRPGRankedItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.manaCost = new fields.NumberField({ ...requiredInteger, initial: 1, min: 0 });
    schema.range = new fields.StringField({ required: false, blank: true, initial: "" });
    schema.duration = new fields.StringField({ required: false, blank: true, initial: "" });
    schema.cooldown = new fields.StringField({ required: false, blank: true, initial: "" });

    schema.castingKeywords = new fields.ArrayField(
      new fields.StringField({
        required: true, blank: false,
        choices: ["attack", "passive", "interrupt", "areaOfEffect", "mindControl", "heal"],
      }),
      { required: false, initial: [] }
    );

    // Classes that DON'T pay the +1 Mana surcharge for casting this Spell.
    schema.favoredClasses = new fields.ArrayField(
      new fields.StringField({ required: true, blank: false }),
      { required: false, initial: [] }
    );

    // Alternate Mana-cost/damage tradeoffs, e.g. Magic Missile's
    // "3 Mana: -4 damage / 4 Mana: -2 damage / 6 Mana: Add 1 Rank damage die".
    schema.manaCostVariants = new fields.ArrayField(
      new fields.SchemaField({
        manaCost: new fields.NumberField({ ...requiredInteger, initial: 1, min: 0 }),
        description: new fields.StringField({ required: true, blank: true }),
      }),
      { required: false, initial: [] }
    );

    // Spell damage defaults to magical, overriding ranked-item-base's
    // mundane-by-default (docs/known-gaps.md 1.4) - a Skill/Damage Effect
    // (weapon strikes) still defaults false from the parent schema.
    schema.isMagicDamage = new fields.BooleanField({ required: true, initial: true });

    // Ongoing/toggled spell effects (docs/known-gaps.md 1.4) - e.g. Shield,
    // Bang Bro: cast once to start a timed effect, rather than a one-shot
    // roll. isToggled is content-authored (true only for spells that work this
    // way); active is player/GM-toggled runtime state, off by default. No
    // in-game timer is modeled - a person turns it off manually when the
    // fiction says the duration elapsed (see CarlDice.rollToggleSpell).
    schema.isToggled = new fields.BooleanField({ required: true, initial: false });
    schema.active = new fields.BooleanField({ required: true, initial: false });

    return schema;
  }
}
