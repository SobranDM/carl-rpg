/**
 * Weapons and Attacks. A crawler's Attack with a Weapon Skill needs a
 * matching weapon: one in hand (the Main or Off Hand), or one in the
 * Hotlist, which is swapped into the Main Hand for free as part of the
 * Attack Action ("Drawing or swapping a weapon from a Hotlist is free as
 * part of that Action", p.64; p.98). Hand-to-hand Skills, Improvised
 * Weapons and natural attacks need none (CONFIG.CARLRPG.
 * weaponlessAttackSkills). A gear item names the Skill it's wielded with in
 * its Weapon Skill field (system.weaponSkill).
 *
 * Only Characters are checked: a Pet fights with what it is, a Mob with its
 * printed Attacks, and Spells and Scroll casts need no weapon.
 */
import { isCrawler } from "./actor-kinds.mjs";
import { slugifySkillName } from "./modifiers.mjs";
import { isHandToHand, withoutOutclassedUnarmed } from "./hand-to-hand.mjs";
import { isTwoHanded, isWeaponFor } from "./gear.mjs";

// What gear is lives in gear.mjs; re-exported for this module's callers.
export { isWeaponFor };

/**
 * Does this Attack need a weapon?
 * @param {Actor} actor
 * @param {Item} skill
 * @returns {boolean}
 */
export function needsWeapon(actor, skill) {
  if (!isCrawler(actor) || skill?.type !== "skill" || skill.system?.category !== "attack") return false;
  if (isHandToHand(skill)) return false;
  const slug = slugifySkillName(skill.name);
  return !(CONFIG.CARLRPG.weaponlessAttackSkills ?? []).some((name) => slugifySkillName(name) === slug);
}

/**
 * Can this crawler make this Attack, and with what?
 *  - no weapon needed, or a matching one in either hand: ready.
 *  - a matching one in the Hotlist: ready once it's swapped into the Main
 *    Hand (`swap`: its Hotlist slot and the item).
 *  - neither: not ready.
 * @param {Actor} actor
 * @param {Item} skill
 * @param {{mainHand?: Item|null}} [options]  mainHand: treat this item as
 *   the one in the Main Hand (a swap about to happen).
 * @returns {{ready: boolean, weapon: Item|null, swap: {index: number, item: Item}|null}}
 */
export function attackReadiness(actor, skill, { mainHand } = {}) {
  if (!needsWeapon(actor, skill)) return { ready: true, weapon: null, swap: null };
  const slots = actor.system.gearSlots ?? {};
  const inMain = mainHand !== undefined ? mainHand : (slots.mainHand ? actor.items.get(slots.mainHand) : null);
  // A two-handed item about to go in the Main Hand takes the Off Hand too.
  const inOff = mainHand && isTwoHanded(mainHand) ? null : (slots.offHand ? actor.items.get(slots.offHand) : null);
  const held = [inMain, inOff].find((item) => isWeaponFor(item, skill));
  if (held) return { ready: true, weapon: held, swap: null };
  const hotlist = actor.system.hotlist ?? [];
  for (let index = 0; index < hotlist.length; index++) {
    const item = hotlist[index] ? actor.items.get(hotlist[index]) : null;
    if (item && item !== mainHand && isWeaponFor(item, skill)) return { ready: true, weapon: item, swap: { index, item } };
  }
  return { ready: false, weapon: null, swap: null };
}

/**
 * The Attack! button's choices: the crawler's Attack Skills it can use now
 * (an outranked Unarmed Combat left out, as before), by name, each with the
 * weapon it would use and whether that's swapped in from the Hotlist.
 * @param {Actor} actor
 * @returns {{skill: Item, weapon: Item|null, swap: {index: number, item: Item}|null}[]}
 */
export function attackChoices(actor) {
  const skills = actor.items
    .filter((i) => i.type === "skill" && i.system.category === "attack")
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang, { sensitivity: "base" }));
  return withoutOutclassedUnarmed(actor, skills)
    .map((skill) => ({ skill, ...attackReadiness(actor, skill) }))
    .filter((choice) => choice.ready)
    .map(({ skill, weapon, swap }) => ({ skill, weapon, swap }));
}

/**
 * Warn that this Attack has no weapon to use.
 * @param {Item} skill
 */
export function warnNoWeapon(skill) {
  ui.notifications.warn(game.i18n.format("CARLRPG.Weapon.NoWeapon", { skill: skill.name }));
}
