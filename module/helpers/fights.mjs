/**
 * Which fight a creature is in - one rule for every lookup (ruled
 * 2026-11-19): a started Combat with it among the combatants, compared by
 * the actor itself (Combatant#actor is a token's own synthetic actor, or
 * the world actor of a linked token - the same object a sheet or token
 * hands us). In the rare case of several, the one this user's tracker
 * shows (game.combat) wins, else the first.
 */

/**
 * The started fight with a combatant that passes `test`.
 * @param {(combatant: Combatant) => boolean} test
 * @returns {Combat|null}
 */
export function fightWhere(test) {
  const fights = game.combats.filter((c) => c.started && c.combatants.some(test));
  return fights.find((c) => c === game.combat) ?? fights[0] ?? null;
}

/**
 * The started fight this actor is a combatant of, if any.
 * @param {Actor|null|undefined} actor
 * @returns {Combat|null}
 */
export function fightOf(actor) {
  return actor ? fightWhere((cb) => cb.actor === actor) : null;
}

/**
 * The fight this actor is in and its round, or null - a stamp for "when"
 * (an AI Favor reroll's Check, a potion's Sickness).
 * @param {Actor|null|undefined} actor
 * @returns {{combatId: string, round: number}|null}
 */
export function fightStamp(actor) {
  const combat = fightOf(actor);
  return combat ? { combatId: combat.id, round: combat.round } : null;
}
