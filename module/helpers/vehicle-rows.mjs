/**
 * The roll-dialog rows riding in a vehicle adds (Vehicles, p.72), in the
 * same shape as module/helpers/debuff-effects.mjs's Debuff rows, so they show
 * as pre-ticked checkboxes in the roll dialog - untick one the fiction says
 * doesn't apply (an Attack from straight ahead, say) - and resolve the same
 * way. They never consume a condition (`conditionId: null`).
 *  - The driver: "you'll roll with Disadvantage while you're the vehicle's
 *    driver unless it's to drive, use mounted-only weapons (like a lance), or
 *    use one of your vehicle's built-in weapons." A mounted weapon is a
 *    Skill with its Mounted box ticked (Lance). An unlocked "No Disadvantage
 *    on Attacks" tier of the driver's driving Skill (Driving Rank 5, Chopper
 *    Pilot Rank 10) lifts it from Attacks. A parked vehicle isn't driven.
 *  - Driving the vehicle (a Check with the Skill the vehicle names): Advantage
 *    from a previous Amazing Success ("on your next Skill Check to operate
 *    this vehicle"), and an unlocked stunt-Advantage tier (Rank 15; offered
 *    unticked - it's for crazy stunts only).
 *  - Any occupant's Evade: "an Evade Buff equal to the vehicle's Move ÷ 10,
 *    except from straight ahead or behind". An unlocked Evade-Advantage tier
 *    (Driving Rank 10's "Advantage to Evade Attacks against your vehicle")
 *    goes to the driver's own Evade (vehicles themselves don't Evade).
 * The driver's perks are their own driving Skill's tiers (vehicle-state.mjs
 * driverPerks).
 */
import { isVehicle } from "./actor-kinds.mjs";
import { sameSkillName } from "./modifiers.mjs";
import { driverPerks, vehicleSeatOf, vehicleStatus } from "./vehicle-state.mjs";

/**
 * @param {Actor} actor  The one rolling (or, in "difficulty" mode, a Mob
 *   occupant whose Evade is a static Difficulty).
 * @param {"check"|"attack"|"evade"} rollKind
 * @param {{skillItem?: Item|null, builtIn?: boolean, mode?: "roll"|"difficulty"}} [options]
 *   builtIn: firing one of the vehicle's built-in weapons.
 * @returns {object[]} Debuff-row-shaped rows (undecorated).
 */
export function collectVehicleRows(
  actor,
  rollKind,
  { skillItem = null, builtIn = false, mode = "roll" } = {},
) {
  if (!actor || isVehicle(actor)) return [];
  const seat = vehicleSeatOf(actor);
  if (!seat) return [];
  const vehicle = seat.vehicle;
  const sys = vehicle.system;
  const status = vehicleStatus(vehicle);
  const driving = seat.role === "driver" && !sys.parked;
  const perks = driving ? driverPerks(actor, vehicle) : null;

  const rows = [];
  const add = (id, kind, value, key, defaultOn = true) =>
    rows.push({
      id: `vehicle-${id}`,
      key: "vehicle",
      conditionId: null,
      kind,
      value,
      defaultOn,
      consume: false,
      situational: true,
      label: game.i18n.format(`CARLRPG.Vehicle.Rows.${key}`, {
        vehicle: vehicle.name,
        value,
        skill: perks?.item?.name ?? sys.driveSkill,
      }),
    });

  if (rollKind === "evade") {
    if (status.evadeBuff > 0) add("evade-buff", "penalty", status.evadeBuff, "EvadeBuff");
    if (mode === "roll" && driving) {
      add("driving", "disadvantage", 0, "Driving");
      if (perks.evadeAdvantage) add("driving-evade", "advantage", 0, "DrivingEvade");
    }
    return rows;
  }
  if (mode !== "roll" || !driving) return rows;

  if (skillItem && sameSkillName(skillItem.name, sys.driveSkill)) {
    if (sys.nextCheckAdvantage) add("amazing", "advantage", 0, "Amazing");
    if (perks.stuntAdvantage) add("stunt", "advantage", 0, "Stunt", false);
    return rows;
  }
  if (rollKind === "attack") {
    const mounted = skillItem?.system?.mounted === true;
    if (builtIn || mounted || perks.attackOk) return rows;
  }
  add("driving", "disadvantage", 0, "Driving");
  return rows;
}
