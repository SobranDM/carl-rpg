/**
 * The "Apply Healing" (+ optional "Mend Debuff") buttons on a Heal roll's
 * chat card - the write side of CarlDice.rollHeal (module/dice/dice.mjs),
 * see docs/known-gaps.md 1.2. Mirrors the target-effect pipeline's shape
 * (module/chat/target-effects-card.mjs): the roll only ever snapshots what
 * it needs as chat message flags, the actual system.hb.value/
 * system.conditions writes happen here, on click, gated to GM/owner, with a
 * flag-based double-apply guard.
 *
 * Heal Self only ever targets the caster (`range: "Self only"`), so
 * rollHeal only snapshots the caster's own UUID (`healActorUuid`), not
 * `game.user.targets` the way rollAttack's target-effect flow does. A
 * future ally-targeting Heal spell would need its own targets snapshot and
 * an actor picker here; deliberately not built ahead of a real use case.
 */
import { removeConditionFromActor } from "../helpers/conditions.mjs";
import { shortRestUpdates } from "../helpers/rest.mjs";
import { showCarlDialog, rollButton, cancelButton } from "../apps/carl-dialog.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/heal-footer.hbs";

/**
 * Render the chat-card footer: the healing summary, an "Apply Healing"
 * button, and (only when the unlocked tier grants it) a "Mend Debuff"
 * button.
 * @param {{full?: boolean, amount?: number, canMend?: boolean}} options
 * @returns {Promise<string>}
 */
export async function buildHealFooter({ full = false, amount = 0, canMend = false } = {}) {
  const { renderTemplate } = foundry.applications.handlebars;
  const summary = full
    ? game.i18n.localize("CARLRPG.Heal.WillHealFull")
    : game.i18n.format("CARLRPG.Heal.WillHeal", { amount });
  return renderTemplate(FOOTER_TEMPLATE, { summary, canMend });
}

/**
 * @param {string} uuid
 * @returns {Promise<Actor|null>}
 */
async function resolveHealActor(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  return doc instanceof Actor ? doc : (doc.actor ?? null);
}

/**
 * @param {ChatMessage} message
 * @returns {boolean} Whether the current user may click Apply/Mend for this
 *   card - a GM always can; otherwise only the owner of the snapshotted actor.
 */
function canApplyHeal(message) {
  if (game.user.isGM) return true;
  const uuid = message.getFlag("carl-rpg", "healActorUuid");
  if (!uuid) return false;
  try {
    const doc = fromUuidSync(uuid);
    const actor = doc instanceof Actor ? doc : doc?.actor;
    return !!actor?.isOwner;
  } catch (e) {
    return false;
  }
}

/**
 * Apply the snapshotted healing to the snapshotted actor, then flag the
 * message so the button can't double-apply on a later re-render.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
async function onApplyHeal(event, message) {
  event.preventDefault();
  const uuid = message.getFlag("carl-rpg", "healActorUuid");
  const actor = await resolveHealActor(uuid);
  if (!actor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Heal.NoActor"));
    return;
  }

  const full = message.getFlag("carl-rpg", "healFull") ?? false;
  const amount = message.getFlag("carl-rpg", "healAmount") ?? 0;
  const sys = actor.system;
  const effectiveMax = sys.hb?.effectiveMax ?? sys.hb?.max ?? 0;

  // "Heal to full" (Rank 15) reuses the Short Rest formula for the Mana
  // half-restore it also grants, but overrides hb.value straight to
  // effectiveMax rather than the Short Rest's flat "+5" - see
  // docs/known-gaps.md 1.2 and module/helpers/rest.mjs.
  const updates = full
    ? { ...shortRestUpdates(actor), "system.hb.value": effectiveMax }
    : { "system.hb.value": Math.min((sys.hb?.value ?? 0) + amount, effectiveMax) };

  // Rank 15's "benefits of a short rest" additionally clears every Minor
  // Injury outright, on top of the Short Rest's own hb/mana formula - this
  // happens before (and independently of) the separate Mend Debuff button,
  // which still lets the caster pick one more Debuff/Major Injury to remove.
  if (full) {
    updates["system.conditions"] = (sys.conditions ?? []).filter((c) => c.key !== "minorInjury");
  }

  await actor.update(updates);
  await updateCardMessage(message, { flags: { "carl-rpg": { healApplied: true } } });
  ui.notifications.info(game.i18n.format("CARLRPG.Heal.AppliedNotice", { name: actor.name }));
}

/**
 * Remove one entry from the actor's current `system.conditions` - directly,
 * if there's only one to choose from, otherwise via a picker dialog. Kept
 * deliberately simple, per docs/known-gaps.md 1.2 - no attempt to filter the
 * list to conditions matching the tier's descriptive scope ("Minor Injury,
 * Poison, or Disease" / "Major Injury or other Debuff"); the caster picks
 * from everything currently on the actor.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
async function onMendDebuff(event, message) {
  event.preventDefault();
  const uuid = message.getFlag("carl-rpg", "healActorUuid");
  const actor = await resolveHealActor(uuid);
  if (!actor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Heal.NoActor"));
    return;
  }

  const conditions = actor.system.conditions ?? [];
  if (!conditions.length) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Heal.NoConditions", { name: actor.name }));
    return;
  }

  // Only one Debuff to mend - just remove it, no need to make the player
  // pick from a list of one.
  if (conditions.length === 1) {
    await removeConditionFromActor(actor, 0);
    await updateCardMessage(message, { flags: { "carl-rpg": { healMended: true } } });
    ui.notifications.info(game.i18n.format("CARLRPG.Heal.MendedNotice", { name: actor.name }));
    return;
  }

  const options = conditions
    .map((c, i) => `<option value="${i}">${foundry.utils.escapeHTML(c.label || c.key)}</option>`)
    .join("");
  const result = await showCarlDialog({
    title: game.i18n.localize("CARLRPG.Heal.MendTitle"),
    content: `<div class="carl-dialog-body"><div class="form-group">
      <select name="index">${options}</select>
    </div></div>`,
    buttons: [rollButton({ label: "CARLRPG.Heal.MendConfirm" }), cancelButton()],
  });
  if (!result) return;

  const index = Number(result.index);
  if (!Number.isInteger(index) || !conditions[index]) return;
  await removeConditionFromActor(actor, index);
  await updateCardMessage(message, { flags: { "carl-rpg": { healMended: true } } });
  ui.notifications.info(game.i18n.format("CARLRPG.Heal.MendedNotice", { name: actor.name }));
}

/**
 * Registry entries consumed by the shared registerChatListener (module/chat/
 * chat-listener.mjs) - preserves this pair's GM/owner visibility gating and
 * one-shot "already used" disabling per button (one cast grants exactly one
 * Mend, same as it grants exactly one Apply). Both share `.carl-heal-card`
 * as their wrapperSelector; if `!canApplyHeal`, the second `.remove()` call
 * is a harmless no-op on an already-removed element.
 */
export const healActionEntries = [
  {
    action: "applyHeal",
    buttonSelector: ".carl-apply-heal",
    wrapperSelector: ".carl-heal-card",
    canAct: canApplyHeal,
    doneFlag: "healApplied",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Heal.Applied")}`,
    onClick: onApplyHeal,
  },
  {
    action: "mendDebuff",
    buttonSelector: ".carl-mend-debuff",
    wrapperSelector: ".carl-heal-card",
    canAct: canApplyHeal,
    doneFlag: "healMended",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Heal.Mended")}`,
    onClick: onMendDebuff,
  },
];
