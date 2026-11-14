/**
 * Driving Checks (Vehicles, p.72): "when you try a cool maneuver or drive
 * while in combat, you need to make a Check". The driver rolls an Unopposed
 * Driving (or Chopper Pilot) Check - untrained with Disadvantage - and
 * Table 6 sets the vehicle's Move this round:
 *   Critical Hit: +50% Move this round, or 1 AI Favor (the driver picks).
 *   Amazing Success: full Move, and Advantage on the next Check to operate it.
 *   Standard Success: full Move.     Near Miss: -5ft.
 *   Standard Fail: half Move.        Major Fail: half Move and 10% damage.
 *   Critical Fail: stalls (no Move) and 30% damage.
 * 10% / 30% damage is read as 1 / 3 Health Bar slots, ignoring DR.
 * The result is recorded on the vehicle for this round at once; what's left
 * to choose or confirm (the Critical Hit pick, the damage, an upgrade) is a
 * button on the card (module/chat/vehicle-card.mjs).
 *
 * "Stop" mode is the other Check (p.72): stopping in time, at 10 + Move ÷ 5
 * - on a success you stop where you want, on a fail the GM decides.
 */
import CarlDice, { checkSubtitle, extractNaturalD20 } from "../dice/dice.mjs";
import { CARLRPG } from "./config.mjs";
import { degreeBadge, getDegreeOfSuccess, isHitDegree } from "./rules.mjs";
import { rollsLikeCrawler } from "./actor-kinds.mjs";
import { skillOrUntrainedCopy } from "./race-class-grants.mjs";
import { aiRerollFlags, rerollFormula } from "./ai-favor.mjs";
import { updateCardMessage } from "./chat-socket.mjs";
import { createRollMessage, esc } from "../chat/chat-card.mjs";
import { drivingOutcome, vehicleDriver, vehicleFight, vehicleStatus } from "./vehicle-state.mjs";
import { updateVehicle } from "./vehicles.mjs";

const SCOPE = "carl-rpg";

/**
 * Whether this user may roll the vehicle's driving Checks: its driver must
 * roll like a crawler (a Mob driver's result is the GM's pick on the
 * Details tab), and the user is the GM or plays the driver.
 * @param {Actor} vehicle
 * @param {User} [user]
 * @returns {boolean}
 */
export function canDrive(vehicle, user = game.user) {
  const driver = vehicleDriver(vehicle);
  return !!driver && rollsLikeCrawler(driver) && (user.isGM || driver.testUserPermission(user, "OWNER"));
}

/**
 * Record this round's Table 6 result on the vehicle: Move for the round
 * (keeping a ram's Move loss from the same round), Advantage for the next
 * operating Check on an Amazing Success, and it's moving.
 * @param {Actor} vehicle
 * @param {string} degree
 * @param {{critChoice?: string}} [options]
 * @returns {Promise<void>}
 */
export async function commitDrivingRound(vehicle, degree, { critChoice = "" } = {}) {
  const fight = vehicleFight(vehicle);
  const status = vehicleStatus(vehicle);
  await updateVehicle(vehicle, {
    "system.round": {
      combatId: fight?.id ?? "",
      round: fight?.round ?? null,
      degree,
      critChoice,
      ramFactor: status.roundActive ? vehicle.system.round.ramFactor : 1,
    },
    "system.nextCheckAdvantage": degree === "amazingSuccess",
    "system.parked": false,
  });
}

/**
 * Roll the driver's Check for this vehicle and post its card.
 * @param {Actor} vehicle
 * @param {{mode?: "table6"|"stop", skipDialog?: boolean}} [options]
 * @returns {Promise<string|null>} The Degree, or null if not rolled.
 */
export async function rollDrivingCheck(vehicle, { mode = "table6", skipDialog = false } = {}) {
  const driver = vehicleDriver(vehicle);
  const loc = (key, data = {}) => game.i18n.format(`CARLRPG.Vehicle.${key}`, { vehicle: vehicle.name, ...data });
  if (!driver) {
    ui.notifications.warn(loc("NoDriver"));
    return null;
  }
  if (!rollsLikeCrawler(driver)) {
    ui.notifications.warn(loc("MobDriver", { name: driver.name }));
    return null;
  }
  if (!canDrive(vehicle)) {
    ui.notifications.warn(loc("NotYourVehicle"));
    return null;
  }
  const skillCfg = CARLRPG.vehicleDriveSkills[vehicle.system.driveSkill];
  const { skill, trained } = await skillOrUntrainedCopy(driver, skillCfg.skillName, { system: { governingStat: "dex" } });
  const floor = game.settings.get("carl-rpg", "currentFloor");
  const status = vehicleStatus(vehicle);
  // Unopposed: 10 + Floor x 2 (p.59). Stopping in time: 10 + Move ÷ 5.
  const difficulty = mode === "stop" ? status.stopDifficulty : 10 + 2 * floor;
  const result = await CarlDice.rollOpposedSkillCheck(driver, skill, {
    difficulty, opponent: null, skipDialog, post: false, markUse: trained,
  });
  if (!result) return null;

  // An Amazing Success's Advantage is spent on this Check.
  const usedAdvantage = (result.applied ?? []).some((r) => r.id === "vehicle-amazing");
  if (mode === "table6") await commitDrivingRound(vehicle, result.degree);
  else if (usedAdvantage) await updateVehicle(vehicle, { "system.nextCheckAdvantage": false });

  await postDrivingCard(vehicle, driver, {
    mode, degree: result.degree, roll: result.roll, natural: result.naturalRoll, total: result.total,
    difficulty: result.difficulty, formula: result.formula, breakdown: result.breakdown,
    label: skill.name, debuffNote: result.debuffNote, trained,
  });
  return result.degree;
}

/**
 * The text of a Driving Check result: Table 6's line, or the stop result.
 * @param {"table6"|"stop"} mode
 * @param {string} degree
 * @returns {string}
 */
export function drivingOutcomeText(mode, degree) {
  if (mode === "stop") {
    const stopped = isHitDegree(degree);
    return game.i18n.localize(stopped ? "CARLRPG.Vehicle.StopSuccess" : "CARLRPG.Vehicle.StopFail");
  }
  return game.i18n.localize(`CARLRPG.Vehicle.Outcome.${degree}`);
}

/**
 * Post a Driving Check card. Its buttons (module/chat/vehicle-card.mjs) read
 * `flags.carl-rpg.driving`; `driving.roll` is what a reroll (AI Favor or
 * Fuzzy Dice) rolls again.
 * @param {Actor} vehicle
 * @param {Actor} driver
 * @param {object} data
 * @returns {Promise<ChatMessage>}
 */
export async function postDrivingCard(vehicle, driver, {
  mode, degree, roll, natural, total, difficulty, formula, breakdown, label, debuffNote = "", trained = true,
  rerolledBy = null, favorUsed = false,
}) {
  const title = game.i18n.format(mode === "stop" ? "CARLRPG.Vehicle.StopTitle" : "CARLRPG.Vehicle.DrivingTitle", {
    name: driver.name, vehicle: vehicle.name,
  });
  const body = [
    `<p>${esc(drivingOutcomeText(mode, degree))}</p>`,
    trained ? "" : `<p class="carl-hint">${esc(game.i18n.localize("CARLRPG.Vehicle.Untrained"))}</p>`,
    debuffNote ?? "",
    rerolledBy ? `<p class="carl-reroll-note">${esc(game.i18n.localize(rerolledBy === "favor" ? "CARLRPG.Reroll.Note" : "CARLRPG.Vehicle.Card.FuzzyNote"))}</p>` : "",
  ].join("");
  const rollSpec = { formula, natural, total, difficulty, breakdown, label, title, img: vehicle.img };
  return createRollMessage({
    rolls: [roll],
    rollMeta: [{ label, detail: vehicle.name, breakdown }],
    title,
    subtitle: checkSubtitle(degree, difficulty),
    img: vehicle.img,
    badge: degreeBadge(degree),
    body,
    footer: `<div class="carl-driving-buttons"></div>`,
    actor: driver,
    flags: {
      driving: {
        vehicleUuid: vehicle.uuid, driverUuid: driver.uuid, mode, degree, trained,
        critChoice: "", damageApplied: false, absorbed: false, roll: rollSpec, favorUsed,
      },
      // One AI Favor reroll per Check: none once one has been spent on it.
      ...(favorUsed ? {} : aiRerollFlags(driver, { kind: "driving", ...rollSpec, body: debuffNote })),
    },
  });
}

/**
 * Whether anything has been done with this card's result - a reroll must
 * come "before the GM announces the result" (p.61).
 * @param {object} driving  flags.carl-rpg.driving
 * @returns {boolean}
 */
export function drivingResultSettled(driving) {
  return !!(driving?.critChoice || driving?.damageApplied || driving?.absorbed);
}

/**
 * Reroll a Driving Check card (AI Favor, or Fuzzy Dice): roll the same d20
 * expression plus the rest of the old total, post a new card, record its
 * result, and retire the old card. The caller has already paid. A Fuzzy
 * Dice reroll still allows an AI Favor one; after an AI Favor one, no more.
 * @param {ChatMessage} message
 * @param {{by?: "favor"|"fuzzyDice"}} [options]
 * @returns {Promise<ChatMessage|null>}
 */
export async function rerollDrivingCheck(message, { by = "favor" } = {}) {
  const driving = message.flags?.[SCOPE]?.driving;
  const vehicle = driving ? await fromUuid(driving.vehicleUuid) : null;
  const driver = driving ? await fromUuid(driving.driverUuid) : null;
  if (!vehicle || !driver) return null;
  const spec = driving.roll;
  const roll = await new Roll(rerollFormula(spec)).evaluate();
  const natural = extractNaturalD20(roll);
  const degree = getDegreeOfSuccess(natural, roll.total, spec.difficulty);
  await updateCardMessage(message, { flags: { [SCOPE]: { aiRerolled: true } } });
  if (driving.mode === "table6") await commitDrivingRound(vehicle, degree);
  return postDrivingCard(vehicle, driver, {
    mode: driving.mode, degree, roll, natural, total: roll.total, difficulty: spec.difficulty,
    formula: spec.formula, breakdown: spec.breakdown, label: spec.label, trained: driving.trained,
    rerolledBy: by, favorUsed: by === "favor" || !!driving.favorUsed,
  });
}

/**
 * Table 6's effect for this card, for its buttons.
 * @param {object} driving
 * @returns {object|null}
 */
export function cardOutcome(driving) {
  return driving?.mode === "table6" ? drivingOutcome(driving.degree) : null;
}
