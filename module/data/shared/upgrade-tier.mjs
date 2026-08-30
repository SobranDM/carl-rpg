import { defineChangesField } from "./change-entry.mjs";

/**
 * One "on hit, the target gains Debuff X" entry on an Upgrade tier. This is
 * NOT a ChangeEntry - it never modifies the acting actor's own bonuses, and
 * it's never auto-applied. It only ever surfaces the "Apply to Target(s)"
 * button on the Attack chat card (module/chat/target-effects-card.mjs) once
 * its rank/crit gates pass; a person clicks the button to actually write the
 * Debuff onto the target(s), via the same logic as the Conditions tab's
 * manual add (module/helpers/conditions.mjs).
 *
 * Don't confuse this with ChangeEntry's own `conditions` field (roll-time
 * opt-in checkboxes gating whether a bonus applies) - completely different
 * concept despite the similar-sounding domain (see module/data/shared/
 * change-entry.mjs's docstring).
 *
 * @returns {Record<string, foundry.data.fields.DataField>}
 */
export function defineTargetEffectSchema() {
  const fields = foundry.data.fields;
  return {
    id: new fields.StringField({
      required: true, blank: false,
      initial: () => foundry.utils.randomID(),
    }),
    /** Key into CONFIG.CARLRPG.debuffs (module/helpers/config.mjs) - a closed enum, not free text. */
    debuffKey: new fields.StringField({ required: true, blank: true, initial: "" }),
    stacks: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 1, min: 1 }),
    /** Only surface/apply this effect when the triggering roll was a natural 20 (e.g. Iron Punch, Fear). */
    critOnly: new fields.BooleanField({ required: true, initial: false }),
    /** Optional display override; falls back to CONFIG.CARLRPG.debuffs[debuffKey].label. */
    label: new fields.StringField({ required: false, blank: true, initial: "" }),
  };
}

/**
 * @param {object} [options] Extra ArrayField options.
 * @returns {foundry.data.fields.ArrayField}
 */
export function defineTargetEffectsField(options = {}) {
  const fields = foundry.data.fields;
  return new fields.ArrayField(new fields.SchemaField(defineTargetEffectSchema()), {
    required: false,
    initial: [],
    ...options,
  });
}

/**
 * Shared schema for one Rank-gated "Upgrade" tier (Rank 5 / 10 / 15), used by
 * Skills, Spells, and Damage Effects - the three item types that follow the
 * book's "gains additional bonuses at Ranks 5, 10, and 15" pattern.
 *
 * @returns {Record<string, foundry.data.fields.DataField>}
 */
export function defineUpgradeTierSchema() {
  const fields = foundry.data.fields;
  const requiredInteger = { required: true, nullable: false, integer: true };
  return {
    id: new fields.StringField({
      required: true, blank: false,
      initial: () => foundry.utils.randomID(),
    }),
    rankThreshold: new fields.NumberField({
      required: true, nullable: false, integer: true, initial: 5,
      choices: [5, 10, 15],
    }),
    /** Free text shown on the sheet, e.g. "+1d4 base damage, and attacks targeting the back of a foe deal x2 damage." */
    description: new fields.StringField({ required: true, blank: true }),
    changes: defineChangesField(),
    targetEffects: defineTargetEffectsField(),
    /**
     * Heal-type Spells only (see CarlRPGRankedItemBase#healDice and
     * CarlDice.rollHeal). Once this tier is unlocked (rank >= rankThreshold)
     * it overrides the item's/lower tiers' heal formula - e.g. Heal Self
     * Rank 5 -> "1d6", Rank 10 -> "2d6". Blank means this tier doesn't
     * change the heal formula (it may still set healToFull/healMend).
     */
    healDice: new fields.StringField({ required: false, blank: true, initial: "" }),
    /**
     * This tier heals straight to the actor's hb.effectiveMax instead of
     * rolling healDice - not a dice roll at all (Heal Self Rank 15: "heal
     * to full"). rollHeal checks this before falling back to healDice.
     */
    healToFull: new fields.BooleanField({ required: true, initial: false }),
    /**
     * This tier additionally lets the caster remove one entry from the
     * target's system.conditions (Heal Self Rank 5/10: "mend a ... Debuff").
     * Deliberately not scoped to *which* condition beyond a free pick from
     * the target's current list - the rules text here is descriptive
     * flavor ("Minor Injury, Poison, or Disease" / "Major Injury or other
     * Debuff"), not a mechanically-enforceable taxonomy.
     */
    healMend: new fields.BooleanField({ required: true, initial: false }),
    /**
     * Attack-capable Skills/Spells/Damage Effects only (see docs/known-gaps.md
     * 1.3/1.7). Once this tier is unlocked, it overrides the item's own
     * baseDamage.damageType for every damage term that doesn't carry its own
     * ChangeEntry.damageType override (module/data/shared/change-entry.mjs) -
     * i.e. the item's "default" damage pool. One entry recolors the whole
     * pool to a different single type; two-or-more split the pool's final
     * total evenly across them (module/helpers/damage-pipeline.mjs's
     * splitDamageEvenly), e.g. Magic Missile Rank 10: "the missiles deal
     * Force and Fire damage" -> `["force", "fire"]`. Blank entries (the sheet
     * UI always renders two dropdowns) are filtered out at read time. Empty
     * array/all-blank means "no override, keep inheriting baseDamage.damageType."
     */
    damageTypes: new fields.ArrayField(
      new fields.StringField({
        required: false, blank: true, initial: "",
        choices: ["", ...Object.keys(CONFIG.CARLRPG.damageTypes)],
      }),
      { required: false, initial: [] }
    ),
    /**
     * Shield-style secondary-HP-pool tiers only (docs/known-gaps.md 1.4,
     * mirrors healDice's base-field-plus-tier-override shape). 0 (default)
     * means this tier doesn't change the granting item's shieldSlots
     * (CarlRPGRankedItemBase#shieldSlots) - the highest-rankThreshold
     * unlocked tier with a nonzero override wins (see module/helpers/
     * modifiers.mjs's computeActiveShieldSlots), falling back to the item's
     * own base shieldSlots if no unlocked tier overrides it.
     */
    shieldSlots: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
  };
}

/**
 * @param {object} [options] Extra ArrayField options.
 * @returns {foundry.data.fields.ArrayField}
 */
export function defineUpgradesField(options = {}) {
  const fields = foundry.data.fields;
  return new fields.ArrayField(new fields.SchemaField(defineUpgradeTierSchema()), {
    required: false,
    initial: [],
    ...options,
  });
}
