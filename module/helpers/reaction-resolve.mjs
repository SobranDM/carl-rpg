/**
 * Mob Attack Resolution (Step 3, p.82; docs/combat-phases.md): "the Mobs deal
 * damage to the crawlers who either failed to Evade or didn't bother to
 * Evade".
 *
 * Lock Results (on the Reaction card or the tracker) locks the card, moves
 * the round to Resolution and posts the Damage card: a table per targeted
 * creature, a row per Attack on it. A row that will take damage shows the
 * GM a button with the Attack's damage formula; clicking it rolls that
 * Attack's damage once ("The GM rolls each Attack's damage dice"), applies it
 * to every defender it landed on, and fills in their Damage and Slots - the
 * card is updated in place. By the book:
 *  - not Evaded (or Caught): full damage;
 *  - Evaded: none - or half for an Area Attack, a quarter in its Splash (p.83);
 *  - an Evade that failed by 10 or more: +Floor damage and a Minor Injury
 *    after combat; a Natural 1: double damage and a Major Injury (p.80);
 *  - Caught: the Catcher takes it, with no Shield (p.191);
 *  - a Near Miss by a vehicle's occupant hits the vehicle (p.72).
 * Next Phase then goes to the Crawler Action Phase, offering to roll
 * anything still unrolled first.
 */
import { RollParts } from "../dice/roll-parts.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { applyDamageWithResult } from "../chat/damage-card.mjs";
import { actorFor, reactionCardFor, withCard, writeState } from "../chat/reaction-card.mjs";
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
      isArea: !!attack.isArea, floor: attack.floor ?? game.settings.get(SCOPE, "currentFloor"), rolled: null,
      effect: attack.effect ?? "", range: attack.range ?? "",
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
    const extraDr = hit.caughtBy ? catcherDr(actorFor(hit.caughtBy.uuid)) : 0;
    if (extraDr) tags.push({ key: "CARLRPG.Resolve.CatcherDr", data: { dr: extraDr } });
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
      applyUuid, status, caught: !!hit.caughtBy, extraDr,
      row: { hit: !!hit.row?.hit, zone: hit.row?.zone ?? "full", amazing: false },
      evade: evade ? { degree: evade.degree, success: evade.success } : null,
      tags, notes, result: null,
    };
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
  if (!actor) return 0;
  const item = actor.items?.find((i) => i.type === "skill" && i.name === "Catcher");
  const rank = actor.system?.skills?.[slugifySkillName("Catcher")]?.rank ?? item?.system.rank ?? 0;
  return 5 * Math.min(3, Math.floor(rank / 5));
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
    const rolled = await rollAttackDamage(attack);
    if (!rolled) return false;
    if (game.dice3d) void game.dice3d.showForRoll(rolled.roll, game.user, true).catch(() => {});
    attack.rolled = { total: rolled.total, breakdown: rolled.breakdown };

    const damageByType = { [attack.damageType]: rolled.total };
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
      if (raw <= 0) {
        row.result = { raw: 0, final: 0, slots: 0, shieldSlots: 0, dying: false, extra: [] };
        continue;
      }
      const applied = await applyDamageWithResult(actor, outcome.damage, attack.damageIsMagic, {
        noShield: row.caught, extraDr: row.extraDr ?? 0,
      });
      row.result = {
        raw,
        final: applied.result.totalFinalDamage,
        slots: applied.dying ? 0 : applied.result.slotsLost,
        shieldSlots: applied.dying ? 0 : applied.result.shieldSlotsLost,
        dying: applied.dying,
        // Beyond the digest line: a Dying countdown, a Debuff ended by the hit.
        extra: applied.dying ? applied.lines : applied.lines.slice(1),
      };
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
 * Draw the Damage card's tables, for whoever is viewing it (the roll
 * buttons are the GM's). Called from module/chat/chat-listener.mjs.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateDamageCard(message, html) {
  const container = html.querySelector(".carl-reaction-damage");
  const data = message.getFlag(SCOPE, FLAG);
  if (!container || !data) return;
  const i18n = game.i18n;
  const tables = new Map();
  for (const row of Object.values(data.rows ?? {}).sort((a, b) => a.order - b.order)) {
    if (!tables.has(row.tableUuid)) tables.set(row.tableUuid, { name: row.tableName, rows: [] });
    tables.get(row.tableUuid).rows.push(row);
  }
  container.innerHTML = [...tables.values()].map((table) => {
    const notes = [];
    const body = table.rows.map((row) => {
      const attack = data.attacks[row.attackId] ?? {};
      for (const note of row.notes ?? []) notes.push(esc(i18n.format(note.key, note.data)));
      for (const line of row.result?.extra ?? []) notes.push(line);
      const tags = (row.tags ?? []).map((t) => `<span class="carl-damage-tag">${esc(i18n.format(t.key, t.data))}</span>`).join("");
      // The printed effect stays in view: on-hit Debuffs are the GM's to apply.
      const effect = attack.effect ? `<div class="carl-attack-effect">${esc(attack.effect)}</div>` : "";
      const name = `<td class="carl-damage-attack"><strong>${esc(attack.mobName)}</strong><br>${esc(attack.attackName)}${tags ? `<div>${tags}</div>` : ""}${effect}</td>`;
      return `<tr data-row-id="${esc(row.id)}">${name}${damageCells(row, attack)}</tr>`;
    }).join("");
    return `<table class="carl-damage-table">
      <caption>${esc(table.name)}</caption>
      <thead><tr><th>${esc(i18n.localize("CARLRPG.Resolve.Attack"))}</th><th>${esc(i18n.localize("CARLRPG.Resolve.Damage"))}</th><th>${esc(i18n.localize("CARLRPG.Resolve.Slots"))}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>${notes.length ? `<ul class="carl-damage-notes plain">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}`;
  }).join("");
}

/** A row's Damage and Slots cells - or one merged cell before it's rolled. */
function damageCells(row, attack) {
  const i18n = game.i18n;
  const merged = (text) => `<td colspan="2" class="carl-damage-status">${text}</td>`;
  switch (row.status) {
    case "missed": return merged(esc(i18n.localize("CARLRPG.Resolve.Missed")));
    case "evaded": return merged(esc(i18n.localize("CARLRPG.Resolve.Evaded")));
    case "noDamage": return merged(esc(i18n.localize("CARLRPG.Resolve.NoDamage")));
    case "pending": {
      const formula = esc(displayFormula(attack));
      if (!game.user.isGM) return merged(esc(i18n.format("CARLRPG.Resolve.Waiting", { formula: displayFormula(attack) })));
      return merged(`<button type="button" class="carl-damage-roll-button" data-action="reactionDamage" data-attack-id="${esc(row.attackId)}">
        <i class="fas fa-dice"></i> ${formula}</button>`);
    }
  }
  const r = row.result ?? {};
  if (r.missing) return merged(esc(i18n.localize("CARLRPG.Resolve.TargetGone")));
  const tip = esc(i18n.format("CARLRPG.Resolve.RolledTip", { rolled: attack.rolled?.total ?? "-", raw: r.raw ?? 0, final: r.final ?? 0 }));
  const shield = r.shieldSlots ? ` <span class="carl-damage-shield">${esc(i18n.format("CARLRPG.Resolve.ShieldSlots", { count: r.shieldSlots }))}</span>` : "";
  const slots = r.dying ? esc(i18n.localize("CARLRPG.Resolve.Dying")) : `${esc(r.slots ?? 0)}${shield}`;
  return `<td class="carl-damage-amount" data-tooltip="${tip}">${esc(r.final ?? 0)}</td><td class="carl-damage-slots">${slots}</td>`;
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
