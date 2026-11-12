/**
 * The per-target rows on an Attack card (CarlDice.rollAttack and
 * rollMobAttack). Each targeted token gets its own row - its own hit/miss,
 * its own Roll Evade, its own Apply - instead of one Evade and one Apply for
 * the whole card (p.81: "a separate Evade Check against each Attack directed
 * at their crawler"; p.83 Area Attacks). The row data lives in the card's
 * `targetRows` flag (module/helpers/attack-targets.mjs); the rows themselves
 * are drawn at render time from those flags (decorateTargetRows, called by
 * module/chat/chat-listener.mjs), so an Evade, an Apply or a Taunt redirect
 * shows up on the next render with no stored HTML to rewrite.
 *
 * Who can click: a row's Roll Evade and Apply belong to the GM and that
 * target's owner; Apply All is the GM's. Mobs don't roll Evade ("Mobs are
 * player-facing; they never roll", p.267), so only crawler rows get one.
 */
import CarlDice from "../dice/dice.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import { degreeBadge, isHitDegree } from "../helpers/rules.mjs";
import { activeRows, rowOutcome, rowEvadeDifficulty, rowResolved } from "../helpers/attack-targets.mjs";
import { addConditionToActor } from "../helpers/conditions.mjs";
import { resolveCombatantFor } from "../helpers/token-resolution.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { appendCardSection, createRollMessage, esc } from "./chat-card.mjs";
import { applyDamageToActor } from "./damage-card.mjs";
import { isImmuneToAllDamage } from "../helpers/damage-pipeline.mjs";
import { buildEvadeConsequenceFooter, userOwnsUuid } from "./evade-link-card.mjs";
import { aiRerollFlags } from "../helpers/ai-favor.mjs";

const SCOPE = "carl-rpg";

/** Rows this client is resolving right now (message.id:rowId) - blocks a double click. */
const inFlight = new Set();

/**
 * Rows this client has already Evaded or applied, by message.id:rowId. A
 * player's write reaches the card through the GM's client and lands a moment
 * later, so until it does the row is treated as done here - a second click
 * (or a re-render before the flag arrives) can't resolve it twice.
 * @type {Map<string, {evaded?: boolean, applied?: boolean}>}
 */
const doneLocally = new Map();

/** The row as this client should treat it, with any not-yet-arrived local result folded in. */
function withLocal(message, row) {
  const local = doneLocally.get(`${message.id}:${row.id}`);
  if (!local) return row;
  // Once the card's own flags show the result, the local copy is no longer needed.
  if ((!local.applied || row.applied) && (!local.evaded || row.evade)) {
    doneLocally.delete(`${message.id}:${row.id}`);
    return row;
  }
  return { ...row, applied: row.applied || !!local.applied, evade: row.evade ?? (local.evaded ? { pending: true } : null) };
}

function markLocal(message, rowId, result) {
  const key = `${message.id}:${rowId}`;
  doneLocally.set(key, { ...(doneLocally.get(key) ?? {}), ...result });
}

function damageTypeLabel(type) {
  return type ? game.i18n.localize(CARLRPG.damageTypes[type] ?? type) : game.i18n.localize("CARLRPG.Roll.Damage");
}

/**
 * The static part of the card: what the Attack carries (damage pills,
 * on-hit effects, an Area tag), a placeholder the rows are drawn into, and
 * the GM's Apply All.
 * @param {{damageByType: Record<string, number>, targetEffects: object[], isArea: boolean}} args
 * @returns {string}
 */
export function buildAttackTargetsFooter({ damageByType = {}, targetEffects = [], isArea = false }) {
  const pills = Object.entries(damageByType)
    .filter(([, amount]) => amount)
    .map(([type, amount]) => `<span class="carl-damage-pill">${esc(amount)} ${esc(damageTypeLabel(type))}</span>`)
    .join("");
  const effects = targetEffects
    .map((te) => `<span class="carl-target-effect-pill">${esc(te.displayLabel ?? te.label ?? te.debuffKey)} &times;${esc(te.stacks ?? 1)}</span>`)
    .join("");
  return `<div class="carl-attack-targets">
    ${isArea ? `<div class="carl-area-tag"><i class="fas fa-burst"></i> ${game.i18n.localize("CARLRPG.Targets.AreaAttack")}</div>` : ""}
    ${pills ? `<div class="carl-damage-portions"><span class="carl-damage-label">${game.i18n.localize("CARLRPG.Damage.WillApply")}</span> ${pills}</div>` : ""}
    ${effects ? `<div class="carl-target-effects-list"><span class="carl-target-effects-label">${game.i18n.localize("CARLRPG.TargetEffects.WillApply")}</span> ${effects}</div>` : ""}
    <div class="carl-target-rows"></div>
    <div class="carl-apply-all-row">
      <button type="button" class="carl-apply-all" data-action="applyAllTargets">
        <i class="fas fa-heart-crack"></i> ${game.i18n.localize("CARLRPG.Targets.ApplyAll")}
      </button>
    </div>
  </div>`;
}

/** A short status for one row, as the viewer sees it. */
function rowStatus(row, flags) {
  const i18n = game.i18n;
  if (row.applied) return i18n.localize("CARLRPG.Targets.Applied");
  if (row.evade?.pending) return i18n.localize("CARLRPG.Targets.EvadePending");
  if (!row.hit) return i18n.format("CARLRPG.Targets.Missed", { difficulty: row.difficulty ?? "-" });
  if (row.evade) {
    if (row.evade.success) return i18n.localize(flags.isArea ? "CARLRPG.Targets.EvadedHalf" : "CARLRPG.Targets.Evaded");
    if (row.evade.degree === "criticalFail") return i18n.localize("CARLRPG.Targets.EvadeCriticalFail");
    if (row.evade.degree === "majorFail") return i18n.localize("CARLRPG.Targets.EvadeMajorFail");
    return i18n.localize("CARLRPG.Targets.EvadeFailed");
  }
  if (row.isCharacter) {
    const difficulty = rowEvadeDifficulty(row, flags);
    return i18n.format("CARLRPG.Targets.Incoming", { difficulty: difficulty ?? "-" });
  }
  return i18n.localize(row.amazing ? "CARLRPG.Targets.HitAmazing" : "CARLRPG.Targets.Hit");
}

/**
 * Draw the target rows into an Attack card, for whoever is viewing it.
 * Called from module/chat/chat-listener.mjs on every render.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateTargetRows(message, html) {
  const container = html.querySelector(".carl-target-rows");
  if (!container) return;
  const flags = message.flags?.[SCOPE] ?? {};
  const rows = activeRows(flags.targetRows).map((row) => withLocal(message, row));

  // A targeted Attack that missed everyone still rolls its damage (a Taunt
  // may redirect it onto someone it does hit); keep it out of sight until a
  // row is a hit.
  if (rows.length && !rows.some((row) => row.hit)) {
    html.querySelectorAll(".carl-damage-roll, .carl-attack-targets .carl-damage-portions, .carl-attack-targets .carl-target-effects-list")
      .forEach((el) => el.remove());
  }
  container.innerHTML = rows.map((row) => {
    const mine = userOwnsUuid(row.uuid);
    const buttons = [];
    if (mine && !row.applied && row.hit && row.isCharacter && !row.evade) {
      const free = row.freeEvade && !row.freeUsed;
      buttons.push(`<button type="button" class="carl-row-evade" data-action="rowEvade">
        <i class="fas fa-person-running"></i> ${game.i18n.localize(free ? "CARLRPG.Evade.RollFreeButton" : "CARLRPG.Evade.RollButton")}</button>`);
    }
    if (mine && !rowResolved(row, flags.isArea) && !row.evade?.pending) {
      buttons.push(`<button type="button" class="carl-row-apply" data-action="rowApply">
        <i class="fas fa-heart-crack"></i> ${game.i18n.localize("CARLRPG.Targets.Apply")}</button>`);
    }
    const zone = row.zone === "splash"
      ? `<span class="carl-target-zone">${game.i18n.localize("CARLRPG.Targets.Splash")}</span>` : "";
    return `<div class="carl-target-row" data-row-id="${esc(row.id)}">
      <span class="carl-target-name">${esc(row.name)}</span>${zone}
      <span class="carl-target-status">${esc(rowStatus(row, flags))}</span>
      <span class="carl-target-buttons">${buttons.join("")}</span>
    </div>`;
  }).join("");

  const pending = rows.some((row) => !rowResolved(row, flags.isArea));
  if (!game.user.isGM || !pending) html.querySelector(".carl-apply-all-row")?.remove();
}

/** The row a clicked button belongs to (with any local, not-yet-arrived result). */
function clickedRow(message, button) {
  const rowId = button?.closest("[data-row-id]")?.dataset.rowId;
  const row = rowId ? message.getFlag(SCOPE, "targetRows")?.[rowId] : null;
  return row && !row.replaced ? withLocal(message, row) : null;
}

/** Resolve a row's token/actor uuid to {actor, token}. */
export async function resolveRowTarget(row) {
  const doc = row?.uuid ? await fromUuid(row.uuid) : null;
  if (!doc) return null;
  if (doc instanceof Actor) return { actor: doc, token: null };
  return doc.actor ? { actor: doc.actor, token: doc } : null;
}

/**
 * Run `fn` unless this row is already being resolved on this client - and
 * only if the result can be recorded on the card: a player's writes reach
 * someone else's card through the GM's client (module/helpers/
 * chat-socket.mjs), so with no GM online nothing is rolled or applied.
 */
async function guarded(message, rowId, fn) {
  const key = `${message.id}:${rowId}`;
  if (inFlight.has(key)) return;
  if (!message.canUserModify(game.user, "update") && !game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return;
  }
  inFlight.add(key);
  try {
    await fn();
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Roll this row's Evade (an Interrupt, p.81). The result is written to the
 * row only; damage is then applied from the row's Apply. A failed free Evade
 * (p.96) changes nothing but spends the freebie - "If they fail that free
 * Check, they may still spend an Action to Evade as usual and try again."
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 * @param {HTMLElement} button
 */
async function onRowEvade(event, message, button) {
  event.preventDefault();
  const row = clickedRow(message, button);
  if (!row || row.applied || row.evade || !row.hit) return;
  await guarded(message, row.id, async () => {
    if (withLocal(message, row).evade) return;
    const target = await resolveRowTarget(row);
    if (!target) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Evade.NoActor"));
      return;
    }
    if (!target.actor.isOwner && !game.user.isGM) return;

    const free = row.freeEvade && !row.freeUsed;
    const difficulty = rowEvadeDifficulty(row, message.flags[SCOPE]);
    const rollData = await CarlDice.rollEvadeCheck(target.actor, { difficulty, skipDialog: false, post: false, isAction: !free });
    if (!rollData) return;
    await recordRowEvade(message, row, target, { ...rollData, free });
  });
}

const GREAT_EVADE = ["criticalHit", "amazingSuccess"];

/**
 * Record a row's Evade result on the Attack card and post the outcome card.
 * Shared by the row's Roll Evade and an AI Favor reroll of that Evade
 * (module/chat/ai-favor-reroll.mjs), which passes `reroll` (the original
 * roll's data) - its result replaces the earlier one.
 * @param {ChatMessage} message  The Attack card.
 * @param {object} row
 * @param {{actor: Actor, token: TokenDocument|null}} target
 * @param {{roll: Roll, breakdown: string, degree: string, debuffNote?: string, free: boolean,
 *   formula?: string, naturalRoll?: number|null, total?: number, difficulty?: number|null, reroll?: object|null}} result
 * @returns {Promise<void>}
 */
export async function recordRowEvade(message, row, target, {
  roll, breakdown, degree, debuffNote = "", free, formula, naturalRoll, total, difficulty, reroll = null,
}) {
  const flags = message.flags[SCOPE];
  const success = isHitDegree(degree);

  // Nat 20 / Amazing Success: Advantage on the evader's next Attack against
  // this attacker (Degrees of Success, p.79) - see CarlDice.rollAttack. A
  // reroll that loses that result takes the Advantage back.
  if (flags.attackerUuid) {
    const combatant = resolveCombatantFor(target);
    if (combatant?.canUserModify(game.user, "update")) {
      if (GREAT_EVADE.includes(degree)) {
        await combatant.setFlag(SCOPE, "advantageVsUuid", flags.attackerUuid);
      } else if (GREAT_EVADE.includes(reroll?.degree)
        && combatant.getFlag(SCOPE, "advantageVsUuid") === flags.attackerUuid) {
        await combatant.unsetFlag(SCOPE, "advantageVsUuid");
      }
    }
  }

  // The outcome card offers the AI Favor reroll (once - a reroll's own card
  // carries it as used).
  const rerollFlags = reroll
    ? { aiReroll: { ...reroll, used: true } }
    : aiRerollFlags(target.actor, {
      kind: "rowEvade", formula, natural: naturalRoll, total, difficulty, breakdown, body: debuffNote,
      attackMessageId: message.id, rowId: row.id, free, degree,
    });
  const rerollNote = reroll ? `<p class="carl-reroll-note">${game.i18n.localize("CARLRPG.Reroll.Note")}</p>` : "";

  if (free && !success) {
    await updateCardMessage(message, { flags: { [SCOPE]: { targetRows: { [row.id]: { freeUsed: true } } } } });
    await createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: game.i18n.localize("CARLRPG.Evade.FreeEvade"), breakdown }],
      title: game.i18n.format("CARLRPG.Evade.OutcomeTitle", { name: target.actor.name }),
      img: target.actor.img,
      subtitle: game.i18n.localize("CARLRPG.Evade.FreeEvadeFailed"),
      badge: degreeBadge(degree),
      body: `${debuffNote}<p>${game.i18n.localize("CARLRPG.Evade.FreeEvadeFailedBody")}</p>${rerollNote}`,
      flags: rerollFlags,
      actor: target.actor,
      token: target.token,
    });
    return;
  }

  markLocal(message, row.id, { evaded: true });
  await updateCardMessage(message, {
    flags: { [SCOPE]: { targetRows: { [row.id]: { evade: { degree, success }, freeUsed: row.freeUsed || free } } } },
  });

  const subtitleKey = success
    ? (flags.isArea ? "CARLRPG.Targets.EvadedHalf" : "CARLRPG.Evade.Evaded")
    : degree === "majorFail" ? "CARLRPG.Evade.HitMajorFail"
      : degree === "criticalFail" ? "CARLRPG.Evade.HitCriticalFail" : "CARLRPG.Evade.HitNormal";
  const debuffKey = degree === "majorFail" ? "minorInjury" : degree === "criticalFail" ? "majorInjury" : null;
  const outcomeFlags = { ...rerollFlags };
  let footer;
  if (debuffKey) {
    outcomeFlags.debuffKey = debuffKey;
    outcomeFlags.debuffActorUuid = row.uuid;
    footer = await buildEvadeConsequenceFooter(debuffKey);
  }
  await createRollMessage({
    rolls: [roll],
    rollMeta: [{ label: game.i18n.localize("CARLRPG.Roll.Evade"), breakdown }],
    title: game.i18n.format("CARLRPG.Evade.OutcomeTitle", { name: target.actor.name }),
    img: target.actor.img,
    subtitle: game.i18n.localize(subtitleKey),
    badge: degreeBadge(degree),
    body: `${debuffNote}<p>${game.i18n.localize("CARLRPG.Targets.ApplyFromCard")}</p>${rerollNote}`,
    footer,
    flags: outcomeFlags,
    actor: target.actor,
    token: target.token,
  });
}

/**
 * Apply one row: its damage (scaled for Splash/Evade/Amazing - module/
 * helpers/attack-targets.mjs's rowOutcome) through the damage pipeline, and
 * the Attack's on-hit effects unless the target Evaded. The row is marked
 * applied first, so a second click can't apply it twice.
 * @param {ChatMessage} message
 * @param {object} row
 * @returns {Promise<string[]>} GM digest lines.
 */
export async function applyRow(message, row) {
  const flags = message.flags[SCOPE];
  if (withLocal(message, row).applied) return [];
  const target = await resolveRowTarget(row);
  if (!target) return [];
  markLocal(message, row.id, { applied: true });
  await updateCardMessage(message, { flags: { [SCOPE]: { targetRows: { [row.id]: { applied: true } } } } });

  const outcome = rowOutcome(row, {
    damageByType: flags.damageByType ?? {},
    isArea: !!flags.isArea,
    floor: flags.floor ?? game.settings.get(SCOPE, "currentFloor"),
  });
  const lines = [];
  if (Object.values(outcome.damage).some((v) => v)) {
    lines.push(...await applyDamageToActor(target.actor, outcome.damage, flags.damageIsMagic ?? true));
  }
  // An Immunity to the whole hit also ignores its Debuffs (p.93).
  const immune = outcome.effects && (flags.targetEffects ?? []).length
    && isImmuneToAllDamage(flags.damageByType, target.actor);
  if (immune) {
    lines.push(game.i18n.format("CARLRPG.Targets.ImmuneNoEffects", { name: esc(target.actor.name) }));
  } else if (outcome.effects) {
    for (const te of flags.targetEffects ?? []) {
      await addConditionToActor(target.actor, te.debuffKey, { stacks: te.stacks, source: te.sourceLabel, label: te.label });
    }
  }
  return lines;
}

/** Append GM digest lines to the Attack card. */
async function appendDigest(message, lines) {
  if (!lines.length) return;
  const html = `<div class="carl-gm-digest carl-gm-only">
    <div class="carl-gm-digest-title">${game.i18n.localize("CARLRPG.Damage.DigestTitle")}</div>
    <ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
  </div>`;
  await updateCardMessage(message, { content: appendCardSection(message, html) });
}

async function onRowApply(event, message, button) {
  event.preventDefault();
  const row = clickedRow(message, button);
  if (!row || row.evade?.pending || rowResolved(row, message.getFlag(SCOPE, "isArea"))) return;
  if (!userOwnsUuid(row.uuid)) return;
  await guarded(message, row.id, async () => {
    const lines = await applyRow(message, row);
    await appendDigest(message, lines);
  });
}

async function onApplyAll(event, message) {
  event.preventDefault();
  if (!game.user.isGM) return;
  await guarded(message, "all", async () => {
    const lines = [];
    const isArea = message.getFlag(SCOPE, "isArea");
    for (const row of activeRows(message.getFlag(SCOPE, "targetRows"))) {
      if (rowResolved(row, isArea)) continue;
      lines.push(...await applyRow(message, row));
    }
    await appendDigest(message, lines);
    ui.notifications.info(game.i18n.localize("CARLRPG.Targets.AppliedAll"));
  });
}

/**
 * Registry entries for module/chat/chat-listener.mjs. `custom: true` - these
 * buttons are drawn per viewer by decorateTargetRows, so the listener's
 * generic flag-based gating skips them; each handler re-checks its row.
 */
export const attackTargetsActionEntries = [
  { action: "rowEvade", custom: true, onClick: onRowEvade },
  { action: "rowApply", custom: true, onClick: onRowApply },
  { action: "applyAllTargets", custom: true, onClick: onApplyAll },
];
