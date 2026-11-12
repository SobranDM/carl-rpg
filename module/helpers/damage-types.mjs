/**
 * Damage types (Table 10: Damage Types and Rarity, p.93) and a forgiving
 * reader for the words other sources use for them. Pure - no Foundry
 * globals - so the PDF parsers can use it in Node too.
 *
 * The book lists exactly these 13 types, the same keys as
 * CONFIG.CARLRPG.damageTypes. Rather than adding near-duplicate types (a
 * "cold" type that an Ice Immunity wouldn't cover), other spellings map onto
 * the book's types: an imported "Cold" Spell is Ice damage, and an Ice
 * Resistance applies to it.
 */

/** The book's 13 damage types, in Table 10 order. */
export const DAMAGE_TYPE_KEYS = [
  "acid", "bludgeoning", "electric", "fire", "force", "holy", "ice",
  "necrotic", "piercing", "poison", "psychic", "slashing", "sonic",
];

/**
 * Other words for the book's types: other games' names, other books'
 * misprints ("Psionic" on Evil Eye, a line-broken "Bludgeon-"), and short
 * forms.
 */
export const DAMAGE_TYPE_ALIASES = {
  bludgeon: "bludgeoning",
  blunt: "bludgeoning",
  crushing: "bludgeoning",
  pierce: "piercing",
  slash: "slashing",
  cold: "ice",
  frost: "ice",
  lightning: "electric",
  electricity: "electric",
  electrical: "electric",
  shock: "electric",
  radiant: "holy",
  thunder: "sonic",
  psionic: "psychic",
  toxic: "poison",
  venom: "poison",
  corrosive: "acid",
  arcane: "force",
};

/**
 * One damage-type word to the book's key: "Fire" -> "fire", "cold" ->
 * "ice". Anything else (blank, "untyped", a typo) -> "".
 * @param {string} word
 * @returns {string}
 */
export function normalizeDamageType(word) {
  const key = String(word ?? "").trim().toLowerCase();
  if (DAMAGE_TYPE_KEYS.includes(key)) return key;
  return DAMAGE_TYPE_ALIASES[key] ?? "";
}

const WORD_RE = new RegExp(
  `\\b(${[...DAMAGE_TYPE_KEYS, ...Object.keys(DAMAGE_TYPE_ALIASES)].join("|")})\\b`,
  "gi",
);

/**
 * Every damage type named in a piece of text, in order of appearance,
 * without repeats: "2d6 Fire and Cold damage" -> ["fire", "ice"].
 * @param {string} text
 * @returns {string[]}
 */
export function findDamageTypes(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(WORD_RE)) {
    const type = normalizeDamageType(match[1]);
    if (type && !found.includes(type)) found.push(type);
  }
  return found;
}

/**
 * The first damage type named in a piece of text, or "".
 * @param {string} text
 * @returns {string}
 */
export function findDamageType(text) {
  return findDamageTypes(text)[0] ?? "";
}
