import CarlRPGItemBase from "./item-base.mjs";
import { defineUpgradesField } from "./shared/upgrade-tier.mjs";

/**
 * Shared base for the three Rank-progression Item types: Skill, Spell, and
 * Damage Effect. All three follow the book's "gains additional bonuses at
 * Ranks 5, 10, and 15" pattern (Skill Upgrades, p. 173-174).
 */
export default class CarlRPGRankedItemBase extends CarlRPGItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.governingStat = new fields.StringField({ required: false, blank: true, initial: "" });

    schema.rank = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0, max: 20 });

    // The Skill Advancement mark checkbox (Crawler Advancement, p. 169).
    schema.marked = new fields.BooleanField({ required: true, initial: false });

    schema.isPassive = new fields.BooleanField({ required: true, initial: false });

    schema.advancementGate = new fields.StringField({
      required: true, blank: false, initial: "normal",
      choices: ["normal", "passive-until-5", "magic-only"],
    });

    // Optional: only meaningful for attack-capable entries.
    schema.baseDamage = new fields.SchemaField({
      dice: new fields.StringField({ required: false, blank: true, initial: "" }),
      stat: new fields.StringField({ required: false, blank: true, initial: "" }),
      damageType: new fields.StringField({ required: false, blank: true, initial: "" }),
    });

    // Optional: only meaningful for Heal-type Spells (castingKeywords
    // includes "heal", see CarlDice.rollHeal in module/dice/dice.mjs). Base-
    // tier healing formula (e.g. Heal Self's "1d4"); Rank 5/10/15 Upgrade
    // tiers can override it via their own healDice/healToFull (see
    // module/data/shared/upgrade-tier.mjs).
    schema.healDice = new fields.StringField({ required: false, blank: true, initial: "" });

    // Whether this item's damage counts as magical (docs/known-gaps.md 1.4) -
    // e.g. gates whether a Shield-style ward reduces it, or a future gear DR
    // that only applies to non-magical hits. Skills/Damage Effects (mundane
    // weapons/strikes) default false; Spell overrides this default to true
    // (see spell.mjs) since spell damage is magical by default.
    schema.isMagicDamage = new fields.BooleanField({ required: true, initial: false });

    // Base Shield-style secondary-HP-pool slot count (docs/known-gaps.md 1.4) -
    // 0 means "this item doesn't grant a shield pool" (the vast majority of
    // items). Rank-gated overrides live on the Upgrade tier (see
    // module/data/shared/upgrade-tier.mjs), mirroring healDice's own
    // base-field-plus-tier-override shape. A future phase (not this one) reads
    // this to size an actor's actual shield pool while the granting spell is
    // toggled active.
    schema.shieldSlots = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });

    schema.upgrades = defineUpgradesField();

    return schema;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
  }

  /**
   * Upgrade tiers currently unlocked at this item's Rank.
   * @returns {object[]}
   */
  get unlockedUpgrades() {
    return this.upgrades.filter(u => this.rank >= u.rankThreshold);
  }
}
