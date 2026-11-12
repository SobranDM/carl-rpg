import { CARLRPG } from "./config.mjs";

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
  const effectiveMax = sys.hb?.effectiveMax ?? sys.hb?.max ?? 0;
  return {
    "system.hb.value": Math.min((sys.hb?.value ?? 0) + 5, effectiveMax),
    "system.mana.value": Math.min((sys.mana?.value ?? 0) + Math.floor((sys.mana?.max ?? 0) / 2), sys.mana?.max ?? 0),
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
  const effectiveMax = sys.hb?.effectiveMax ?? sys.hb?.max ?? 0;
  return {
    "system.hb.value": Math.min((sys.hb?.value ?? 0) + n, effectiveMax),
    "system.mana.value": Math.min((sys.mana?.value ?? 0) + 5 * n, sys.mana?.max ?? 0),
  };
}
