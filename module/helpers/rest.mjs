import { CARLRPG } from "./config.mjs";
import { findConditionWithMechanic } from "./debuff-effects.mjs";

/**
 * Add `amount` to `current` without going past `max` - and never lower a
 * value already above it. The one clamp rule for every restore (potions,
 * per-round Buffs).
 * @param {number} current
 * @param {number} amount
 * @param {number} max
 * @returns {number}
 */
export function restoreUpTo(current, amount, max) {
  return Math.max(current, Math.min(current + (Number(amount) || 0), max));
}

/**
 * Whether a Buff's per-round restore (`perRound` on a consumable's Buff or
 * a condition entry) restores anything.
 * @param {{hb?: number|null, mana?: number|null}|null|undefined} perRound
 * @returns {boolean}
 */
export function restoresPerRound(perRound) {
  return !!(perRound?.hb || perRound?.mana);
}

/** The Health Bar ceiling a heal fills to (effective max, with bonuses). */
export function hbCeiling(system) {
  return system.hb?.effectiveMax ?? system.hb?.max ?? 0;
}

/**
 * A Buff's per-round restore (`perRound`), `rounds` times over: Mana and
 * Health Bar each up to its max, never lowered; the Health Bar not at all
 * under The Taint (a "noHealing" Debuff). The one rule for a round's end
 * (round-end.mjs applyPerRoundRestores), what's still owed when a fight
 * ends (processCombatEnd), and a restore used outside a fight, which lands
 * all at once (consumables.mjs). Callers word their own chat lines.
 * @param {object} system  The actor's system data.
 * @param {{hb: number, mana: number}} current  What it has now - including
 *   anything already restored in the same pass.
 * @param {{hb?: number|null, mana?: number|null}} perRound
 * @param {number} [rounds]
 * @returns {{hb: number, mana: number, taint: object|null}}  The new values;
 *   taint: the Debuff that blocked the Health Bar part, if one did.
 */
export function restorePerRound(system, current, perRound, rounds = 1) {
  let { hb, mana } = current;
  let taint = null;
  if (perRound?.mana) mana = restoreUpTo(mana, perRound.mana * rounds, system.mana?.max ?? 0);
  if (perRound?.hb) {
    taint = findConditionWithMechanic(system, "noHealing") ?? null;
    if (!taint) hb = restoreUpTo(hb, perRound.hb * rounds, hbCeiling(system));
  }
  return { hb, mana, taint };
}

/**
 * Shared short-rest recovery formula (Playing the Game, p. 94): +5 Health
 * Bar slots and +half of max Mana, both clamped to their max. Extracted out
 * of module/apps/gm-toolbox.mjs's Short Rest button so CarlDice.rollHeal's
 * Rank 15 tier ("gain the benefits of a short rest" - see Heal Self,
 * packs-source/skills-and-spells/heal-self.json) can apply the exact same math instead
 * of re-deriving it, per docs/known-gaps.md 1.2's instruction.
 * @param {Actor} actor
 * @returns {{"system.hb.value": number, "system.mana.value": number}}
 */
export function shortRestUpdates(actor) {
  const sys = actor.system;
  const manaMax = sys.mana?.max ?? 0;
  return {
    "system.hb.value": restoreUpTo(sys.hb?.value ?? 0, 5, hbCeiling(sys)),
    "system.mana.value": restoreUpTo(sys.mana?.value ?? 0, Math.floor(manaMax / 2), manaMax),
  };
}

/**
 * Restore to full: each value raised to its max, never lowered (a value
 * above max - a max-raising Buff just ended - stays where it is).
 * @param {Actor} actor
 * @returns {{"system.hb.value": number, "system.mana.value": number}}
 */
export function fullRestoreUpdates(actor) {
  const sys = actor.system;
  return {
    "system.hb.value": Math.max(sys.hb?.value ?? 0, hbCeiling(sys)),
    "system.mana.value": Math.max(sys.mana?.value ?? 0, sys.mana?.max ?? 0),
  };
}

const REST_LENGTH = { short: 1, long: 2, fullDay: 3 };

/**
 * The conditions left after a rest (Playing the Game p.94/96, Table 11): a
 * Debuff whose `mechanics.endsOnRest` is this rest's length or shorter ends -
 * Minor Injury on a short rest; Fatigued, Major and Long-Term Minor Injury on
 * a long rest; Long-Term Major Injury on a full day's rest. A longer rest
 * includes everything a shorter one ends.
 * @param {object[]} conditions  An actor's system.conditions.
 * @param {"short"|"long"|"fullDay"} restKind
 * @returns {object[]}
 */
export function conditionsAfterRest(conditions, restKind) {
  const length = REST_LENGTH[restKind] ?? 0;
  return (conditions ?? []).filter((c) => {
    const endsOn = CARLRPG.debuffs[c.key]?.mechanics?.endsOnRest;
    return !(endsOn && REST_LENGTH[endsOn] <= length);
  });
}

/**
 * Hourly mending (p.95): "For every full hour spent outside of combat or
 * other stressful situations, they mend their wounds and recover 1 HB slot
 * and 5 Mana." Both clamped to their max; the book sets no cap on hours.
 * @param {Actor} actor
 * @param {number} hours  Whole hours of calm.
 * @returns {{"system.hb.value": number, "system.mana.value": number}}
 */
export function mendingUpdates(actor, hours) {
  const sys = actor.system;
  const n = Math.max(0, Math.floor(Number(hours) || 0));
  return {
    "system.hb.value": restoreUpTo(sys.hb?.value ?? 0, n, hbCeiling(sys)),
    "system.mana.value": restoreUpTo(sys.mana?.value ?? 0, 5 * n, sys.mana?.max ?? 0),
  };
}
