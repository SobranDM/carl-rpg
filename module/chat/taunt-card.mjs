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
 * targetUuids flag (and swapping its target rows) - written by the card's
 * writer in the card's queue (tauntRedirectNow), checked there against the
 * card as it is then: once redirected, the SAME card's
 * existing "Apply Damage"/"Apply to Target(s)"/"Roll Evade" buttons (already
 * wired via module/chat/chat-listener.mjs's registry) act on the new target
 * automatically - no new apply-side code needed here at all. The Taunt roll
 * itself posts as its own small chat message (reusing CarlDice's roll-then-
 * post shape via rollOpposedSkillCheck, post:false + this file's own
 * createRollMessage call, exactly like the per-target Evade (attack-targets-card.mjs)
 * folds its own roll into a combined outcome write) so the roll stays
 * visible, separate from the (unchanged in appearance, just re-flagged)
 * Attack card.
 */
import CarlDice from "../dice/dice.mjs";
import { degreeBadge, isHitDegree } from "../helpers/rules.mjs";
import { resolveActingActor } from "../helpers/token-resolution.mjs";
import { createRollMessage } from "./chat-card.mjs";
import { askGM, registerAskHandler } from "../helpers/chat-socket.mjs";
import { noteUndo, takeAction } from "../helpers/actions.mjs";
import { withCardQueue } from "./check-revision.mjs";
import { activeRows, crawlerAttackDifficulty, crawlerAttackRow, mobAttackRow, nextRowId } from "../helpers/attack-targets.mjs";
import { rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { ownedSkill } from "../helpers/modifiers.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/taunt-footer.hbs";

// Once any of these has fired, the Attack card's outcome is already
// resolved - retroactively changing who it targeted doesn't make sense
// (see docs/taunt-and-nat20-advantage-prompt.md, Part B step 4). The
// per-target rows (module/chat/attack-targets-card.mjs) lock it too, once
// any row has been Evaded or applied.
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

export function isCardLocked(message) {
  if (LOCK_FLAGS.some((flag) => !!message.getFlag("carl-rpg", flag))) return true;
  // A Shield Block counts as a reaction too (helpers/shield-block.mjs).
  return activeRows(message.getFlag("carl-rpg", "targetRows")).some((row) => row.applied || row.evade || row.block);
}

/**
 * The taunter's new target row: a Mob Attack re-resolves its to-hit for the
 * taunter (their Held/Take Down); a crawler's Attack checks its rolled total
 * against the taunter's own Evade.
 * @param {ChatMessage} message
 * @param {{actor: Actor, token: TokenDocument|null}} taunter
 * @returns {object}
 */
function taunterRow(message, taunter) {
  const flags = message.flags["carl-rpg"];
  const id = nextRowId(flags.targetRows);
  const target = { uuid: taunter.token?.uuid ?? taunter.actor.uuid, actor: taunter.actor };
  if (!rollsLikeCrawler(flags.attackerType)) {
    return mobAttackRow({ id, target, base: flags.mobBase ?? flags.targetDifficulty, ownRows: flags.mobOwnRows ?? [] }).row;
  }
  const floor = flags.floor ?? game.settings.get("carl-rpg", "currentFloor");
  return crawlerAttackRow({
    id, target,
    difficulty: crawlerAttackDifficulty(taunter.actor, floor).difficulty,
    attackTotal: flags.attackTotal, naturalRoll: flags.naturalRoll ?? null,
  });
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
export function canActTaunt() {
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
function onTauntAttack(event, message) {
  event.preventDefault();
  return tauntAttack(message);
}

/**
 * Taunt an Attack card's Attack (onTauntAttack). In a phased fight this is
 * the Taunt Interrupt Action - 1 Action, as on the Reaction card
 * (docs/action-tracking.md) - spent once the roll is made, whatever it
 * rolled. The roll is made here; the redirect is written by the card's
 * writer, in its queue (tauntRedirectNow), and refused there if the Attack
 * was settled or its rows changed while the dialog was open. The roll
 * stands either way.
 * @param {ChatMessage} message  The Attack card.
 * @param {{taunter?: {actor: Actor, token: TokenDocument|null}, skipDialog?: boolean}} [options]
 *   taunter: who Taunts (default: the acting user's token/actor) - preset by tests.
 * @returns {Promise<"redirected"|"failed"|"refused"|"unanswered"|null>}  What
 *   came of it; null if no Taunt was made.
 */
export async function tauntAttack(message, { taunter = null, skipDialog = false } = {}) {
  if (isCardLocked(message)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.AlreadyResolved"));
    return null;
  }
  if (message.getFlag("carl-rpg", "isArea")) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.NotArea"));
    return null;
  }

  const resolved = taunter ?? resolveActingActor();
  if (!resolved) return null;
  const taunterUuid = resolved.token?.uuid ?? resolved.actor.uuid;

  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  if (targetUuids.includes(taunterUuid)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.CannotTauntSelf"));
    return null;
  }

  const attackerActor = await resolveAttackerActor(message);
  if (!attackerActor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.NoAttacker"));
    return null;
  }

  // Matched by slug (modifiers.mjs ownedSkill: any case or punctuation),
  // the convention every by-name Skill lookup uses - Taunt is a specific
  // named Skill, not a generic mechanic every actor has access to.
  const tauntItem = ownedSkill(resolved.actor, "Taunt")?.item;
  if (!tauntItem) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Taunt.NoTauntSkill"));
    return null;
  }

  const statKey = tauntItem.system.opposedStat || "int";
  const statMod = attackerActor.system.stats?.[statKey]?.mod ?? 0;
  const floor = game.settings.get("carl-rpg", "currentFloor");
  const difficulty = 10 + statMod + floor;
  // The rows the redirect would replace, as they are before the dialog: if
  // they change meanwhile, the redirect is refused (tauntRedirectNow).
  const seen = activeRows(message.getFlag("carl-rpg", "targetRows")).map((row) => row.id);

  return takeAction(resolved.actor, "other", game.i18n.localize("CARLRPG.Reaction.Op.taunt"), async () => {
    // The attacking Mob's own Debuffs lower this Difficulty too (p.96) -
    // rollOpposedSkillCheck offers them as dialog rows via `opponent`.
    const rollData = await CarlDice.rollOpposedSkillCheck(resolved.actor, tauntItem, {
      difficulty, opponent: attackerActor, skipDialog, post: false,
    });
    if (!rollData) return null; // Dialog cancelled - nothing to record, no Action spent.
    const { roll, breakdown, degree, debuffNote } = rollData;
    const success = isHitDegree(degree);

    const answer = await askGM(TAUNT, { cardId: message.id, taunterUuid, success, seen },
      { local: message.canUserModify(game.user, "update") });
    const outcome = answer?.outcome ?? null;

    // Posted once the card's writer has answered, so it says what happened.
    let subtitle = "CARLRPG.Taunt.Fail";
    if (outcome === "redirected") subtitle = "CARLRPG.Taunt.Success";
    else if (success) subtitle = outcome === "refused" ? "CARLRPG.Taunt.SuccessTooLate" : "CARLRPG.Taunt.SuccessUnanswered";
    await createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: tauntItem.name, detail: `vs. ${attackerActor.name}`, breakdown }],
      title: game.i18n.format("CARLRPG.Taunt.RollTitle", { name: resolved.actor.name }),
      img: resolved.actor.img,
      subtitle: game.i18n.localize(subtitle),
      badge: degreeBadge(degree),
      body: debuffNote ?? "",
      actor: resolved.actor,
      token: resolved.token,
    });
    // Undone (helpers/action-undo.mjs): the roll card goes (chat-card.mjs
    // notes it), and the Taunt button it used comes back. A redirect can't
    // be taken back - that Taunt's undo is refused.
    if (outcome === "redirected") noteUndo(resolved.actor, { t: "blocked", reason: "TauntRedirected" });
    else if (answer?.marked) noteUndo(resolved.actor, { t: "set", uuid: message.uuid, data: { "flags.carl-rpg.tauntedBy": null } });

    const name = resolved.actor.name;
    if (outcome === "redirected") ui.notifications.info(game.i18n.format("CARLRPG.Taunt.RedirectedNotice", { name }));
    else if (outcome === "failed") ui.notifications.info(game.i18n.format("CARLRPG.Taunt.FailedNotice", { name }));
    else if (outcome === "refused") ui.notifications.warn(game.i18n.format("CARLRPG.Taunt.TooLate", { name }));
    // Unanswered (no GM, or none in time - askGM said so): the roll was
    // still made, so the Action is still spent.
    return outcome ?? "unanswered";
  });
}

const TAUNT = "tauntRedirect";

/**
 * The writer's side of a Taunt from an Attack card, in the card's queue
 * (the one its rows' Applies are claimed in): checked against the card as
 * it is now, and written in one step.
 *  - `tauntedBy` - the Taunt button's one-shot doneFlag, set on any
 *    outcome - names the first Taunt made (`marked`: this one set it).
 *  - On a Success the Attack's target rows are swapped for one taunter row
 *    (old rows are marked replaced - flag subtrees can't be deleted by a
 *    merge update), its id allocated here - unless the card is locked now
 *    (a row Evaded, blocked or applied), or its rows aren't the ones the
 *    taunter saw (another Taunt took it): then refused.
 * @param {{cardId: string, taunterUuid: string, success: boolean, seen: string[]}} data
 * @param {User} user  Who asked.
 * @returns {Promise<{outcome: "redirected"|"failed"|"refused", marked: boolean}|null>}
 */
export function tauntRedirectNow({ cardId, taunterUuid, success, seen } = {}, user = game.user) {
  return withCardQueue(cardId, async () => {
    const message = game.messages.get(cardId);
    const taunter = taunterFrom(taunterUuid);
    if (!message || !taunter) return null;
    if (!user.isGM && !taunter.actor.testUserPermission(user, "OWNER")) return null;
    const flags = message.flags["carl-rpg"] ?? {};
    const marked = !flags.tauntedBy;
    const mark = async () => {
      if (marked) await message.update({ flags: { "carl-rpg": { tauntedBy: taunterUuid } } });
    };
    if (!success) {
      await mark();
      return { outcome: "failed", marked };
    }
    if (redirectRefused(message, taunterUuid, seen)) {
      await mark();
      return { outcome: "refused", marked };
    }
    const update = { tauntedBy: taunterUuid, targetUuids: [taunterUuid] };
    const rows = flags.targetRows;
    if (rows) {
      const row = taunterRow(message, taunter);
      update.targetRows = Object.fromEntries([
        ...Object.keys(rows).map((id) => [id, { replaced: true }]),
        [row.id, row],
      ]);
    }
    await message.update({ flags: { "carl-rpg": update } });
    return { outcome: "redirected", marked };
  });
}
// Registered at load: chat-socket.mjs is a leaf, evaluated before this module.
registerAskHandler(TAUNT, tauntRedirectNow);

/**
 * Whether a successful Taunt can't take the Attack now: it's settled (a
 * row Evaded, blocked or applied), an Area Attack, already aimed at the
 * taunter, or its rows aren't those the taunter saw before rolling.
 * @param {ChatMessage} message
 * @param {string} taunterUuid
 * @param {string[]} seen  The active row ids before the dialog.
 * @returns {boolean}
 */
function redirectRefused(message, taunterUuid, seen) {
  if (isCardLocked(message) || message.getFlag("carl-rpg", "isArea")) return true;
  if ((message.getFlag("carl-rpg", "targetUuids") ?? []).includes(taunterUuid)) return true;
  const now = activeRows(message.getFlag("carl-rpg", "targetRows")).map((row) => row.id);
  return !Array.isArray(seen) || now.length !== seen.length || now.some((id, i) => id !== seen[i]);
}

/** The taunter from its token or actor uuid, as resolveActingActor gives it. */
function taunterFrom(uuid) {
  let doc = null;
  try {
    doc = uuid ? fromUuidSync(uuid) : null;
  } catch {
    return null;
  }
  if (doc instanceof Actor) return { actor: doc, token: null };
  return doc?.actor ? { actor: doc.actor, token: doc } : null;
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
