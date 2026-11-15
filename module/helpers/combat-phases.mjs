/**
 * The phased PvE round (Combat, p.80-82; docs/combat-phases.md):
 *  1. Mob Action Declaration - the GM declares each Mob's Attacks and targets;
 *  2. Crawler Reaction Phase - Interrupts (Evade, Taunt, Catcher...);
 *  3. Mob Attack Resolution - damage lands;
 *  4. Crawler Action Phase - crawlers act in any order;
 *  5. Clean Up - end-of-round effects (CarlRPGCombat#_onEndRound).
 * Surprise ("crawlers who surprise their foes get a free Action before the
 * normal flow", p.80) comes once, before round 1's declaration.
 *
 * The step lives on the Combat as `flags.carl-rpg.phase = {round, step}`. A
 * flag left over from another round reads as `declare`, so a round change can
 * never strand a stale step. Clean Up isn't a step of its own: it is the
 * round advance itself. CarlRPGCombat#_preUpdate stamps the new round's step
 * in the same update as the round change.
 *
 * Phases apply to a combat with any Mob in it ("PvE") while the world
 * setting is on. A crawlers-only fight (PvP, p.87) keeps core's initiative
 * turns.
 */

const SCOPE = "carl-rpg";

/** Every step a round can be in, in order. */
export const PHASE_STEPS = Object.freeze(["surprise", "declare", "react", "resolve", "act"]);

/** The five steps the tracker's phase bar shows (p.80): Clean Up is the round advance. */
export const PHASE_BAR_STEPS = Object.freeze(["declare", "react", "resolve", "act", "cleanup"]);

/** Register the world setting, from the `init` hook. */
export function registerPhaseSettings() {
  game.settings.register(SCOPE, "phasedCombat", {
    name: "CARLRPG.Phase.Setting.Name",
    hint: "CARLRPG.Phase.Setting.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      // Switched on mid-fight: running PvE fights drop core's current turn.
      for (const combat of game.combats) void syncPhaseState(combat).catch((err) => console.error("CarlRPG | phase sync failed", err));
      ui.combat?.render();
    },
  });
}

/**
 * Whether this combat runs the phased round once started: a Carl RPG combat
 * that isn't PvP (crawlers only), with the setting on.
 * @param {Combat|null|undefined} combat
 * @returns {boolean}
 */
export function usesPhases(combat) {
  if (!combat || typeof combat.isPvP !== "boolean") return false;
  if (!game.settings.get(SCOPE, "phasedCombat")) return false;
  return !combat.isPvP;
}

/**
 * Whether this combat is running the phased round right now.
 * @param {Combat|null|undefined} combat
 * @returns {boolean}
 */
export function isPhased(combat) {
  return usesPhases(combat) && combat.started;
}

/**
 * The current step, or null when the combat isn't phased.
 * @param {Combat|null|undefined} combat
 * @returns {"surprise"|"declare"|"react"|"resolve"|"act"|null}
 */
export function currentPhase(combat) {
  if (!isPhased(combat)) return null;
  const flag = combat.getFlag(SCOPE, "phase");
  if (flag?.round === combat.round && PHASE_STEPS.includes(flag.step)) return flag.step;
  return "declare";
}

/**
 * The phase flag for the start of a round.
 * @param {number} round
 * @param {boolean} surprise  Round 1 of a fight where the crawlers surprised the Mobs.
 * @returns {{round: number, step: string}}
 */
export function roundStartPhase(round, surprise) {
  return { round, step: round === 1 && surprise ? "surprise" : "declare" };
}

/**
 * The started, phased combat this actor is a combatant of (a token's actor
 * or the world actor), if any. The viewed combat is checked first.
 * @param {Actor|null|undefined} actor
 * @returns {Combat|null}
 */
export function phasedCombatFor(actor) {
  if (!actor) return null;
  // Combatant#actor is the token's own (synthetic) actor, or the world actor
  // for a linked token - the same object a sheet or token hands us.
  const isIn = (combat) => combat.combatants.some((c) => c.actor === actor);
  const candidates = new Set([game.combat, ...game.combats.contents].filter(Boolean));
  return [...candidates].find((combat) => isPhased(combat) && isIn(combat)) ?? null;
}

/**
 * A started fight that becomes phased mid-round (a Mob joins a PvP fight, or
 * the setting is switched on) still has core's current turn. Clear it and
 * open the round at Declaration. Active GM only; does nothing for a combat
 * that isn't phased or already has no turn.
 * @param {Combat} combat
 * @returns {Promise<void>}
 */
export async function syncPhaseState(combat) {
  if (!game.users.activeGM?.isSelf || !game.combats.has(combat?.id)) return;
  if (!isPhased(combat) || combat.turn === null) return;
  await combat.update({ turn: null, [`flags.${SCOPE}.phase`]: roundStartPhase(combat.round, false) }, { turnEvents: false });
  await postPhaseNotice(combat, "declare", { roundStart: true });
}

/**
 * What the Reaction Phase does on the way in and out, registered at init
 * (module/carl-rpg.mjs) so this module doesn't import the chat card:
 *  - startReaction(combat): post the round's Reaction card;
 *  - lockResults(combat): Lock Results - lock the card, move to `resolve`,
 *    post the Damage card;
 *  - finishResolution(combat): leaving `resolve` - offer to roll any damage
 *    still unrolled; false stays in Resolution;
 *  - retireReaction(combat): Previous Phase out of Reaction - discard the card.
 * @type {{startReaction?: Function, lockResults?: Function, finishResolution?: Function, retireReaction?: Function}}
 */
export const reactionHandlers = {};

/**
 * Where Next Phase goes from each step. `act` ends the round instead.
 * @type {Record<string, string>}
 */
const NEXT_STEP = { surprise: "declare", declare: "react", react: "act", resolve: "act" };

/**
 * Advance the combat one step (the tracker's Next Phase, or Combat#nextTurn).
 * Declaration -> Reaction posts the Reaction card (after the Reaction
 * notice, so the card is the latest thing in chat); Reaction -> Lock
 * Results resolves it. From `act` this ends the round: Clean Up runs, and
 * the next round starts at `declare`.
 * @param {Combat} combat
 * @returns {Promise<Combat>}
 */
export async function nextPhase(combat) {
  return stepOnce(combat, async () => {
    const step = currentPhase(combat);
    if (!step) return combat;
    if (step === "act") return combat.nextRound();
    if (step === "react" && reactionHandlers.lockResults) return reactionHandlers.lockResults(combat);
    if (step === "resolve" && reactionHandlers.finishResolution && !(await reactionHandlers.finishResolution(combat))) return combat;
    await setPhase(combat, NEXT_STEP[step]);
    if (step === "declare") await reactionHandlers.startReaction?.(combat);
    return combat;
  });
}

/**
 * Step back one step - only while nothing has been applied. Reaction goes
 * back to Declaration (its card is discarded); past Resolution damage has
 * landed, so it refuses.
 * @param {Combat} combat
 * @returns {Promise<Combat>}
 */
export async function previousPhase(combat) {
  return stepOnce(combat, async () => {
    const step = currentPhase(combat);
    if (step === "react") {
      await reactionHandlers.retireReaction?.(combat);
      return setPhase(combat, "declare");
    }
    if (step === "resolve" || step === "act") {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Phase.CannotRewind"));
    }
    return combat;
  });
}

/** Combats with a phase change in progress on this client. */
const stepping = new Set();

/**
 * Run one phase change at a time per combat, GM only. A second click that
 * lands while the first is still writing (a double-click on End Round) is
 * dropped, rather than reading the half-changed step and advancing again.
 * @param {Combat} combat
 * @param {() => Promise<Combat>} fn
 * @returns {Promise<Combat>}
 */
async function stepOnce(combat, fn) {
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Phase.GMOnly"));
    return combat;
  }
  if (stepping.has(combat.id)) return combat;
  stepping.add(combat.id);
  try {
    return await fn();
  } finally {
    stepping.delete(combat.id);
  }
}

/**
 * Set the current round's step and post a short notice of it.
 * @param {Combat} combat
 * @param {string} step
 * @returns {Promise<Combat>}
 */
export async function setPhase(combat, step) {
  if (!PHASE_STEPS.includes(step)) throw new Error(`Unknown combat phase "${step}"`);
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Phase.GMOnly"));
    return combat;
  }
  await combat.setFlag(SCOPE, "phase", { round: combat.round, step });
  await postPhaseNotice(combat, step);
  return combat;
}

/**
 * Post a short chat notice that a step has begun.
 * @param {Combat} combat
 * @param {string} step
 * @param {{roundStart?: boolean}} [options]  roundStart: the first step of a
 *   new round (titled "Round N"); otherwise the notice is titled by its step,
 *   so going back to Declaration doesn't read as a new round.
 * @returns {Promise<ChatMessage|null>}
 */
export async function postPhaseNotice(combat, step, { roundStart = false } = {}) {
  // The round-start notice comes from Combat#_onStartRound, after the update
  // that started the round - the combat may be gone by then.
  if (!step || !game.combats.has(combat.id)) return null;
  const i18n = game.i18n;
  const title = roundStart
    ? i18n.format("CARLRPG.Phase.RoundTitle", { round: combat.round })
    : i18n.localize(`CARLRPG.Phase.Step.${step}`);
  const body = i18n.localize(`CARLRPG.Phase.Notice.${step}`);
  const esc = foundry.utils.escapeHTML;
  const subtitle = roundStart ? `<span class="carl-phase-notice-step">${esc(i18n.localize(`CARLRPG.Phase.Step.${step}`))}</span>` : "";
  return ChatMessage.create({
    content: `<div class="carl-phase-notice" data-step="${esc(step)}">
      <strong>${esc(title)}</strong>${subtitle}
      <p>${esc(body)}</p>
    </div>`,
    speaker: { alias: i18n.localize("CARLRPG.Phase.Speaker") },
    flags: { [SCOPE]: { phaseNotice: { combatId: combat.id, round: combat.round, step, roundStart } } },
  });
}
