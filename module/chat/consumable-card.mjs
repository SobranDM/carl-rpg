/**
 * The chat card for a used consumable (module/helpers/consumables.mjs):
 * what it does, who it went to and - when the user could apply it - what
 * happened. When the user can't update the recipient (a potion poured into
 * another player's crawler), the card carries an Apply button for the GM or
 * the recipient's owner instead, with the effects snapshotted on the card so
 * it still works after the last one is used up.
 */
import { CARLRPG } from "../helpers/config.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { appendCardSection, createCardMessage, createRollMessage, esc } from "./chat-card.mjs";
import { canActOnUuidFlag, resolveTargetActor } from "./evade-link-card.mjs";
import { applyConsumableEffects, hasBuff } from "../helpers/consumables.mjs";

const SCOPE = "carl-rpg";

/**
 * Human-readable list of what a consumable does.
 * @param {object|null} effects  system.consumable
 * @param {string} [itemName]  Names an unnamed Buff, as the applied one is.
 * @returns {string[]}
 */
export function describeConsumable(effects, itemName = "") {
  if (!effects) return [];
  const t = (key, data = {}) => game.i18n.format(`CARLRPG.Consumable.Does.${key}`, data);
  const out = [];
  const heal = effects.heal ?? {};
  if (heal.full) out.push(t("HealFull"));
  else if (heal.slots) out.push(t("Heal", { slots: heal.slots }));
  if (heal.mend === "minor") out.push(t("MendMinor"));
  else if (heal.mend === "any") out.push(t("MendAny"));
  const mana = effects.mana ?? {};
  if (mana.full) out.push(t("ManaFull"));
  else if (mana.amount) out.push(t("Mana", { amount: mana.amount }));
  for (const key of effects.cures ?? []) {
    const label = CARLRPG.debuffs[key]?.label;
    out.push(t("Cure", { debuff: label ? game.i18n.localize(label) : esc(key) }));
  }
  const permanent = effects.permanent ?? {};
  if (permanent.kind === "stat" && permanent.target) {
    out.push(t("Stat", { value: permanent.value, stat: game.i18n.localize(CARLRPG.statAbbreviations[permanent.target] ?? permanent.target) }));
  } else if (permanent.kind === "skill") {
    out.push(t("Skill", { value: permanent.value, skill: esc(permanent.target || game.i18n.localize("CARLRPG.Consumable.AnySkill")) }));
  }
  const buff = effects.buff ?? {};
  const perRound = buff.perRound ?? {};
  if (hasBuff(buff)) {
    const label = esc(buff.label || itemName);
    const duration = buff.duration
      ? t("BuffFor", { buff: label, duration: buff.duration, unit: game.i18n.localize(`CARLRPG.Consumable.Unit.${buff.unit}`) })
      : t("Buff", { buff: label });
    const restores = [
      perRound.hb ? t("PerRoundHb", { amount: perRound.hb }) : null,
      perRound.mana ? t("PerRoundMana", { amount: perRound.mana }) : null,
    ].filter(Boolean);
    out.push(restores.length ? `${duration} (${restores.join(", ")})` : duration);
  }
  return out;
}

const list = (lines) => (lines?.length ? `<ul class="carl-consumable-list">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : "");

/**
 * Post the card for a used consumable.
 * @param {object} args
 * @param {Actor} args.actor       Who used it.
 * @param {Actor} args.recipient   Who it went to.
 * @param {{name: string, img: string}} args.item
 * @param {object|null} args.effects  Snapshot of system.consumable (null: nothing left to apply).
 * @param {boolean} [args.isPotion]
 * @param {{combatId: string, round: number}|null} [args.drankAt]  The fight and round it was used in
 *   (Potion Sickness; whether a round-measured Buff counts rounds).
 * @param {string[]|null} [args.lines]  Results, when already applied; null = not yet.
 * @param {Roll[]} [args.rolls]
 * @param {object[]} [args.rollMeta]
 * @returns {Promise<ChatMessage>}
 */
export async function postConsumableCard({ actor, recipient, item, effects, isPotion = false, drankAt = null, lines = null, rolls = [], rollMeta = [] }) {
  const pending = lines === null && !!effects;
  const subtitle = recipient.uuid === actor.uuid
    ? game.i18n.format("CARLRPG.Consumable.UsedBy", { name: actor.name })
    : game.i18n.format("CARLRPG.Consumable.GivenTo", { name: actor.name, target: recipient.name });
  const body = list(lines ?? describeConsumable(effects, item.name));
  const flags = {
    consumableRecipientUuid: recipient.uuid,
    consumableItemName: item.name,
    consumableApplied: !pending,
  };
  if (pending) {
    flags.consumableEffects = effects;
    flags.consumableIsPotion = isPotion;
    flags.consumableDrankAt = drankAt;
  }
  const footer = pending
    ? `<div class="carl-consumable-apply">
        <button type="button" class="carl-apply-consumable" data-action="applyConsumable">
          <i class="fas fa-flask"></i> ${game.i18n.format("CARLRPG.Consumable.ApplyTo", { name: esc(recipient.name) })}
        </button></div>`
    : undefined;
  const common = { title: item.name, subtitle, img: item.img, body, footer, flags, actor };
  return rolls.length ? createRollMessage({ ...common, rolls, rollMeta }) : createCardMessage(common);
}

// Cards being applied on this client - a second click while the first is
// still running does nothing.
const applying = new Set();

async function onApplyConsumable(event, message) {
  event.preventDefault();
  if (applying.has(message.id)) return;
  const recipient = await resolveTargetActor(message.getFlag(SCOPE, "consumableRecipientUuid"));
  if (!recipient) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Consumable.NoRecipient"));
    return;
  }
  applying.add(message.id);
  try {
    const lines = await applyConsumableEffects(recipient, message.getFlag(SCOPE, "consumableEffects") ?? {}, {
      itemName: message.getFlag(SCOPE, "consumableItemName") ?? "",
      isPotion: !!message.getFlag(SCOPE, "consumableIsPotion"),
      drankAt: message.getFlag(SCOPE, "consumableDrankAt") ?? null,
    });
    // Marked applied only once the effects are in - if they fail, Apply
    // stays available to try again.
    await updateCardMessage(message, {
      flags: { [SCOPE]: { consumableApplied: true } },
      ...(lines.length ? { content: appendCardSection(message, list(lines)) } : {}),
    });
  } catch (err) {
    console.error("CarlRPG | Applying a consumable failed", err);
    ui.notifications.error(game.i18n.localize("CARLRPG.Consumable.ApplyFailed"));
  } finally {
    applying.delete(message.id);
  }
}

/** Registry entry for module/chat/chat-listener.mjs. */
export const consumableActionEntries = [{
  action: "applyConsumable",
  buttonSelector: ".carl-apply-consumable",
  wrapperSelector: ".carl-consumable-apply",
  canAct: (m) => canActOnUuidFlag(m, "consumableRecipientUuid"),
  doneFlag: "consumableApplied",
  doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Consumable.Applied")}`,
  onClick: onApplyConsumable,
}];
