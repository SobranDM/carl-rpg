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
import { isVehicle, rollsLikeCrawler } from "./actor-kinds.mjs";
import { vehicleSeatOf, vehicleStatus } from "./vehicle-state.mjs";
import { collectVehicleRows } from "./vehicle-rows.mjs";

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
 * The id of the `index`th row added because row `parentId` was applied (a
 * ram's occupant rows, module/helpers/vehicle-ram.mjs): t0's are t100,
 * t101..., t1's are t200... Fixed by the parent rather than "the next free
 * id", so two rows applied at once - by two users, or by one player whose
 * writes go through the GM - can't both pick the same ids and overwrite
 * each other's rows. Still a number, so activeRows sorts them after the
 * rows they came from.
 * @param {string} parentId  "t0", "t1"...
 * @param {number} index
 * @returns {string}
 */
export function childRowId(parentId, index) {
  return `t${(Number(parentId.slice(1)) + 1) * 100 + index}`;
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
  const { base, rows } = attackDifficultyParts(actor, floor);
  const resolved = resolveDifficultyRows(base, rows);
  return { difficulty: resolved.difficulty, applied: resolved.applied };
}

/**
 * The Difficulty a crawler's Attack rolls against, before the dialog: the
 * base, and the rows that may change it (shown in the roll dialog for the
 * primary target).
 *  - A vehicle: "10 + the Vehicle's current Move ÷ 5" - no Floor - with an
 *    unticked "head-on or from behind" row that drops the Move part (p.72).
 *  - A creature: its static Evade + Floor, lowered by its Debuffs (only
 *    Woozy for one that rolls its own Evade). A Mob riding in a vehicle adds
 *    the occupant's Evade Buff (Move ÷ 10).
 * @param {Actor} actor  The target.
 * @param {number} floor
 * @returns {{base: number, rows: object[]}}
 */
export function attackDifficultyParts(actor, floor) {
  if (isVehicle(actor)) {
    const status = vehicleStatus(actor);
    return { base: status.attackDifficulty, rows: vehicleHeadOnRows(actor, status, -1) };
  }
  const sys = actor.system;
  const rows = collectDebuffRows(sys, "evade", { ownerName: actor.name, idPrefix: "target", ownAction: false });
  const used = rollsLikeCrawler(actor)
    ? rows.filter((r) => r.kind === "noDex")
    : [...rows, ...collectVehicleRows(actor, "evade", { mode: "difficulty" })];
  return { base: staticEvade(sys) + floor, rows: used };
}

/**
 * "If attacking a vehicle head-on or trunk-on, do not include the vehicle's
 * Move in the Difficulty" - an unticked row, since only the table knows.
 * @param {Actor} vehicle
 * @param {object} status  vehicleStatus(vehicle).
 * @param {1|-1} sign  -1 lowers a Difficulty (a crawler's Attack); +1 raises
 *   a Mob's to-hit by the same amount (compared against the full Difficulty).
 * @returns {object[]}
 */
function vehicleHeadOnRows(vehicle, status, sign) {
  const value = status.attackDifficulty - status.headOnDifficulty;
  if (value <= 0) return [];
  return [{
    id: "vehicle-headon", key: "vehicle", conditionId: null, kind: "penalty", value: sign * value,
    defaultOn: false, consume: false, situational: true,
    label: game.i18n.format("CARLRPG.Vehicle.Rows.HeadOn", { vehicle: vehicle.name }),
  }];
}

/**
 * A Mob's to-hit against a vehicle can be raised by the head-on row (see
 * vehicleHeadOnRows); none for other targets.
 * @param {Actor} actor
 * @returns {object[]}
 */
export function mobVsVehicleRows(actor) {
  return isVehicle(actor) ? vehicleHeadOnRows(actor, vehicleStatus(actor), 1) : [];
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
export function crawlerAttackRow({
  id, target, difficulty, attackTotal, naturalRoll, zone = "full", shared = null, vehicle = undefined, redirect = true,
}) {
  const degree = getDegreeOfSuccess(naturalRoll, attackTotal, difficulty);
  const hit = shared ? shared.hit : (difficulty === null ? degree !== "criticalFail" : isHitDegree(degree));
  const ride = vehicle === undefined ? seatVehicle(target.actor) : vehicle;
  const row = baseRow({
    id, target, zone, difficulty, hit,
    amazing: shared ? shared.amazing : degree === "amazingSuccess",
    degree, natural: naturalRoll, vehicle: ride,
  });
  // "A Near Miss targeting an occupant hits the vehicle" (p.72): it's a hit,
  // on the vehicle - so there's nothing for the occupant to Evade (the card
  // hides Roll Evade on a redirected row).
  if (redirect && !shared && ride && degree === "nearMissFail") {
    Object.assign(row, { hit: true, redirectUuid: ride.uuid, redirectName: ride.name });
  }
  return row;
}

/**
 * The vehicle a target is riding, as {uuid, name}, or null.
 * @param {Actor|{type?: string}|null} actor
 * @returns {{uuid: string, name: string}|null}
 */
function seatVehicle(actor) {
  if (!(actor instanceof Actor)) return null;
  const seat = vehicleSeatOf(actor);
  return seat ? { uuid: seat.vehicle.uuid, name: seat.vehicle.name } : null;
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
  // A vehicle can't Evade: the Mob hits it when its to-hit reaches the
  // vehicle's Difficulty (10 + Move ÷ 5), and misses otherwise.
  if (isVehicle(target.actor)) {
    const status = vehicleStatus(target.actor);
    const resolved = resolveDifficultyRows(base, [...ownRows, ...mobVsVehicleRows(target.actor)], checked);
    const hit = resolved.difficulty === null || resolved.difficulty >= status.attackDifficulty;
    const row = baseRow({ id, target, zone, difficulty: status.attackDifficulty, hit, amazing: false });
    row.toHit = resolved.difficulty;
    return { row, applied: resolved.applied };
  }
  const defenderRows = target.actor
    ? collectAdvantageAgainstRows(target.actor.system, { ownerName: target.actor.name, idPrefix: "target" })
    : [];
  const resolved = resolveDifficultyRows(base, [...ownRows, ...defenderRows], checked);
  const row = baseRow({
    id, target, zone, difficulty: resolved.difficulty, hit: true, amazing: false, vehicle: seatVehicle(target.actor),
  });
  row.freeEvade = resolved.netAdvantage < 0;
  return { row, applied: resolved.applied };
}

/**
 * @param {object} args
 * @param {{uuid: string, name: string}|null} [args.vehicle]  The vehicle the
 *   target is riding, if any (a Near Miss on it hits the vehicle).
 * @param {boolean} [args.canEvade]  Defaults to "rolls like a crawler".
 * @param {"target"|"recoil"|"occupant"} [args.role]  A ram's extra rows
 *   (module/helpers/vehicle-ram.mjs).
 * @param {Record<string, number>|null} [args.damageOverride]  This row's own
 *   damage instead of the card's (ram recoil and occupants, an explosion).
 * @returns {TargetRow}
 */
export function baseRow({
  id, target, zone = "full", difficulty, hit, amazing, degree = null, natural = null, vehicle = null,
  canEvade = rollsLikeCrawler(target.actor), role = "target", damageOverride = null,
}) {
  return {
    id,
    uuid: target.uuid,
    name: target.actor?.name ?? "?",
    // "Defends like a crawler": the owner rolls its Evade (crawlers and
    // their Pets). Kept under this name so older cards still read.
    isCharacter: canEvade,
    isVehicle: isVehicle(target.actor),
    zone,
    difficulty,
    hit,
    amazing,
    degree,
    natural,
    vehicleUuid: vehicle?.uuid ?? null,
    vehicleName: vehicle?.name ?? null,
    redirectUuid: null,
    redirectName: null,
    role,
    damageOverride,
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
  // A row with its own damage (a ram's recoil and occupants, an explosion):
  // exactly that, with no Debuffs. Only skipped by a successful Evade.
  if (row.damageOverride) {
    return row.evade?.success ? { damage: {}, effects: false } : { damage: { ...row.damageOverride }, effects: false };
  }
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
  return rollsLikeCrawler(attackerType) && row.isCharacter ? attackTotal : row.difficulty;
}
