/**
 * The "Apply Damage" button on an Attack chat card - the write side of the
 * damage-type pipeline (docs/known-gaps.md 1.3/1.7). module/dice/dice.mjs's
 * CarlDice.rollAttack rolls per-damage-type subtotals (grouped by
 * buildDamageRollParts) and stores them as chat message flags; this is the
 * FIRST "roll damage, then apply a computed reduction to a target's HB"
 * mechanism in the codebase, so it mirrors the now-twice-proven pattern from
 * module/chat/target-effects-card.mjs and module/chat/heal-card.mjs as
 * closely as possible rather than inventing a new shape:
 *  - targets are never re-resolved at click time - rollAttack already
 *    snapshots game.user.targets at roll time (module/chat/
 *    target-effects-card.mjs's targetUuids flag, reused here rather than
 *    re-captured);
 *  - the actual DR -> Resistance -> Vulnerability -> Immunity -> whole-slot
 *    math (module/helpers/damage-pipeline.mjs) runs HERE, on click, against
 *    each target's THEN-CURRENT system.resistances/system.dr - not
 *    snapshotted at roll time, since (unlike the debuff/heal amount) the
 *    correct reduction genuinely depends on live target state and could
 *    reasonably change between roll and apply (e.g. a Debuff granting
 *    temporary Resistance lands in between);
 *  - a message flag (`damageApplied`) guards against double-apply, gated to
 *    the GM or an owner of at least one snapshotted target.
 *
 * An attack that both applies a targetEffect AND deals damage (e.g. Fire
 * Fingers Rank 10) renders BOTH footers in the same card - see
 * CarlDice.rollAttack, which concatenates buildTargetEffectsFooter's and
 * this module's buildDamageFooter's HTML. The two buttons are independent:
 * either can be clicked (or not) without affecting the other.
 */
import { computeDamageApplication } from "../helpers/damage-pipeline.mjs";
import { createCardMessage } from "./chat-card.mjs";
import { CARLRPG } from "../helpers/config.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/damage-footer.hbs";

function damageTypeLabel(type) {
  if (!type) return game.i18n.localize("CARLRPG.Roll.Damage");
  return game.i18n.localize(CARLRPG.damageTypes[type] ?? type);
}

/**
 * Render the chat-card footer listing this roll's raw per-type damage
 * subtotals, plus the "Apply Damage" button. Only ever called when at least
 * one type's subtotal is nonzero (see CarlDice.rollAttack).
 * @param {Record<string, number>} damageByType
 * @returns {Promise<string>}
 */
export async function buildDamageFooter(damageByType) {
  const { renderTemplate } = foundry.applications.handlebars;
  const portions = Object.entries(damageByType ?? {})
    .filter(([, amount]) => amount)
    .map(([type, amount]) => ({ label: damageTypeLabel(type), amount }));
  return renderTemplate(FOOTER_TEMPLATE, { portions });
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
function canApplyDamage(message) {
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
 * Format one target's pipeline result as a readable digest line, e.g.
 * "Bludgeoning 8; Fire 4 -> 2 (Resisted) = 10 total, 2 slot(s) lost." Every
 * other roll/apply flow in this system shows its math in the chat log, not
 * just a toast - this is the GM-facing counterpart to that, since a
 * target's resistances/DR are often GM-only information (see the whisper in
 * the caller).
 * @param {Actor} actor
 * @param {{perType: Array<{type: string, raw: number, afterDr: number, state: string, final: number}>, totalFinalDamage: number, slotsLost: number}} result
 * @returns {string}
 */
function formatDamageDigestLine(actor, result) {
  const parts = result.perType.map((p) => {
    const label = damageTypeLabel(p.type);
    if (p.state === "none" && p.afterDr === p.raw) return `${label} ${p.final}`;
    const stateLabel = p.state === "none" ? "" : ` (${game.i18n.localize(CARLRPG.resistanceStates[p.state] ?? p.state)})`;
    return `${label} ${p.raw} -> ${p.final}${stateLabel}`;
  });
  // Shield absorption (docs/known-gaps.md 1.4) happens ahead of DR/per-type
  // resistance, so it's surfaced as its own leading segment rather than
  // folded into one of the per-type entries above.
  if (result.shieldAbsorbed > 0) {
    parts.unshift(game.i18n.format("CARLRPG.Damage.DigestShield", { absorbed: result.shieldAbsorbed, slots: result.shieldSlotsLost }));
  }
  return game.i18n.format("CARLRPG.Damage.DigestLine", {
    name: actor.name,
    parts: parts.join("; "),
    total: result.totalFinalDamage,
    slots: result.slotsLost,
  });
}

/**
 * Run the damage pipeline against every snapshotted target's current
 * resistances/dr and apply the resulting whole-slot HB loss, then flag the
 * message so the button can't double-apply on a later re-render. Posts a
 * GM-whispered follow-up card showing exactly what the pipeline did per
 * target/type - Apply Damage previously only surfaced a bare "applied to N
 * target(s)" toast with the DR/Resistance/Vulnerability/Immunity math and
 * slots-lost count entirely invisible after the fact.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
async function onApplyDamage(event, message) {
  event.preventDefault();
  const damageByType = message.getFlag("carl-rpg", "damageByType") ?? {};
  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  // Defaults to magical (docs/known-gaps.md 1.4) - matches
  // computeDamageApplication's own default, so an older chat card missing
  // this flag (from before this phase) never lets Shield intercept damage.
  const isMagic = message.getFlag("carl-rpg", "damageIsMagic") ?? true;
  if (!Object.values(damageByType).some((v) => v)) return;

  const actors = new Map();
  for (const uuid of targetUuids) {
    const actor = await resolveTargetActor(uuid);
    if (actor) actors.set(actor.uuid, actor);
  }
  if (!actors.size) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Damage.NoTargets"));
    return;
  }

  const digestLines = [];
  for (const actor of actors.values()) {
    const result = computeDamageApplication(damageByType, actor, isMagic);
    digestLines.push(formatDamageDigestLine(actor, result));
    // Both writes are batched into one actor.update() call, per shield and
    // HB both potentially changing from the same hit - avoids two separate
    // awaited writes racing/double-rendering (docs/known-gaps.md 1.4).
    const updates = {};
    if (result.shieldSlotsLost > 0) {
      const currentShield = actor.system.shield?.value ?? 0;
      updates["system.shield.value"] = Math.max(0, currentShield - result.shieldSlotsLost);
    }
    if (result.slotsLost > 0) {
      const currentHb = actor.system.hb?.value ?? 0;
      updates["system.hb.value"] = Math.max(0, currentHb - result.slotsLost);
    }
    if (Object.keys(updates).length) await actor.update(updates);
  }

  await message.setFlag("carl-rpg", "damageApplied", true);
  ui.notifications.info(game.i18n.format("CARLRPG.Damage.AppliedNotice", { count: actors.size }));
  await createCardMessage({
    title: game.i18n.localize("CARLRPG.Damage.DigestTitle"),
    body: `<ul>${digestLines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
    whisper: ChatMessage.getWhisperRecipients("GM"),
  });
}

/**
 * Wire up every rendered chat card's Apply Damage button: hide it from
 * anyone who isn't the GM or an owner of at least one snapshotted target,
 * and reflect an already-applied card as disabled (so it can't be
 * double-clicked after scrolling it back into view).
 */
export function registerDamageChatListener() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const btn = html.querySelector(".carl-apply-damage");
    if (!btn) return;

    if (!canApplyDamage(message)) {
      btn.closest(".carl-damage-card")?.remove();
      return;
    }

    if (message.getFlag("carl-rpg", "damageApplied")) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Damage.Applied")}`;
      return;
    }

    btn.addEventListener("click", (event) => onApplyDamage(event, message));
  });
}
