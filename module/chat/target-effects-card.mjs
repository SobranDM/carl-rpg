/**
 * The "Apply to Target(s)" button on an Attack chat card - the write side of
 * the target-effect pipeline (module/helpers/modifiers.mjs's
 * collectItemTargetEffects builds the read side). See docs/known-gaps.md 1.1
 * (now resolved) for the original gap writeup.
 *
 * Targets are never re-resolved at click time: CarlDice.rollAttack
 * (module/dice/dice.mjs) snapshots game.user.targets at roll time and stores
 * the token UUIDs as chat message flags, so clicking this button (possibly
 * much later, after the roller has re-targeted something else) still only
 * ever affects whoever was actually targeted by that roll.
 */
import { addConditionToActor, resolveTargetEffectLabel } from "../helpers/conditions.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/target-effects-footer.hbs";

/**
 * Render the chat-card footer listing what this roll's hit will apply,
 * plus the "Apply to Target(s)" button. Only ever called when
 * targetEffects.length > 0 (see CarlDice.rollAttack).
 * @param {Array<{id: string, debuffKey: string, stacks: number, label: string, sourceLabel: string}>} targetEffects
 * @returns {Promise<string>}
 */
export async function buildTargetEffectsFooter(targetEffects) {
  const { renderTemplate } = foundry.applications.handlebars;
  const effects = targetEffects.map((te) => ({ ...te, displayLabel: resolveTargetEffectLabel(te) }));
  return renderTemplate(FOOTER_TEMPLATE, { effects });
}

/**
 * Resolve a snapshotted token UUID back to its Actor, if it (and its scene)
 * still exist. Tokens/scenes can be deleted between roll time and click
 * time - callers must tolerate nulls.
 * @param {string} uuid
 * @returns {Promise<Actor|null>}
 */
async function resolveTargetActor(uuid) {
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  if (doc instanceof Actor) return doc;
  return doc.actor ?? null;
}

/**
 * @param {ChatMessage} message
 * @returns {boolean} Whether the current user may click Apply for this card -
 *   a GM always can; otherwise only if they own at least one snapshotted target.
 */
function canApplyTargetEffects(message) {
  if (game.user.isGM) return true;
  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  return targetUuids.some((uuid) => {
    try {
      const doc = fromUuidSync(uuid);
      const actor = doc instanceof Actor ? doc : doc?.actor;
      return !!actor?.isOwner;
    } catch (e) {
      return false;
    }
  });
}

/**
 * Apply every snapshotted targetEffect to every snapshotted target, then
 * flag the message so the button can't double-apply on a later re-render.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
async function onApplyTargetEffects(event, message) {
  event.preventDefault();
  const targetEffects = message.getFlag("carl-rpg", "targetEffects") ?? [];
  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  if (!targetEffects.length) return;

  const actors = new Map();
  for (const uuid of targetUuids) {
    const actor = await resolveTargetActor(uuid);
    if (actor) actors.set(actor.uuid, actor);
  }
  if (!actors.size) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.TargetEffects.NoTargets"));
    return;
  }

  for (const actor of actors.values()) {
    for (const te of targetEffects) {
      await addConditionToActor(actor, te.debuffKey, {
        stacks: te.stacks,
        source: te.sourceLabel,
        label: te.label,
      });
    }
  }

  await message.setFlag("carl-rpg", "targetEffectsApplied", true);
  ui.notifications.info(game.i18n.format("CARLRPG.TargetEffects.AppliedNotice", { count: actors.size }));
}

/**
 * Wire up every rendered chat card's Apply button: hide it from anyone who
 * isn't the GM or an owner of at least one snapshotted target, and reflect
 * an already-applied card as disabled (so it can't be double-clicked after
 * scrolling it back into view).
 */
export function registerTargetEffectsChatListener() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const btn = html.querySelector(".carl-apply-target-effects");
    if (!btn) return;

    if (!canApplyTargetEffects(message)) {
      btn.closest(".carl-target-effects")?.remove();
      return;
    }

    if (message.getFlag("carl-rpg", "targetEffectsApplied")) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.TargetEffects.Applied")}`;
      return;
    }

    btn.addEventListener("click", (event) => onApplyTargetEffects(event, message));
  });
}
