/**
 * End-of-round and end-of-combat Debuff automation (Table 11, Playing the
 * Game p.96-97), driven by module/documents/combat.mjs - which Foundry runs
 * on exactly one GM client (Combat#_onEndRound), so every write here has
 * GM permission and never races another client.
 *
 * Fully automatic by the project owner's choice: damage is rolled AND
 * applied, countdowns tick, and expired Debuffs are removed, with one chat
 * card per round recording what happened (the HB-slot math is folded into a
 * GM-only digest, same convention as module/chat/damage-card.mjs).
 *
 * Per round end, for each creature in the Combat:
 *  1. Damage-dealing Debuffs (`mechanics.dot`) roll their damage, once per
 *     stack ("Stackable... they all apply their effect cumulatively").
 *     "Damage from Debuffs bypasses DR, but other Resistances and
 *     Immunities still apply" (p.96) - computeDamageApplication's ignoreDr.
 *     Debuff damage is treated as magical, so a Shield pool doesn't absorb it.
 *     - A crawler that would drop to 0 HB makes an automatic CON Stat Check
 *       vs. 10 + Floor first: "On a Success, the Debuff ends, and the
 *       crawler avoids the damage" (p.96).
 *     - A Dying creature "instead subtract[s] 1 from the countdown value"
 *       for each instance of damage (Dying, Table 11) - nothing is rolled.
 *  2. Any HB-slot loss ends `endsOnHbLoss` Debuffs (Terrified).
 *  3. Dying's countdown ticks down by 1; at 0 the card says so, once (the
 *     actor is left in place - what death means at the table is the GM's
 *     call). Healing ends Dying (module/documents/actor.mjs's _preUpdate).
 *  4. "rounds"-duration Debuffs tick down by 1 and are removed at 0.
 *
 * When a started Combat is deleted, "until the end of combat" Debuffs
 * (`mechanics.endsWithCombat`) and any leftover "rounds"-duration ones are
 * removed.
 */
import { CARLRPG } from "./config.mjs";
import { computeDamageApplication } from "./damage-pipeline.mjs";
import { collectDebuffRows, resolveRollerRows, consumedConditionIds, conditionLabel } from "./debuff-effects.mjs";
import { resolveD20Formula } from "../dice/dice.mjs";
import { createRollMessage, createCardMessage, esc } from "../chat/chat-card.mjs";
import { queueForActor } from "./actor-queue.mjs";

/** An entry's own duration type (Potion Sickness's Poisoned) wins over its preset's. */
function durationTypeOf(condition) {
  return condition.durationType ?? CARLRPG.debuffs[condition.key]?.durationType ?? null;
}


function mechanicsOf(condition) {
  return CARLRPG.debuffs[condition.key]?.mechanics ?? null;
}

/**
 * The distinct actors seated in a Combat - an unlinked token's own synthetic
 * actor, not its base Actor, so each Mob instance keeps its own Debuffs.
 * @param {Combat} combat
 * @returns {Actor[]}
 */
export function combatActors(combat) {
  const byUuid = new Map();
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (actor && !byUuid.has(actor.uuid)) byUuid.set(actor.uuid, actor);
  }
  return [...byUuid.values()];
}

/**
 * Run one creature's end-of-round Debuff effects and write the result.
 * @param {Actor} actor
 * @returns {Promise<{lines: string[], gmLines: string[], rolls: Roll[], rollMeta: object[]}|null>}
 *   null when the actor has no conditions at all. `lines` are trusted HTML.
 */
export function processActorRoundEnd(actor) {
  // One writer at a time: the timed-effect expiry sweep (module/helpers/
  // expiry.mjs) also rewrites conditions, on the same round advance.
  return queueForActor(actor.uuid, () => runActorRoundEnd(actor));
}

async function runActorRoundEnd(actor) {
  const sys = actor.system;
  const conditions = foundry.utils.deepClone(sys.conditions ?? []);
  if (!conditions.length) return null;

  const floor = game.settings.get("carl-rpg", "currentFloor");
  const rollData = actor.getRollData();
  const name = esc(actor.name);
  const lines = [];
  const gmLines = [];
  const rolls = [];
  const rollMeta = [];
  const removeIds = new Set();
  const startHb = sys.hb?.value ?? 0;
  let hb = startHb;

  const dying = conditions.find((c) => mechanicsOf(c)?.countdown) ?? null;
  if (dying && (dying.remaining === null || dying.remaining === undefined)) {
    dying.remaining = Math.max(0, sys.stats?.con?.mod ?? 0);
  }
  // Once the countdown has hit 0 and been announced (keyed to this Dying
  // entry's id, so a later, fresh Dying starts over) nothing more ticks or
  // gets re-announced. A countdown that STARTS at 0 (CON Mod 0 or less) is
  // still live until the first round end announces it.
  const dyingActive = !!dying && actor.getFlag("carl-rpg", "dyingAnnounced") !== dying.id;
  let announceDeath = false;

  // 1. Damage-dealing Debuffs.
  for (const condition of conditions) {
    const dot = mechanicsOf(condition)?.dot;
    if (!dot) continue;
    const label = esc(conditionLabel(condition));

    // "Each time a Dying Crawler would take damage from any source, they
    // instead subtract 1 from the countdown value" - no damage to roll.
    if (dying) {
      if (dyingActive && dying.remaining > 0) {
        dying.remaining -= 1;
        lines.push(game.i18n.format("CARLRPG.RoundEnd.DotWhileDying", { name, debuff: label }));
      }
      continue;
    }

    const stacks = Math.max(1, Number(condition.stacks) || 1);
    const formula = Array.from({ length: stacks }, () => `(${dot.formula})`).join(" + ");
    const roll = await new Roll(formula, rollData).evaluate();
    rolls.push(roll);
    rollMeta.push({ label: `${actor.name}: ${conditionLabel(condition)}`, breakdown: roll.formula });

    const result = computeDamageApplication({ [dot.damageType ?? ""]: roll.total }, actor, true, { ignoreDr: true });

    if (actor.type === "character" && hb > 0 && hb - result.slotsLost <= 0) {
      // An automatic CON Stat Check - the crawler's own Debuffs (Minor
      // Injury's -2, Shit-Faced's Disadvantage, Stunned...) still apply. It
      // isn't an Action, so Queasy/Staggered neither apply nor end.
      const difficulty = 10 + floor;
      const conMod = sys.stats?.con?.mod ?? 0;
      const checkRows = collectDebuffRows(sys, "check", { ownAction: false });
      const effect = resolveRollerRows(checkRows);
      const penalty = effect.penalties.reduce((sum, p) => sum + p.value, 0);
      const check = await new Roll(`${resolveD20Formula(false, "normal", effect)} + (${conMod}) + (${penalty})`).evaluate();
      for (const id of consumedConditionIds(effect.applied)) removeIds.add(id);
      rolls.push(check);
      rollMeta.push({
        label: game.i18n.format("CARLRPG.RoundEnd.FatalCheckLabel", { name: actor.name, difficulty }),
        breakdown: check.formula,
      });
      if (check.total >= difficulty) {
        removeIds.add(condition.id);
        lines.push(game.i18n.format("CARLRPG.RoundEnd.FatalSaved", { name, debuff: label }));
        continue;
      }
      lines.push(game.i18n.format("CARLRPG.RoundEnd.FatalFailed", { name }));
    }

    const slotsLost = Math.min(result.slotsLost, hb);
    hb -= slotsLost;
    lines.push(game.i18n.format("CARLRPG.RoundEnd.DotDamage", { name, debuff: label, amount: result.totalFinalDamage }));
    gmLines.push(game.i18n.format("CARLRPG.RoundEnd.DotDigest", {
      name, debuff: label, raw: roll.total, final: result.totalFinalDamage, slots: slotsLost,
    }));
  }

  // 2. "...or you take at least 1 HB slot damage" (Terrified).
  if (hb < startHb) {
    for (const condition of conditions) {
      if (mechanicsOf(condition)?.endsOnHbLoss && !removeIds.has(condition.id)) {
        removeIds.add(condition.id);
        lines.push(game.i18n.format("CARLRPG.RoundEnd.EndedByDamage", { name, debuff: esc(conditionLabel(condition)) }));
      }
    }
  }

  // 3. Dying's countdown.
  if (dyingActive) {
    dying.remaining = Math.max(0, dying.remaining - 1);
    announceDeath = dying.remaining === 0;
    lines.push(announceDeath
      ? game.i18n.format("CARLRPG.RoundEnd.DyingDead", { name })
      : game.i18n.format("CARLRPG.RoundEnd.DyingCountdown", { name, rounds: dying.remaining }));
  }

  // 4. "rounds"-duration ticks.
  for (const condition of conditions) {
    if (removeIds.has(condition.id) || condition === dying) continue;
    if (durationTypeOf(condition) !== "rounds") continue;
    if (condition.remaining === null || condition.remaining === undefined) continue;
    condition.remaining -= 1;
    if (condition.remaining <= 0) {
      removeIds.add(condition.id);
      lines.push(game.i18n.format("CARLRPG.RoundEnd.Expired", { name, debuff: esc(conditionLabel(condition)) }));
    }
  }

  const kept = conditions.filter((c) => !removeIds.has(c.id));
  const updates = {};
  if (JSON.stringify(kept) !== JSON.stringify(sys.conditions ?? [])) updates["system.conditions"] = kept;
  if (hb !== startHb) updates["system.hb.value"] = hb;
  if (announceDeath) updates["flags.carl-rpg.dyingAnnounced"] = dying.id;
  if (Object.keys(updates).length) await actor.update(updates);

  return { lines, gmLines, rolls, rollMeta };
}

/**
 * End-of-round pass over every creature in the Combat, posting one summary
 * card when anything happened.
 * @param {Combat} combat
 * @param {number} round  The round that just ended.
 * @returns {Promise<ChatMessage|null>}
 */
export async function processRoundEnd(combat, round) {
  const lines = [];
  const gmLines = [];
  const rolls = [];
  const rollMeta = [];
  for (const actor of combatActors(combat)) {
    try {
      const result = await processActorRoundEnd(actor);
      if (!result) continue;
      lines.push(...result.lines);
      gmLines.push(...result.gmLines);
      rolls.push(...result.rolls);
      rollMeta.push(...result.rollMeta);
    } catch (err) {
      console.error(`CarlRPG | End-of-round Debuff processing failed for ${actor.name}`, err);
    }
  }
  if (!lines.length) return null;

  let body = `<ul class="carl-round-end-list">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
  if (gmLines.length) {
    body += `<div class="carl-gm-digest carl-gm-only">
      <div class="carl-gm-digest-title">${game.i18n.localize("CARLRPG.Damage.DigestTitle")}</div>
      <ul>${gmLines.map((l) => `<li>${l}</li>`).join("")}</ul>
    </div>`;
  }
  const title = game.i18n.format("CARLRPG.RoundEnd.Title", { round });
  const subtitle = game.i18n.localize("CARLRPG.RoundEnd.Subtitle");
  if (rolls.length) {
    return createRollMessage({ rolls, rollMeta, title, subtitle, body, flags: { roundEnd: round } });
  }
  return createCardMessage({ title, subtitle, body, flags: { roundEnd: round } });
}

/**
 * "Until the end of the combat" (Burned, Muted, Stiff Legs, The Taint) -
 * plus any "rounds"-duration Debuff still ticking, since rounds stop when
 * the combat does.
 * @param {Combat} combat
 * @returns {Promise<ChatMessage|null>}
 */
export async function processCombatEnd(combat) {
  const lines = [];
  for (const actor of combatActors(combat)) {
    await queueForActor(actor.uuid, async () => {
      const current = actor.system.conditions ?? [];
      const ending = current.filter((c) => {
        const preset = CARLRPG.debuffs[c.key];
        return preset?.mechanics?.endsWithCombat || durationTypeOf(c) === "rounds";
      });
      if (!ending.length) return;
      try {
        await actor.update({ "system.conditions": current.filter((c) => !ending.includes(c)) });
        lines.push(game.i18n.format("CARLRPG.RoundEnd.CombatEnded", {
          name: esc(actor.name),
          debuffs: ending.map((c) => esc(conditionLabel(c))).join(", "),
        }));
      } catch (err) {
        console.error(`CarlRPG | End-of-combat Debuff cleanup failed for ${actor.name}`, err);
      }
    });
  }
  if (!lines.length) return null;
  return createCardMessage({
    title: game.i18n.localize("CARLRPG.RoundEnd.CombatEndTitle"),
    body: `<ul class="carl-round-end-list">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
  });
}
