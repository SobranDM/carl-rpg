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
 *  0. Per-round restores from a timed Buff (`perRound` - a Mana Refill
 *     potion, module/helpers/consumables.mjs) come first, as their own
 *     update, so the actor's own rules run on them: a heal ends Dying and
 *     every other "until healed" Debuff before the countdown could tick, and
 *     a crawler knocked back to 0 by this round's damage gains Dying again.
 *     The dead get nothing; HB blocked by The Taint is reported.
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
 *  4. "rounds"-duration Debuffs - and Buffs measured in rounds - tick down
 *     by 1 and are removed at 0.
 *
 * When a started Combat is deleted, "until the end of combat" Debuffs
 * (`mechanics.endsWithCombat`) and any leftover "rounds"-duration Debuffs
 * are removed. A consumable's Buff counting rounds instead pays out what its
 * per-round restore still owes, all at once (as it would have outside a
 * fight), and if it carries bonuses it carries on, on the clock, for its
 * remaining rounds (10 seconds each).
 */
import { CARLRPG } from "./config.mjs";
import { computeDamageApplication } from "./damage-pipeline.mjs";
import { collectDebuffRows, resolveRollerRows, consumedConditionIds, conditionLabel, findConditionWithMechanic } from "./debuff-effects.mjs";
import { resolveD20Formula } from "../dice/dice.mjs";
import { createRollMessage, createCardMessage, esc } from "../chat/chat-card.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { hbCeiling, restoreUpTo, restoresPerRound } from "./rest.mjs";

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

/**
 * Whether this creature is dead by the rules: a Mob at 0 HB ("Mobs die
 * instantly at 0% HB"), or a crawler whose Dying countdown has run out (its
 * end was announced). Nothing restores them on its own - that's the GM's
 * call.
 */
function isDead(actor) {
  const sys = actor.system;
  if (actor.type !== "character") return (sys.hb?.value ?? 0) <= 0;
  const dying = (sys.conditions ?? []).find((c) => mechanicsOf(c)?.countdown);
  return !!dying && actor.getFlag("carl-rpg", "dyingAnnounced") === dying.id;
}

/**
 * Step 0: every per-round restore on the actor ("Restores 15 Mana per round
 * for 10 rounds"), as one update of its own. Healing that way ends Dying,
 * Sepsis... through CarlRPGActor#_preUpdate, exactly like any other heal;
 * those endings are listed here. The dead are left alone, and a heal
 * blocked by The Taint is reported.
 * @param {Actor} actor
 * @param {string[]} lines  The round-end card's lines (appended to).
 */
async function applyPerRoundRestores(actor, lines) {
  const sys = actor.system;
  const restoring = (sys.conditions ?? []).filter((c) => restoresPerRound(c.perRound));
  if (!restoring.length || isDead(actor)) return;

  const name = esc(actor.name);
  const startHb = sys.hb?.value ?? 0;
  let hb = startHb;
  const startMana = sys.mana?.value ?? 0;
  let mana = startMana;
  let taint;
  for (const condition of restoring) {
    const per = condition.perRound;
    const source = esc(conditionLabel(condition));
    if (per.mana) {
      const next = restoreUpTo(mana, per.mana, sys.mana?.max ?? 0);
      if (next > mana) {
        lines.push(game.i18n.format("CARLRPG.RoundEnd.RestoreMana", { name, amount: next - mana, source }));
        mana = next;
      }
    }
    if (!per.hb) continue;
    taint ??= findConditionWithMechanic(sys, "noHealing") ?? false;
    if (taint) {
      lines.push(game.i18n.format("CARLRPG.RoundEnd.RestoreHbBlocked", { name, source, debuff: esc(conditionLabel(taint)) }));
      continue;
    }
    const next = restoreUpTo(hb, per.hb, hbCeiling(sys));
    if (next > hb) {
      lines.push(game.i18n.format("CARLRPG.RoundEnd.RestoreHb", { name, amount: next - hb, source }));
      hb = next;
    }
  }

  const updates = {};
  if (hb !== startHb) {
    updates["system.hb.value"] = hb;
    for (const condition of sys.conditions ?? []) {
      if (!mechanicsOf(condition)?.endsOnHealing) continue;
      lines.push(mechanicsOf(condition).countdown
        ? game.i18n.format("CARLRPG.RoundEnd.DyingHealed", { name })
        : game.i18n.format("CARLRPG.RoundEnd.EndedByHealing", { name, debuff: esc(conditionLabel(condition)) }));
    }
  }
  if (mana !== startMana) updates["system.mana.value"] = mana;
  if (Object.keys(updates).length) await actor.update(updates);
}

async function runActorRoundEnd(actor) {
  if (!(actor.system.conditions ?? []).length) return null;

  const floor = game.settings.get("carl-rpg", "currentFloor");
  const rollData = actor.getRollData();
  const name = esc(actor.name);
  const lines = [];
  const gmLines = [];
  const rolls = [];
  const rollMeta = [];
  const removeIds = new Set();

  // 0. Per-round restores, written as their own update before anything
  // else - so the actor's own rules run on them: healing ends every "until
  // healed" Debuff, Dying included (CarlRPGActor#_preUpdate), before its
  // countdown could tick.
  await applyPerRoundRestores(actor, lines);

  const sys = actor.system;
  const conditions = foundry.utils.deepClone(sys.conditions ?? []);
  if (!conditions.length) return { lines, gmLines, rolls, rollMeta };
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
  let slotsLostTotal = 0;

  // 1. Damage-dealing Debuffs.
  for (const condition of conditions) {
    const dot = mechanicsOf(condition)?.dot;
    if (!dot || removeIds.has(condition.id)) continue;
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
    slotsLostTotal += slotsLost;
    lines.push(game.i18n.format("CARLRPG.RoundEnd.DotDamage", { name, debuff: label, amount: result.totalFinalDamage }));
    gmLines.push(game.i18n.format("CARLRPG.RoundEnd.DotDigest", {
      name, debuff: label, raw: roll.total, final: result.totalFinalDamage, slots: slotsLost,
    }));
  }

  // 2. "...or you take at least 1 HB slot damage" (Terrified) - slots
  // actually lost to damage, even if a restore made up for them.
  if (slotsLostTotal > 0) {
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

  // 4. "rounds"-duration ticks (Debuffs, and Buffs measured in rounds).
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

  // A crawler knocked from above 0 to 0 here gains Dying in this same
  // update (CarlRPGActor#_preUpdate) - including one just healed out of it
  // by step 0.
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
/** A consumable's timed Buff (module/helpers/consumables.mjs), not a Debuff. */
function isConsumableBuff(condition) {
  return condition.key === "custom" && (restoresPerRound(condition.perRound) || (condition.changes ?? []).length > 0);
}

export async function processCombatEnd(combat) {
  const lines = [];
  for (const actor of combatActors(combat)) {
    await queueForActor(actor.uuid, async () => {
      const sys = actor.system;
      const current = foundry.utils.deepClone(sys.conditions ?? []);
      const name = esc(actor.name);
      const ending = [];
      const kept = [];
      const updates = {};
      let hb = sys.hb?.value ?? 0;
      let mana = sys.mana?.value ?? 0;
      const dead = isDead(actor);
      for (const c of current) {
        const rounds = durationTypeOf(c) === "rounds";
        if (rounds && isConsumableBuff(c)) {
          // What the restore still owes lands now.
          const left = Math.max(0, Number(c.remaining) || 0);
          if (left && restoresPerRound(c.perRound) && !dead) {
            if (c.perRound.mana) {
              const next = restoreUpTo(mana, c.perRound.mana * left, sys.mana?.max ?? 0);
              if (next > mana) {
                lines.push(game.i18n.format("CARLRPG.RoundEnd.RestoreMana", { name, amount: next - mana, source: esc(conditionLabel(c)) }));
                mana = next;
              }
            }
            if (c.perRound.hb && !findConditionWithMechanic(sys, "noHealing")) {
              const next = restoreUpTo(hb, c.perRound.hb * left, hbCeiling(sys));
              if (next > hb) {
                lines.push(game.i18n.format("CARLRPG.RoundEnd.RestoreHb", { name, amount: next - hb, source: esc(conditionLabel(c)) }));
                hb = next;
              }
            }
          }
          // Bonuses carry on, on the clock, for the rounds they had left.
          if ((c.changes ?? []).length && left) {
            kept.push({
              ...c, durationType: null, remaining: null, perRound: { hb: null, mana: null },
              expiresAt: game.time.worldTime + left * (CONFIG.time.roundTime || 10),
            });
          } else {
            ending.push(c);
          }
          continue;
        }
        if (CARLRPG.debuffs[c.key]?.mechanics?.endsWithCombat || rounds) ending.push(c);
        else kept.push(c);
      }
      if (hb !== (sys.hb?.value ?? 0)) updates["system.hb.value"] = hb;
      if (mana !== (sys.mana?.value ?? 0)) updates["system.mana.value"] = mana;
      if (JSON.stringify(kept) !== JSON.stringify(sys.conditions ?? [])) updates["system.conditions"] = kept;
      if (!Object.keys(updates).length) return;
      try {
        await actor.update(updates);
        if (ending.length) {
          lines.push(game.i18n.format("CARLRPG.RoundEnd.CombatEnded", {
            name,
            debuffs: ending.map((c) => esc(conditionLabel(c))).join(", "),
          }));
        }
      } catch (err) {
        console.error(`CarlRPG | End-of-combat cleanup failed for ${actor.name}`, err);
      }
    });
  }
  if (!lines.length) return null;
  return createCardMessage({
    title: game.i18n.localize("CARLRPG.RoundEnd.CombatEndTitle"),
    body: `<ul class="carl-round-end-list">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
  });
}
