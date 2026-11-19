import CarlRPGItemBase from "./item-base.mjs";
import { defineTargetEffectsField, defineUpgradesField } from "./shared/upgrade-tier.mjs";
import { currentFloor } from "../helpers/floor.mjs";

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

    // Separate from governingStat (which governs this item's OWN roll bonus):
    // the Stat an Opposed Skill Check's Difficulty is computed against on the
    // OTHER side of the check (e.g. Taunt is Charisma-governed, but its
    // Difficulty is "10 + the target Mob's INT Mod + Floor" - see
    // docs/taunt-and-nat20-advantage-prompt.md). Blank = "not an Opposed
    // Skill Check" (the vast majority of Skills/Spells/Damage Effects -
    // Attack Skills use rollAttack's own DEX-vs-Evade convention instead of
    // this field). Built generic rather than Taunt-specific, matching this
    // project's precedent of standalone reusable infrastructure (see
    // resolveActingActor in module/helpers/token-resolution.mjs).
    schema.opposedStat = new fields.StringField({ required: false, blank: true, initial: "" });

    schema.rank = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0, max: 20 });

    // The Skill Advancement mark checkbox (Crawler Advancement, p. 169).
    schema.marked = new fields.BooleanField({ required: true, initial: false });

    schema.isPassive = new fields.BooleanField({ required: true, initial: false });

    schema.advancementGate = new fields.StringField({
      required: true, blank: false, initial: "normal",
      choices: () => Object.keys(CONFIG.CARLRPG.advancementGates),
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

    // Who a heal can take (module/helpers/heal-targets.mjs): "self" (Heal
    // Self, Heal), "others" - not yourself, pets or minions (Heal Others),
    // "pets" - pets and minions only (Heal Critter), "anyone". Blank: by
    // Range - "Self only" is "self", anything else "anyone".
    schema.heals = new fields.StringField({
      required: true, blank: true, initial: "",
      choices: () => Object.keys(CONFIG.CARLRPG.healsChoices),
    });
    // The heal restores the target's whole Health Bar at any Rank, with no
    // dice (Heal Critter: "heal back to 100% Health Bar"). HB only - unlike
    // an Upgrade tier's healToFull, which also grants a Short Rest's
    // benefits (Heal Self Rank 15).
    schema.healToFull = new fields.BooleanField({ required: true, initial: false });

    // The Attack's damage is Armor-Piercing at any Rank: it ignores DR,
    // except DR from gear marked Anti-Piercing (p.95, p.225). An Upgrade
    // tier can make it so from its Rank (upgrade-tier.mjs).
    schema.armorPiercing = new fields.BooleanField({ required: true, initial: false });

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
    // base-field-plus-tier-override shape. Sizes the actor's shield pool while
    // the granting Spell is toggled active (modifiers.mjs's
    // computeActiveShieldSlots).
    schema.shieldSlots = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });

    schema.upgrades = defineUpgradesField();

    // On-hit Debuffs at any Rank (docs/skill-item-sheets.md): the base tier
    // the Rank 5/10/15 Upgrades build on - "on a hit, the target gains X",
    // with the same Critical Hit only / Amazing Success only flags.
    schema.targetEffects = defineTargetEffectsField();

    return schema;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    // "Pets don't have trackable Skill Ranks. Instead, their Ranks in their
    // Attacks, Spells, and abilities ... are equal to the Floor Number (even
    // at Level 1!)" (p.231). Set here, at prepare time, so every reader of
    // system.rank agrees (upgrade gating, damage and heal tiers, the sheet)
    // and nothing is written: the stored Rank stays the item's own when it's
    // dragged to a crawler. Floor 0 counts as Rank 1, so Spells still cast.
    // A Floor change re-prepares every actor and its items (carl-rpg.mjs).
    this.rankIsFloor = this.parent?.actor?.type === "pet";
    if (this.rankIsFloor) {
      const floor = currentFloor();
      this.rank = Math.min(Math.max(1, floor), 20);
    }
  }

  /**
   * Upgrade tiers currently unlocked at this item's Rank.
   * @returns {object[]}
   */
  get unlockedUpgrades() {
    return this.upgrades.filter(u => this.rank >= u.rankThreshold);
  }
}
