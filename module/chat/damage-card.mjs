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
import {
  changeConditions,
  dyingRounds,
  removeConditionsWithMechanic,
} from "../helpers/conditions.mjs";
import { appendCardSection, esc } from "./chat-card.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { ownsUuid } from "../helpers/token-resolution.mjs";
import { damageTypeLabel } from "../helpers/damage-types.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/damage-footer.hbs";

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
export function canApplyDamage(message) {
  if (game.user.isGM) return true;
  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  return targetUuids.some((uuid) => ownsUuid(uuid));
}

/**
 * Format one target's pipeline result as its digest line: the target's
 * name, then the hit's math, each term named, and what it cost as chips -
 * e.g. "Pack Rat (2)" over "[1 Slot] 4 - 1 (DR) = 3 damage". The
 * terms follow the pipeline's order: Shield (non-magic only), DR, then each
 * damage type's Resistance, Vulnerability or Immunity. GM-facing, since a
 * target's resistances/DR are often GM-only information (see the
 * .carl-gm-only fold-in in the caller).
 * @param {Actor} actor
 * @param {{perType: Array<{type: string, raw: number, afterDr: number, state: string, final: number}>, totalFinalDamage: number, slotsLost: number, shieldAbsorbed: number, shieldSlotsLost: number, drApplied: number}} result
 * @returns {string}
 */
function formatDamageDigestLine(actor, result) {
  const i18n = game.i18n;
  const term = (amount, label) => `${amount} <span class="carl-digest-term">(${esc(label)})</span>`;
  const raw = result.perType.reduce((sum, p) => sum + p.raw, 0);
  const shield = result.shieldAbsorbed ?? 0;
  const dr = result.drApplied ?? 0;

  let math = String(raw);
  let changed = false;
  if (shield > 0) {
    math += ` - ${term(shield, i18n.localize("CARLRPG.Damage.Digest.Shield"))}`;
    changed = true;
  }
  // A negative DR (a Debuff's) adds to the hit.
  if (dr) {
    math += ` ${dr > 0 ? "-" : "+"} ${term(Math.abs(dr), i18n.localize("CARLRPG.Damage.Digest.Dr"))}`;
    changed = true;
  }
  for (const p of result.perType) {
    const delta = p.final - p.afterDr;
    if (p.state === "none" || !delta) continue;
    const label = i18n.format("CARLRPG.Damage.Digest.TypeState", {
      type: damageTypeLabel(p.type),
      state: i18n.localize(`CARLRPG.Damage.Digest.State.${p.state}`),
    });
    math += ` ${delta < 0 ? "-" : "+"} ${term(Math.abs(delta), label)}`;
    changed = true;
  }
  // A fraction rounded down (a halved hit) changes it too.
  const total = i18n.format("CARLRPG.Damage.Digest.Total", { total: result.totalFinalDamage });
  math = changed || result.totalFinalDamage !== raw ? `${math} = ${total}` : total;

  // What it cost, ahead of the math: HB slots, and any Shield slots.
  const chip = (tone, text) =>
    `<span class="carl-status-chip" data-tone="${tone}">${esc(text)}</span>`;
  const slots = result.slotsLost;
  const chips = [
    chip(
      slots ? "bad" : "muted",
      i18n.format(`CARLRPG.Damage.Digest.${slots === 1 ? "Slot" : "Slots"}`, { slots }),
    ),
  ];
  const shieldSlots = result.shieldSlotsLost ?? 0;
  if (shieldSlots)
    chips.push(
      chip(
        "neutral",
        i18n.format(`CARLRPG.Damage.Digest.${shieldSlots === 1 ? "ShieldSlot" : "ShieldSlots"}`, {
          slots: shieldSlots,
        }),
      ),
    );

  return (
    `<span class="carl-digest-name">${esc(actor.name)}</span>` +
    `<span class="carl-digest-math"><span class="carl-digest-cost">${chips.join(" ")}</span> ` +
    `<span class="carl-digest-sum">${math}</span></span>`
  );
}

/**
 * Apply one damage instance to one actor: the pipeline (Shield -> DR ->
 * Resistances -> whole slots) against its live state, or - for a Dying
 * creature - 1 off the countdown instead ("Each time a Dying Crawler would
 * take damage from any source, they instead subtract 1", Table 11). Ends
 * `endsOnHbLoss` Debuffs (Terrified) when a slot is lost. Shared by this
 * card's Apply Damage and the per-target rows on an Attack card
 * (module/chat/attack-targets-card.mjs).
 * @param {Actor} actor
 * @param {Record<string, number>} damageByType
 * @param {boolean} isMagic
 * @param {{noShield?: boolean, armorPiercing?: boolean}} [options]  noShield: a Shield pool can't take
 *   this hit - a Catcher's caught damage ("You can't use Evade, Shield Block,
 *   and other Skills or Spells to negate damage dealt to you this way",
 *   p.191). The pipeline only lets Shield absorb non-magic damage, so this
 *   runs it as if magic. armorPiercing: only Anti-Piercing gear's DR applies
 *   (damage-pipeline.mjs).
 * @returns {Promise<string[]>} GM digest lines.
 */
export async function applyDamageToActor(
  actor,
  damageByType,
  isMagic,
  { noShield = false, armorPiercing = false } = {},
) {
  return (await applyDamageWithResult(actor, damageByType, isMagic, { noShield, armorPiercing }))
    .lines;
}

/**
 * applyDamageToActor, also returning the pipeline's numbers (damage after
 * DR and Resistances, HB and Shield slots lost) and whether the hit only
 * ticked a Dying countdown - for a card that shows them (module/helpers/
 * reaction-resolve.mjs).
 * @param {Actor} actor
 * @param {Record<string, number>} damageByType
 * @param {boolean} isMagic
 * @param {{noShield?: boolean, extraDr?: number, armorPiercing?: boolean}} [options]
 * @returns {Promise<{lines: string[], result: object, dying: boolean}>}
 */
export async function applyDamageWithResult(
  actor,
  damageByType,
  isMagic,
  { noShield = false, extraDr = 0, armorPiercing = false } = {},
) {
  const lines = [];
  const result = computeDamageApplication(damageByType, actor, isMagic || noShield, {
    extraDr,
    armorPiercing,
  });

  const dying = (actor.system.conditions ?? []).find(
    (c) => CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.countdown,
  );
  if (dying) {
    const left = dying.remaining ?? dyingRounds(actor.system);
    if (result.totalFinalDamage > 0 && left > 0) {
      await changeConditions(actor, [
        { op: "patch", id: dying.id, fields: { remaining: left - 1 } },
      ]);
      lines.push(
        game.i18n.format("CARLRPG.Damage.DyingCountdown", {
          name: foundry.utils.escapeHTML(actor.name),
          rounds: left - 1,
        }),
      );
    }
    return { lines, result, dying: true };
  }

  lines.push(formatDamageDigestLine(actor, result));
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
  // "...or you take at least 1 HB slot damage" (Terrified, Table 11).
  if (result.slotsLost > 0) {
    const ended = await removeConditionsWithMechanic(actor, "endsOnHbLoss");
    if (ended.length) {
      lines.push(
        game.i18n.format("CARLRPG.Damage.DebuffEnded", {
          name: esc(actor.name),
          debuffs: ended.map((d) => esc(d)).join(", "),
        }),
      );
    }
  }
  return { lines, result, dying: false };
}

/**
 * Run the damage pipeline against every snapshotted target's current
 * resistances/dr and apply the resulting whole-slot HB loss, then flag the
 * message so the button can't double-apply on a later re-render. Folds a
 * GM-only digest showing exactly what the pipeline did per target/type onto
 * the SAME card (rather than posting a separate follow-up message) - Apply
 * Damage previously only surfaced a bare "applied to N target(s)" toast with
 * the DR/Resistance/Vulnerability/Immunity math and slots-lost count
 * entirely invisible after the fact.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
export async function onApplyDamage(event, message) {
  event.preventDefault();
  const damageByType = message.getFlag("carl-rpg", "damageByType") ?? {};
  const targetUuids = message.getFlag("carl-rpg", "targetUuids") ?? [];
  // Defaults to magical (docs/known-gaps.md 1.4) - matches
  // computeDamageApplication's own default, so an older chat card missing
  // this flag (from before this phase) never lets Shield intercept damage.
  const isMagic = message.getFlag("carl-rpg", "damageIsMagic") ?? true;
  const armorPiercing = !!message.getFlag("carl-rpg", "armorPiercing");
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
    digestLines.push(
      ...(await applyDamageToActor(actor, damageByType, isMagic, { armorPiercing })),
    );
  }

  // GM-only visibility of this digest is enforced generically by
  // chat-listener.mjs's .carl-gm-only removal, not a bespoke check here -
  // same client-side-only confidentiality level as the old whisper-targeted
  // message (Foundry delivers whispers to every client's game.messages
  // regardless of recipient; neither mechanism is server-enforced
  // redaction), just folded onto the same card instead of a 4th message.
  const digestHtml = `<div class="carl-gm-digest carl-gm-only">
    <div class="carl-gm-digest-title">${game.i18n.localize("CARLRPG.Damage.DigestTitle")}</div>
    <ul>${digestLines.map((l) => `<li>${l}</li>`).join("")}</ul>
  </div>`;
  const content = appendCardSection(message, digestHtml);
  await updateCardMessage(message, { content, flags: { "carl-rpg": { damageApplied: true } } });
  ui.notifications.info(game.i18n.format("CARLRPG.Damage.AppliedNotice", { count: actors.size }));
}

/**
 * Registry entries consumed by the shared registerChatListener (module/chat/
 * chat-listener.mjs) - preserves this button's GM/owner visibility gating,
 * one-shot "already applied" disabling, and (new) a "superseded by Evade"
 * disabled state for whenever a linked Evade roll (module/chat/
 * evade-link-card.mjs) has determined the real outcome instead.
 */
export const damageActionEntries = [
  {
    action: "applyDamage",
    buttonSelector: ".carl-apply-damage",
    wrapperSelector: ".carl-damage-card",
    canAct: canApplyDamage,
    doneFlag: "damageApplied",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Damage.Applied")}`,
    supersededFlag: "damageSuperseded",
    supersededLabel: () =>
      `<i class="fas fa-ban"></i> ${game.i18n.localize("CARLRPG.Damage.Superseded")}`,
    onClick: onApplyDamage,
  },
];
