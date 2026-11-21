/**
 * Item bonuses from text, and the kinds of enchantment a magic item can have.
 * Shared by the PDF importer's gear (pdf-import/parse-gear.mjs) and the loot
 * generator (helpers/loot.mjs).
 *
 * Pure (no Foundry globals at load): the Node PDF tool loads it.
 */

import { changeEntry } from "../pdf-import/shared.mjs";
import { normalizeDamageType } from "./damage-types.mjs";

/** A Stat's name as written ("Dexterity") -> its key. */
export const STAT_WORDS = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  charisma: "cha",
};

/**
 * Map one benefit bullet onto ChangeEntries, or none when it is prose:
 * "+1 Dexterity", "+3 Double Tap Skill", "+5 to the Skullcracker Skill",
 * "Resistance to Poison and Ice damage". "+1 to all Skill or Stat Checks"
 * names no one Skill, so it stays prose.
 * @param {string} text
 * @param {string} label  The changes' label.
 * @returns {object[]}  ChangeEntries.
 */
export function bulletToChanges(text, label) {
  const value = (sign, n) => (sign === "+" ? n : `-${n}`);
  let m = text.match(/^([+−-])(\d+) (Strength|Dexterity|Constitution|Intelligence|Charisma)$/i);
  if (m)
    return [
      changeEntry({
        label,
        targetType: "stat",
        target: STAT_WORDS[m[3].toLowerCase()],
        value: value(m[1], m[2]),
      }),
    ];
  m = text.match(/^([+−-])(\d+) (?!(?:to )?(?:all|any)\b)(?:to (?:the |your )?)?(.+?) Skill\b/);
  if (m)
    return [
      changeEntry({
        label,
        targetType: "skillRank",
        target: m[3].trim(),
        value: value(m[1], m[2]),
      }),
    ];
  m = text.match(/^(Resistance|Immunity|Vulnerability) to (.+?) damage$/i);
  if (m) {
    const state = { resistance: "resist", immunity: "immune", vulnerability: "vulnerable" }[
      m[1].toLowerCase()
    ];
    return m[2]
      .split(/,|\band\b/)
      .map((t) => normalizeDamageType(t))
      .filter(Boolean)
      .map((t) =>
        changeEntry({ label, targetType: "resistance", target: t, mode: "override", value: state }),
      );
  }
  return [];
}

/**
 * The kinds of enchantment a magic item's effect table can give (Tables
 * 39-41, p.219), read from a result's text so a GM's own world copy of a
 * table (or a row they add) is read the same way. Something Unique (Table 42)
 * is a linked result, not text.
 */
const ENCHANTMENT_PATTERNS = [
  ["stat", /\+X Stat/i],
  ["skill", /\+X Skill/i],
  ["passiveSkill", /Passive Skill/i],
  ["resistance", /Resistance to an? uncommon/i],
  ["dr", /Damage Resistance/i],
  ["externalBuff", /External Buff/i],
  ["inherentSpell", /Inherent Spell/i],
  ["buff", /\bBuff\b/i],
];

/**
 * An effect table result's kind of enchantment.
 * @param {string} text
 * @returns {"stat"|"skill"|"passiveSkill"|"resistance"|"dr"|"externalBuff"|"inherentSpell"|"buff"|"text"}
 *   "text": anything else (a GM's own row), kept as written.
 */
export function enchantmentKind(text) {
  const found = ENCHANTMENT_PATTERNS.find(([, re]) => re.test(String(text ?? "")));
  return found ? found[0] : "text";
}

/**
 * Which effect table an Item Type result (Table 38) is, by its text.
 * @param {string} text
 * @returns {"mundane"|"clothing"|"accessory"}
 */
export function itemTypeKind(text) {
  const t = String(text ?? "");
  if (/Clothing/i.test(t)) return "clothing";
  if (/Accessory/i.test(t)) return "accessory";
  return "mundane";
}

/**
 * A loot table row's name read for its quantity: "Torch ×10", "Torch x10",
 * "Crawler Biscuits (100)", "Bandages (1d6)". The rest is the item's name.
 * @param {string} name
 * @returns {{name: string, quantity: string}}  quantity: a number or a dice formula ("1" when none).
 */
export function lootRowQuantity(name) {
  const text = String(name ?? "").trim();
  let m = text.match(/^(.*?)\s*[×x]\s*(\d+)$/i);
  if (m) return { name: m[1].trim(), quantity: m[2] };
  m = text.match(/^(.*?)\s*\((\d+(?:d\d+)?(?:\s*[+×x*]\s*\d+)?)\)$/i);
  if (m) return { name: m[1].trim(), quantity: m[2].replace(/[×x]/gi, "*").replace(/\s+/g, "") };
  return { name: text, quantity: "1" };
}

/**
 * Loot table rows that stand for something rolled, not an item: a Spell
 * Scroll or Spellbook of a random Spell (Table 27), or a magic item
 * (Tables 38-42). Matched by the row's name, so a GM can add one in
 * Foundry's own table editor.
 * @param {string} name
 * @returns {"spellScroll"|"spellbook"|"magicItem"|null}
 */
export function lootRowSpecial(name) {
  const t = String(name ?? "").trim();
  if (/^(?:Rare )?Spell Scrolls?$/i.test(t)) return "spellScroll";
  if (/^(?:Rare )?(?:Spellbooks?|Magic Tome)$/i.test(t)) return "spellbook";
  if (/^Magic Item$/i.test(t)) return "magicItem";
  return null;
}
