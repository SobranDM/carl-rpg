/**
 * Shared short-rest recovery formula (Playing the Game, p. 94): +5 Health
 * Bar slots and +half of max Mana, both clamped to their max. Extracted out
 * of module/apps/gm-toolbox.mjs's Short Rest button so CarlDice.rollHeal's
 * Rank 15 tier ("gain the benefits of a short rest" - see Heal Self,
 * packs-source/spells/heal-self.json) can apply the exact same math instead
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
