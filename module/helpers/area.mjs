/**
 * Area Attack detection (Combat, p.83): whether an Attack affects an area -
 * a Blast, Burst, Cone, Line, or Splash - so the roll dialog can pre-tick
 * "Area Attack". The book marks areas inconsistently: the "Area of Effect"
 * casting keyword on some Spells, otherwise only in prose ("Range: 20ft
 * Cone", "10ft Blast radius", "+5ft Splash"), and Mob stat blocks put it in
 * the attack line ("2d10+4 Sonic, 30ft Cone"). The dialog checkbox is the
 * final word either way.
 */

const AREA_PATTERN = /\d+\s*(?:ft|feet|foot)\.?\s*(?:Blast|Burst|Cone|Line)\b|\+\s*\d+\s*(?:ft|feet|foot)\.?\s*Splash\b/i;

/**
 * Whether a piece of text describes an area of effect.
 * @param {...string} texts
 * @returns {boolean}
 */
export function textDescribesArea(...texts) {
  return texts.some((text) => AREA_PATTERN.test(String(text ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")));
}

/**
 * Whether a Skill/Spell/Damage Effect item makes an Area Attack at its
 * current Rank: the "areaOfEffect" casting keyword, or area wording in its
 * range, base description, or any Upgrade tier it has unlocked (Fireball
 * Rank 15's "+40ft Splash").
 * @param {Item|null} item
 * @param {number} [rank]  The Rank to check Upgrade tiers against (defaults to the item's own).
 * @returns {boolean}
 */
export function isAreaItem(item, rank = item?.system?.rank ?? 0) {
  if (!item) return false;
  const sys = item.system ?? {};
  if ((sys.castingKeywords ?? []).includes("areaOfEffect")) return true;
  const unlocked = (sys.upgrades ?? []).filter((u) => rank >= (u.rankThreshold ?? Infinity)).map((u) => u.description);
  return textDescribesArea(sys.range, sys.description, ...unlocked);
}

/**
 * Whether a Mob's printed Attack (module/data/mob.mjs's attacks[]) is an
 * Area Attack.
 * @param {{range?: string, effect?: string, damage?: string, name?: string}} attack
 * @returns {boolean}
 */
export function isAreaMobAttack(attack) {
  return textDescribesArea(attack?.range, attack?.effect, attack?.damage);
}
