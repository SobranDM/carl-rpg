/**
 * Grinding (Crawler Advancement, p.170): hours accrue toward a Skill until
 * they equal its current Rank, then an Advancement Check is rolled at once
 * ("Any penalties from Debuffs (Fatigued is common) apply to this check").
 *
 *  - "If you've been grinding for more hours than needed for a particular
 *    Skill, apply any additional hours to another Skill (you can't bank
 *    hours for the same Skill)" - the surplus is returned to the caller,
 *    which offers it via module/chat/grind-surplus-card.mjs.
 *  - "You cannot grind the same Skill more than once per day" is left to
 *    the GM (by the project owner's choice) - nothing here tracks days.
 *  - The grinding check is not an end-of-floor check: it gets no Race/Class
 *    "at the end of each floor, add 1" bonus, and it leaves the Skill's
 *    use-mark alone so that end-of-floor check still happens.
 *
 * Accrued hours live in the item's `grindHours` flag between grinds ("They
 * may accumulate from one day or even one floor to the next").
 */
import CarlDice from "../dice/dice.mjs";
import { skillRankCap } from "./modifiers.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";

const SCOPE = "carl-rpg";
const GRINDABLE_TYPES = new Set(["skill", "spell", "damageEffect"]);

/**
 * Whether grinding hours may go into this item: a Skill/Spell/Damage Effect
 * the actor has at least Rank 1 in, below its Rank cap, that can advance
 * through use (CarlDice.isAdvancedByUse - not a Passive Spell or a
 * "magic-only" Skill).
 * @param {Actor} actor
 * @param {Item} item
 * @returns {boolean}
 */
export function isGrindTarget(actor, item) {
  if (!item || !GRINDABLE_TYPES.has(item.type)) return false;
  const rank = item.system.rank ?? 0;
  if (rank < 1) return false;
  const cap = skillRankCap(actor.system, item.name);
  if (rank >= cap) return false;
  return CarlDice.isAdvancedByUse(item);
}

/**
 * `<option>` markup for a grind-target picker, labelled with each item's
 * Rank and accrued hours - shared by the GM Toolbox's Grind dialog and the
 * surplus card's dialog.
 * @param {Item[]} items
 * @returns {string}
 */
export function grindTargetOptions(items) {
  return items.map((item) => {
    const label = game.i18n.format("CARLRPG.Grind.TargetOption", {
      name: item.name, rank: item.system.rank, accrued: item.getFlag(SCOPE, "grindHours") ?? 0,
    });
    return `<option value="${item.id}">${foundry.utils.escapeHTML(label)}</option>`;
  }).join("");
}

/**
 * Put grinding hours into one Skill. Below its Rank threshold the hours are
 * just stored; at the threshold the stored hours reset, the Advancement
 * Check is rolled (with Debuff penalties), and any hours beyond the
 * threshold are returned as surplus for another Skill.
 * @param {Actor} actor
 * @param {Item} item
 * @param {number} hours
 * @returns {Promise<{rolled: boolean, accrued: number, surplus: number}>}
 */
export async function applyGrindHours(actor, item, hours) {
  const rank = item.system.rank ?? 0;
  const accrued = (item.getFlag(SCOPE, "grindHours") ?? 0) + Math.max(0, Math.floor(Number(hours) || 0));

  if (accrued < rank) {
    await item.setFlag(SCOPE, "grindHours", accrued);
    ui.notifications.info(game.i18n.format("CARLRPG.Toolbox.GrindProgress", { name: item.name, accrued, rank }));
    return { rolled: false, accrued, surplus: 0 };
  }

  await item.setFlag(SCOPE, "grindHours", 0);
  ui.notifications.info(game.i18n.format("CARLRPG.Toolbox.GrindThresholdReached", { name: item.name }));
  await CarlDice.rollAdvancementCheck(actor, item, { debuffs: true, floorBonus: false, clearMark: false });
  return { rolled: true, accrued: rank, surplus: accrued - rank };
}

/**
 * Grinding toward a Level (p.171): "Keep a running total of all your
 * grinding hours and erase it only when you level up... You gain a Level
 * when you grind a number of hours equal to your current Level." The total
 * resets in CarlRPGActor#_preUpdate on any Level gain. "The party member
 * with the lowest Level gains 1d2 Levels when they level up this way" is
 * left to the GM (the card says so).
 * @param {Actor} actor  A character.
 * @param {number} hours
 * @returns {Promise<{leveled: boolean, total: number}>}
 */
export async function addGrindLevelHours(actor, hours) {
  if (actor?.type !== "character") return { leveled: false, total: 0 };
  const level = actor.system.attributes?.level?.value ?? 1;
  const total = (actor.system.grindLevelHours ?? 0) + Math.max(0, Math.floor(Number(hours) || 0));
  if (total < level || level >= 250) {
    await actor.update({ "system.grindLevelHours": total });
    return { leveled: false, total };
  }
  await actor.update({ "system.attributes.level.value": level + 1 });
  await createCardMessage({
    title: game.i18n.localize("CARLRPG.Grind.LevelTitle"),
    body: `<p>${game.i18n.format("CARLRPG.Grind.LevelBody", { name: foundry.utils.escapeHTML(actor.name), level: level + 1 })}</p>`,
    actor,
  });
  return { leveled: true, total };
}
