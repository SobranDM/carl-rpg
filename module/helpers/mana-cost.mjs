/**
 * What a Spell costs a caster: its cost, plus the Favored-Class +1, then
 * day or night for a Lajabless (helpers/day-night.mjs). Every spend (a
 * cast, an Attack, a heal, switching a toggled Spell on) and every place a
 * cost is shown (the Spells list, the Hotlist, the roll dialog's variants)
 * goes through effectiveManaCost, so what's shown is what's spent.
 */
import { sameSkillName } from "./modifiers.mjs";
import { dayNightManaCost } from "./day-night.mjs";

/**
 * "If a Spell is Favored by any particular Classes, other Classes pay 1
 * additional Mana to cast it" (p.201; module/data/spell.mjs's
 * favoredClasses). A Spell lists Class CATEGORIES ("Mage", "Cleric"...),
 * which a Class item carries as `classTypes` - "Boring Ol' Mage" is a Mage
 * - so the match is against those (and the Class's own name, for a Spell
 * that names one), by slug: any case or punctuation. A Spell with no
 * favoredClasses charges everyone the same, and a caster with no Class yet
 * isn't an "other Class", so pays no surcharge either.
 * @param {Item} spellItem
 * @param {Actor} actor
 * @param {number} manaCost
 * @returns {number}
 */
export function applyFavoredClassSurcharge(spellItem, actor, manaCost) {
  const favored = spellItem.system.favoredClasses ?? [];
  if (!favored.length) return manaCost;
  const classItem = actor.system.classItem;
  if (!classItem) return manaCost;
  const categories = [...(classItem.system?.classTypes ?? []), classItem.name];
  return categories.some((c) => favored.some((f) => sameSkillName(f, c))) ? manaCost : manaCost + 1;
}

/**
 * A Spell's cost to this caster: the Favored-Class +1 first, then day or
 * night (ruled 2026-11-27).
 * @param {Item} spellItem
 * @param {Actor} actor
 * @param {number} [manaCost]  A variant's cost; the Spell's own by default.
 * @returns {number}
 */
export function effectiveManaCost(spellItem, actor, manaCost = spellItem?.system?.manaCost ?? 0) {
  if (!actor) return manaCost;
  return dayNightManaCost(actor, applyFavoredClassSurcharge(spellItem, actor, manaCost));
}
