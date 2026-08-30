import CarlRPGRankedItemBase from "./ranked-item-base.mjs";

/**
 * Unified Skill type covering both combat (Attack) and non-combat
 * (Utility/Passive) Skills. Attack-specific fields stay blank/unused for
 * non-combat Skills rather than splitting into a separate Item type -
 * Attack Skills like Dagger or Pugilism are structurally just Skills with an
 * extra Base Damage line (Skills, Spells & Gear, p. 173).
 */
export default class CarlRPGSkill extends CarlRPGRankedItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.category = new fields.StringField({
      required: true, blank: false, initial: "utility",
      choices: ["attack", "utility", "passive"],
    });

    schema.isAttack = new fields.BooleanField({ required: true, initial: false });
    schema.attackType = new fields.StringField({
      required: false, blank: true, initial: "",
      choices: ["", "melee", "ranged"],
    });
    schema.range = new fields.StringField({ required: false, blank: true, initial: "" });

    // Only relevant to low-damage weapons that grant AI Favor when not maximized.
    schema.aiFavor = new fields.NumberField({ ...requiredInteger, required: false, initial: 0, min: 0 });

    schema.cooldown = new fields.StringField({ required: false, blank: true, initial: "" });
    schema.limitations = new fields.StringField({ required: false, blank: true, initial: "" });

    // Persisted sheet UI state: is this Skill's nested Damage Effects drawer
    // open on the merged Abilities tab? Collapsed by default since there can
    // be many Skill rows. See module/helpers/drawer-toggle.mjs.
    schema.damageEffectsExpanded = new fields.BooleanField({ required: true, initial: false });

    // Persisted sheet UI state: is this Skill's read-only description/
    // upgrades detail drawer open (toggled by clicking the Skill's name)?
    schema.detailsExpanded = new fields.BooleanField({ required: true, initial: false });

    return schema;
  }
}
