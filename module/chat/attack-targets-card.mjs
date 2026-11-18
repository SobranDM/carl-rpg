/**
 * The per-target rows on an Attack card (CarlDice.rollAttack and
 * rollMobAttack). Each targeted token gets its own row - its own hit/miss,
 * its own Evade, its own Apply - instead of one Evade and one Apply for the
 * whole card (p.81: "a separate Evade Check against each Attack directed at
 * their crawler"; p.83 Area Attacks). The row data lives in the card's
 * `targetRows` flag (module/helpers/attack-targets.mjs); the rows are drawn
 * at render time from those flags (decorateTargetRows, called by module/
 * chat/chat-listener.mjs) in the combat cards' status rows (module/chat/
 * status-rows.mjs; docs/reaction-card-redesign.md, phase 3).
 *
 * Who rolls: the crawlers. On a Mob Attack the crawlers it's aimed at roll
 * their Evades against its fixed to-hit; on a crawler's Attack the crawler
 * rolled against each Mob's fixed Evade - a Mob's row has Apply and nothing
 * else ("Mobs are player-facing; they never roll", p.267). A crawler
 * targeted by another crawler Evades (p.87).
 *
 * A row's Evade is kept on the row (module/chat/row-evade.mjs), with its
 * Intervene, AI Reroll and injury icons - no card of its own. Who can click:
 * a row's Evade, AI Reroll and injury belong to the GM and that target's
 * owner; its Apply to whoever owns what takes the hit; Intervene to the
 * other crawlers in the fight; Apply All to the GM.
 */
import CarlDice from "../dice/dice.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import { isHitDegree } from "../helpers/rules.mjs";
import { activeRows, rowOutcome, rowEvadeDifficulty, rowResolved } from "../helpers/attack-targets.mjs";
import { resolveTargetEffectLabel } from "../helpers/conditions.mjs";
import { landDebuffs } from "../helpers/land-debuffs.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { appendCardSection, esc } from "./chat-card.mjs";
import { applyDamageToActor } from "./damage-card.mjs";
import { userOwnsUuid } from "./evade-link-card.mjs";
import { rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { afterRamRowApplied } from "../helpers/vehicle-ram.mjs";
import { evadeIsFree, noteUndo, takeAction } from "../helpers/actions.mjs";
import {
  addRowInjury, decidingRowCheck, recordRowEvade, resolveRowTarget, rowInjury, rowInterveneOpen, rowInterveners,
  rowRerollSources, shownRowCheck,
} from "./row-evade.mjs";
import {
  checkDetail, checkNotes, d6CouldChange, headerProgress, iconButton, rememberOpenRows, statusChip, statusRow, statusSection, versusNum,
} from "./status-rows.mjs";
import { interveneRow } from "./check-revision.mjs";
import { rerollRow } from "./ai-favor-reroll.mjs";

export { resolveRowTarget };

const SCOPE = "carl-rpg";

/**
 * Which rows' expanders this client has open, by `messageId:rowKey`.
 * @type {Set<string>}
 */
const openRows = new Set();

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
 * @param {{damageByType: Record<string, number>, targetEffects: object[], isArea: boolean, noAmazing?: boolean}} args
 *   noAmazing: the Attack has targets and was an Amazing Success against
 *   none - an Amazing-Success-only Debuff lands on no one, so it's dimmed.
 * @returns {string}
 */
export function buildAttackTargetsFooter({ damageByType = {}, targetEffects = [], isArea = false, noAmazing = false }) {
  const pills = Object.entries(damageByType)
    .filter(([, amount]) => amount)
    .map(([type, amount]) => `<span class="carl-damage-pill">${esc(amount)} ${esc(damageTypeLabel(type))}</span>`)
    .join("");
  // Each Debuff by name, with where it comes from ("Burned ×1 · Blazing
  // Longsword") and, if only on an Amazing Success, that (decided per
  // target when applied - debuffLandsOn); dimmed if no target was one.
  const effects = targetEffects
    .map((te) => {
      const name = te.displayLabel || resolveTargetEffectLabel(te);
      // A Mob Attack's trigger, when it's more than "on a hit".
      const trigger = te.trigger && te.trigger !== "hit" ? game.i18n.localize(CARLRPG.mobAttackTriggers[te.trigger] ?? te.trigger) : "";
      const notes = [te.sourceLabel, te.amazingSuccessOnly ? game.i18n.localize("CARLRPG.OnHitDebuff.OnAmazing") : "", trigger]
        .filter(Boolean).map((n) => ` · ${esc(n)}`).join("");
      const dim = te.amazingSuccessOnly && noAmazing;
      const tipKey = dim ? "CARLRPG.OnHitDebuff.NoAmazing" : "CARLRPG.OnHitDebuff.TriggerHint.amazing";
      const tip = te.amazingSuccessOnly ? ` data-tooltip="${esc(game.i18n.localize(tipKey))}"` : "";
      return `<span class="carl-target-effect-pill${dim ? " is-dim" : ""}"${tip}>${esc(name)} &times;${esc(te.stacks ?? 1)}`
        + (notes ? `<span class="carl-target-effect-source">${notes}</span>` : "") + `</span>`;
    })
    .join("");
  return `<div class="carl-attack-targets">
    ${isArea ? `<div class="carl-area-tag"><i class="fas fa-burst"></i> ${game.i18n.localize("CARLRPG.Targets.AreaAttack")}</div>` : ""}
    ${pills ? `<div class="carl-damage-portions"><span class="carl-damage-label">${game.i18n.localize("CARLRPG.Damage.WillApply")}</span> ${pills}</div>` : ""}
    ${effects ? `<div class="carl-target-effects-list"><span class="carl-target-effects-label">${game.i18n.localize("CARLRPG.TargetEffects.WillApply")}</span> ${effects}</div>` : ""}
    <div class="carl-target-rows"></div>
    <div class="carl-apply-all-row">
      <button type="button" class="carl-apply-all carl-status-button" data-action="applyAllTargets">
        <i class="fas fa-heart-crack"></i> ${game.i18n.localize("CARLRPG.Targets.ApplyAll")}
      </button>
    </div>
  </div>`;
}

/**
 * A ram's recoil (module/helpers/vehicle-ram.mjs) waits on the target it was
 * aimed at: until that target has Evaded (or been hit and applied), whether
 * the ram connected isn't settled.
 * @param {object} row
 * @param {object} flags  The card's flags.
 * @returns {boolean}
 */
function recoilWaiting(row, flags) {
  if (row.role !== "recoil" || !flags.ram) return false;
  const primary = flags.targetRows?.[flags.ram.primaryRowId];
  return !!primary && primary.hit && primary.isCharacter && !primary.evade && !primary.applied && !primary.redirectUuid;
}

/** Whether a row's target is on the party's side: a hit on it is bad news. */
function partySide(row) {
  return !!row.isCharacter || !!row.isVehicle;
}

/**
 * A crawler's Attack total against one row: each row keeps its own kept d20
 * (Advantage against one target and not another), the rest is the card's.
 * @param {object} row
 * @param {object} flags
 * @returns {number|null}
 */
function attackTotalFor(row, flags) {
  if (typeof flags.attackTotal !== "number") return null;
  const natural = flags.naturalRoll ?? null;
  if (natural === null || row.natural === null || row.natural === undefined) return flags.attackTotal;
  return flags.attackTotal - natural + row.natural;
}

/**
 * Where one row stands, as its chip shows it, with the Evade it shows.
 * @param {object} row
 * @param {object} flags
 * @returns {{status: string, check: object|null, which: "free"|"evade"|null}}
 */
function targetStatus(row, flags) {
  const shown = shownRowCheck(row);
  if (!row.hit) return { status: "missed", ...shown };
  if (row.evade?.pending) return { status: "incoming", ...shown };
  if (row.evade?.success) {
    if (flags.isArea) return { status: row.zone === "splash" ? "quarter" : "half", ...shown };
    const deciding = decidingRowCheck(row);
    return { status: deciding && deciding === row.checks?.free ? "missed" : "evaded", ...shown };
  }
  if (row.evade || row.redirectUuid || !row.isCharacter || row.applied) return { status: "hit", ...shown };
  return { status: "incoming", ...shown };
}

/** One row, for this viewer. */
function targetRow(message, row, flags, { status, check, which }) {
  const i18n = game.i18n;
  const sub = [];
  if (row.zone === "splash") sub.push(i18n.localize("CARLRPG.Targets.Splash"));
  if (row.amazing) sub.push(i18n.localize(CARLRPG.degreesOfSuccess.amazingSuccess));
  if (which === "free") sub.push(check.success ? i18n.localize("CARLRPG.Reaction.FreeEvade") : i18n.format("CARLRPG.Reaction.Sub.freeFailed", { total: check.total }));
  if (which === "evade" && check.degree === "nearMissFail") sub.push(i18n.localize(CARLRPG.degreesOfSuccess.nearMissFail));
  sub.push(...checkNotes(check));
  // "A Near Miss targeting an occupant hits the vehicle" (p.72).
  if (row.redirectUuid) sub.push(i18n.format("CARLRPG.Vehicle.NearMissHitsVehicle", { vehicle: row.redirectName ?? "?" }));
  if (recoilWaiting(row, flags)) sub.push(i18n.localize("CARLRPG.Vehicle.Ram.RecoilWaiting"));
  if (row.evade?.pending) sub.push(i18n.localize("CARLRPG.Targets.EvadePending"));
  if (row.injuryAdded) sub.push(i18n.localize("CARLRPG.Targets.InjuryAdded"));
  if (row.applied) sub.push(i18n.localize("CARLRPG.Targets.Applied"));

  let num = "";
  if (check) num = versusNum(check.total, check.difficulty);
  else if (status === "incoming") {
    num = `<span class="carl-status-vs">${esc(i18n.localize("CARLRPG.Roll.Evade"))}</span> <b>${esc(rowEvadeDifficulty(row, flags) ?? "-")}</b>`;
  } else if (rollsLikeCrawler(flags.attackerType)) num = versusNum(attackTotalFor(row, flags) ?? "-", row.difficulty);
  else if (row.toHit !== undefined && row.toHit !== null) num = versusNum(row.toHit, row.difficulty);

  // This viewer's icons on the row.
  const mine = userOwnsUuid(row.uuid);
  // Whoever owns what actually takes the hit applies it - the vehicle, when
  // a Near Miss on its occupant hits it instead.
  const applier = userOwnsUuid(row.redirectUuid ?? row.uuid);
  const data = { "row-id": row.id };
  const acts = [];
  if (mine && !row.applied && row.hit && row.isCharacter && !row.evade && !row.redirectUuid) {
    const free = row.freeEvade && !row.freeUsed;
    acts.push(iconButton("fa-person-running", i18n.localize(free ? "CARLRPG.Evade.RollFreeButton" : "CARLRPG.Evade.RollButton"),
      { ...data, action: "rowEvade" }));
  }
  if (which && rowRerollSources(message, row.id, which).length) {
    acts.push(iconButton("fa-dice-d20", i18n.localize("CARLRPG.Reaction.Op.reroll"), { ...data, which, action: "rowReroll" }));
  }
  if (which && d6CouldChange(check) && rowInterveneOpen(message, row.id, which) && rowInterveners(message, row.id, which).length) {
    acts.push(iconButton("fa-handshake-angle", i18n.localize("CARLRPG.Intervene.Button"), { ...data, which, action: "rowIntervene" }));
  }
  const injury = rowInjury(row);
  if (injury && !row.injuryAdded && mine) {
    acts.push(iconButton("fa-band-aid", i18n.localize(injury === "majorInjury" ? "CARLRPG.Evade.AddMajorInjury" : "CARLRPG.Evade.AddMinorInjury"),
      { ...data, action: "rowInjury" }));
  }
  if (applier && !rowResolved(row, flags.isArea) && !row.evade?.pending && !recoilWaiting(row, flags)) {
    acts.push(iconButton("fa-heart-crack", i18n.localize("CARLRPG.Targets.Apply"), { ...data, action: "rowApply" }));
  }

  // The expander: the Evade shown, and a free one it replaced.
  const freeBehind = which === "evade" && row.checks?.free
    ? `<div class="carl-status-detail-head">${esc(i18n.localize("CARLRPG.Reaction.FreeEvade"))}</div>${checkDetail(row.checks.free)}` : "";
  const key = `row:${row.id}`;
  const tone = status === "hit" ? (partySide(row) ? "bad" : "good") : null;
  return statusRow({
    id: row.id, key, open: openRows.has(`${message.id}:${key}`),
    chip: statusChip(status, tone ? { tone } : {}),
    what: `<strong>${esc(row.name)}</strong>`, sub, num, acts: acts.join(""),
    detail: check ? `${checkDetail(check)}${freeBehind}` : "",
  });
}

/** The rows' heading summary: how many of each. */
function targetSummary(statuses) {
  const i18n = game.i18n;
  const counts = {};
  for (const { status } of statuses) {
    const key = status === "quarter" ? "half" : status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return ["hit", "incoming", "half", "evaded", "missed"]
    .filter((key) => counts[key])
    .map((key) => i18n.format(`CARLRPG.Targets.Sum.${key}`, { n: counts[key] }))
    .join(" · ");
}

/**
 * Draw the target rows into an Attack card, for whoever is viewing it: a
 * section of status rows, and the header's badge - "0 of 2 settled" on a
 * Mob's Attack, "1 hit" on a crawler's. Called from module/chat/
 * chat-listener.mjs on every render.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateTargetRows(message, html) {
  const container = html.querySelector(".carl-target-rows");
  if (!container) return;
  const flags = message.flags?.[SCOPE] ?? {};
  const rows = activeRows(flags.targetRows).map((row) => withLocal(message, row));
  const i18n = game.i18n;

  // A targeted Attack that missed everyone still rolls its damage (a Taunt
  // may redirect it onto someone it does hit); keep it out of sight until a
  // row is a hit.
  if (rows.length && !rows.some((row) => row.hit)) {
    html.querySelectorAll(".carl-damage-roll, .carl-attack-targets .carl-damage-portions, .carl-attack-targets .carl-target-effects-list")
      .forEach((el) => el.remove());
  }
  if (rows.length) {
    const statuses = rows.map((row) => targetStatus(row, flags));
    container.innerHTML = statusSection({
      name: i18n.localize("CARLRPG.Targets.Section"),
      summary: targetSummary(statuses),
      rows: rows.map((row, i) => targetRow(message, row, flags, statuses[i])),
    });
    if (rollsLikeCrawler(flags.attackerType)) {
      const hits = rows.filter((row) => row.hit).length;
      headerProgress(html, hits ? i18n.format("CARLRPG.Targets.Hits", { n: hits }) : i18n.localize("CARLRPG.Targets.AllMissed"));
    } else {
      const settled = statuses.filter((s) => s.status !== "incoming").length;
      headerProgress(html, i18n.format("CARLRPG.Reaction.Progress", { settled, total: rows.length }));
    }
    rememberOpenRows(container, message.id, openRows);
  } else {
    container.innerHTML = "";
  }

  const pending = rows.some((row) => !rowResolved(row, flags.isArea));
  if (!game.user.isGM || !pending) html.querySelector(".carl-apply-all-row")?.remove();
}

/** The row a clicked button belongs to (with any local, not-yet-arrived result). */
function clickedRow(message, button) {
  const rowId = button?.closest("[data-row-id]")?.dataset.rowId;
  const row = rowId ? message.getFlag(SCOPE, "targetRows")?.[rowId] : null;
  return row && !row.replaced ? withLocal(message, row) : null;
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

/** The row's Roll Evade button. */
function onRowEvade(event, message, button) {
  event.preventDefault();
  const rowId = button?.closest("[data-row-id]")?.dataset.rowId;
  return rowId ? evadeRow(message, rowId) : undefined;
}

/**
 * Roll a row's Evade (an Interrupt, p.81). The result is written to the
 * row only; damage is then applied from the row's Apply. A failed free Evade
 * (p.96) changes nothing but spends the freebie - "If they fail that free
 * Check, they may still spend an Action to Evade as usual and try again."
 * It's kept on the row, which can be Intervened on or rerolled in place
 * (module/chat/row-evade.mjs).
 * @param {ChatMessage} message  The Attack card.
 * @param {string} rowId
 * @param {{skipDialog?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function evadeRow(message, rowId, { skipDialog = false } = {}) {
  const stored = message.getFlag(SCOPE, "targetRows")?.[rowId];
  const row = stored && !stored.replaced ? withLocal(message, stored) : null;
  // A Near Miss that hit the occupant's vehicle instead has nothing to Evade.
  if (!row || row.applied || row.evade || !row.hit || row.redirectUuid) return;
  await guarded(message, row.id, async () => {
    if (withLocal(message, row).evade) return;
    const target = await resolveRowTarget(row);
    if (!target) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Evade.NoActor"));
      return;
    }
    if (!target.actor.isOwner && !game.user.isGM) return;

    const free = row.freeEvade && !row.freeUsed;
    // A paid Evade is the Evade Action in a fight - one covers every Attack
    // on them this round (p.81; helpers/actions.mjs). A free one costs
    // nothing, nor does an uncommanded Pet's.
    const pays = !free && !evadeIsFree(target.actor);
    await takeAction(target.actor, "other", game.i18n.localize("CARLRPG.Roll.Evade"), async (ctx) => {
      if (!pays) ctx.free();
      else if (!ctx.require()) return null;
      const difficulty = rowEvadeDifficulty(row, message.flags[SCOPE]);
      const rollData = await CarlDice.rollEvadeCheck(target.actor, { difficulty, skipDialog, post: false, isAction: !free });
      if (!rollData) return null;
      // Shown as done here until the GM's write of the row arrives.
      if (!(free && !isHitDegree(rollData.degree))) markLocal(message, row.id, { evaded: true });
      const check = await recordRowEvade(message, row, target, rollData, { free });
      // Undone: the row back to before this Evade (a free one costs nothing).
      if (!free) noteUndo(target.actor, { t: "rowEvade", messageId: message.id, rowId: row.id, checkId: check.id });
      return true;
    }, { tag: "evade", optional: true });
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
  // A ram's recoil isn't applied before its target has had its Evade.
  if (recoilWaiting(row, flags)) return [];
  // A Near Miss on a vehicle's occupant lands on the vehicle (p.72).
  const target = await resolveRowTarget(row.redirectUuid ? { uuid: row.redirectUuid } : row);
  if (!target) return [];
  markLocal(message, row.id, { applied: true });
  await updateCardMessage(message, { flags: { [SCOPE]: { targetRows: { [row.id]: { applied: true } } } } });

  // A ram's recoil only happens if the ram connected: not when the target
  // it was aimed at Evaded it (module/helpers/vehicle-ram.mjs).
  if (row.role === "recoil" && flags.ram) {
    const primary = flags.targetRows?.[flags.ram.primaryRowId];
    if (primary?.evade?.success) return [game.i18n.format("CARLRPG.Vehicle.Ram.NoRecoil", { vehicle: esc(target.actor.name) })];
  }

  const outcome = rowOutcome(row, {
    damageByType: flags.damageByType ?? {},
    isArea: !!flags.isArea,
    floor: flags.floor ?? game.settings.get(SCOPE, "currentFloor"),
  });
  const lines = [];
  if (Object.values(outcome.damage).some((v) => v)) {
    lines.push(...await applyDamageToActor(target.actor, outcome.damage, flags.damageIsMagic ?? true));
  }
  // A rammed (or ramming) vehicle passes half its damage to its occupants,
  // and the rammer loses Move - even when the recoil rounds down to nothing.
  if (flags.ram && row.hit) lines.push(...await afterRamRowApplied(message, row, target.actor, outcome.damage));
  if (outcome.effects) lines.push(...(await landDebuffs(target.actor, flags.targetEffects, row, flags.damageByType)).lines);
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
  if (!userOwnsUuid(row.redirectUuid ?? row.uuid)) return;
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

/** A row's id and Check ("free"/"evade") from its icon. */
function rowRef(button) {
  return { rowId: button?.closest("[data-row-id]")?.dataset.rowId ?? null, which: button?.dataset.which ?? null };
}

/** A row's AI Reroll (its d20 icon). */
async function onRowReroll(event, message, button) {
  event.preventDefault();
  const { rowId, which } = rowRef(button);
  if (rowId && which) await rerollRow(message, rowId, which);
}

/** A row's Intervene (its handshake icon). */
async function onRowIntervene(event, message, button) {
  event.preventDefault();
  const { rowId, which } = rowRef(button);
  if (rowId && which) await interveneRow(message, rowId, which);
}

/** A row's injury (its band-aid icon): the Debuff its Evade called for. */
async function onRowInjury(event, message, button) {
  event.preventDefault();
  const { rowId } = rowRef(button);
  if (rowId) await guarded(message, `${rowId}:injury`, () => addRowInjury(message, rowId));
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
  { action: "rowReroll", custom: true, onClick: onRowReroll },
  { action: "rowIntervene", custom: true, onClick: onRowIntervene },
  { action: "rowInjury", custom: true, onClick: onRowInjury },
];
