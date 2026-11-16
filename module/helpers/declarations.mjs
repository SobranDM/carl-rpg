/**
 * Declared Mob Attacks (Step 1, Mob Action Declaration, p.81;
 * docs/combat-phases.md). In a phased fight's Declaration step a Mob Attack
 * isn't rolled: CarlDice.rollMobAttack records it here, with everything the
 * Reaction card and Resolution need later - its target rows (to-hit per
 * defender, free Evade), its damage formula, and what a Taunt re-resolves
 * against. Nothing goes to chat until the GM starts the Reaction Phase.
 *
 * Stored on the Combat as `flags.carl-rpg.declared = {round, attacks: {id: Declaration}}`.
 * A store left over from another round reads as empty, and the first
 * declaration of a new round replaces it.
 */
import { refundAction } from "./actions.mjs";

const SCOPE = "carl-rpg";

/**
 * @typedef {object} Declaration
 * @property {string} id
 * @property {number} round
 * @property {string} mobUuid       The attacking Mob's token (or actor) uuid.
 * @property {string|null} tokenId  Its token's id, for the map mark.
 * @property {string|null} sceneId
 * @property {string} mobName
 * @property {string} mobImg
 * @property {number} attackIndex   Index into the Mob's system.attacks.
 * @property {string} attackName
 * @property {string} damage        The printed damage formula ("F" = Floor).
 * @property {string} damageType
 * @property {boolean} damageIsMagic
 * @property {boolean} isArea
 * @property {number} floor
 * @property {number|null} difficulty  The to-hit against the first target.
 * @property {number|null} mobBase    The to-hit plus the dialog's modifier.
 * @property {object[]} mobOwnRows    The Mob's own applied Debuff rows.
 * @property {Record<string, object>} targetRows  One row per defender (helpers/attack-targets.mjs).
 * @property {string} effect
 * @property {string} range
 * @property {object[]} spentConditions  One-shot Debuffs the Mob spent declaring it -
 *   restored if the declaration is withdrawn.
 * @property {{combatantId: string, id: string}|null} action  The Mob Action it spent
 *   (helpers/actions.mjs) - refunded if the declaration is withdrawn.
 * @property {number} createdAt
 */

/**
 * This round's declarations, in the order they were made.
 * @param {Combat|null|undefined} combat
 * @returns {Declaration[]}
 */
export function declaredAttacks(combat) {
  const store = combat?.getFlag(SCOPE, "declared");
  if (!store || store.round !== combat.round) return [];
  return Object.values(store.attacks ?? {})
    .filter((d) => d && d.id)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/**
 * This round's declarations by one Mob: matched by its token's uuid, or by
 * its actor's uuid for a Mob with no token.
 * @param {Combat|null|undefined} combat
 * @param {{tokenUuid?: string|null, actorUuid?: string|null}} mob
 * @returns {Declaration[]}
 */
export function declarationsByMob(combat, { tokenUuid = null, actorUuid = null }) {
  return declaredAttacks(combat).filter((d) => (tokenUuid && d.mobUuid === tokenUuid) || (actorUuid && d.mobUuid === actorUuid));
}

/** Pending writes per combat id: one at a time, so they can't overwrite each other. */
const writes = new Map();

/**
 * Run a write to a combat's declarations after any earlier one has landed.
 * Two quick declarations at the start of a round would otherwise both see
 * last round's store and both replace it - the second wiping the first.
 * @template T
 * @param {Combat} combat
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function queueWrite(combat, task) {
  const next = (writes.get(combat.id) ?? Promise.resolve()).then(task, task);
  writes.set(combat.id, next.catch(() => {}));
  return next;
}

/**
 * Record a declaration for the current round (GM only - only a GM can
 * write to the Combat).
 * @param {Combat} combat
 * @param {Omit<Declaration, "id"|"round">} data
 * @returns {Promise<Declaration>}
 */
export function recordDeclaration(combat, data) {
  return queueWrite(combat, async () => {
    const { ForcedReplacement } = foundry.data.operators;
    const id = foundry.utils.randomID();
    const declaration = { ...data, id, round: combat.round, createdAt: Date.now() };
    const store = combat.getFlag(SCOPE, "declared");
    const declared = store?.round === combat.round
      ? { attacks: { [id]: declaration } }
      : ForcedReplacement.create({ round: combat.round, attacks: { [id]: declaration } });
    await combat.update({ flags: { [SCOPE]: { declared } } });
    return declaration;
  });
}

/**
 * Withdraw a declaration (the tracker's or the Declare HUD's remove button).
 * The one-shot Debuffs the Mob spent declaring it (Stunned, Staggered...)
 * come back, so declaring again gives the same to-hit.
 * @param {Combat} combat
 * @param {string} id
 * @returns {Promise<void>}
 */
export function removeDeclaration(combat, id) {
  return queueWrite(combat, async () => {
    const declaration = declaredAttacks(combat).find((d) => d.id === id);
    if (!game.user.isGM || !declaration) return;
    const { ForcedDeletion } = foundry.data.operators;
    await combat.update({ flags: { [SCOPE]: { declared: { attacks: { [id]: new ForcedDeletion() } } } } });
    await restoreSpentConditions(declaration);
    // And the Action it spent (helpers/actions.mjs).
    if (declaration.action) await refundAction(combat, declaration.action.combatantId, declaration.action.id);
  });
}

/**
 * Give a withdrawn declaration's spent Debuffs back to its Mob (any it has
 * since regained are left alone).
 * @param {Declaration} declaration
 * @returns {Promise<void>}
 */
async function restoreSpentConditions(declaration) {
  const spent = declaration.spentConditions ?? [];
  if (!spent.length) return;
  const doc = await fromUuid(declaration.mobUuid);
  const actor = doc instanceof Actor ? doc : doc?.actor;
  if (!actor) return;
  const current = actor.system.toObject().conditions ?? [];
  const have = new Set(current.map((c) => c.id));
  const back = spent.filter((c) => !have.has(c.id));
  if (back.length) await actor.update({ "system.conditions": [...current, ...back] });
}

/**
 * "Bite → Wren, Chase": a declaration's attack and its targets.
 * @param {Declaration} declaration
 * @returns {string}
 */
export function describeDeclaration(declaration) {
  const targets = Object.values(declaration.targetRows ?? {}).map((row) => row.name).join(", ");
  return game.i18n.format("CARLRPG.Declare.Summary", { attack: declaration.attackName, targets: targets || "-" });
}
