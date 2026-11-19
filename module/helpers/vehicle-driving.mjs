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
 *
 * The card is revised in place (module/chat/check-revision.mjs; docs/
 * intervene.md, stage 2) by an AI Favor or Fuzzy Dice reroll and by an
 * Intervene: it keeps its `checkId`, and the vehicle's round follows.
 */
import CarlDice, { checkSubtitle, interventionRolls, rerollNote } from "../dice/dice.mjs";
import { degreeBadge, getDegreeOfSuccess, interventionTotal, isHitDegree, unopposedDifficulty } from "./rules.mjs";
import { rollsLikeCrawler } from "./actor-kinds.mjs";
import { skillOrUntrainedCopy } from "./race-class-grants.mjs";
import { aiRerollFlags } from "./ai-favor.mjs";
import { createRollMessage } from "../chat/chat-card.mjs";
import { drivingOutcome, resolveOccupant, roundStamp, vehicleDriver, vehicleStatus } from "./vehicle-state.mjs";
import { updateVehicle } from "./vehicles.mjs";
import { esc } from "./html.mjs";
import { currentFloor } from "./floor.mjs";

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
 * @param {{critChoice?: string, checkId?: string}} [options]  checkId: the
 *   Check (its card's flags.carl-rpg.driving.checkId) this result is from.
 * @returns {Promise<void>}
 */
export async function commitDrivingRound(vehicle, degree, { critChoice = "", checkId = "" } = {}) {
  await updateVehicle(vehicle, {
    "system.round": roundStamp(vehicle, { checkId, degree, critChoice }),
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
  // The Skill the vehicle names (Driving, Chopper Pilot or homebrew).
  const driveSkill = vehicle.system.driveSkill.trim();
  if (!driveSkill) {
    ui.notifications.warn(loc("NoDriveSkill"));
    return null;
  }
  const { skill, trained } = await skillOrUntrainedCopy(driver, driveSkill, { system: { governingStat: "dex" } });
  const floor = currentFloor();
  const status = vehicleStatus(vehicle);
  // Unopposed: 10 + Floor x 2 (p.59). Stopping in time: 10 + Move ÷ 5.
  const difficulty = mode === "stop" ? status.stopDifficulty : unopposedDifficulty(floor);
  const result = await CarlDice.rollOpposedSkillCheck(driver, skill, {
    difficulty, opponent: null, skipDialog, post: false, markUse: trained,
  });
  if (!result) return null;

  // An Amazing Success's Advantage is spent on this Check.
  const usedAdvantage = (result.applied ?? []).some((r) => r.id === "vehicle-amazing");
  const checkId = foundry.utils.randomID();
  if (mode === "table6") await commitDrivingRound(vehicle, result.degree, { checkId });
  else if (usedAdvantage) await updateVehicle(vehicle, { "system.nextCheckAdvantage": false });

  await postDrivingCard(vehicle, driver, {
    mode, checkId, degree: result.degree, roll: result.roll, natural: result.naturalRoll, total: result.total,
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
 * A Driving Check card's parts, for its first posting and every revision.
 * @param {Actor} vehicle
 * @param {Actor} driver
 * @param {object} data
 * @param {string[]} [data.rerolledBy]  The rerolls made on it ("favor", "fuzzyDice").
 * @returns {object}  createRollMessage / renderRollCard parts.
 */
function drivingCardParts(vehicle, driver, {
  mode, degree, difficulty, rolls, rollMeta, extraRollRows = [], debuffNote = "", trained = true, rerolledBy = [],
}) {
  const notes = rerolledBy.map((by) => rerollNote(by === "favor" ? "CARLRPG.Reroll.Note" : "CARLRPG.Vehicle.Card.FuzzyNote"));
  return {
    rolls,
    rollMeta,
    extraRollRows,
    title: game.i18n.format(mode === "stop" ? "CARLRPG.Vehicle.StopTitle" : "CARLRPG.Vehicle.DrivingTitle", {
      name: driver.name, vehicle: vehicle.name,
    }),
    subtitle: checkSubtitle(degree, difficulty),
    img: vehicle.img,
    badge: degreeBadge(degree),
    body: [
      `<p>${esc(drivingOutcomeText(mode, degree))}</p>`,
      trained ? "" : `<p class="carl-hint">${esc(game.i18n.localize("CARLRPG.Vehicle.Untrained"))}</p>`,
      debuffNote ?? "",
      ...notes,
    ].join(""),
    footer: `<div class="carl-driving-buttons"></div>`,
  };
}

/**
 * Post a Driving Check card. Its buttons (module/chat/vehicle-card.mjs) read
 * `flags.carl-rpg.driving`; `driving.roll` is the Check a reroll (AI Favor
 * or Fuzzy Dice) rolls again and an Intervene adds to - every Driving card
 * has it, while `aiReroll` is only on a character driver's.
 * @param {Actor} vehicle
 * @param {Actor} driver
 * @param {object} data
 * @returns {Promise<ChatMessage>}
 */
export async function postDrivingCard(vehicle, driver, {
  mode, checkId = "", degree, roll, natural, total, difficulty, formula, breakdown, label, debuffNote = "", trained = true,
}) {
  const parts = drivingCardParts(vehicle, driver, {
    mode, degree, difficulty, rolls: [roll], rollMeta: [{ label, detail: vehicle.name, breakdown }], debuffNote, trained,
  });
  const rollSpec = { formula, natural, total, difficulty, breakdown, label, title: parts.title, img: vehicle.img };
  return createRollMessage({
    ...parts,
    actor: driver,
    flags: {
      driving: {
        vehicleUuid: vehicle.uuid, driverUuid: driver.uuid, mode, checkId, degree, trained,
        critChoice: "", damageApplied: false, absorbed: false, parked: false, roll: rollSpec, debuffNote,
        rerolledBy: [], favorUsed: false,
      },
      ...aiRerollFlags(driver, { kind: "driving", ...rollSpec, body: debuffNote }),
    },
  });
}

/**
 * Whether this card's result is still the vehicle's for this round, so its
 * buttons may change it (a Critical Hit pick, Shock Absorbers, a reroll).
 * A card from an earlier round, or one a later Check (or a hand-set result
 * on the sheet) has replaced, is not: its buttons would stamp an old result
 * onto the current round. Only a Table 6 card sets the round; a stopping
 * card is always current.
 * @param {object} driving  flags.carl-rpg.driving
 * @returns {boolean}
 */
export function drivingCardCurrent(driving) {
  if (driving?.mode !== "table6") return true;
  const vehicle = resolveOccupant(driving.vehicleUuid);
  if (!vehicle || !driving.checkId) return false;
  return vehicleStatus(vehicle).roundActive && vehicle.system.round.checkId === driving.checkId;
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
 * Is a once-per-Floor upgrade installed and unused on this Floor?
 * @param {Actor|null} vehicle
 * @param {"fuzzyDice"|"shockAbsorbers"} key
 * @returns {boolean}
 */
export function upgradeReady(vehicle, key) {
  const upgrade = vehicle?.system.upgrades?.[key];
  return !!upgrade?.installed && upgrade.usedFloor !== currentFloor();
}

/**
 * Whether a Driving card's Check can still change (a reroll, an Intervene):
 * its result hasn't been used (a Critical Hit pick, its damage, Shock
 * Absorbers), it's still the vehicle's result this round, and - stopping in
 * time - the vehicle hasn't been parked from it. A card replaced by an
 * older reroll (before they were made in place) is closed.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function drivingOpen(message) {
  const flags = message?.flags?.[SCOPE] ?? {};
  const driving = flags.driving;
  if (!driving?.roll || flags.aiRerolled) return false;
  if (drivingResultSettled(driving) || !drivingCardCurrent(driving)) return false;
  return !(driving.mode === "stop" && driving.parked);
}

/**
 * A Driving card's new parts after a reroll (AI Favor or Fuzzy Dice), an
 * Intervene, or its undo - written by module/chat/check-revision.mjs, which
 * then runs `after`: the round's result re-committed under the same
 * `checkId`, so the card still owns it.
 * @param {ChatMessage} message
 * @param {{interventions: object[], reroll: {natural: number, total: number, roll: object, source: string}|null}} change
 * @returns {Promise<object|null>}  null if the vehicle or driver is gone.
 */
export async function reviseDriving(message, { interventions = [], reroll = null }) {
  const flags = message.flags[SCOPE];
  const driving = foundry.utils.deepClone(flags.driving);
  const vehicle = resolveOccupant(driving.vehicleUuid);
  const driver = resolveOccupant(driving.driverUuid);
  if (!vehicle || !driver) return null;
  const spec = driving.roll;
  const aiReroll = flags.aiReroll ? foundry.utils.deepClone(flags.aiReroll) : null;
  let base = message.rolls?.[0];
  if (reroll) {
    spec.rerolledFrom = { natural: spec.natural, total: spec.total };
    Object.assign(spec, { natural: reroll.natural, total: reroll.total });
    base = Roll.fromData(reroll.roll);
    driving.rerolledBy = [...(driving.rerolledBy ?? []), reroll.source];
    if (reroll.source === "favor") driving.favorUsed = true;
    // The Intervene window and the AI Favor reroll read the d20 from here.
    if (aiReroll) Object.assign(aiReroll, { natural: reroll.natural, total: reroll.total, used: aiReroll.used || reroll.source === "favor" });
  }
  const total = spec.total + interventionTotal(interventions);
  const degree = getDegreeOfSuccess(spec.natural, total, spec.difficulty);
  driving.degree = degree;
  const d6 = interventionRolls(interventions);
  const rerolled = (driving.rerolledBy ?? []).length > 0;
  const parts = drivingCardParts(vehicle, driver, {
    mode: driving.mode, degree, difficulty: spec.difficulty,
    rolls: [base, ...d6.rolls],
    rollMeta: [
      { label: spec.label, detail: rerolled ? `${vehicle.name} · ${game.i18n.localize("CARLRPG.Reroll.Rerolled")}` : vehicle.name, breakdown: spec.breakdown },
      ...d6.meta,
    ],
    extraRollRows: d6.totalRow(total),
    debuffNote: driving.debuffNote ?? aiReroll?.body ?? "", trained: driving.trained, rerolledBy: driving.rerolledBy ?? [],
  });
  const newFlags = { driving, interventions };
  if (aiReroll) newFlags.aiReroll = aiReroll;
  return {
    ...parts,
    flags: newFlags,
    unset: [],
    after: driving.mode === "table6" ? () => commitDrivingRound(vehicle, degree, { checkId: driving.checkId }) : null,
  };
}

/**
 * Table 6's effect for this card, for its buttons.
 * @param {object} driving
 * @returns {object|null}
 */
export function cardOutcome(driving) {
  return driving?.mode === "table6" ? drivingOutcome(driving.degree) : null;
}
