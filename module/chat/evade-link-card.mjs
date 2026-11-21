/**
 * Shared Evade pieces for Attack cards. The Evade roll itself is per target
 * now - each target row on an Attack card has its own Roll Evade (module/
 * chat/attack-targets-card.mjs) - so this module keeps what that flow and
 * the other cards share:
 *  - the PvP Evade Difficulty rule (resolveEvadeDifficulty);
 *  - the GM/owner gate many card buttons use (canActOnUuidFlag);
 *  - the "Add Minor/Major Injury Debuff" button on Evade outcome cards
 *    posted before a row's Evade was kept on the row (module/chat/
 *    row-evade.mjs) - their stored markup still carries it.
 */
import { addConditionToActor } from "../helpers/conditions.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { ownsUuid } from "../helpers/token-resolution.mjs";

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
 * @param {ChatMessage} message
 * @param {string} flagKey  A flag holding either one UUID or an array of them.
 * @returns {boolean} Whether the current user may act on this button - a GM
 *   always can; otherwise only if they own at least one snapshotted actor.
 */
export function canActOnUuidFlag(message, flagKey) {
  if (game.user.isGM) return true;
  const uuids = [message.getFlag("carl-rpg", flagKey)].flat().filter(Boolean);
  return uuids.some((uuid) => ownsUuid(uuid));
}

/**
 * Considerate Play and PvP (Carl RPG p.87): when both the attacker and the
 * defender are Characters, the attacker's own rolled Attack total becomes
 * the Evade Difficulty. Otherwise (Evade Interrupt Action, p.81, vs. a
 * Mob on either side), the already-computed static formula applies.
 * @param {{attackerType: string, defenderType: string, attackTotal: number, targetDifficulty: number|null}} args
 * @returns {number|null}
 */
export function resolveEvadeDifficulty({
  attackerType,
  defenderType,
  attackTotal,
  targetDifficulty,
}) {
  return rollsLikeCrawler(attackerType) && rollsLikeCrawler(defenderType)
    ? attackTotal
    : targetDifficulty;
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

  if (
    !(await addConditionToActor(actor, debuffKey, {
      source: game.i18n.localize("CARLRPG.Roll.Evade"),
    }))
  )
    return;
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
    doneLabel: () =>
      `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Evade.DebuffAdded")}`,
    onClick: onAddEvadeDebuff,
  },
];
