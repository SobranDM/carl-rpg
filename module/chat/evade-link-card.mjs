/**
 * Shared Evade pieces for Attack cards. The Evade roll itself is per target
 * now - each target row on an Attack card has its own Roll Evade (module/
 * chat/attack-targets-card.mjs) - so this module keeps what that flow and
 * the other cards share:
 *  - the PvP Evade Difficulty rule (resolveEvadeDifficulty);
 *  - the GM/owner gate many card buttons use (canActOnUuidFlag);
 *  - the Evade outcome card's "Add Minor/Major Injury Debuff" button for a
 *    Major or Critical Fail (p.79-80) - never auto-applied.
 */
import { addConditionToActor } from "../helpers/conditions.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";

const CONSEQUENCE_FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/evade-consequence-footer.hbs";

/**
 * Render the "Add Minor/Major Injury Debuff" footer for an Evade-outcome
 * card that came back Major or Critical Fail.
 * @param {string} debuffKey  "minorInjury" | "majorInjury"
 * @returns {Promise<string>}
 */
export async function buildEvadeConsequenceFooter(debuffKey) {
  const { renderTemplate } = foundry.applications.handlebars;
  const debuffButtonLabel = game.i18n.localize(
    debuffKey === "majorInjury" ? "CARLRPG.Evade.AddMajorInjury" : "CARLRPG.Evade.AddMinorInjury"
  );
  return renderTemplate(CONSEQUENCE_FOOTER_TEMPLATE, { debuffButtonLabel });
}

/**
 * Resolve a snapshotted token/actor UUID back to its Actor, if it (and its
 * scene) still exist. Tokens/scenes can be deleted between roll time and
 * click time - callers must tolerate nulls.
 * @param {string} uuid
 * @returns {Promise<Actor|null>}
 */
export async function resolveTargetActor(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  return doc instanceof Actor ? doc : (doc.actor ?? null);
}

/**
 * Whether the current user owns the actor behind a token/actor uuid (a GM
 * always does).
 * @param {string} uuid
 * @returns {boolean}
 */
export function userOwnsUuid(uuid) {
  if (game.user.isGM) return true;
  try {
    const doc = fromUuidSync(uuid);
    const actor = doc instanceof Actor ? doc : doc?.actor;
    return !!actor?.isOwner;
  } catch (e) {
    return false;
  }
}

/**
 * @param {ChatMessage} message
 * @param {string} flagKey  A flag holding either one UUID or an array of them.
 * @returns {boolean} Whether the current user may act on this button - a GM
 *   always can; otherwise only if they own at least one snapshotted actor.
 */
export function canActOnUuidFlag(message, flagKey) {
  if (game.user.isGM) return true;
  const uuids = [message.getFlag("carl-rpg", flagKey)].flat().filter(Boolean);
  return uuids.some((uuid) => userOwnsUuid(uuid));
}

/**
 * Considerate Play and PvP (Carl RPG p.87): when both the attacker and the
 * defender are Characters, the attacker's own rolled Attack total becomes
 * the Evade Difficulty. Otherwise (Evade Interrupt Action, p.81, vs. a
 * Mob on either side), the already-computed static formula applies.
 * @param {{attackerType: string, defenderType: string, attackTotal: number, targetDifficulty: number|null}} args
 * @returns {number|null}
 */
export function resolveEvadeDifficulty({ attackerType, defenderType, attackTotal, targetDifficulty }) {
  return (attackerType === "character" && defenderType === "character") ? attackTotal : targetDifficulty;
}

/**
 * Add the Debuff a Major/Critical Fail outcome calls for - one click,
 * exactly like every other Condition write in this codebase
 * (module/helpers/conditions.mjs's addConditionToActor); never silent.
 * @param {PointerEvent} event
 * @param {ChatMessage} message  The Evade-outcome chat message.
 */
async function onAddEvadeDebuff(event, message) {
  event.preventDefault();
  const uuid = message.getFlag("carl-rpg", "debuffActorUuid");
  const debuffKey = message.getFlag("carl-rpg", "debuffKey");
  const actor = await resolveTargetActor(uuid);
  if (!actor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Evade.NoActor"));
    return;
  }

  await addConditionToActor(actor, debuffKey, { source: game.i18n.localize("CARLRPG.Roll.Evade") });
  await updateCardMessage(message, { flags: { "carl-rpg": { debuffAdded: true } } });
  ui.notifications.info(game.i18n.format("CARLRPG.Evade.DebuffAddedNotice", { name: actor.name }));
}

/**
 * Registry entries consumed by the shared registerChatListener (module/chat/
 * chat-listener.mjs).
 */
export const evadeActionEntries = [
  // Attack cards posted before the per-target rows still carry the old
  // single "Roll Evade" button - say so instead of ignoring the click.
  {
    action: "rollEvade",
    custom: true,
    onClick: (event) => {
      event.preventDefault();
      ui.notifications.warn(game.i18n.localize("CARLRPG.Targets.OldCard"));
    },
  },
  {
    action: "addEvadeDebuff",
    buttonSelector: ".carl-add-evade-debuff",
    wrapperSelector: ".carl-evade-consequence",
    canAct: (m) => canActOnUuidFlag(m, "debuffActorUuid"),
    doneFlag: "debuffAdded",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Evade.DebuffAdded")}`,
    onClick: onAddEvadeDebuff,
  },
];
