/**
 * The "Taunt This Attack" button on an Attack chat card (Taunt, Interrupt
 * Action, Carl RPG p.81 / docs/taunt-and-nat20-advantage-prompt.md). Unlike
 * "Roll Evade" (module/chat/evade-link-card.mjs), which determines a NEW
 * outcome for the SAME defender, Taunt is rolled by a THIRD PARTY - a
 * different crawler than whoever the Attack currently targets - who makes
 * an INT-Opposed Taunt Skill Check against the attacking Mob and, on
 * Success, redirects that specific already-rolled Attack onto themselves.
 *
 * The redirect itself is just overwriting the Attack ChatMessage's own
 * targetUuids flag via updateCardMessage: once redirected, the SAME card's
 * existing "Apply Damage"/"Apply to Target(s)"/"Roll Evade" buttons (already
 * wired via module/chat/chat-listener.mjs's registry) act on the new target
 * automatically - no new apply-side code needed here at all. The Taunt roll
 * itself posts as its own small chat message (reusing CarlDice's roll-then-
 * post shape via rollOpposedSkillCheck, post:false + this file's own
 * createRollMessage call, exactly like evade-link-card.mjs's onRollEvade
 * folds its own roll into a combined outcome write) so the roll stays
 * visible, separate from the (unchanged in appearance, just re-flagged)
 * Attack card.
 */
import CarlDice from "../dice/dice.mjs";
import { degreeBadge, isHitDegree } from "../helpers/rules.mjs";
import { resolveActingActor } from "../helpers/token-resolution.mjs";
import { createRollMessage } from "./chat-card.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/taunt-footer.hbs";

// Once any of these has fired, the Attack card's outcome is already
// resolved - retroactively changing who it targeted doesn't make sense
// (see docs/taunt-and-nat20-advantage-prompt.md, Part B step 4).
const LOCK_FLAGS = ["damageApplied", "targetEffectsApplied", "evadeRolled"];

/**
 * Render the "Taunt This Attack" footer. Rendered whenever rollAttack
 * snapshotted an attacker (attackerUuid) - see CarlDice.rollAttack.
 * @returns {Promise<string>}
 */
export async function buildTauntLinkFooter() {
  const { renderTemplate } = foundry.applications.handlebars;
  return renderTemplate(FOOTER_TEMPLATE, {});
}

function isCardLocked(message) {
  return LOCK_FLAGS.some((flag) => !!message.getFlag("carl-rpg", flag));
}

/**
 * Resolve the attacking Mob's Actor off the Attack message's own
 * attackerUuid flag. Tokens/scenes can be deleted between roll time and
 * click time - callers must tolerate nulls.
 * @param {ChatMessage} message
 * @returns {Promise<Actor|null>}
 */
async function resolveAttackerActor(message) {
  const uuid = message.getFlag("carl-rpg", "attackerUuid");
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  return doc instanceof Actor ? doc : (doc.actor ?? null);
}

/**
 * Unlike the Apply Damage/Target-Effects/Evade buttons (all gated to an
 * owner of a snapshotted TARGET), Taunt's whole point is a THIRD PARTY
 * redirecting the attack onto themselves - gating on targetUuids ownership
 * would be backwards here. Simplest correct behavior per the design prompt:
 * visible to the GM or anyone who owns an Actor at all; the real "not
 * already the target"/"already resolved" checks happen in onClick with a
 * clear toast rather than being expressed as a visibility predicate.
 * @returns {boolean}
 */
function canActTaunt() {
  if (game.user.isGM) return true;
  return !!game.user.character || game.actors.some((a) => a.isOwner);
}

/**
 * Roll an INT-Opposed Taunt Skill Check for the acting user's resolved
 * token/actor against the attacking Mob's Difficulty (10 + Mob's
 * opposedStat Mod + current Floor, mirroring rollAttack's own static-
 * formula convention), post it as its own card, and on Success overwrite
 * the original Attack message's targetUuids with the taunter - the same
 * card's existing damage/target-effect/evade buttons pick up the new target
 * with zero further wiring.
 * @param {PointerEvent} event
 * @param {ChatMessage} message  The original Attack chat message.
 */
async function onTauntAttack(event, message) {
  event.preventDefault();
  if (isCardLocked(message)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.AlreadyResolved"));
    return;
  }

  const resolved = resolveActingActor();
  if (!resolved) return;
  const taunterUuid = resolved.token?.uuid ?? resolved.actor.uuid;

  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  if (targetUuids.includes(taunterUuid)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.CannotTauntSelf"));
    return;
  }

  const attackerActor = await resolveAttackerActor(message);
  if (!attackerActor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.NoAttacker"));
    return;
  }

  // Matched by name, same convention as every other by-name Skill lookup in
  // this codebase (module/sheets/actor-sheet.mjs's Damage Effect matching,
  // rollAttack's damageEffectChoices) - Taunt is a specific named Skill, not
  // a generic mechanic every actor has access to.
  const tauntItem = resolved.actor.items.find((i) => i.type === "skill" && i.name === "Taunt");
  if (!tauntItem) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.NoTauntSkill"));
    return;
  }

  const statKey = tauntItem.system.opposedStat || "int";
  const statMod = attackerActor.system.stats?.[statKey]?.mod ?? 0;
  const floor = game.settings.get("carl-rpg", "currentFloor");
  const difficulty = 10 + statMod + floor;

  const rollData = await CarlDice.rollOpposedSkillCheck(resolved.actor, tauntItem, { difficulty, skipDialog: false, post: false });
  if (!rollData) return; // Dialog cancelled - nothing to record.
  const { roll, breakdown, degree } = rollData;
  const success = isHitDegree(degree);

  await createRollMessage({
    rolls: [roll],
    rollMeta: [{ label: tauntItem.name, detail: `vs. ${attackerActor.name}`, breakdown }],
    title: game.i18n.format("CARLRPG.Taunt.RollTitle", { name: resolved.actor.name }),
    img: resolved.actor.img,
    subtitle: game.i18n.localize(success ? "CARLRPG.Taunt.Success" : "CARLRPG.Taunt.Fail"),
    badge: degreeBadge(degree),
    actor: resolved.actor,
    token: resolved.token,
  });

  // tauntedBy is this button's own one-shot doneFlag (set on ANY outcome,
  // not just Success) - the Interrupt Action is spent either way, mirroring
  // Roll Evade's evadeRolled locking regardless of the Evade's own outcome.
  const flags = { tauntedBy: taunterUuid };
  if (success) flags.targetUuids = [taunterUuid];
  await updateCardMessage(message, { flags: { "carl-rpg": flags } });

  ui.notifications.info(game.i18n.format(
    success ? "CARLRPG.Taunt.RedirectedNotice" : "CARLRPG.Taunt.FailedNotice",
    { name: resolved.actor.name }
  ));
}

/**
 * Registry entries consumed by the shared registerChatListener (module/chat/
 * chat-listener.mjs) - see evadeActionEntries in module/chat/
 * evade-link-card.mjs for the exact shape this mirrors.
 */
export const tauntActionEntries = [{
  action: "tauntAttack",
  buttonSelector: ".carl-taunt-attack",
  wrapperSelector: ".carl-taunt-link",
  canAct: canActTaunt,
  doneFlag: "tauntedBy",
  doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Taunt.Done")}`,
  onClick: onTauntAttack,
}];
