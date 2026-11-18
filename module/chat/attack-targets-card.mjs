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
 *
 * Shield Block (p.198; helpers/shield-block.mjs): a target's owner whose
 * crawler has the Skill and a Shield in hand can block a physical, non-Area
 * Attack on its row (magical too from Rank 5) - a Check against what its
 * Evade would roll against. Like a row's Evade, one Shield Block Action
 * covers every Attack this round (the 2026-11-18 ruling; shield-block.mjs
 * BLOCK_TAG): the first block pays, later ones that round - on other cards,
 * or after the Reaction card's - are free. On Success the row's
 * Apply halves the damage before DR (Rank 15: less the STR Mod); a Major or
 * Critical Fail costs the Shield DR when the row is applied. A Natural 20
 * at Rank 10 offers a free Shield Bash at the attacker.
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
import { evadeIsFree, hasSpent, noteUndo, takeAction } from "../helpers/actions.mjs";
import { blockedDamage } from "../helpers/damage-pipeline.mjs";
import {
  attackIsMagical, BLOCK_TAG, bashOffered, blockableAttack, blockNotes, blockReduction, damageShield, rollShieldBash, shieldBlocker,
  shieldLossFor,
} from "../helpers/shield-block.mjs";
import {
  addRowInjury, decidingRowCheck, recordRowBlock, recordRowEvade, resolveRowTarget, rowInjury, rowInterveneOpen, rowInterveners,
  rowRerollSources, shownRowCheck,
} from "./row-evade.mjs";
import {
  checkDetail, checkNotes, d6CouldChange, headerProgress, iconButton, rememberOpenRows, statusChip, statusRow, statusSection, trackPerCard, versusNum,
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
 * Rows this client has already Evaded, Shield Blocked, applied or Shield
 * Bashed from, by message.id:rowId. A player's write reaches the card
 * through the GM's client and lands a moment later, so until it does the
 * row is treated as done here - a second click (or a re-render before the
 * flag arrives) can't resolve it twice.
 * @type {Map<string, {evaded?: boolean, applied?: boolean, blocked?: boolean, bashed?: boolean}>}
 */
const doneLocally = trackPerCard(new Map());

/** The row as this client should treat it, with any not-yet-arrived local result folded in. */
function withLocal(message, row) {
  const local = doneLocally.get(`${message.id}:${row.id}`);
  if (!local) return row;
  // Once the card's own flags show the result, the local copy is no longer needed.
  if ((!local.applied || row.applied) && (!local.evaded || row.evade) && (!local.blocked || row.block)
    && (!local.bashed || row.checks?.block?.bashed)) {
    doneLocally.delete(`${message.id}:${row.id}`);
    return row;
  }
  const out = { ...row, applied: row.applied || !!local.applied, evade: row.evade ?? (local.evaded ? { pending: true } : null) };
  if (local.blocked) out.block = row.block ?? { pending: true };
  if (local.bashed && row.checks?.block) out.checks = { ...row.checks, block: { ...row.checks.block, bashed: true } };
  return out;
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
 * @param {{damageByType: Record<string, number>, targetEffects: object[], isArea: boolean, noAmazing?: boolean, armorPiercing?: boolean}} args
 *   noAmazing: the Attack has targets and was an Amazing Success against
 *   none - an Amazing-Success-only Debuff lands on no one, so it's dimmed.
 *   armorPiercing: the damage ignores DR but Anti-Piercing gear's - a pill says so.
 * @returns {string}
 */
export function buildAttackTargetsFooter({ damageByType = {}, targetEffects = [], isArea = false, noAmazing = false, armorPiercing = false }) {
  let pills = Object.entries(damageByType)
    .filter(([, amount]) => amount)
    .map(([type, amount]) => `<span class="carl-damage-pill">${esc(amount)} ${esc(damageTypeLabel(type))}</span>`)
    .join("");
  if (pills && armorPiercing) {
    pills += `<span class="carl-damage-pill carl-armor-piercing-pill" data-tooltip="${esc(game.i18n.localize("CARLRPG.ArmorPiercing.Hint"))}">`
      + `<i class="fas fa-shield-virus" aria-hidden="true"></i> ${esc(game.i18n.localize("CARLRPG.ArmorPiercing.Label"))}</span>`;
  }
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
  if (row.evade?.pending || row.block?.pending) return { status: "incoming", ...shown };
  // A Shield Block: halved, or a hit (it still counts as one, p.198).
  if (row.block) return { status: row.block.success ? "blocked" : "hit", ...shown };
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
  if (which === "block") sub.push(...blockNotes(check));
  sub.push(...checkNotes(check));
  // "A Near Miss targeting an occupant hits the vehicle" (p.72).
  if (row.redirectUuid) sub.push(i18n.format("CARLRPG.Vehicle.NearMissHitsVehicle", { vehicle: row.redirectName ?? "?" }));
  if (recoilWaiting(row, flags)) sub.push(i18n.localize("CARLRPG.Vehicle.Ram.RecoilWaiting"));
  if (row.evade?.pending || row.block?.pending) sub.push(i18n.localize("CARLRPG.Targets.EvadePending"));
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
  if (mine && !row.applied && row.hit && row.isCharacter && !row.evade && !row.block && !row.redirectUuid) {
    const free = row.freeEvade && !row.freeUsed;
    acts.push(iconButton("fa-person-running", i18n.localize(free ? "CARLRPG.Evade.RollFreeButton" : "CARLRPG.Evade.RollButton"),
      { ...data, action: "rowEvade" }));
  }
  if (mine && rowBlockable(row, flags)) {
    acts.push(iconButton("fa-shield", i18n.localize("CARLRPG.ShieldBlock.Button"), { ...data, action: "rowBlock" }));
  }
  if (mine && rowBashOpen(row, flags)) {
    acts.push(iconButton("fa-shield-halved", i18n.localize("CARLRPG.ShieldBlock.BashButton"), { ...data, action: "rowBash" }));
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
  if (applier && !rowResolved(row, flags.isArea) && !row.evade?.pending && !row.block?.pending && !recoilWaiting(row, flags)) {
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

/** An Actor from a row's uuid (sync), or null. */
function rowActor(uuid) {
  try {
    const doc = uuid ? fromUuidSync(uuid) : null;
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  } catch {
    return null;
  }
}

/** What Shield Block needs to know about the card's Attack. */
function attackFacts(flags) {
  return {
    isArea: !!flags.isArea,
    hasDamage: Object.values(flags.damageByType ?? {}).some((v) => v),
    magical: attackIsMagical({ damageIsMagic: flags.damageIsMagic, isSpell: flags.isSpell }),
  };
}

/**
 * Can this row's target Shield Block it now (helpers/shield-block.mjs)? A
 * landing hit on a creature that defends itself - not applied, blocked or
 * Evaded yet (a failed Evade can still be followed by a block), not a ram's
 * extra row or a Near Miss on its vehicle - whose target has the Skill and
 * a Shield in hand, and an Attack it can block at its Rank.
 * @param {object} row
 * @param {object} flags  The card's flags.
 * @returns {boolean}
 */
export function rowBlockable(row, flags) {
  if (!row?.hit || !row.isCharacter || row.applied || row.block || row.redirectUuid || row.damageOverride) return false;
  if ((row.role ?? "target") !== "target" || row.evade?.success || row.evade?.pending) return false;
  const blocker = shieldBlocker(rowActor(row.uuid));
  return !!blocker && blockableAttack(attackFacts(flags), blocker.rank);
}

/** Whether a row's Shield Block offers its Shield Bash (Rank 10, a Natural 20) and it hasn't been made. */
function rowBashOpen(row, flags) {
  const check = row?.checks?.block;
  return !!check && !check.bashed && !!flags.attackerUuid && bashOffered(check, check.rank ?? 0);
}

/** The rows' heading summary: how many of each. */
function targetSummary(statuses) {
  const i18n = game.i18n;
  const counts = {};
  for (const { status } of statuses) {
    const key = status === "quarter" || status === "blocked" ? "half" : status;
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

/** The row's Shield Block icon. */
function onRowBlock(event, message, button) {
  event.preventDefault();
  const rowId = button?.closest("[data-row-id]")?.dataset.rowId;
  return rowId ? blockRow(message, rowId) : undefined;
}

/**
 * Roll a row's Shield Block (p.198): a Shield Block Skill Check against what
 * the row's Evade would roll against (the Mob's to-hit; another crawler's
 * Attack total, p.87). The Check is written to the row; the row's Apply
 * uses it. The Shield Block Action (an Interrupt) in a fight - one covers
 * every Attack on them this round, as a row's Evade does (BLOCK_TAG).
 * @param {ChatMessage} message  The Attack card.
 * @param {string} rowId
 * @param {{skipDialog?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function blockRow(message, rowId, { skipDialog = false } = {}) {
  const stored = message.getFlag(SCOPE, "targetRows")?.[rowId];
  const row = stored && !stored.replaced ? withLocal(message, stored) : null;
  const flags = message.flags[SCOPE];
  if (!row || !rowBlockable(row, flags)) return;
  await guarded(message, row.id, async () => {
    if (withLocal(message, row).block) return;
    const target = await resolveRowTarget(row);
    if (!target) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Evade.NoActor"));
      return;
    }
    if (!target.actor.isOwner && !game.user.isGM) return;
    const blocker = shieldBlocker(target.actor);
    if (!blocker) return;
    // The round's Shield Block Action - never its Evade Action. Already
    // spent this round: this one is free.
    const pays = !hasSpent(target.actor, BLOCK_TAG);
    await takeAction(target.actor, "other", game.i18n.localize("CARLRPG.ShieldBlock.Name"), async (ctx) => {
      if (!pays) ctx.free();
      else if (!ctx.require()) return null;
      const difficulty = rowEvadeDifficulty(row, flags);
      const result = await CarlDice.rollOpposedSkillCheck(target.actor, blocker.skill, { difficulty, skipDialog, post: false });
      if (!result) return null;
      markLocal(message, row.id, { blocked: true });
      const check = await recordRowBlock(message, row, target, result, { shield: blocker.shield, rank: blocker.rank });
      // Undone: the row back to before this block (a free one has no Action to undo).
      if (pays) noteUndo(target.actor, { t: "rowEvade", which: "block", messageId: message.id, rowId: row.id, checkId: check.id });
      return true;
    }, { tag: BLOCK_TAG, optional: true });
  });
}

/** The row's Shield Bash icon: the free Attack at the attacker, then the row marked. */
async function onRowBash(event, message, button) {
  event.preventDefault();
  const row = clickedRow(message, button);
  const flags = message.flags[SCOPE];
  if (!row || !rowBashOpen(row, flags) || !userOwnsUuid(row.uuid)) return;
  await guarded(message, `${row.id}:bash`, async () => {
    const target = await resolveRowTarget(row);
    if (!target) return;
    const card = await rollShieldBash(target.actor, { targetUuid: flags.attackerUuid, rank: row.checks.block.rank ?? 0 });
    if (!card) return;
    markLocal(message, row.id, { bashed: true });
    await updateCardMessage(message, { flags: { [SCOPE]: { targetRows: { [row.id]: { checks: { block: { bashed: true } } } } } } });
  });
}

/**
 * Apply one row: its damage (scaled for Splash/Evade/Amazing - module/
 * helpers/attack-targets.mjs's rowOutcome) through the damage pipeline, and
 * the Attack's on-hit effects unless the target Evaded. A Shield Block on it
 * halves the damage before DR (helpers/shield-block.mjs) - its Debuffs still
 * land - and a Major or Critical Fail costs the Shield DR now.
 *
 * The row is read again from the card (with this client's own marks) just
 * before it's applied, and skipped if it's applied already; then marked
 * applied and applied here, at once - no round trip to the GM. What's
 * applied is the row as the card has it now, not the `row` passed in.
 * @param {ChatMessage} message
 * @param {object} row  The row (only its id is trusted).
 * @returns {Promise<string[]>} GM digest lines.
 */
export async function applyRow(message, row) {
  const stored = message.getFlag(SCOPE, "targetRows")?.[row.id];
  if (!stored || stored.replaced || withLocal(message, stored).applied) return [];
  // A ram's recoil isn't applied before its target has had its Evade.
  if (recoilWaiting(stored, message.flags[SCOPE])) return [];
  // A Near Miss on a vehicle's occupant lands on the vehicle (p.72).
  const target = await resolveRowTarget(stored.redirectUuid ? { uuid: stored.redirectUuid } : stored);
  if (!target) return [];
  // Read again after the wait: applied meanwhile (by this client, or as
  // the card now says), it isn't applied again.
  const flags = message.flags[SCOPE];
  const current = flags.targetRows?.[row.id] ?? stored;
  if (current.replaced || withLocal(message, current).applied) return [];
  row = current;
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
  // A Shield Block (p.198): half the damage before DR, less the STR Mod at Rank 15.
  const block = row.redirectUuid ? null : (row.checks?.block ?? null);
  const damage = block?.success ? blockedDamage(outcome.damage, blockReduction(target.actor, block.rank ?? 0)) : outcome.damage;
  if (Object.values(damage).some((v) => v)) {
    lines.push(...await applyDamageToActor(target.actor, damage, flags.damageIsMagic ?? true, { armorPiercing: !!flags.armorPiercing }));
  }
  if (block) lines.push(...await shieldDamageLines(target.actor, block));
  // A rammed (or ramming) vehicle passes half its damage to its occupants,
  // and the rammer loses Move - even when the recoil rounds down to nothing.
  if (flags.ram && row.hit) lines.push(...await afterRamRowApplied(message, row, target.actor, outcome.damage));
  if (outcome.effects) lines.push(...(await landDebuffs(target.actor, flags.targetEffects, row, flags.damageByType)).lines);
  return lines;
}

/**
 * A failed Shield Block's cost to the Shield (a Major Fail -1 DR, a
 * Critical Fail -2), written now, and the digest line saying so.
 * @param {Actor} actor
 * @param {object} block  The row's block Check.
 * @returns {Promise<string[]>}
 */
async function shieldDamageLines(actor, block) {
  const loss = shieldLossFor(block.degree);
  const hurt = loss ? await damageShield(actor, block.shieldId, loss) : null;
  if (!hurt) return [];
  const key = hurt.broken ? "CARLRPG.ShieldBlock.Digest.broken" : "CARLRPG.ShieldBlock.Digest.loss";
  return [game.i18n.format(key, { name: esc(actor.name), shield: esc(hurt.name), amount: hurt.amount, dr: hurt.dr })];
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
  if (!row || row.evade?.pending || row.block?.pending || rowResolved(row, message.getFlag(SCOPE, "isArea"))) return;
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
    await applyAllRows(message);
    ui.notifications.info(game.i18n.localize("CARLRPG.Targets.AppliedAll"));
  });
}

/**
 * Apply every row still to be applied (the GM's Apply All), one at a time.
 * Each row is read again from the card (and this client's own marks) just
 * before it's applied: one applied meanwhile - a player's own Apply that
 * has reached the card - is skipped, not applied twice.
 * @param {ChatMessage} message
 * @returns {Promise<string[]>}  The digest lines (appended to the card).
 */
export async function applyAllRows(message) {
  const lines = [];
  const ids = activeRows(message.getFlag(SCOPE, "targetRows")).map((row) => row.id);
  for (const id of ids) {
    const row = message.getFlag(SCOPE, "targetRows")?.[id];
    if (!row || row.replaced || rowResolved(withLocal(message, row), message.getFlag(SCOPE, "isArea"))) continue;
    lines.push(...await applyRow(message, row));
  }
  await appendDigest(message, lines);
  return lines;
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
  { action: "rowBlock", custom: true, onClick: onRowBlock },
  { action: "rowBash", custom: true, onClick: onRowBash },
];
