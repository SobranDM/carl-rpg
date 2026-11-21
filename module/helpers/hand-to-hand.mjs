/**
 * Hand-to-hand Combat Skills (p.179): Foot Soldier, Noggin Nocker,
 * Pugilism, Unarmed Combat and Wrasslin' - or a homebrew one - marked by the
 * Skill's Hand-to-Hand box (system.isHandToHand).
 *
 * Unarmed Combat: "Limitations: Cannot choose a Damage Effect." - the
 * Skill's No Damage Effects box (system.noDamageEffects). So once a crawler
 * has another hand-to-hand Skill at a higher Rank, a hand-to-hand Skill
 * with that box is worse in every way, and the Attack! button's choices and
 * the Hotlist's Swap and Attack leave it out (it's still on the Skills tab).
 * Read from the boxes, never the names, so a GM's homebrew Skill works too.
 */
import { ownedRank } from "./modifiers.mjs";

/**
 * Is this a hand-to-hand Combat Skill (p.179)?
 * @param {Item} skill
 * @returns {boolean}
 */
export function isHandToHand(skill) {
  return skill?.type === "skill" && !!skill.system?.isHandToHand;
}

/**
 * Can this Attack Skill take a Damage Effect? Not one with the No Damage
 * Effects box (Unarmed Combat: "Cannot choose a Damage Effect", p.179).
 * @param {Item} skill
 * @returns {boolean}
 */
export function takesDamageEffects(skill) {
  return !(skill?.type === "skill" && skill.system?.noDamageEffects);
}

/**
 * The Attack Skills to offer, without each hand-to-hand Skill with No
 * Damage Effects (Unarmed Combat) that another hand-to-hand Skill the
 * crawler has outranks.
 * @param {Actor} actor
 * @param {Item[]} attackSkills
 * @returns {Item[]}
 */
export function withoutOutclassedUnarmed(actor, attackSkills) {
  const outclassed = (skill) => {
    if (!isHandToHand(skill) || takesDamageEffects(skill)) return false;
    const rank = ownedRank(actor, skill);
    return actor.items.some(
      (i) => i.id !== skill.id && isHandToHand(i) && ownedRank(actor, i) > rank,
    );
  };
  return attackSkills.filter((s) => !outclassed(s));
}
