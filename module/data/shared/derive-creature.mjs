import { getStatMod } from "../../helpers/rules.mjs";
import { computeActiveShieldSlots } from "../../helpers/modifiers.mjs";

/**
 * The stat block and derived values every creature Actor shares - Characters
 * (character.mjs), Mobs (mob.mjs) and Pets (pet.mjs). Each type calls these
 * in its own prepareDerivedData, around its own type-specific steps (a Mob
 * sets hb.max from its Level before deriveResourceCaps, for instance), after
 * aggregateActorBonuses (module/helpers/modifiers.mjs) has filled
 * this.bonuses / this.caps / this.grantedResistances.
 */

/**
 * The five Stats. `value` is the GM/player-editable base and is NEVER
 * touched by the modifier engine; `bonus`/`effective`/`mod` are derived-only
 * every pass (mod comes from effective = value + bonus, not value alone), or
 * bonuses would silently compound on every save.
 * @param {number|Record<string, number>} initial  A starting value for every
 *   Stat, or one per Stat key.
 * @returns {foundry.data.fields.SchemaField}
 */
export function defineStatsField(initial) {
  const fields = foundry.data.fields;
  const requiredInteger = { required: true, nullable: false, integer: true };
  const stats = {};
  for (const key of Object.keys(CONFIG.CARLRPG.stats)) {
    const start = typeof initial === "number" ? initial : (initial?.[key] ?? 1);
    stats[key] = new fields.SchemaField({
      value: new fields.NumberField({ ...requiredInteger, initial: start, min: 1 }),
      bonus: new fields.NumberField({ ...requiredInteger, initial: 0 }),
      effective: new fields.NumberField({ ...requiredInteger, initial: start }),
      mod: new fields.NumberField({ ...requiredInteger, initial: 0 }),
      label: new fields.StringField({ required: true, blank: true }),
    });
  }
  return new fields.SchemaField(stats);
}

/**
 * Each Stat's bonus (from the modifier engine), effective value (capped by
 * any capMax ChangeEntry) and Mod.
 * @param {object} sys  The Actor's system data.
 */
export function deriveStats(sys) {
  for (const key in sys.stats) {
    const stat = sys.stats[key];
    if (!stat) continue;
    const bonus = sys.bonuses?.[`stats.${key}`] ?? 0;
    const cap = sys.caps?.[`stats.${key}`];
    const effective = cap !== undefined ? Math.min(stat.value + bonus, cap) : stat.value + bonus;
    stat.bonus = bonus;
    stat.effective = effective;
    stat.mod = getStatMod(effective);
    stat.label = game.i18n.localize(CONFIG.CARLRPG.stats[key]) ?? key;
  }
}

/**
 * DR and Resistances. `dr` and `resistances` stay the flat editable bases;
 * drBonus/drEffective come from "resource" ChangeEntries targeting "dr"
 * (with an optional capMax), and a "resistance" ChangeEntry (e.g. a Race's
 * "Immunity to Poison") overrides the base for its own type only, in
 * resistancesEffective - read by module/helpers/damage-pipeline.mjs. Removing
 * the granting item reverts to the base.
 * @param {object} sys
 */
export function deriveDefenses(sys) {
  sys.drBonus = sys.bonuses?.dr ?? 0;
  sys.drEffective = sys.caps?.dr !== undefined
    ? Math.min(sys.dr + sys.drBonus, sys.caps.dr)
    : sys.dr + sys.drBonus;
  sys.resistancesEffective = { ...sys.resistances, ...sys.grantedResistances };
}

/**
 * HB slot value and effective max, Max Mana and the Shield pool. Runs after
 * the type has set hb.max.
 *  - HB: each slot holds the (effective) CON Mod; effective max = base max +
 *    any "hb.max" resource bonus.
 *  - Mana: "You gain Mana Points equal to your Enhanced Intelligence Stat.
 *    Not the Stat Mod this time, but the actual value." (p.110) - the
 *    effective value, so a live INT bonus from gear isn't dropped.
 *  - Shield (docs/known-gaps.md 1.4): fully derived from whichever owned
 *    toggled spell is active; the clamp shrinks it if that spell is turned
 *    off or loses Rank.
 * @param {object} sys
 */
export function deriveResourceCaps(sys) {
  sys.hb.slotValue = sys.stats.con?.mod ?? 0;
  sys.hb.bonusMax = sys.bonuses?.["hb.max"] ?? 0;
  sys.hb.effectiveMax = sys.hb.max + sys.hb.bonusMax;
  sys.mana.max = (sys.stats.int?.effective ?? 0) + (sys.bonuses?.["mana.max"] ?? 0);

  sys.shield.slotValue = sys.stats.con?.mod ?? 0;
  sys.shield.effectiveMax = computeActiveShieldSlots(sys.parent?.items ? Array.from(sys.parent.items) : []);
  if (sys.shield.value > sys.shield.effectiveMax) sys.shield.value = sys.shield.effectiveMax;
}

/**
 * Roll data: @stats.*, @skills.*, @lvl and @floor. Floor is one world-wide
 * value owned by the GM Toolbox - never stored per-actor.
 * @param {object} sys
 * @param {number} lvl
 * @returns {object}
 */
export function creatureRollData(sys, lvl) {
  const data = {};
  if (sys.stats) {
    data.stats = {};
    for (const [k, v] of Object.entries(sys.stats)) data.stats[k] = foundry.utils.deepClone(v);
  }
  if (sys.skills) data.skills = foundry.utils.deepClone(sys.skills);
  data.lvl = lvl;
  data.floor = game.settings.get("carl-rpg", "currentFloor");
  return data;
}
