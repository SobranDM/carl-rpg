/**
 * Shared schema for a single structured modifier ("ChangeEntry").
 *
 * This is the homebrew replacement for Foundry's ActiveEffect changes: any
 * item (gear, feature, skill/spell/damage-effect upgrade tier) can carry an
 * array of these to modify ANY target, including arbitrary/homebrew skill
 * names with no master list. `target` is resolved dynamically at aggregation
 * time (see module/helpers/modifiers.mjs) the same way Roll.replaceFormulaData
 * resolves `@`-paths via foundry.utils.getProperty - no schema field needs to
 * exist for `target` ahead of time.
 *
 * `mode` mirrors the type enum used by ActiveEffect/DataField#applyChange in
 * Foundry v14 core (add/subtract/multiply/override/upgrade/downgrade), since
 * the aggregation engine reuses that apply logic directly rather than
 * reimplementing it.
 *
 * `conditions` are never auto-evaluated. Each is a roll-time checkbox the
 * player/GM ticks based on the fiction (e.g. "Attacking from behind?"); a
 * change with unchecked conditions simply doesn't apply to that roll.
 */

/** @returns {Record<string, foundry.data.fields.DataField>} */
export function defineChangeEntrySchema() {
  const fields = foundry.data.fields;
  return {
    id: new fields.StringField({
      required: true, blank: false,
      initial: () => foundry.utils.randomID(),
    }),
    /** Optional display label for this change; falls back to the owning item's name in tooltips. */
    label: new fields.StringField({ required: false, blank: true }),
    targetType: new fields.StringField({
      required: true, blank: false, initial: "skillDamage",
      choices: ["stat", "skillRank", "skillDamage", "resource", "rollMode", "custom", "resistance", "advancementBonus"],
    }),
    /** Dotted path or arbitrary skill/resource name. Resolved dynamically - no master list required. */
    target: new fields.StringField({ required: true, blank: true }),
    mode: new fields.StringField({
      required: true, blank: false, initial: "add",
      choices: ["add", "subtract", "multiply", "override", "upgrade", "downgrade"],
    }),
    /** Formula string; may include dice notation and @-refs (e.g. "1d4", "2", "@rank"). For targetType "resistance", one of "resist"|"vulnerable"|"immune" instead of a number. */
    value: new fields.StringField({ required: true, blank: true, initial: "0" }),
    /**
     * Only meaningful when targetType is "stat" or "resource" (e.g. target
     * "dr"). An optional ceiling on the EFFECTIVE value (base + all bonuses),
     * applied after aggregation - e.g. Hobgoblin's "-5 Charisma. Charisma is
     * capped at 10". Blank means no cap. When multiple sources cap the same
     * target, the most restrictive (lowest) cap wins.
     */
    capMax: new fields.StringField({ required: false, blank: true, initial: "" }),
    /**
     * Only meaningful for a "stat"/"skillRank"/"resource" change granted by a
     * Race/Class item. When set (> 0), this change only takes effect once
     * the owning actor's Character Level reaches this value - e.g. Bune's
     * "At Level 50, +2 Dexterity". 0 (the default) means always active.
     */
    levelGate: new fields.NumberField({ required: false, integer: true, initial: 0, min: 0 }),
    /**
     * Only meaningful when targetType is "skillDamage". Author-declared (not
     * inferred from the formula) because Critical Hit only doubles "base"
     * damage dice - Table 37 Rank Damage Dice ("rankDie") are explicitly
     * excluded from doubling per the rules, and flat/multiplier terms never
     * double either way.
     *   base       - "+1d4 base damage" style Upgrade text; doubles on crit.
     *   rankDie    - references the Table 37 Rank->die lookup; never doubles.
     *   flat       - a flat numeric add (not dice); never doubles.
     *   multiplier - a post-roll multiplier (e.g. "x2 damage"); never doubles.
     */
    damageDiceKind: new fields.StringField({
      required: false, blank: true, initial: "",
      choices: ["", "base", "rankDie", "flat", "multiplier"],
    }),
    /**
     * Only meaningful when targetType is "skillDamage" (see
     * docs/known-gaps.md 1.7). An explicit damage-type override for THIS
     * term, e.g. Fire Fingers Rank 15 granting Pugilism a Rank damage die
     * that stays Fire even though Pugilism's own baseDamage.damageType is
     * Bludgeoning. Blank (the common case) means "inherit whichever item's
     * damage this term lands on - its own baseDamage.damageType", resolved
     * by module/dice/dice.mjs's buildDamageRollParts, not here - this field
     * only ever carries the author's override, never a resolved value.
     */
    damageType: new fields.StringField({
      required: false, blank: true, initial: "",
      choices: ["", ...Object.keys(CONFIG.CARLRPG.damageTypes)],
    }),
    conditions: new fields.ArrayField(
      new fields.SchemaField({
        id: new fields.StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
        label: new fields.StringField({ required: true, blank: true }),
        default: new fields.BooleanField({ required: false, initial: false }),
      }),
      { required: false, initial: [] }
    ),
  };
}

/**
 * @param {object} [options] Extra ArrayField options (e.g. initial).
 * @returns {foundry.data.fields.ArrayField}
 */
export function defineChangesField(options = {}) {
  const fields = foundry.data.fields;
  return new fields.ArrayField(new fields.SchemaField(defineChangeEntrySchema()), {
    required: false,
    initial: [],
    ...options,
  });
}
