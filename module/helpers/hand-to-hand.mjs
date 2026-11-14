/**
 * Hand-to-hand Combat Skills (p.179): Foot Soldier, Noggin Nocker,
 * Pugilism, Unarmed Combat and Wrasslin' - or a homebrew one - marked by the
 * Skill's Hand-to-Hand box (system.isHandToHand).
 *
 * Unarmed Combat: "Limitations: Cannot choose a Damage Effect." - so once a
 * crawler has another hand-to-hand Skill at a higher Rank, Unarmed Combat is
 * worse in every way, and the Combat tab's Attacks list leaves it out
 * (it's still on the Skills tab).
 */
import { ownedRank, slugifySkillName } from "./modifiers.mjs";

/** Whether `name` is one of `names`, ignoring case and punctuation. */
function nameIn(names, name) {
  const slug = slugifySkillName(name);
  return (names ?? []).some((n) => slugifySkillName(n) === slug);
}

/**
 * Is this a hand-to-hand Combat Skill (p.179)?
 * @param {Item} skill
 * @returns {boolean}
 */
export function isHandToHand(skill) {
  return skill?.type === "skill" && !!skill.system?.isHandToHand;
}

/**
 * Can this Attack Skill take a Damage Effect? Not Unarmed Combat ("Cannot
 * choose a Damage Effect", p.179).
 * @param {Item} skill
 * @returns {boolean}
 */
export function takesDamageEffects(skill) {
  return !nameIn(CONFIG.CARLRPG.noDamageEffectSkills, skill?.name ?? "");
}


/**
 * The Combat tab's Attacks list, without Unarmed Combat when another
 * hand-to-hand Skill the crawler has outranks it.
 * @param {Actor} actor
 * @param {Item[]} attackSkills
 * @returns {Item[]}
 */
export function withoutOutclassedUnarmed(actor, attackSkills) {
  const unarmed = attackSkills.find((s) => nameIn(CONFIG.CARLRPG.noDamageEffectSkills, s.name));
  if (!unarmed) return attackSkills;
  const rank = ownedRank(actor, unarmed);
  const outclassed = actor.items.some((i) => i.id !== unarmed.id && isHandToHand(i) && ownedRank(actor, i) > rank);
  return outclassed ? attackSkills.filter((s) => s !== unarmed) : attackSkills;
}
