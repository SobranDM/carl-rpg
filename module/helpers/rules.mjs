import { CARLRPG } from './config.mjs';

/**
 * Look up a Stat's modifier via the Table 2 stepped lookup (NOT a linear
 * formula - e.g. a Stat of 10-19 is always +4, regardless of exactly where
 * in that range it falls).
 * @param {number} statValue
 * @returns {number}
 */
export function getStatMod(statValue) {
  const value = Number(statValue) || 0;
  for (const [min, max, mod] of CARLRPG.statModTable) {
    if (value >= min && value <= max) return mod;
  }
  // Below the table's floor (should not normally happen; Stats start at 1+).
  if (value < CARLRPG.statModTable[0][0]) return CARLRPG.statModTable[0][2];
  // Above the table's ceiling.
  return CARLRPG.statModTable[CARLRPG.statModTable.length - 1][2];
}

/**
 * Look up the Table 37 Rank Damage Dice formula for a given Skill Rank.
 * "Roll the die that is closest to your Skill Rank without going over."
 * Explicitly NOT doubled on a Critical Hit.
 * @param {number} rank
 * @returns {string} A dice formula, e.g. "1d4", "1d8 + 1d6", or "" if rank < 1.
 */
export function getRankDamageDie(rank) {
  const value = Number(rank) || 0;
  if (value < 1) return '';
  let best = '';
  for (const [min, , formula] of CARLRPG.rankDamageDiceTable) {
    if (min <= value) best = formula;
    else break;
  }
  return best;
}

/**
 * Compute the Degree of Success/Failure for a Check.
 * @param {number} naturalRoll  The unmodified d20 result (1-20).
 * @param {number} total        The full modified total (roll + all bonuses).
 * @param {number|null} difficulty  The Difficulty, if the GM set one.
 * @returns {string} One of the CARLRPG.degreesOfSuccess keys.
 */
export function getDegreeOfSuccess(naturalRoll, total, difficulty) {
  if (naturalRoll === 20) return 'criticalHit';
  if (naturalRoll === 1) return 'criticalFail';
  if (difficulty === null || difficulty === undefined) {
    // No Difficulty supplied - can only report the natural-roll-based degrees.
    return total >= 10 ? 'standardSuccess' : 'standardFail';
  }
  const margin = total - difficulty;
  if (margin >= 10) return 'amazingSuccess';
  if (margin >= 0) return 'standardSuccess';
  if (margin >= -2) return 'nearMissFail';
  if (margin >= -9) return 'standardFail';
  return 'majorFail';
}

/**
 * Build a chat-card badge {label, type} for a Degree of Success. Shared by
 * module/dice/dice.mjs and module/chat/evade-link-card.mjs - lives here
 * (rather than in dice.mjs) so the chat module can import it without a
 * dice.mjs <-> chat/evade-link-card.mjs circular import.
 * @param {string} degree
 * @returns {{label: string, type: "hit"|"miss"|"warn"}}
 */
export function degreeBadge(degree) {
  const label = game.i18n.localize(CARLRPG.degreesOfSuccess[degree] ?? degree);
  const type = ['criticalHit', 'amazingSuccess', 'standardSuccess'].includes(degree)
    ? 'hit'
    : ['criticalFail', 'majorFail'].includes(degree)
      ? 'miss'
      : 'warn';
  return { label, type };
}

/** Whether a Degree of Success counts as a hit (vs. a miss/near-miss). */
export function isHitDegree(degree) {
  return ['criticalHit', 'amazingSuccess', 'standardSuccess'].includes(degree);
}
