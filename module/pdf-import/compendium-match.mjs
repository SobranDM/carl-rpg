/**
 * Prefer a compendium copy to a parsed one (ruled 2026-11-18, Q2): a Spell,
 * Skill, consumable or piece of gear the book prints is matched by name to
 * an authored copy, which is richer than what text parsing gives (upgrade
 * Debuffs and bonuses, consumable effects).
 *
 * Where to look, first match wins:
 *   0. this system's packs: Skills & Spells, Consumables, Gear (in that order);
 *   1. rulebook compendiums an import made for another book (importer.mjs);
 *   2. world Items;
 *   3. any other Item compendium (modules', the GM's own).
 * The book being imported is never matched against itself - its own pack
 * or its earlier world-folder import - or a re-import would take its own
 * old parse as "the copy". Mobs are never matched by name across books: a
 * name is no guarantee of the same creature (the Toolkit's Krakaren Clone is
 * Level 10, the Core Rulebook's Level 65).
 *
 * Pure (no Foundry globals): the importer gathers the sources from the
 * world's packs, the Node preview tool from packs-source/.
 */

/** The system's own packs, in priority order. */
export const SYSTEM_PACKS = ["carl-rpg.skills-and-spells", "carl-rpg.consumables", "carl-rpg.gear"];

/** Source tiers, best first. */
export const TIERS = { system: 0, rulebook: 1, world: 2, other: 3 };

/**
 * A name as matched: case, curly vs straight apostrophes, U+2011 and
 * other dashes vs "-", spacing, and parentheticals ("(Rank 3)") don't count.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @typedef {object} MatchCandidate
 * @property {string} name
 * @property {string} type   The Item type ("spell", "skill", "item").
 * @property {number} tier   TIERS.
 * @property {number} [order]  Within a tier (the system packs' order).
 * @property {string} [source] Where it is (a pack id, "world").
 * @property {boolean} [consumable]  A usable item (system.consumable.kind set).
 * @property {string} [weaponSkill]  A weapon's Weapon Skill (gear).
 * @property {string} [category]  A Skill's category ("attack", "utility"...).
 * @property {boolean} [handToHand]  A Hand-to-Hand Attack Skill (needs no weapon).
 * @property {*} [ref]       Whatever the caller needs to fetch it.
 */

/**
 * Index candidates for lookups by normalised name and type, best first.
 * @param {MatchCandidate[]} candidates
 * @returns {(name: string, types: string[]) => MatchCandidate|null}
 */
export function buildMatcher(candidates) {
  const byName = new Map();
  const ranked = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.tier - b.c.tier || (a.c.order ?? 0) - (b.c.order ?? 0) || a.i - b.i);
  for (const { c } of ranked) {
    const key = normalizeName(c.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
  return (name, types) =>
    (byName.get(normalizeName(name)) ?? []).find((c) => types.includes(c.type)) ?? null;
}

/** Which Item types a parsed document may be matched to. */
export const MATCH_TYPES = { spell: ["spell"], item: ["item"], skill: ["skill"] };

/**
 * The kind a match counts as, for the report: a Spell, a Skill, or gear;
 * gear found among consumables counts as a consumable.
 * @param {MatchCandidate} match
 * @returns {"spells"|"skills"|"consumables"|"gear"}
 */
export function matchKind(match) {
  if (match.type === "spell") return "spells";
  if (match.type === "skill") return "skills";
  return match.consumable ? "consumables" : "gear";
}
