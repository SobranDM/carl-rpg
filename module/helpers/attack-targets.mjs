/**
 * Per-target resolution for Attack cards (Combat, p.81-83).
 *
 * An Attack card carries one row per targeted token in its
 * `flags.carl-rpg.targetRows` ({t0: row, t1: row, ...} - keyed by a short
 * id, never by uuid, since a uuid's dots would be read as a flag path). Each
 * row is resolved on its own:
 *  - its own Difficulty (that target's Evade, or a Mob Attack's to-hit
 *    adjusted for that defender) and hit/miss;
 *  - its own Evade - "The player rolls a separate Evade Check against each
 *    Attack directed at their crawler" (p.81);
 *  - its own Apply (damage + on-hit effects).
 *
 * Area Attacks (p.83): "the attacker makes a single Attack roll against a
 * foe of their choosing... If the Attack is successful, the attacker rolls
 * damage once and applies the full damage to all creatures... in the
 * affected area"; Splash "deals half as much damage"; "A victim who Evades
 * an Area Attack reduces the damage by 50%. A successful Evade in the splash
 * zone reduces the damage by another 50% so only 25%... rounded down".
 */
import { collectDebuffRows, collectAdvantageAgainstRows, resolveDifficultyRows } from "./debuff-effects.mjs";
import { getDegreeOfSuccess, isHitDegree, staticEvade } from "./rules.mjs";
import { scaleDamageByType } from "./damage-pipeline.mjs";

/**
 * @typedef {object} TargetRow
 * @property {string} id           "t0", "t1"... - the row's key in targetRows.
 * @property {string} uuid         The target token's (or actor's) uuid.
 * @property {string} name
 * @property {boolean} isCharacter Feeds the PvP Evade rule (p.87).
 * @property {"full"|"splash"} zone
 * @property {number|null} difficulty  What this target's Evade rolls against (or the Attack rolled against).
 * @property {boolean} hit         Whether the Attack lands on this target unless it Evades.
 * @property {boolean} amazing     Amazing Success against this target: +Floor damage (p.79).
 * @property {boolean} freeEvade   A Disadvantaged Mob Attack's free Evade (p.96).
 * @property {boolean} freeUsed
 * @property {{degree: string, success: boolean}|null} evade
 * @property {boolean} applied
 * @property {boolean} replaced    Taunted away (module/chat/taunt-card.mjs) - no longer a target.
 */

/** Rows in order, skipping any that were Taunted away. */
export function activeRows(targetRows) {
  return Object.values(targetRows ?? {})
    .filter((row) => row && !row.replaced)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/**
 * Whether a row has nothing left to apply: already applied, missed, or a
 * clean Evade of a non-area Attack.
 * @param {TargetRow} row
 * @param {boolean} isArea
 * @returns {boolean}
 */
export function rowResolved(row, isArea) {
  return !!row.applied || !row.hit || (row.evade?.success === true && !isArea);
}

/** The next free row id ("t3" after t0-t2). */
export function nextRowId(targetRows) {
  const ids = Object.keys(targetRows ?? {}).map((id) => Number(id.slice(1))).filter(Number.isFinite);
  return `t${ids.length ? Math.max(...ids) + 1 : 0}`;
}

/**
 * The Difficulty a crawler's Attack rolls against for one target, with that
 * target's default Debuff rows (a Mob's Debuffs all lower its static Evade;
 * a crawler's only through Woozy - see CarlDice.rollAttack).
 * @param {Actor} actor  The target.
 * @param {number} floor
 * @returns {{difficulty: number, applied: object[]}}
 */
export function crawlerAttackDifficulty(actor, floor) {
  const sys = actor.system;
  const rows = collectDebuffRows(sys, "evade", { ownerName: actor.name, idPrefix: "target", ownAction: false });
  const used = actor.type === "character" ? rows.filter((r) => r.kind === "noDex") : rows;
  const resolved = resolveDifficultyRows(staticEvade(sys) + floor, used);
  return { difficulty: resolved.difficulty, applied: resolved.applied };
}

/**
 * A row for a crawler's Attack (CarlDice.rollAttack) against one target.
 * @param {object} args
 * @param {string} args.id
 * @param {{uuid: string, actor: Actor}} args.target
 * @param {number|null} args.difficulty
 * @param {number} args.attackTotal
 * @param {number|null} args.naturalRoll
 * @param {"full"|"splash"} [args.zone]
 * @param {{hit: boolean, amazing: boolean}|null} [args.shared]  An Area Attack's
 *   single result against the chosen foe, applied to every row.
 * @returns {TargetRow}
 */
export function crawlerAttackRow({ id, target, difficulty, attackTotal, naturalRoll, zone = "full", shared = null }) {
  const degree = getDegreeOfSuccess(naturalRoll, attackTotal, difficulty);
  const hit = shared ? shared.hit : (difficulty === null ? degree !== "criticalFail" : isHitDegree(degree));
  return baseRow({
    id, target, zone, difficulty, hit,
    amazing: shared ? shared.amazing : degree === "amazingSuccess",
  });
}

/**
 * A row for a Mob's printed Attack (CarlDice.rollMobAttack) against one
 * defender: the to-hit, adjusted by the Mob's own Debuff rows and by this
 * defender's Held/Take Down ("Attacks against a Held foe are made with
 * Advantage" - +5 for a Mob, p.60). A net-Disadvantaged Attack gives this
 * defender a free Evade (p.96). Mob Attacks always land unless Evaded.
 * @param {object} args
 * @param {string} args.id
 * @param {{uuid: string, actor: Actor}} args.target
 * @param {number|null} args.base       To-hit plus the dialog's modifier.
 * @param {object[]} args.ownRows       The Mob's own applied rows (defaultOn true).
 * @param {Set<string>|null} [args.checked]  The dialog's ticks, for the primary target only.
 * @param {"full"|"splash"} [args.zone]
 * @returns {{row: TargetRow, applied: object[]}}
 */
export function mobAttackRow({ id, target, base, ownRows, checked = null, zone = "full" }) {
  const defenderRows = target.actor
    ? collectAdvantageAgainstRows(target.actor.system, { ownerName: target.actor.name, idPrefix: "target" })
    : [];
  const resolved = resolveDifficultyRows(base, [...ownRows, ...defenderRows], checked);
  const row = baseRow({ id, target, zone, difficulty: resolved.difficulty, hit: true, amazing: false });
  row.freeEvade = resolved.netAdvantage < 0;
  return { row, applied: resolved.applied };
}

function baseRow({ id, target, zone, difficulty, hit, amazing }) {
  return {
    id,
    uuid: target.uuid,
    name: target.actor?.name ?? "?",
    isCharacter: target.actor?.type === "character",
    zone,
    difficulty,
    hit,
    amazing,
    freeEvade: false,
    freeUsed: false,
    evade: null,
    applied: false,
    replaced: false,
  };
}

/**
 * What one row takes when applied: the card's rolled damage, scaled for this
 * target (Amazing Success +Floor; Splash half; an Evade's result), plus
 * whether the on-hit effects land.
 *  - Missed, or a successful Evade vs. a non-area Attack: nothing.
 *  - A successful Evade vs. an Area Attack: half (a quarter in the Splash).
 *  - A failed Evade: Major Fail +Floor, Critical Fail double (p.79-80).
 * @param {TargetRow} row
 * @param {{damageByType: Record<string, number>, isArea: boolean, floor: number}} card
 * @returns {{damage: Record<string, number>, effects: boolean}}
 */
export function rowOutcome(row, { damageByType, isArea, floor }) {
  if (!row?.hit) return { damage: {}, effects: false };
  const evaded = row.evade?.success === true;
  if (evaded && !isArea) return { damage: {}, effects: false };
  const degree = row.evade?.degree;
  let factor = row.zone === "splash" ? 0.5 : 1;
  if (evaded) factor *= 0.5;
  if (degree === "criticalFail") factor *= 2;
  const base = { ...(damageByType ?? {}) };
  if (row.amazing) base[""] = (base[""] ?? 0) + floor;
  const damage = scaleDamageByType(base, factor, degree === "majorFail" ? floor : 0);
  return { damage, effects: !evaded };
}

/**
 * The Difficulty this row's Evade rolls against: in PvP "That value [the
 * attacker's Attack Skill Check] then serves as the Difficulty for their
 * victim's Evade Check" (p.87), otherwise the row's own Difficulty.
 * @param {TargetRow} row
 * @param {{attackerType: string, attackTotal: number}} card
 * @returns {number|null}
 */
export function rowEvadeDifficulty(row, { attackerType, attackTotal }) {
  return attackerType === "character" && row.isCharacter ? attackTotal : row.difficulty;
}
