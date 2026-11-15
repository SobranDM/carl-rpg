/**
 * Read-only Vehicle lookups (Vehicles, p.72-73; module/data/vehicle.mjs):
 * who is aboard, who drives, which fight it's in, and its Move this round.
 * Nothing here writes or rolls - module/helpers/vehicles.mjs (boarding,
 * relays), vehicle-driving.mjs (Driving Checks) and vehicle-ram.mjs do -
 * so dice.mjs and the attack-row helpers can import this without a cycle.
 *
 * Move is worked out when read (vehicleStatus), because it depends on other
 * documents that don't re-prepare the vehicle when they change: the
 * driver's Driving Rank, the combat round, the clock (Nitrous).
 */
import { isVehicle } from "./actor-kinds.mjs";
import { slugifySkillName } from "./modifiers.mjs";
import { sweepableActors } from "./expiry.mjs";

/**
 * The Actor behind an occupant's uuid (a world Actor, or an unlinked
 * token's synthetic actor), or null if it's gone.
 * @param {string} uuid
 * @returns {Actor|null}
 */
export function resolveOccupant(uuid) {
  try {
    const doc = uuid ? foundry.utils.fromUuidSync(uuid) : null;
    if (doc instanceof Actor) return doc;
    return doc?.actor ?? null;
  } catch {
    return null;
  }
}

/**
 * The uuid an occupant is stored under: the Actor's own (a linked token's
 * is the world Actor; an unlinked Mob's is its token's synthetic actor).
 * @param {Actor} actor
 * @returns {string}
 */
export function occupantKey(actor) {
  return actor?.uuid ?? "";
}

/**
 * Everyone aboard, driver first.
 * @param {Actor} vehicle
 * @returns {Array<{uuid: string, role: string, name: string, index: number, actor: Actor|null}>}
 */
export function vehicleOccupants(vehicle) {
  const occupants = (vehicle?.system?.occupants ?? []).map((o, index) => ({
    ...o, index, actor: resolveOccupant(o.uuid),
  }));
  return occupants.sort((a, b) => (a.role === "driver" ? -1 : 0) - (b.role === "driver" ? -1 : 0));
}

/**
 * The driver's Actor, if anyone is driving.
 * @param {Actor} vehicle
 * @returns {Actor|null}
 */
export function vehicleDriver(vehicle) {
  const seat = (vehicle?.system?.occupants ?? []).find((o) => o.role === "driver");
  return seat ? resolveOccupant(seat.uuid) : null;
}

/**
 * Every Vehicle in play: world vehicles, and unlinked vehicle tokens on the
 * viewed scene and in running fights.
 * @returns {Actor[]}
 */
export function vehiclesInPlay() {
  return sweepableActors().filter((a) => isVehicle(a));
}

/**
 * Who sits where, by occupant uuid, across every vehicle in play - built on
 * the first lookup and kept until something it reads changes. One roll
 * looks seats up many times (each target's Difficulty and rows); without it
 * each lookup walked every actor and token. Dropped (invalidateSeatIndex)
 * by module/helpers/vehicles.mjs's registerVehicleHooks on any change to a
 * vehicle, a token, a fight or the viewed scene - coarse on purpose: a
 * stale seat is worse than a rebuild.
 * @type {Map<string, {vehicle: Actor, role: string, index: number}>|null}
 */
let seatIndex = null;

/** Forget the seat index; the next lookup rebuilds it. */
export function invalidateSeatIndex() {
  seatIndex = null;
}

/** @returns {Map<string, {vehicle: Actor, role: string, index: number}>} */
function buildSeatIndex() {
  const index = new Map();
  for (const vehicle of vehiclesInPlay()) {
    vehicle.system.occupants.forEach((o, i) => {
      // The first vehicle listing someone wins, as a straight search would.
      if (o.uuid && !index.has(o.uuid)) index.set(o.uuid, { vehicle, role: o.role, index: i });
    });
  }
  return index;
}

/**
 * The vehicle an actor is riding, and its seat.
 * @param {Actor} actor
 * @returns {{vehicle: Actor, role: string, index: number}|null}
 */
export function vehicleSeatOf(actor) {
  if (!actor || isVehicle(actor)) return null;
  seatIndex ??= buildSeatIndex();
  return seatIndex.get(occupantKey(actor)) ?? null;
}

/**
 * The started fight a vehicle is in: one where any occupant is a combatant.
 * @param {Actor} vehicle
 * @returns {Combat|null}
 */
export function vehicleFight(vehicle) {
  const keys = new Set((vehicle?.system?.occupants ?? []).map((o) => o.uuid));
  if (!keys.size) return null;
  return game.combats.find((c) => c.started && c.combatants.some((cb) => keys.has(cb.actor?.uuid))) ?? null;
}

/**
 * The driver's Rank in this vehicle's driving Skill (Driving or Chopper
 * Pilot), 0 if untrained.
 * @param {Actor|null} driver
 * @param {string} driveSkill  A CONFIG.CARLRPG.vehicleDriveSkills key.
 * @returns {number}
 */
export function driverRank(driver, driveSkill) {
  const name = CONFIG.CARLRPG.vehicleDriveSkills[driveSkill]?.skillName;
  if (!driver || !name) return 0;
  return driver.system?.skills?.[slugifySkillName(name)]?.rank ?? 0;
}

/**
 * Table 6's effect for a Degree.
 * @param {string} degree
 * @returns {object|null}
 */
export function drivingOutcome(degree) {
  return CONFIG.CARLRPG.drivingOutcomes[degree] ?? null;
}

/**
 * One level better (Hydromancy Shock Absorbers: "Reduce the level of a
 * Driving Check Fail by 1 (a Major Fail becomes a Standard Fail)").
 * @param {string} degree
 * @returns {string}
 */
export function stepUpDegree(degree) {
  const order = CONFIG.CARLRPG.degreeOrder;
  const i = order.indexOf(degree);
  return i < 0 ? degree : order[Math.min(i + 1, order.length - 1)];
}

/**
 * This round's Move from a Driving Check result (Table 6).
 * @param {number} maxMove
 * @param {string} degree  "" for no Check this round: full Move.
 * @param {string} [critChoice]  A Critical Hit's "move" (+50%) or "favor".
 * @returns {number}
 */
export function tableSixMove(maxMove, degree, critChoice = "") {
  const outcome = drivingOutcome(degree);
  if (!outcome) return maxMove;
  if (outcome.stall) return 0;
  if (outcome.critChoice && critChoice === "move") return Math.floor(maxMove * 1.5);
  return Math.max(0, Math.floor(maxMove * outcome.factor) + outcome.delta);
}

/**
 * A creature's or vehicle's Size value (1-8), for "larger than" (ramming).
 * @param {Actor} actor
 * @returns {number|null}
 */
export function actorSizeValue(actor) {
  const sys = actor?.system;
  if (!sys) return null;
  if (typeof sys.size === "number") return sys.size;
  if (typeof sys.details?.size === "number") return sys.details.size;
  const match = String(sys.size ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

/**
 * Everything about a vehicle's motion right now (p.72-73):
 *  - maxMove: base Move, +5ft per driving-Skill Rank threshold its driver
 *    has reached, doubled while Nitrous runs.
 *  - currentMove: 0 when parked; otherwise this round's Table 6 result
 *    (full Move when no Check was made this round), times any ram loss.
 *  - attackDifficulty: "10 + the Vehicle's current Move ÷ 5" - no Floor -
 *    and 10 head-on or from behind.
 *  - evadeBuff (occupants, Move ÷ 10), boardDifficulty (10 + Move ÷ 2),
 *    stopDifficulty (10 + Move ÷ 5), ramDice (Size + Move ÷ 10).
 * @param {Actor} vehicle
 * @returns {object}
 */
export function vehicleStatus(vehicle) {
  const sys = vehicle.system;
  const driver = vehicleDriver(vehicle);
  const skill = CONFIG.CARLRPG.vehicleDriveSkills[sys.driveSkill];
  const rank = driverRank(driver, sys.driveSkill);
  const driveBonus = (skill?.moveRanks ?? []).filter((r) => rank >= r).length * 5;
  const nitrousEndsAt = sys.upgrades.nitrous.endsAt;
  const nitrousActive = nitrousEndsAt !== null && nitrousEndsAt !== undefined && nitrousEndsAt > game.time.worldTime;
  const maxMove = (sys.move + driveBonus) * (nitrousActive ? 2 : 1);

  const fight = vehicleFight(vehicle);
  const stamp = sys.round;
  const roundActive = fight
    ? stamp.combatId === fight.id && stamp.round === fight.round
    : stamp.combatId === "";
  const roundMove = roundActive ? Math.floor(tableSixMove(maxMove, stamp.degree, stamp.critChoice) * stamp.ramFactor) : maxMove;
  const currentMove = sys.parked ? 0 : roundMove;

  return {
    driver,
    driverRank: rank,
    driveBonus,
    nitrousActive,
    nitrousRemaining: nitrousActive ? Math.ceil(nitrousEndsAt - game.time.worldTime) : 0,
    maxMove,
    fight,
    roundActive,
    roundDegree: roundActive ? stamp.degree : "",
    currentMove,
    attackDifficulty: 10 + Math.floor(currentMove / 5),
    headOnDifficulty: 10,
    evadeBuff: Math.floor(currentMove / 10),
    boardDifficulty: 10 + Math.floor(currentMove / 2),
    stopDifficulty: 10 + Math.floor(currentMove / 5),
    ramDice: sys.size + Math.floor(currentMove / 10),
    occupantCount: sys.occupants.length,
    capacity: sys.occupancy + sys.cargo,
  };
}
