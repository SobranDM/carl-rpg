/**
 * Grinding surplus (p.170): "If you've been grinding for more hours than
 * needed for a particular Skill, apply any additional hours to another
 * Skill (you can't bank hours for the same Skill)."
 *
 * When a grind overshoots a Skill's Rank, the extra hours are posted as a
 * chat card with an "Apply to another Skill" button. The card carries the
 * grinding actor's UUID (flag `grindSurplus.actorUuid`, and `data-actor-uuid`
 * on the button's wrapper) so the button and its dialog know whose Skills
 * to offer. Only the GM or that actor's owner sees the button (the shared
 * chat listener's canAct gating - module/chat/chat-listener.mjs). The dialog
 * lists only that actor's valid grind targets (module/helpers/grinding.mjs's
 * isGrindTarget), never the Skill the hours came from. Applying the hours
 * can overshoot again, which simply posts another card.
 */
import { applyGrindHours, isGrindTarget, grindTargetOptions } from "../helpers/grinding.mjs";
import { createCardMessage, esc } from "./chat-card.mjs";
import { canActOnUuidFlag, resolveTargetActor } from "./evade-link-card.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { showCarlDialog, rollButton, cancelButton } from "../apps/carl-dialog.mjs";


/** Surplus cards this client is applying right now - blocks a second click before the first lands. */
const inFlight = new Set();

/**
 * Cards this client has already spent. A player's "spent" write reaches the
 * card through the GM's client a moment later, so until then it's treated as
 * spent here - a second click can't apply the same hours again.
 */
const spentLocally = new Set();

/**
 * Grind hours into a Skill and, if they overshoot it, post the surplus card.
 * The single entry point for the GM Toolbox's Grind button and for this
 * card's own button.
 * @param {Actor} actor
 * @param {Item} item
 * @param {number} hours
 * @returns {Promise<{rolled: boolean, accrued: number, surplus: number}>}
 */
export async function grindAndOfferSurplus(actor, item, hours) {
  const result = await applyGrindHours(actor, item, hours);
  if (result.surplus > 0) await postGrindSurplusCard(actor, item, result.surplus);
  return result;
}

/**
 * @param {Actor} actor
 * @param {Item} sourceItem  The Skill the surplus came from.
 * @param {number} hours
 * @returns {Promise<ChatMessage>}
 */
export async function postGrindSurplusCard(actor, sourceItem, hours) {
  const button = `<div class="carl-grind-surplus" data-actor-uuid="${esc(actor.uuid)}">
    <button type="button" class="carl-grind-surplus-apply" data-action="applyGrindSurplus">
      <i class="fas fa-share"></i> ${game.i18n.localize("CARLRPG.Grind.ApplyButton")}
    </button>
  </div>`;
  return createCardMessage({
    title: game.i18n.localize("CARLRPG.Grind.SurplusTitle"),
    subtitle: game.i18n.format("CARLRPG.Grind.SurplusSubtitle", { hours }),
    body: `<p>${game.i18n.format("CARLRPG.Grind.SurplusBody", {
      name: esc(actor.name), hours, skill: esc(sourceItem.name),
    })}</p>`,
    footer: button,
    actor,
    flags: { grindSurplus: { actorUuid: actor.uuid, hours, sourceItemId: sourceItem.id } },
  });
}

/**
 * The actor's Skills that may take the surplus: valid grind targets other
 * than the one the hours came from.
 * @param {Actor} actor
 * @param {string} sourceItemId
 * @returns {Item[]}
 */
export function grindSurplusTargets(actor, sourceItemId) {
  return actor.items.filter((item) => item.id !== sourceItemId && isGrindTarget(actor, item));
}

async function onApplyGrindSurplus(event, message) {
  event.preventDefault();
  if (inFlight.has(message.id) || spentLocally.has(message.id)) return;
  inFlight.add(message.id);
  try {
    await applySurplus(message);
  } finally {
    inFlight.delete(message.id);
  }
}

async function applySurplus(message) {
  // A player can't mark someone else's card spent themselves - the GM's
  // client does it over the socket (module/helpers/chat-socket.mjs). With no
  // GM online that can't happen, so the hours aren't applied either (the
  // card would otherwise stay live and spend the same hours again).
  if (!message.canUserModify(game.user, "update") && !game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return;
  }
  const { actorUuid, hours = 0, sourceItemId } = message.getFlag("carl-rpg", "grindSurplus") ?? {};
  const actor = await resolveTargetActor(actorUuid);
  if (!actor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Grind.ActorGone"));
    return;
  }

  const targets = grindSurplusTargets(actor, sourceItemId);
  if (!targets.length) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Grind.NoTargets", { name: actor.name }));
    return;
  }

  const options = grindTargetOptions(targets);
  const result = await showCarlDialog({
    title: game.i18n.format("CARLRPG.Grind.PickTitle", { hours }),
    content: `<div class="carl-dialog-body"><div class="form-group">
      <label>${game.i18n.format("CARLRPG.Grind.PickPrompt", { name: esc(actor.name), hours })}</label>
      <select name="itemId">${options}</select>
    </div></div>`,
    buttons: [rollButton({ label: "CARLRPG.Grind.ApplyConfirm" }), cancelButton()],
  });
  if (!result) return;

  // Re-validate at click time - the actor's Skills can change while the
  // dialog is open - and spend the card before applying, so a second click
  // can't apply the same hours twice.
  const item = actor.items.get(result.itemId);
  if (!item || item.id === sourceItemId || !isGrindTarget(actor, item)) return;
  if (message.getFlag("carl-rpg", "grindSurplusApplied") || spentLocally.has(message.id)) return;
  spentLocally.add(message.id);
  await updateCardMessage(message, { flags: { "carl-rpg": { grindSurplusApplied: true } } });
  await grindAndOfferSurplus(actor, item, hours);
}

export const grindSurplusActionEntries = [{
  action: "applyGrindSurplus",
  buttonSelector: ".carl-grind-surplus-apply",
  wrapperSelector: ".carl-grind-surplus",
  canAct: (m) => canActOnUuidFlag(m, "grindSurplus.actorUuid"),
  doneFlag: "grindSurplusApplied",
  doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Grind.Applied")}`,
  onClick: onApplyGrindSurplus,
}];
