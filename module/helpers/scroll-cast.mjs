/**
 * Casting a Spell from a Scroll (Item Rules, p.99): "Scroll Spells have a
 * set Rank... The caster pays no Mana to cast the Spell and cannot change
 * the Rank", and "casts the Spell as though the crawler cast it themselves".
 *
 * The caster doesn't own the Spell, so it's built as an unsaved embedded
 * Item on them at the scroll's Rank, with a fresh id (an owned copy dragged
 * from a compendium keeps the compendium's id, so reusing the source's id
 * could collide with it). Its skill-bag entry comes from that one item alone
 * (modifiers.mjs's buildItemSkillEntry), not the caster's own copy of the
 * Spell. The normal cast paths (module/dice/dice.mjs: rollSkillCheck,
 * rollAttack, rollHeal) take it as their `castAs` option, which also skips
 * Mana and the Advancement use-mark.
 */
import { buildItemSkillEntry } from "./modifiers.mjs";
import { cleanSkillLikeCopy } from "./race-class-grants.mjs";

/**
 * @param {Actor} actor  The caster.
 * @param {object} spellData  The Spell's data (toObject() of the source).
 * @param {number} rank  The scroll's fixed Rank.
 * @returns {{item: Item, castAs: {skillEntry: object, conditionalModifiers: object[], free: true, spellData: object, rank: number}}}
 */
export function buildScrollCast(actor, spellData, rank) {
  const data = cleanSkillLikeCopy(spellData, rank);
  data.system.active = false;
  const item = new Item.implementation({ ...data, _id: foundry.utils.randomID() }, { parent: actor });
  const { skillEntry, conditionalModifiers } = buildItemSkillEntry(actor.system, item);
  return { item, castAs: { skillEntry, conditionalModifiers, free: true, spellData: data, rank } };
}
