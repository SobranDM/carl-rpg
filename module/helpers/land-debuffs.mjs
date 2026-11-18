/**
 * Land an Attack's Debuffs on one defender it hit and who didn't Evade - a
 * crawler's Attack (its Skill's, Damage Effect's and gear's) or a Mob's
 * (docs/skill-item-sheets.md, docs/mob-sheet.md). Each lands by its own
 * trigger against this row (modifiers.mjs debuffLandsOn); none on a full
 * Immunity to the hit (p.93) or on something that takes no Debuffs (a
 * vehicle). Shared by an Attack card row's Apply (chat/attack-targets-
 * card.mjs applyRow) and the Damage card (reaction-resolve.mjs). A leaf
 * module, so the Damage card needn't load the Attack card's.
 */
import { addConditionToActor } from "./conditions.mjs";
import { isImmuneToAllDamage } from "./damage-pipeline.mjs";
import { takesConditions } from "./actor-kinds.mjs";
import { debuffLandsOn } from "./modifiers.mjs";

/**
 * @param {Actor} actor
 * @param {object[]} targetEffects
 * @param {object} row  With `amazing` and `evade` ({degree, success} or null).
 * @param {Record<string, number>} damageByType  The hit's damage.
 * @returns {Promise<{landed: object[], lines: string[]}>}  What landed, and
 *   GM digest lines saying why nothing did.
 */
export async function landDebuffs(actor, targetEffects, row, damageByType) {
  const landing = (targetEffects ?? []).filter((te) => te?.debuffKey && debuffLandsOn(te, row));
  if (!actor || !landing.length) return { landed: [], lines: [] };
  const name = foundry.utils.escapeHTML(actor.name);
  if (isImmuneToAllDamage(damageByType ?? {}, actor)) {
    return { landed: [], lines: [game.i18n.format("CARLRPG.Targets.ImmuneNoEffects", { name })] };
  }
  if (!takesConditions(actor)) {
    return { landed: [], lines: [game.i18n.format("CARLRPG.Vehicle.ImmuneToDebuffs", { name })] };
  }
  for (const te of landing) {
    await addConditionToActor(actor, te.debuffKey, { stacks: te.stacks, source: te.sourceLabel, label: te.label });
  }
  return { landed: landing, lines: [] };
}
