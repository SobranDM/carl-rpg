/**
 * Defeat and death marking (Health Menu, p.92/94):
 *  - "Mobs die instantly at 0% HB" - a Mob (or Boss) at 0 HB is defeated.
 *  - A crawler at 0 HB gains Dying instead (CarlRPGActor#_preUpdate), and
 *    is only defeated (dead) once that countdown reaches 0.
 *
 * "Defeated" is Foundry's own notion: the Combatant's `defeated` flag (the
 * tracker's skull) plus the DEFEATED status effect as a token overlay -
 * the same pair the core tracker's "toggle defeated" button sets. Run on
 * the active GM only (CarlRPGActor#_onUpdate), which may update any
 * Combatant and token.
 */

/** @returns {string} The status id core uses for "defeated" (normally "dead"). */
function defeatedStatusId() {
  return CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
}

/**
 * Whether this actor should currently count as defeated by the rules.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function shouldBeDefeated(actor) {
  const sys = actor?.system;
  if (!sys) return false;
  if (actor.type !== "character") return (sys.hb?.value ?? 1) <= 0;
  const dying = (sys.conditions ?? []).find((c) => CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.countdown);
  return !!dying && (dying.remaining ?? 1) <= 0;
}

/**
 * Mark or unmark an actor defeated: its DEFEATED token overlay and every
 * Combatant (in any Combat) that represents it. No-ops where already set.
 * @param {Actor} actor
 * @param {boolean} defeated
 * @returns {Promise<void>}
 */
export async function setDefeated(actor, defeated) {
  const statusId = defeatedStatusId();
  if (actor.statuses?.has(statusId) !== defeated) {
    await actor.toggleStatusEffect(statusId, { active: defeated, overlay: true });
  }
  for (const combat of game.combats) {
    const updates = combat.combatants
      .filter((c) => c.actor?.uuid === actor.uuid && c.defeated !== defeated)
      .map((c) => ({ _id: c.id, defeated }));
    if (updates.length) await combat.updateEmbeddedDocuments("Combatant", updates);
  }
}

/**
 * Bring an actor's defeated marking in line with the rules after an update
 * that touched its HB or conditions. A marking is only cleared when this
 * update healed the actor up from 0 HB (`previousHb` <= 0), so a GM's own
 * hand-set "defeated" on a living creature (one that fled or surrendered)
 * survives every other update.
 * @param {Actor} actor
 * @param {{previousHb?: number|null}} [options]  HB before this update (CarlRPGActor#_preUpdate).
 * @returns {Promise<void>}
 */
export async function syncDefeated(actor, { previousHb = null } = {}) {
  if (shouldBeDefeated(actor)) return setDefeated(actor, true);
  const healedFromZero = previousHb !== null && previousHb <= 0 && (actor.system?.hb?.value ?? 0) > 0;
  if (healedFromZero && actor.statuses?.has(defeatedStatusId())) return setDefeated(actor, false);
}
