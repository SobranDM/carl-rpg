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
      required: true,
      blank: false,
      initial: "utility",
      choices: () => Object.keys(CONFIG.CARLRPG.skillCategories),
    });

    schema.attackType = new fields.StringField({
      required: false,
      blank: true,
      initial: "",
      choices: () => ["", ...Object.keys(CONFIG.CARLRPG.attackTypes)],
    });
    schema.range = new fields.StringField({ required: false, blank: true, initial: "" });

    // A hand-to-hand Combat Skill (p.179: Foot Soldier, Noggin Nocker,
    // Pugilism, Unarmed Combat, Wrasslin' - or a homebrew one). Unarmed
    // Combat leaves the Combat tab's Attacks once one of these outranks it
    // (module/helpers/hand-to-hand.mjs).
    schema.isHandToHand = new fields.BooleanField({ required: true, initial: false });

    // What a Skill does, set on the Skill itself - never read from its name,
    // so a GM's homebrew Skill works the same way as the book's:
    //  - noWeapon: an Attack that needs no weapon besides hand-to-hand ones
    //    (Improvised Weapons, p.178; Bite, Back Claw, Slice Attack -
    //    module/helpers/weapons.mjs needsWeapon);
    //  - noDamageEffects: an Attack that "Cannot choose a Damage Effect"
    //    (Unarmed Combat, p.179 - module/helpers/hand-to-hand.mjs);
    //  - commandsPets: the Skill Command Pet rolls (Animal Handling, p.232 -
    //    module/helpers/pet-command.mjs).
    schema.noWeapon = new fields.BooleanField({ required: true, initial: false });
    schema.noDamageEffects = new fields.BooleanField({ required: true, initial: false });
    schema.commandsPets = new fields.BooleanField({ required: true, initial: false });

    // A mounted-only weapon (Lance, p.182): a vehicle's driver attacks with
    // it without the driving Disadvantage ("unless it's to ... use
    // mounted-only weapons (like a lance)", p.72 - module/helpers/
    // vehicle-rows.mjs). Not enforced: nothing stops using it unmounted.
    schema.mounted = new fields.BooleanField({ required: true, initial: false });

    // Only relevant to low-damage weapons that grant AI Favor when not maximized.
    schema.aiFavor = new fields.NumberField({
      ...requiredInteger,
      required: false,
      initial: 0,
      min: 0,
    });

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
