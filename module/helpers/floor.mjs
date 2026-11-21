/**
 * Floor-level rules the GM Toolbox's End Floor and Boss Killed actions use,
 * and the current Floor.
 */

/**
 * The Floor the party is on (the world setting the GM Toolbox moves).
 * @returns {number}
 */
export function currentFloor() {
  return game.settings.get("carl-rpg", "currentFloor");
}

/**
 * "When a party kills a Boss, each member gains Levels based on the tier of
 * the Boss" (Crawler Advancement, p.170).
 */
export const BOSS_TIERS = {
  neighborhood: { label: "CARLRPG.Toolbox.BossTier.Neighborhood", levels: 1, box: "bronze" },
  borough: { label: "CARLRPG.Toolbox.BossTier.Borough", levels: 2, box: "silver" },
  city: { label: "CARLRPG.Toolbox.BossTier.City", levels: 3, box: "gold" },
  province: { label: "CARLRPG.Toolbox.BossTier.Province", levels: 4, box: "platinum" },
  country: { label: "CARLRPG.Toolbox.BossTier.Country", levels: 5, box: "legendary" },
  floor: { label: "CARLRPG.Toolbox.BossTier.Floor", levels: 6, box: "celestial" },
};

/**
 * Default days before a floor collapses (30-hour days): the First Floor 5
 * and the Second 6 (Atlas, "Time to Level Collapse"), the Third 8, the
 * Fourth 10 and the Fifth 15 (Time, p.63). The GM may set their own; floors
 * without a default return null.
 * @param {number} floor
 * @returns {number|null}
 */
export function collapseDays(floor) {
  return { 1: 5, 2: 6, 3: 8, 4: 10, 5: 15 }[floor] ?? null;
}

/**
 * The automatic end-of-floor Popularity change (Popularity, p.280): +1 if
 * "Your Charisma is 5 x F (five times the Floor number) or higher", -1 if
 * "Your Charisma is only 2 x F... or lower" - the Charisma SCORE (the book
 * spells the Stat out; "CHA" alone would mean the Mod, p.110). No change
 * before the first real floor.
 * @param {number} charisma  The crawler's (Enhanced) Charisma score.
 * @param {number} floor     The floor that is ending.
 * @returns {-1|0|1}
 */
export function endOfFloorPopularityDelta(charisma, floor) {
  const f = Number(floor) || 0;
  if (f < 1) return 0;
  const cha = Number(charisma) || 0;
  if (cha >= 5 * f) return 1;
  if (cha <= 2 * f) return -1;
  return 0;
}
