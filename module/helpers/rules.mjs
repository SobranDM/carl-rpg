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

/**
 * A creature's static Evade before the Floor and any Debuffs: 10 + DEX Mod
 * + any Evade bonus (Dodge's "rollMode" evadeBonus). The one formula behind
 * both a Mob sheet's Evade (module/data/mob.mjs) and the Difficulty an
 * Attack rolls against (CarlDice.rollAttack, which adds the Floor).
 * @param {object} sys  An actor's system data.
 * @returns {number}
 */
export function staticEvade(sys) {
  return 10 + (sys?.stats?.dex?.mod ?? 0) + (sys?.bonuses?.evadeBonus ?? 0);
}

/**
 * The roll dialog's Difficulty presets (The Core Mechanic, p.59), at the
 * current Floor: Unopposed "10 + [Floor Number x 2]", Stat Check "10 + Floor
 * Number", and - when there's an opponent - Opposed "10 + antagonist's
 * relevant Stat Mod + Floor Number". `given` adds the Difficulty the caller
 * already computed (an Attack's Evade, a Taunt's...). "Custom" keeps
 * whatever is typed. "The GM may simply assign a Difficulty of their
 * choosing" - every preset is just a starting value.
 * @param {object} options
 * @param {number} options.floor
 * @param {"custom"|"unopposed"|"stat"|"opposed"|"given"} [options.selected]
 * @param {{name: string, stat: string, mod: number}|null} [options.opposed]
 * @param {{label: string, value: number}|null} [options.given]
 * @returns {{key: string, label: string, value: number|null, selected: boolean}[]}
 */
export function buildDifficultyPresets({ floor, selected = "custom", opposed = null, given = null }) {
  const f = Number(floor) || 0;
  const i18n = game.i18n;
  const presets = [];
  if (given && given.value !== null && given.value !== undefined) {
    presets.push({ key: "given", label: `${given.label}: ${given.value}`, value: given.value });
  }
  presets.push({ key: "unopposed", label: i18n.format("CARLRPG.Dialog.Preset.Unopposed", { value: 10 + 2 * f }), value: 10 + 2 * f });
  presets.push({ key: "stat", label: i18n.format("CARLRPG.Dialog.Preset.Stat", { value: 10 + f }), value: 10 + f });
  if (opposed) {
    const value = 10 + (Number(opposed.mod) || 0) + f;
    presets.push({ key: "opposed", label: i18n.format("CARLRPG.Dialog.Preset.Opposed", { name: opposed.name, stat: opposed.stat, value }), value });
  }
  presets.push({ key: "custom", label: i18n.localize("CARLRPG.Dialog.Preset.Custom"), value: null });
  const pick = presets.some((p) => p.key === selected) ? selected : "custom";
  return presets.map((p) => ({ ...p, selected: p.key === pick }));
}

/**
 * The value of the preset a dialog opens on (null for "custom").
 * @param {{value: number|null, selected: boolean}[]} presets
 * @returns {number|null}
 */
export function selectedPresetValue(presets) {
  return presets.find((p) => p.selected)?.value ?? null;
}
