/**
 * Shield Block (p.198, Strength, Interrupt; docs/rules-fixes.md D):
 * "Requires you to be wielding a shield. Cannot be used against Area of
 * Effect damage. A successful Shield Block still counts as 'a hit crawler'
 * or 'a crawler who failed to Evade.' ... When you are attacked by a
 * physical Attack, spend one Action to make a separate Shield Block Skill
 * Check vs. the Mob's 'to hit' for each of the Attacks targeting you... On
 * Success, take half the damage before applying your DR. Your Shield takes
 * a -1 DR penalty on a Major Fail; -2 on a Critical Fail. It breaks at 0
 * DR. However, a broken shield and lost DR can be Repaired."
 * Upgrades: Rank 5 also against Spells and magical damage; Rank 10 a
 * Natural 20 may make a free Shield Bash (3d6 + STR Bludgeoning); Rank 15
 * +1d6 Shield Bash damage, and the halved damage is further reduced by the
 * STR Mod.
 *
 * The rules in one place: who can block (the Skill and a Shield in hand),
 * against what (physical, not Area - magical too from Rank 5), one Action
 * for every Attack it can block (BLOCK_TAG), what a
 * block does to the damage (damage-pipeline.mjs blockedDamage) and to the
 * Shield, and the Shield Bash. The Upgrades have no fields of their own,
 * so they're read from the Skill's Rank, as Catcher's are
 * (reaction-resolve.mjs catcherRank). The cards that offer it:
 * module/chat/reaction-card.mjs (phased fights) and module/chat/
 * attack-targets-card.mjs (an Attack card's rows).
 */
import CarlDice, { extractNaturalD20 } from "../dice/dice.mjs";
import { rerollFormula } from "./ai-favor.mjs";
import { isInHand, isShield } from "./gear.mjs";
import { buildItemSkillEntry, effectiveRank, shieldDrState, slugifySkillName } from "./modifiers.mjs";
import { passiveContext } from "./actions.mjs";

/** The Skill's name, as the compendium has it. */
export const SHIELD_BLOCK = "Shield Block";

/**
 * A Shield Block Action's tag (helpers/actions.mjs hasSpent): one Action
 * rolls against every Attack it can block this round (the 2026-11-18
 * ruling, worded like Evade, p.81), so a later block the same round - on
 * the Reaction card or an Attack card's row - is free, as a later Evade is.
 */
export const BLOCK_TAG = "shieldBlock";

/** The d20 expressions a Check can have been rolled with (dice.mjs d20Formula). */
const D20_FORMULAS = Object.freeze(["1d20", "2d20kh", "2d20kl"]);

/** The Shield's DR lost on a bad Shield Block, by Degree (p.198). */
const SHIELD_LOSS = Object.freeze({ majorFail: 1, criticalFail: 2 });

/**
 * A creature's Shield Block Skill, if it has one.
 * @param {Actor|null} actor
 * @returns {Item|null}
 */
export function shieldBlockSkill(actor) {
  const slug = slugifySkillName(SHIELD_BLOCK);
  return actor?.items?.find((i) => i.type === "skill" && slugifySkillName(i.name) === slug) ?? null;
}

/**
 * Its Shield Block Rank (0 without the Skill).
 * @param {Actor|null} actor
 * @returns {number}
 */
export function shieldBlockRank(actor) {
  const item = shieldBlockSkill(actor);
  if (!item) return 0;
  // The live Rank of this very item (gear "+N" included; a duplicate's
  // bag entry never stands in for it).
  return effectiveRank(item);
}

/**
 * The Shield it's wielding: a Shield in one of its hands (gear.mjs
 * isInHand) that isn't broken. A broken Shield can't block.
 * @param {Actor|null} actor
 * @returns {Item|null}
 */
export function wieldedShield(actor) {
  return actor?.items?.find((i) => isShield(i) && isInHand(i) && !shieldDrState(i).broken) ?? null;
}

/**
 * Who can Shield Block at all: owns the Skill and wields a Shield.
 * @param {Actor|null} actor
 * @returns {{skill: Item, rank: number, shield: Item}|null}
 */
export function shieldBlocker(actor) {
  const skill = shieldBlockSkill(actor);
  const shield = skill ? wieldedShield(actor) : null;
  return skill && shield ? { skill, rank: shieldBlockRank(actor), shield } : null;
}

/**
 * Is an Attack magical? A Spell's always is; otherwise its damage's
 * `damageIsMagic` (dice.mjs: a Skill or Spell's "magical damage" box; a Mob
 * Attack's damage type other than Bludgeoning, Piercing or Slashing - "for
 * physical damage", p.93). Not known reads as magical, as the damage
 * pipeline's default does.
 * @param {{damageIsMagic?: boolean, isSpell?: boolean}} attack
 * @returns {boolean}
 */
export function attackIsMagical(attack) {
  return !!attack?.isSpell || attack?.damageIsMagic !== false;
}

/**
 * Can this Attack be Shield Blocked by someone at this Rank? Not an Area
 * Attack, it has damage to halve, and it's physical - or magical from Rank 5.
 * @param {{isArea?: boolean, hasDamage?: boolean, magical?: boolean}} attack
 * @param {number} rank
 * @returns {boolean}
 */
export function blockableAttack({ isArea = false, hasDamage = true, magical = false } = {}, rank = 0) {
  if (isArea || !hasDamage) return false;
  return !magical || rank >= 5;
}

/**
 * What one Shield Block Action keeps from its first Check for the rest of
 * its Checks: the d20 expression (any Advantage) and everything the dialog
 * added to it. Null when it isn't a d20 Check this can roll again.
 * @param {{formula?: string|null, natural?: number|null, total?: number}} check
 * @returns {{formula: string, rest: number}|null}
 */
export function keptBlockRoll({ formula, natural, total } = {}) {
  if (!D20_FORMULAS.includes(formula) || natural === null || natural === undefined) return null;
  const rest = Number(total) - Number(natural);
  return Number.isFinite(rest) ? { formula, rest: Math.trunc(rest) } : null;
}

/**
 * Another Check of the same Shield Block Action (one Action, "a separate
 * Shield Block Skill Check ... for each of the Attacks", p.198): the d20
 * again with the rest of the first Check's total, against this Attack's
 * to-hit - no dialog, and nothing the first one used up is used again.
 * @param {{formula: string, rest: number}} kept  keptBlockRoll
 * @param {number|null} difficulty
 * @returns {Promise<{roll: Roll, total: number, naturalRoll: number|null, formula: string, difficulty: number|null, breakdown: string}>}
 */
export async function rollBlockAgain(kept, difficulty) {
  const roll = await new Roll(rerollFormula({ formula: kept.formula, natural: 0, total: kept.rest })).evaluate();
  return {
    roll, total: roll.total, naturalRoll: extractNaturalD20(roll), formula: kept.formula, difficulty,
    breakdown: game.i18n.format("CARLRPG.ShieldBlock.Again", { formula: roll.formula, total: roll.total }),
  };
}

/**
 * Rank 15: "Further reduce the damage you would take by your STR Mod" -
 * after halving, before DR (never a negative Mod adding damage).
 * @param {Actor|null} actor
 * @param {number} rank
 * @returns {number}
 */
export function blockReduction(actor, rank) {
  if (rank < 15) return 0;
  return Math.max(0, Number(actor?.system?.stats?.str?.mod) || 0);
}

/**
 * How much DR a Shield Block of this Degree costs the Shield.
 * @param {string|null|undefined} degree
 * @returns {number}
 */
export function shieldLossFor(degree) {
  return SHIELD_LOSS[degree] ?? 0;
}

/**
 * A Shield Block's notes under its row on a card: blocked (half damage) or
 * failed, what a Major or Critical Fail costs the Shield (at Lock Results
 * on the Reaction card, when the row is applied on an Attack card), and a
 * Shield Bash made.
 * @param {object} check  The block's Check (with its shieldName, bashed).
 * @returns {string[]}
 */
export function blockNotes(check) {
  const i18n = game.i18n;
  const notes = [i18n.localize(check?.success ? "CARLRPG.ShieldBlock.Sub.success" : "CARLRPG.ShieldBlock.Sub.failed")];
  const loss = shieldLossFor(check?.degree);
  if (loss) notes.push(i18n.format("CARLRPG.ShieldBlock.Sub.loss", { shield: check.shieldName ?? "?", amount: loss }));
  if (check?.bashed) notes.push(i18n.localize("CARLRPG.ShieldBlock.Sub.bashed"));
  return notes;
}

/**
 * Take DR off a Shield (a Major or Critical Fail). Written by whoever
 * resolves the hit - the GM at Lock Results, the row's applier on an Attack
 * card.
 * @param {Actor} actor
 * @param {string} shieldId
 * @param {number} amount
 * @returns {Promise<{name: string, amount: number, dr: number, broken: boolean}|null>}  null if the Shield is gone.
 */
export async function damageShield(actor, shieldId, amount) {
  const item = actor?.items?.get(shieldId);
  if (!item || !isShield(item) || !(amount > 0)) return null;
  await item.update({ "system.shieldDamage": Math.max(0, Number(item.system.shieldDamage) || 0) + amount });
  const state = shieldDrState(item);
  return { name: item.name, amount, dr: state.dr, broken: state.broken };
}

/**
 * Repair a Shield: "a broken shield and lost DR can be Repaired" (p.198).
 * @param {Item} item
 * @returns {Promise<void>}
 */
export async function repairShield(item) {
  if (!isShield(item) || !item.system.shieldDamage) return;
  await item.update({ "system.shieldDamage": 0 });
}

/**
 * Rank 10: "On a Critical Hit, you may make a Shield Bash Attack" - a
 * Natural 20 on the Shield Block Check.
 * @param {{natural?: number|null}|null} check
 * @param {number} rank
 * @returns {boolean}
 */
export function bashOffered(check, rank) {
  return check?.natural === 20 && rank >= 10;
}

/**
 * The Shield Bash's base dice: 3d6, +1d6 at Rank 15.
 * @param {number} rank
 * @returns {string}
 */
export function bashDice(rank) {
  return rank >= 15 ? "4d6" : "3d6";
}

/**
 * The Shield Bash as an unsaved Attack Skill on the blocker, the way a
 * vehicle's built-in weapon is fired (vehicle-weapons.mjs buildWeaponFire):
 * STR and the Shield Block Rank, 3d6 (4d6 at Rank 15) + STR Bludgeoning.
 * @param {Actor} actor
 * @param {number} rank
 * @returns {{item: Item, castAs: object}}
 */
export function buildShieldBash(actor, rank) {
  const data = {
    _id: foundry.utils.randomID(),
    name: game.i18n.localize("CARLRPG.ShieldBlock.Bash"),
    type: "skill",
    img: shieldBlockSkill(actor)?.img ?? "icons/svg/shield.svg",
    system: {
      rank,
      category: "attack",
      governingStat: "str",
      range: "",
      marked: false,
      isMagicDamage: false,
      baseDamage: { dice: bashDice(rank), stat: "str", damageType: "bludgeoning" },
    },
  };
  const item = new Item.implementation(data, { parent: actor });
  const { skillEntry, conditionalModifiers } = buildItemSkillEntry(actor.system, item);
  return { item, castAs: { skillEntry, conditionalModifiers, free: true, spellData: data, rank } };
}

/**
 * Make the Shield Bash: a free Attack (no Action - "a free melee-range
 * Interrupt Attack") against the attacker, on its own Attack card.
 * @param {Actor} actor  The blocker.
 * @param {{targetUuid: string, rank: number, skipDialog?: boolean}} options
 *   targetUuid: the attacker's token (or actor) uuid.
 * @returns {Promise<ChatMessage|null>}
 */
export async function rollShieldBash(actor, { targetUuid, rank, skipDialog = false }) {
  const doc = targetUuid ? fromUuidSync(targetUuid) : null;
  const targetActor = doc instanceof Actor ? doc : (doc?.actor ?? null);
  const targets = targetActor ? [{ actor: targetActor, document: doc, name: doc.name ?? targetActor.name }] : [];
  const { item, castAs } = buildShieldBash(actor, rank);
  return CarlDice.rollAttack(actor, item, { castAs, targets, skipDialog, within: passiveContext() });
}
