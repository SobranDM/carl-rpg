/**
 * Ramming and exploding (Vehicles, p.73), both as Attack cards (module/chat/
 * attack-targets-card.mjs) so every row gets its own hit/miss, Roll Evade
 * and Apply.
 *
 * Ramming: "a Driving Skill Check vs. the target's Evade. The damage on a
 * hit is 1d6 per size value of the vehicle and per the vehicle's Move ÷10"
 * - (Size + Move ÷ 10)d6 Bludgeoning, + Floor with a Ram Plate ("A vehicle
 * of size 4, moving at 50 inflicts 9d6"). "The ramming vehicle takes half
 * the damage, and halves its Move. If the target is larger than the ramming
 * vehicle, the vehicle takes full damage, and reduces its Move to 0ft" - a
 * "recoil" row for the rammer. "Occupants take half the damage their
 * vehicle takes, reduced by their own Damage Resistance and the vehicle's"
 * - applying any vehicle's row adds a row for each of its occupants.
 *
 * Exploding: "At 0%, the vehicle explodes ..., dealing Xd6+F Fire damage to
 * the occupants, where X is the vehicle's size ... The vehicle's DR does not
 * protect." The book gives no Evade against it.
 */
import CarlDice, { checkSubtitle } from "../dice/dice.mjs";
import { degreeBadge } from "./rules.mjs";
import { isVehicle, rollsLikeCrawler } from "./actor-kinds.mjs";
import { skillOrUntrainedCopy } from "./race-class-grants.mjs";
import { baseRow, childRowId, crawlerAttackDifficulty, crawlerAttackRow } from "./attack-targets.mjs";
import { updateCardMessage } from "./chat-socket.mjs";
import { actorSizeValue, vehicleDriver, vehicleFight, vehicleOccupants, vehicleStatus } from "./vehicle-state.mjs";
import { updateVehicle } from "./vehicles.mjs";
import { canDrive } from "./vehicle-driving.mjs";
import { createRollMessage } from "../chat/chat-card.mjs";
import { buildAttackTargetsFooter } from "../chat/attack-targets-card.mjs";
import { esc } from "./html.mjs";

const SCOPE = "carl-rpg";

/**
 * The ram's dice: (Size + Move ÷ 10)d6, + Floor with a Ram Plate.
 * @param {Actor} vehicle
 * @returns {string}
 */
export function ramFormula(vehicle) {
  const dice = vehicleStatus(vehicle).ramDice;
  return `${dice}d6${vehicle.system.upgrades.ramPlate ? " + @floor" : ""}`;
}

/**
 * Ram the user's targeted token(s) with this vehicle: the driver's Driving
 * (or Chopper Pilot) Check against each target's Difficulty - a vehicle's
 * 10 + Move ÷ 5, a creature's Evade - then the damage, the rammer's recoil
 * and (when applied) the occupants' share.
 * @param {Actor} vehicle
 * @param {{skipDialog?: boolean}} [options]
 * @returns {Promise<ChatMessage|null>}
 */
export async function rollRam(vehicle, { skipDialog = false } = {}) {
  const loc = (key, data = {}) => game.i18n.format(`CARLRPG.Vehicle.${key}`, { vehicle: vehicle.name, ...data });
  const driver = vehicleDriver(vehicle);
  if (!driver || !rollsLikeCrawler(driver)) {
    ui.notifications.warn(driver ? loc("MobDriver", { name: driver.name }) : loc("NoDriver"));
    return null;
  }
  if (!canDrive(vehicle)) {
    ui.notifications.warn(loc("NotYourVehicle"));
    return null;
  }
  const status = vehicleStatus(vehicle);
  if (vehicle.system.parked || status.currentMove <= 0) {
    ui.notifications.warn(loc("Ram.NotMoving"));
    return null;
  }
  const targets = [...(game.user.targets ?? [])].filter((t) => t.actor && t.actor !== vehicle);
  if (!targets.length) {
    ui.notifications.warn(loc("Ram.NoTarget"));
    return null;
  }

  const floor = game.settings.get(SCOPE, "currentFloor");
  const primary = targets[0];
  // The Skill the vehicle names (Driving, Chopper Pilot or homebrew).
  const driveSkill = vehicle.system.driveSkill.trim();
  if (!driveSkill) {
    ui.notifications.warn(loc("NoDriveSkill"));
    return null;
  }
  const { skill, trained } = await skillOrUntrainedCopy(driver, driveSkill, { system: { governingStat: "dex" } });
  const check = await CarlDice.rollOpposedSkillCheck(driver, skill, {
    difficulty: crawlerAttackDifficulty(primary.actor, floor).difficulty,
    opponent: null, skipDialog, post: false, markUse: trained,
  });
  if (!check) return null;
  // A ram is a Check to operate the vehicle: it spends an Amazing Success's Advantage.
  if ((check.applied ?? []).some((r) => r.id === "vehicle-amazing")) {
    await updateVehicle(vehicle, { "system.nextCheckAdvantage": false });
  }

  const rows = targets.map((t, i) => crawlerAttackRow({
    id: `t${i}`,
    target: { uuid: t.document?.uuid ?? t.actor.uuid, actor: t.actor },
    difficulty: i === 0 ? check.difficulty : crawlerAttackDifficulty(t.actor, floor).difficulty,
    attackTotal: check.total,
    naturalRoll: check.naturalRoll,
    // A ram hits the vehicle or the creature it's aimed at - no Near Miss redirect.
    vehicle: null,
    redirect: false,
  }));

  const damageRoll = await new Roll(ramFormula(vehicle), { floor }).evaluate();
  const raw = damageRoll.total;
  // The rammer's own recoil row, if its ram connects with the first target.
  const larger = (actorSizeValue(primary.actor) ?? 0) > vehicle.system.size;
  const recoil = baseRow({
    id: `t${rows.length}`,
    target: { uuid: vehicle.uuid, actor: vehicle },
    difficulty: null,
    hit: rows[0].hit,
    amazing: false,
    canEvade: false,
    role: "recoil",
    damageOverride: { bludgeoning: larger ? raw : Math.floor(raw / 2) },
  });
  recoil.moveFactor = larger ? 0 : 0.5;
  rows.push(recoil);

  const damageByType = { bludgeoning: raw };
  const flags = {
    targetUuids: rows.map((r) => r.uuid),
    targetRows: Object.fromEntries(rows.map((r) => [r.id, r])),
    damageByType,
    damageIsMagic: false,
    isArea: false,
    floor,
    attackTotal: check.total,
    naturalRoll: check.naturalRoll,
    targetDifficulty: check.difficulty,
    attackerType: driver.type,
    attackerUuid: driver.uuid,
    ram: { vehicleUuid: vehicle.uuid, raw, larger, primaryRowId: "t0" },
  };
  const body = [
    `<p>${esc(loc(larger ? "Ram.LargerTarget" : "Ram.Recoil"))}</p>`,
    trained ? "" : `<p class="carl-hint">${esc(game.i18n.localize("CARLRPG.Vehicle.Untrained"))}</p>`,
    check.debuffNote ?? "",
  ].join("");
  return createRollMessage({
    rolls: [check.roll, damageRoll],
    rollMeta: [
      { label: skill.name, detail: `vs. ${primary.actor.name}`, breakdown: check.breakdown },
      { label: game.i18n.localize("CARLRPG.Vehicle.Ram.Damage"), detail: ramFormula(vehicle) },
    ],
    title: loc("Ram.Title", { name: driver.name }),
    // Several targets: each row was rolled against its own Difficulty.
    subtitle: checkSubtitle(check.degree, targets.length > 1 ? null : check.difficulty),
    img: vehicle.img,
    badge: degreeBadge(check.degree),
    body,
    footer: buildAttackTargetsFooter({ damageByType, targetEffects: [], isArea: false }),
    flags,
    actor: driver,
  });
}

/**
 * After a row of a ram or explosion card is applied (module/chat/
 * attack-targets-card.mjs applyRow): a vehicle that took damage passes half
 * of it (less its DR) on to each occupant, as new rows; the rammer's recoil
 * also cuts its Move this round.
 * @param {ChatMessage} message
 * @param {object} row
 * @param {Actor} recipient  Who the row's damage went to.
 * @param {Record<string, number>} damage  The row's damage, before DR.
 * @returns {Promise<string[]>} Digest lines.
 */
export async function afterRamRowApplied(message, row, recipient, damage) {
  const flags = message.flags[SCOPE];
  if (!flags.ram || !isVehicle(recipient)) return [];
  const lines = [];
  if (row.role === "recoil") {
    const status = vehicleStatus(recipient);
    const fight = vehicleFight(recipient);
    const current = recipient.system.round;
    await updateVehicle(recipient, {
      "system.round": {
        combatId: fight?.id ?? "",
        // This round's Driving Check card still owns its result.
        checkId: status.roundActive ? current.checkId : "",
        round: fight?.round ?? null,
        degree: status.roundActive ? current.degree : "",
        critChoice: status.roundActive ? current.critChoice : "",
        ramFactor: row.moveFactor ?? 0.5,
      },
    });
    lines.push(game.i18n.format(row.moveFactor === 0 ? "CARLRPG.Vehicle.Ram.Stopped" : "CARLRPG.Vehicle.Ram.Slowed", { vehicle: esc(recipient.name) }));
  }

  const taken = Object.values(damage ?? {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const share = Math.max(0, Math.floor(taken / 2) - (recipient.system.drEffective ?? recipient.system.dr ?? 0));
  const occupants = vehicleOccupants(recipient).filter((o) => o.actor);
  if (!share || !occupants.length) return lines;
  const added = {};
  for (const [index, o] of occupants.entries()) {
    const id = childRowId(row.id, index);
    added[id] = baseRow({
      id,
      target: { uuid: o.uuid, actor: o.actor },
      difficulty: null,
      hit: true,
      amazing: false,
      canEvade: false,
      role: "occupant",
      damageOverride: { bludgeoning: share },
    });
  }
  await updateCardMessage(message, { flags: { [SCOPE]: { targetRows: added } } });
  lines.push(game.i18n.format("CARLRPG.Vehicle.Ram.OccupantsAdded", { vehicle: esc(recipient.name), damage: share }));
  return lines;
}

/**
 * Blow a vehicle up at 0% HB (active GM, from documents/actor.mjs): Xd6+F
 * Fire to each occupant, X = Size - their own DR applies, the vehicle's
 * doesn't, and they can't Evade it. Everyone is thrown clear (no longer
 * aboard), and the wreck is parked.
 * @param {Actor} vehicle
 * @returns {Promise<ChatMessage|null>}
 */
export async function explodeVehicle(vehicle) {
  if (!isVehicle(vehicle)) return null;
  const floor = game.settings.get(SCOPE, "currentFloor");
  const formula = `${vehicle.system.size}d6 + @floor`;
  const roll = await new Roll(formula, { floor }).evaluate();
  const occupants = vehicleOccupants(vehicle).filter((o) => o.actor);
  const rows = occupants.map((o, i) => baseRow({
    id: `t${i}`,
    target: { uuid: o.uuid, actor: o.actor },
    difficulty: null,
    hit: true,
    amazing: false,
    canEvade: false,
    role: "occupant",
  }));
  const damageByType = { fire: roll.total };
  const message = await createRollMessage({
    rolls: [roll],
    rollMeta: [{ label: game.i18n.localize("CARLRPG.Vehicle.Explosion.Damage"), detail: formula }],
    title: game.i18n.format("CARLRPG.Vehicle.Explosion.Title", { vehicle: vehicle.name }),
    img: vehicle.img,
    body: `<p>${esc(game.i18n.localize(occupants.length ? "CARLRPG.Vehicle.Explosion.Body" : "CARLRPG.Vehicle.Explosion.Empty"))}</p>`,
    footer: rows.length ? buildAttackTargetsFooter({ damageByType, targetEffects: [], isArea: false }) : undefined,
    flags: rows.length ? {
      targetUuids: rows.map((r) => r.uuid),
      targetRows: Object.fromEntries(rows.map((r) => [r.id, r])),
      damageByType,
      damageIsMagic: false,
      isArea: false,
      floor,
      attackerType: "vehicle",
      attackerUuid: vehicle.uuid,
      explosion: { vehicleUuid: vehicle.uuid },
    } : {},
  });
  await vehicle.update({ "system.occupants": [], "system.parked": true });
  return message;
}
