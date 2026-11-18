/**
 * Mob Attack Resolution (Step 3, p.82; docs/combat-phases.md): "the Mobs deal
 * damage to the crawlers who either failed to Evade or didn't bother to
 * Evade".
 *
 * Lock Results (on the Reaction card or the tracker) locks the card, moves
 * the round to Resolution and posts the Damage card: a section per targeted
 * creature, a status row per Attack on it (module/chat/status-rows.mjs, the
 * Reaction card's look). A row that will take damage shows the GM a button
 * with the Attack's damage formula in its number column; clicking it rolls
 * that Attack's damage once ("The GM rolls each Attack's damage dice"),
 * applies it to every defender it landed on, and shows their damage and
 * Health Bar slots - the card is updated in place. By the book:
 *  - not Evaded (or Caught): full damage;
 *  - Evaded: none - or half for an Area Attack, a quarter in its Splash (p.83);
 *  - an Evade that failed by 10 or more: +Floor damage and a Minor Injury
 *    after combat; a Natural 1: double damage and a Major Injury (p.80);
 *  - Caught: the Catcher takes it, with no Shield (p.191);
 *  - its Debuffs land with the damage, each by its trigger: on a hit, or on
 *    an Evade Major Fail or worse / a Critical Fail - which an unEvaded hit
 *    counts as (ruled 2026-11-17) - but not on a full Immunity, nor on a
 *    Catcher at Rank 15 ("ignore any Debuffs attached to this damage",
 *    p.187). An Attack with Debuffs and no damage gets an Apply button in
 *    place of a roll (docs/mob-sheet.md);
 *  - a Near Miss by a vehicle's occupant hits the vehicle (p.72).
 * Next Phase then goes to the Crawler Action Phase, offering to roll
 * anything still unrolled first.
 */
import { RollParts } from "../dice/roll-parts.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { applyDamageWithResult } from "../chat/damage-card.mjs";
import { landDebuffs } from "./land-debuffs.mjs";
import { resolveTargetEffectLabel } from "./conditions.mjs";
import { debuffLandsOn } from "./modifiers.mjs";
import { actorFor, attackDetails, attackLine, reactionCardFor, withCard, writeState } from "../chat/reaction-card.mjs";
import { headerProgress, rememberOpenRows, statusChip, statusRow, statusSection } from "../chat/status-rows.mjs";
import { rowOutcome } from "./attack-targets.mjs";
import { vehicleSeatOf } from "./vehicle-state.mjs";
import { decidingEvade, hitList, unevadedNames } from "./reaction-state.mjs";
import { setPhase } from "./combat-phases.mjs";
import { slugifySkillName } from "./modifiers.mjs";

const SCOPE = "carl-rpg";
const FLAG = "reactionDamage";

/* -------------------------------------------- */
/*  Locking                                     */
/* -------------------------------------------- */

/**
 * Lock the round's Reaction card, move to Resolution and post the Damage
 * card. GM only. Asks first if anyone still has an Attack landing that they
 * haven't Evaded. With no Reaction card (nothing declared) the round goes
 * straight to the Crawler Action Phase.
 * @param {Combat} combat
 * @returns {Promise<Combat>}
 */
export async function lockResults(combat) {
  if (!game.user.isGM) return combat;
  const message = reactionCardFor(combat);
  const state = message?.getFlag(SCOPE, "reaction");
  if (!state || state.locked) return setPhase(combat, "act");

  const waiting = unevadedNames(state);
  if (waiting.length) {
    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CARLRPG.Reaction.Op.lock") },
      classes: ["carl-lock-warning"],
      content: `<p>${esc(game.i18n.format("CARLRPG.Reaction.LockWarning", { names: waiting.join(", ") }))}</p>`,
      rejectClose: false,
    });
    if (!proceed) return combat;
  }

  // Locked through the card's queue, after any change still being applied.
  const locked = await withCard(message.id, async () => {
    const current = foundry.utils.deepClone(message.getFlag(SCOPE, "reaction"));
    if (!current || current.locked) return null;
    current.locked = true;
    await writeState(message, current);
    return current;
  });
  if (!locked) return combat;

  await setPhase(combat, "resolve");
  await postDamageCard(combat, locked);
  return combat;
}

/**
 * Leaving Resolution (Next Phase): offer to roll whatever hasn't been rolled
 * yet. Returns false to stay in Resolution.
 * @param {Combat} combat
 * @returns {Promise<boolean>}
 */
export async function finishResolution(combat) {
  const message = damageCardFor(combat);
  const pending = message ? unrolledAttacks(message.getFlag(SCOPE, FLAG)) : [];
  if (!pending.length) return true;
  const roll = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("CARLRPG.Phase.Next.resolve") },
    classes: ["carl-unrolled-warning"],
    content: `<p>${esc(game.i18n.format("CARLRPG.Resolve.UnrolledWarning", { count: pending.length }))}</p>`,
    rejectClose: false,
  });
  if (!roll) return false;
  await rollAllDamage(message);
  return true;
}

/* -------------------------------------------- */
/*  The Damage card                             */
/* -------------------------------------------- */

/** This round's Damage card for a combat, if any. */
export function damageCardFor(combat) {
  const ref = combat?.getFlag(SCOPE, "damageCard");
  if (!ref || ref.round !== combat.round) return null;
  return game.messages.get(ref.messageId) ?? null;
}

/**
 * The Damage card's rows from a locked Reaction card: one per Attack on each
 * defender, decided as far as it can be before the damage is rolled.
 * @param {Combat} combat
 * @param {object} state  The Reaction card's state.
 * @returns {object}  The card's `reactionDamage` flag.
 */
export function buildDamageState(combat, state) {
  const data = { combatId: combat.id, round: combat.round, attacks: {}, rows: {} };
  for (const attack of Object.values(state.attacks ?? {})) {
    data.attacks[attack.id] = {
      id: attack.id, mobUuid: attack.mobUuid, mobName: attack.mobName, attackName: attack.attackName,
      damage: attack.damage ?? "", damageType: attack.damageType ?? "", damageIsMagic: attack.damageIsMagic ?? true,
      armorPiercing: !!attack.armorPiercing,
      isArea: !!attack.isArea, floor: attack.floor ?? game.settings.get(SCOPE, "currentFloor"), rolled: null,
      effect: attack.effect ?? "", range: attack.range ?? "",
      targetEffects: attack.targetEffects ?? [],
    };
  }
  let order = 0;
  for (const hit of hitList(state)) {
    const attack = data.attacks[hit.attackId];
    if (!attack) continue;
    const evade = decidingEvade(hit);
    let status = "pending";
    if (!hit.row?.hit) status = "missed";
    else if (evade?.success && !attack.isArea) status = "evaded";
    else if (!attack.damage) status = "noDamage";

    const tags = [];
    const notes = [];
    if (hit.tauntedBy) tags.push({ key: "CARLRPG.Reaction.TauntedFrom", data: { name: hit.originalName } });
    if (hit.caughtBy) tags.push({ key: "CARLRPG.Reaction.CaughtFor", data: { name: hit.originalName } });
    const catcher = hit.caughtBy ? actorFor(hit.caughtBy.uuid) : null;
    const extraDr = catcher ? catcherDr(catcher) : 0;
    if (extraDr) tags.push({ key: "CARLRPG.Resolve.CatcherDr", data: { dr: extraDr } });
    // "Ignore any Debuffs attached to this damage" (Catcher Rank 15, p.187).
    const ignoreDebuffs = !!catcher && catcherRank(catcher) >= 15;
    if (ignoreDebuffs && attack.targetEffects.length) tags.push({ key: "CARLRPG.Resolve.CatcherNoDebuffs", data: {} });
    if (hit.row?.zone === "splash") tags.push({ key: "CARLRPG.Targets.Splash", data: {} });
    if (status === "pending" && evade?.success) tags.push({ key: "CARLRPG.Resolve.EvadedHalf", data: {} });

    let applyUuid = hit.targetUuid;
    // "A Near Miss targeting an occupant hits the vehicle" (p.72) - not an
    // Area Attack, which catches the vehicle on its own row.
    if (status === "pending" && !attack.isArea && evade?.degree === "nearMissFail") {
      const target = actorFor(hit.targetUuid);
      const seat = target ? vehicleSeatOf(target) : null;
      if (seat) {
        applyUuid = seat.vehicle.uuid;
        tags.push({ key: "CARLRPG.Resolve.HitsVehicle", data: { vehicle: seat.vehicle.name } });
      }
    }
    // Injuries land "after combat, once the adrenaline wears off" (p.80).
    if (evade?.degree === "majorFail") notes.push({ key: "CARLRPG.Resolve.MinorInjury", data: { name: hit.targetName } });
    if (evade?.degree === "criticalFail") notes.push({ key: "CARLRPG.Resolve.MajorInjury", data: { name: hit.targetName } });

    data.rows[hit.id] = {
      id: hit.id, order: order++, attackId: hit.attackId, tableUuid: hit.targetUuid, tableName: hit.targetName,
      applyUuid, status, caught: !!hit.caughtBy, extraDr, ignoreDebuffs,
      // The Evade it called for, shown under the Mob's name.
      difficulty: hit.row?.isCharacter && hit.row?.hit && !hit.caughtBy ? (hit.row.difficulty ?? null) : null,
      row: { hit: !!hit.row?.hit, zone: hit.row?.zone ?? "full", amazing: false },
      evade: evade ? { degree: evade.degree, success: evade.success } : null,
      tags, notes, result: null,
    };
    // No damage, but Debuffs that would land: the GM applies them (an
    // Apply button in place of a roll).
    if (status === "noDamage" && rowDebuffs(data.rows[hit.id], attack).length) data.rows[hit.id].status = "pending";
  }
  return data;
}

/**
 * A Catcher's extra DR against the hit they Caught: +5 at Rank 5, 10 and 15,
 * adding up (p.187).
 * @param {Actor|null} actor
 * @returns {number}
 */
export function catcherDr(actor) {
  return 5 * Math.min(3, Math.floor(catcherRank(actor) / 5));
}

/**
 * A crawler's Catcher Rank (p.187), 0 without the Skill.
 * @param {Actor|null} actor
 * @returns {number}
 */
export function catcherRank(actor) {
  if (!actor) return 0;
  const item = actor.items?.find((i) => i.type === "skill" && i.name === "Catcher");
  return actor.system?.skills?.[slugifySkillName("Catcher")]?.rank ?? item?.system.rank ?? 0;
}

/**
 * The Debuffs that would land on a Damage card row, before immunities
 * (shown on the row before it's rolled).
 * @param {object} row  A Damage card row.
 * @param {object} attack  Its Attack.
 * @returns {object[]}
 */
export function rowDebuffs(row, attack) {
  if (row.ignoreDebuffs || !row.row?.hit || row.evade?.success) return [];
  return (attack.targetEffects ?? []).filter((te) => te.debuffKey && debuffLandsOn(te, { ...row.row, evade: row.evade }));
}

/**
 * Post the round's Damage card (GM).
 * @param {Combat} combat
 * @param {object} state  The locked Reaction card's state.
 * @returns {Promise<ChatMessage>}
 */
export async function postDamageCard(combat, state) {
  const message = await createCardMessage({
    title: game.i18n.format("CARLRPG.Reaction.DamageTitle", { round: combat.round }),
    subtitle: game.i18n.localize("CARLRPG.Phase.Step.resolve"),
    img: "icons/svg/combat.svg",
    body: `<div class="carl-reaction carl-reaction-damage"></div>`,
    flags: { kind: "reactionDamage", [FLAG]: buildDamageState(combat, state) },
    speaker: { alias: game.i18n.localize("CARLRPG.Phase.Speaker") },
  });
  await combat.setFlag(SCOPE, "damageCard", { round: combat.round, messageId: message.id });
  return message;
}

/** Ids of the Attacks with rows still waiting on their damage roll. */
export function unrolledAttacks(data) {
  if (!data) return [];
  const ids = new Set(Object.values(data.rows ?? {}).filter((r) => r.status === "pending").map((r) => r.attackId));
  return [...ids].filter((id) => !data.attacks[id]?.rolled);
}

/* -------------------------------------------- */
/*  Rolling                                     */
/* -------------------------------------------- */

/**
 * Roll one Attack's damage and apply it to every defender it landed on,
 * updating the card in place. GM only; once per Attack.
 * @param {ChatMessage} message  The Damage card.
 * @param {string} attackId
 * @returns {Promise<boolean>} Whether it rolled.
 */
export function rollAttackOnCard(message, attackId) {
  return withCard(message.id, async () => {
    if (!game.user.isGM) return false;
    const current = message.getFlag(SCOPE, FLAG);
    if (!current?.attacks?.[attackId] || current.attacks[attackId].rolled) return false;
    const data = foundry.utils.deepClone(current);
    const attack = data.attacks[attackId];
    // An Attack with no damage (only Debuffs) has nothing to roll.
    const hasDamage = !!String(attack.damage ?? "").trim();
    const rolled = hasDamage ? await rollAttackDamage(attack) : { total: 0, breakdown: "" };
    if (!rolled) return false;
    if (hasDamage && game.dice3d) void game.dice3d.showForRoll(rolled.roll, game.user, true).catch(() => {});
    attack.rolled = { total: rolled.total, breakdown: rolled.breakdown };

    const damageByType = hasDamage ? { [attack.damageType]: rolled.total } : {};
    const rows = Object.values(data.rows).filter((r) => r.attackId === attackId && r.status === "pending");
    for (const row of rows) {
      row.status = "rolled";
      const outcome = rowOutcome({ ...row.row, evade: row.evade }, { damageByType, isArea: attack.isArea, floor: attack.floor });
      const raw = Object.values(outcome.damage).reduce((sum, v) => sum + (v || 0), 0);
      const actor = actorFor(row.applyUuid);
      if (!actor) {
        row.result = { missing: true };
        continue;
      }
      row.result = { raw: 0, final: 0, slots: 0, shieldSlots: 0, dying: false, extra: [], debuffs: [] };
      if (raw > 0) {
        const applied = await applyDamageWithResult(actor, outcome.damage, attack.damageIsMagic, {
          noShield: row.caught, extraDr: row.extraDr ?? 0, armorPiercing: !!attack.armorPiercing,
        });
        Object.assign(row.result, {
          raw,
          final: applied.result.totalFinalDamage,
          slots: applied.dying ? 0 : applied.result.slotsLost,
          shieldSlots: applied.dying ? 0 : applied.result.shieldSlotsLost,
          dying: applied.dying,
          // Beyond the digest line: a Dying countdown, a Debuff ended by the hit.
          extra: applied.dying ? applied.lines : applied.lines.slice(1),
        });
      }
      // Its Debuffs, each by its trigger (not on an Evade; not for a
      // Catcher at Rank 15).
      if (outcome.effects && !row.ignoreDebuffs) {
        const { landed, lines } = await landDebuffs(actor, attack.targetEffects, { ...row.row, evade: row.evade }, damageByType);
        row.result.debuffs = landed.map((te) => ({ label: resolveTargetEffectLabel(te), stacks: te.stacks ?? 1 }));
        row.result.extra.push(...lines);
      }
    }
    const { ForcedReplacement } = foundry.data.operators;
    await message.update({ flags: { [SCOPE]: { [FLAG]: ForcedReplacement.create(data) } } });
    return true;
  });
}

/**
 * Roll every Attack still waiting.
 * @param {ChatMessage} message
 * @returns {Promise<void>}
 */
export async function rollAllDamage(message) {
  for (const attackId of unrolledAttacks(message.getFlag(SCOPE, FLAG))) await rollAttackOnCard(message, attackId);
}

/**
 * An Attack's damage, rolled once: its printed formula with "F" as the
 * Floor, using the Mob's roll data when it still exists.
 * @param {object} attack
 * @returns {Promise<{roll: Roll, total: number, breakdown: string}|null>}
 */
async function rollAttackDamage(attack) {
  const mob = actorFor(attack.mobUuid);
  const data = { ...(mob?.getRollData() ?? {}) };
  data.floor ??= attack.floor;
  const parts = new RollParts(data);
  parts.add(String(attack.damage).replace(/\bF\b/g, "@floor"), attack.attackName);
  try {
    return await parts.evaluate();
  } catch (err) {
    ui.notifications.warn(game.i18n.format("CARLRPG.MobAttack.BadDamage", { formula: attack.damage }));
    return null;
  }
}

/** The formula as the button shows it: "F" as the Floor. */
function displayFormula(attack) {
  return String(attack.damage).replace(/\bF\b/g, String(attack.floor));
}

/* -------------------------------------------- */
/*  Drawing the card                            */
/* -------------------------------------------- */

/**
 * Which rows' expanders this client has open, by `messageId:rowKey`.
 * @type {Set<string>}
 */
const openRows = new Set();

/** A Damage card row's status chip: why it does what it does. */
function damageStatus(row) {
  if (row.status === "missed") return "missed";
  if (row.status === "evaded") return "evaded";
  if (row.caught) return "caught";
  if (row.evade?.success) return row.row?.zone === "splash" ? "quarter" : "half";
  return "hit";
}

/** The number column: the GM's roll button, the damage and slots, or a word. */
function damageNum(row, attack) {
  const i18n = game.i18n;
  const muted = (text) => `<span class="carl-status-vs">${esc(text)}</span>`;
  switch (row.status) {
    case "missed": return "";
    case "evaded": return muted(i18n.localize("CARLRPG.Resolve.None"));
    case "noDamage": return muted(i18n.localize("CARLRPG.Resolve.NoDamage"));
    case "pending": {
      // Debuffs and no damage: the GM applies them.
      if (!String(attack.damage ?? "").trim()) {
        const label = i18n.localize("CARLRPG.Resolve.ApplyDebuffs");
        if (!game.user.isGM) return muted(label);
        return `<button type="button" class="carl-status-button is-primary carl-damage-roll-button" data-action="reactionDamage" data-attack-id="${esc(row.attackId)}">
        <i class="fas fa-skull-crossbones"></i> ${esc(label)}</button>`;
      }
      const formula = displayFormula(attack);
      if (!game.user.isGM) return `<span class="carl-status-vs" data-tooltip="${esc(i18n.format("CARLRPG.Resolve.Waiting", { formula }))}">${esc(formula)}</span>`;
      return `<button type="button" class="carl-status-button is-primary carl-damage-roll-button" data-action="reactionDamage" data-attack-id="${esc(row.attackId)}">
        <i class="fas fa-dice"></i> ${esc(formula)}</button>`;
    }
  }
  const r = row.result ?? {};
  if (r.missing) return muted(i18n.localize("CARLRPG.Resolve.TargetGone"));
  // A Debuffs-only Attack that dealt nothing: its "Gains" line says it all.
  if (!String(attack.damage ?? "").trim() && !r.final && !r.dying) return muted(i18n.localize("CARLRPG.Resolve.NoDamage"));
  const slots = r.dying ? esc(i18n.localize("CARLRPG.Resolve.Dying"))
    : esc(i18n.format(r.slots === 1 ? "CARLRPG.Resolve.OneSlot" : "CARLRPG.Resolve.SlotCount", { count: r.slots ?? 0 }));
  const shield = r.shieldSlots ? ` ${esc(i18n.format("CARLRPG.Resolve.ShieldSlots", { count: r.shieldSlots }))}` : "";
  return `<b class="carl-damage-amount">${esc(r.final ?? 0)}</b> <span class="carl-status-vs">· <span class="carl-damage-slots">${slots}${shield}</span></span>`;
}

/** A section's heading: the damage taken, what's still to roll, or "All clear". */
function damageSummary(rows) {
  const i18n = game.i18n;
  const parts = [];
  const taken = rows.reduce((sum, row) => sum + (row.status === "rolled" ? (row.result?.final ?? 0) : 0), 0);
  const pending = rows.filter((row) => row.status === "pending").length;
  if (taken) parts.push(i18n.format("CARLRPG.Resolve.Taken", { n: taken }));
  if (pending) parts.push(i18n.format("CARLRPG.Resolve.ToRoll", { n: pending }));
  if (rows.some((row) => row.result?.dying)) parts.push(i18n.localize("CARLRPG.Resolve.DyingShort"));
  if (!parts.length) parts.push(i18n.localize("CARLRPG.Reaction.Sum.clear"));
  return parts.join(" · ");
}

/**
 * Draw the Damage card for whoever is viewing it, in the Reaction card's
 * look (docs/reaction-card-redesign.md): "1 of 3 rolled" in its header, a
 * section per target, a row per Attack with its chip, its damage (or the
 * GM's roll button) and the roll in its expander, and the injury reminders
 * under each section. Called from module/chat/chat-listener.mjs.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateDamageCard(message, html) {
  const container = html.querySelector(".carl-reaction-damage");
  const data = message.getFlag(SCOPE, FLAG);
  if (!container || !data) return;
  const i18n = game.i18n;

  const rolling = new Set(Object.values(data.rows ?? {}).filter((r) => ["pending", "rolled"].includes(r.status)).map((r) => r.attackId));
  const rolled = [...rolling].filter((id) => data.attacks[id]?.rolled).length;
  headerProgress(html, rolling.size
    ? i18n.format("CARLRPG.Resolve.Progress", { rolled, total: rolling.size })
    : i18n.localize("CARLRPG.Resolve.NothingToRoll"));

  const sections = new Map();
  for (const row of Object.values(data.rows ?? {}).sort((a, b) => a.order - b.order)) {
    if (!sections.has(row.tableUuid)) sections.set(row.tableUuid, { name: row.tableName, rows: [] });
    sections.get(row.tableUuid).rows.push(row);
  }
  container.innerHTML = [...sections.values()].map((section) => {
    const notes = [];
    const rows = section.rows.map((row) => {
      const attack = data.attacks[row.attackId] ?? {};
      for (const note of row.notes ?? []) notes.push(esc(i18n.format(note.key, note.data)));
      // Already HTML: the damage pipeline's lines (a Dying countdown, a Debuff the hit ended).
      for (const line of row.result?.extra ?? []) notes.push(line);
      // Under the Mob's name: its Attack and Evade target, then the notes
      // (the chip says it was Evaded).
      const sub = [
        ...attackLine(attack, row.difficulty ?? null),
        ...(row.tags ?? []).filter((t) => t.key !== "CARLRPG.Resolve.EvadedHalf").map((t) => i18n.format(t.key, t.data)),
      ];
      // Its Debuffs: what will land once rolled, then what did.
      const named = (list) => list.map((d) => `${d.label} ×${d.stacks ?? 1}`).join(", ");
      if (row.status === "pending") {
        const coming = rowDebuffs(row, attack).map((te) => ({ label: resolveTargetEffectLabel(te), stacks: te.stacks }));
        if (coming.length) sub.push(i18n.format("CARLRPG.Resolve.WillGain", { debuffs: named(coming) }));
      } else if (row.result?.debuffs?.length) {
        sub.push(i18n.format("CARLRPG.Resolve.Gained", { debuffs: named(row.result.debuffs) }));
      }
      const r = row.result;
      const tip = row.status === "rolled" && r && !r.missing
        ? i18n.format("CARLRPG.Resolve.RolledTip", { rolled: attack.rolled?.total ?? "-", raw: r.raw ?? 0, final: r.final ?? 0 }) : "";
      const detail = [
        attack.rolled ? `<div>${esc(attack.rolled.breakdown ?? "")}</div>` : "",
        tip ? `<div>${esc(tip)}</div>` : "",
        attackDetails(attack),
      ].join("");
      const key = `damage:${row.id}`;
      return statusRow({
        id: row.id, key, open: openRows.has(`${message.id}:${key}`),
        chip: statusChip(damageStatus(row)),
        what: `<strong>${esc(attack.mobName ?? "?")}</strong>`,
        flag: attack.effect ? `<i class="fas fa-scroll carl-status-flag" data-tooltip="${esc(i18n.localize("CARLRPG.Reaction.HasEffect"))}"></i>` : "",
        sub, num: damageNum(row, attack), numTip: tip, detail,
      });
    });
    return statusSection({ name: section.name, summary: damageSummary(section.rows), rows, notes });
  }).join("");
  rememberOpenRows(container, message.id, openRows);
}

/**
 * The GM's roll button on a Damage card row.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 * @param {HTMLElement} button
 */
async function onRollDamage(event, message, button) {
  event.preventDefault();
  if (!game.user.isGM) return;
  button.disabled = true;
  try {
    await rollAttackOnCard(message, button.dataset.attackId);
  } finally {
    button.disabled = false;
  }
}

/** Registry entries for module/chat/chat-listener.mjs. */
export const damageCardActionEntries = [{ action: "reactionDamage", custom: true, onClick: onRollDamage }];
