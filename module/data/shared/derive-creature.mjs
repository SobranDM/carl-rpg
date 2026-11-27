import { getStatMod } from "../../helpers/rules.mjs";
import { computeActiveShieldSlots } from "../../helpers/modifiers.mjs";
import { conditionLabel, findConditionWithMechanic } from "../../helpers/debuff-effects.mjs";
import { currentFloor } from "../../helpers/floor.mjs";
import { dayNightStat } from "../../helpers/day-night.mjs";

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
 * any capMax ChangeEntry) and Mod. A Stat is a whole number: once every
 * bonus and cap is in, any fraction - a Strength of 2 x1.25 - is dropped
 * (ruled 2026-11-21), so the Mod is Table 2's for the Stat shown.
 * @param {object} sys  The Actor's system data.
 */
export function deriveStats(sys) {
  for (const key in sys.stats) {
    const stat = sys.stats[key];
    if (!stat) continue;
    const bonus = sys.bonuses?.[`stats.${key}`] ?? 0;
    const cap = sys.caps?.[`stats.${key}`];
    // Day or night, for a Lajabless (helpers/day-night.mjs): on the whole
    // Stat, before any cap. The bonus shown is then what it all adds up to.
    const phased = dayNightStat(sys, key, stat.value + bonus);
    const total = cap !== undefined ? Math.min(phased, cap) : phased;
    const effective = Math.floor(total);
    stat.bonus = phased === stat.value + bonus ? bonus : Math.floor(phased) - stat.value;
    stat.effective = effective;
    stat.mod = getStatMod(effective);
    stat.label = game.i18n.localize(CONFIG.CARLRPG.stats[key]) ?? key;
  }
}

/**
 * DR and Resistances. `dr` and `resistances` stay the flat editable bases.
 *  - DR: (base + every "dr" add) x the DR multiplier (an Iron Skin Potion's
 *    x2 doubles the whole DR - modifiers.mjs keeps it apart as
 *    drMultiplier), rounded down, then any capMax. drBonus is how far that
 *    is from the base (what the sheet shows as "= N"). drAntiPiercing is
 *    the part an Armor-Piercing hit still meets (Anti-Piercing gear's).
 *  - A "resistance" ChangeEntry (e.g. a Race's "Immunity to Poison")
 *    overrides the base for its own type only, in resistancesEffective -
 *    read by module/helpers/damage-pipeline.mjs. Removing the granting item
 *    reverts to the base.
 * @param {object} sys
 */
export function deriveDefenses(sys) {
  const total = Math.floor((sys.dr + (sys.bonuses?.dr ?? 0)) * (sys.drMultiplier ?? 1));
  sys.drEffective = sys.caps?.dr !== undefined ? Math.min(total, sys.caps.dr) : total;
  sys.drBonus = sys.drEffective - sys.dr;
  // Against an Armor-Piercing hit only Anti-Piercing gear's DR counts
  // (modifiers.mjs drAntiPiercingBase), scaled by the same multiplier and
  // never more than the whole DR (so a cap holds too).
  const antiPiercing = Math.floor((sys.drAntiPiercingBase ?? 0) * (sys.drMultiplier ?? 1));
  sys.drAntiPiercing = Math.max(0, Math.min(antiPiercing, sys.drEffective));
  sys.resistancesEffective = { ...sys.resistances, ...sys.grantedResistances };
}

/**
 * A Character's Move and Step (in feet): the editable base (details.move/
 * step) plus "move"/"step" resource bonuses (Tigran's +10ft, Running).
 *  - Fatigued halves Move, rounded down to 5 ft - once, however many stacks.
 *  - Held and Terrified block Move and Step; Stiff Legs and Staggered block
 *    the Step. moveBlockedBy/stepBlockedBy name the first Debuff doing it
 *    ("" when free) - the sheet strikes the value through. The value itself
 *    is kept, for when the Debuff ends.
 * @param {object} sys
 */
export function deriveMovement(sys) {
  const details = sys.details ?? {};
  let move = Math.max(0, (details.move ?? 0) + (sys.bonuses?.move ?? 0));
  const halved = findConditionWithMechanic(sys, "halveMove");
  if (halved) move = Math.floor(move / 2 / 5) * 5;
  sys.moveEffective = move;
  sys.moveHalvedBy = halved ? conditionLabel(halved) : "";
  sys.stepEffective = Math.max(0, (details.step ?? 0) + (sys.bonuses?.step ?? 0));
  const noMove = findConditionWithMechanic(sys, "noMove");
  const noStep = findConditionWithMechanic(sys, "noStep");
  sys.moveBlockedBy = noMove ? conditionLabel(noMove) : "";
  sys.stepBlockedBy = noStep ? conditionLabel(noStep) : "";
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
  sys.shield.effectiveMax = computeActiveShieldSlots(
    sys.parent?.items ? Array.from(sys.parent.items) : [],
  );
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
  data.floor = currentFloor();
  return data;
}
