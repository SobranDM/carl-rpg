/**
 * The buttons on a Driving Check card (module/helpers/vehicle-driving.mjs),
 * drawn per viewer from the card's `flags.carl-rpg.driving`:
 *  - Critical Hit: the driver picks +50% Move this round, or 1 AI Favor.
 *  - Major / Critical Fail: apply the 1 / 3 Health Bar slots of damage (the
 *    GM or the vehicle's owner) - ignoring DR.
 *  - Hydromancy Shock Absorbers, once per Floor: "Reduce the level of a
 *    Driving Check Fail by 1" - before the damage is applied.
 *  - Stopping in time, on a success: park.
 * Rerolls (AI Favor, and Fuzzy Dice - "One Driving Skill Check reroll per
 * Floor", p.73) are the card's Reroll button (module/chat/ai-favor-reroll.mjs),
 * revising it in place. A card replaced by an older reroll keeps none of its
 * buttons. The ones that change the round's result (Critical Hit, Shock
 * Absorbers) are only on the card whose result the vehicle has this round
 * (drivingCardCurrent) - not one from an earlier round, or one a later
 * Check has replaced.
 */
import { CARLRPG } from "../helpers/config.mjs";
import { isHitDegree } from "../helpers/rules.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { appendCardSection, esc } from "./chat-card.mjs";
import { resolveOccupant, stepUpDegree } from "../helpers/vehicle-state.mjs";
import { updateVehicle } from "../helpers/vehicles.mjs";
import {
  canDrive, cardOutcome, commitDrivingRound, drivingCardCurrent, drivingOutcomeText, upgradeReady,
} from "../helpers/vehicle-driving.mjs";

const SCOPE = "carl-rpg";
/** Cards with a button mid-click - a double click mustn't apply twice. */
const inFlight = new Set();

/** The card's vehicle and driver, resolved synchronously for drawing. */
function cardDocs(driving) {
  return { vehicle: resolveOccupant(driving?.vehicleUuid), driver: resolveOccupant(driving?.driverUuid) };
}

/**
 * Which buttons this viewer gets on this card.
 * @param {ChatMessage} message
 * @returns {Array<{action: string, icon: string, label: string}>}
 */
function drivingButtons(message) {
  const flags = message.flags?.[SCOPE] ?? {};
  const driving = flags.driving;
  if (!driving || flags.aiRerolled) return [];
  const { vehicle, driver } = cardDocs(driving);
  if (!vehicle || !driver) return [];
  const loc = (key, data) => game.i18n.format(`CARLRPG.Vehicle.Card.${key}`, data ?? {});
  const outcome = cardOutcome(driving);
  const driverSide = canDrive(vehicle);
  const current = drivingCardCurrent(driving);
  const buttons = [];
  if (outcome?.critChoice && !driving.critChoice && driverSide && current) {
    buttons.push({ action: "drivingCritMove", icon: "fa-gauge-high", label: loc("CritMove") });
    if (driver.type === "character") buttons.push({ action: "drivingCritFavor", icon: "fa-star", label: loc("CritFavor") });
  }
  const failed = !isHitDegree(driving.degree);
  if (driving.mode === "table6" && failed && !driving.absorbed && !driving.damageApplied && driverSide && current
    && upgradeReady(vehicle, "shockAbsorbers")) {
    buttons.push({ action: "drivingAbsorb", icon: "fa-water", label: loc("Absorb") });
  }
  if (outcome?.damageSlots && !driving.damageApplied && (game.user.isGM || vehicle.isOwner)) {
    buttons.push({ action: "drivingDamage", icon: "fa-car-burst", label: loc("Damage", { slots: outcome.damageSlots }) });
  }
  if (driving.mode === "stop" && !failed && !vehicle.system.parked && (driverSide || vehicle.isOwner)) {
    buttons.push({ action: "drivingPark", icon: "fa-parking", label: loc("Park") });
  }
  return buttons;
}

/**
 * Draw this viewer's buttons into a Driving Check card (from
 * module/chat/chat-listener.mjs on every render).
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateDrivingCard(message, html) {
  const container = html.querySelector(".carl-driving-buttons");
  if (!container) return;
  container.innerHTML = drivingButtons(message).map((b) => `<button type="button" data-action="${b.action}">
    <i class="fas ${b.icon}"></i> ${esc(b.label)}</button>`).join("");
}

/**
 * Run one button's action, if this viewer may (the buttons are re-checked,
 * since a card can be stale).
 * @param {ChatMessage} message
 * @param {string} action
 * @param {(ctx: {driving: object, vehicle: Actor, driver: Actor}) => Promise<void>} fn
 */
async function run(message, action, fn) {
  if (inFlight.has(message.id)) return;
  if (!drivingButtons(message).some((b) => b.action === action)) return;
  inFlight.add(message.id);
  try {
    const driving = message.flags[SCOPE].driving;
    const { vehicle, driver } = cardDocs(driving);
    await fn({ driving, vehicle, driver });
  } finally {
    inFlight.delete(message.id);
  }
}

/** Note what a button did on the card. */
function noteOnCard(message, text) {
  return updateCardMessage(message, { content: appendCardSection(message, `<p class="carl-driving-note">${esc(text)}</p>`) });
}

const handlers = {
  async drivingCritMove(message) {
    await run(message, "drivingCritMove", async ({ driving, vehicle }) => {
      await commitDrivingRound(vehicle, "criticalHit", { critChoice: "move", checkId: driving.checkId });
      await updateCardMessage(message, { flags: { [SCOPE]: { driving: { critChoice: "move" } } } });
      await noteOnCard(message, game.i18n.localize("CARLRPG.Vehicle.Card.CritMoveDone"));
    });
  },
  async drivingCritFavor(message) {
    await run(message, "drivingCritFavor", async ({ driving, vehicle, driver }) => {
      await driver.update({ "system.details.aiFavor": (driver.system.details?.aiFavor ?? 0) + 1 });
      await commitDrivingRound(vehicle, "criticalHit", { critChoice: "favor", checkId: driving.checkId });
      await updateCardMessage(message, { flags: { [SCOPE]: { driving: { critChoice: "favor" } } } });
      await noteOnCard(message, game.i18n.format("CARLRPG.Vehicle.Card.CritFavorDone", { name: driver.name }));
    });
  },
  async drivingDamage(message) {
    await run(message, "drivingDamage", async ({ driving, vehicle }) => {
      const slots = cardOutcome(driving)?.damageSlots ?? 0;
      await updateCardMessage(message, { flags: { [SCOPE]: { driving: { damageApplied: true } } } });
      await vehicle.update({ "system.hb.value": Math.max(0, vehicle.system.hb.value - slots) });
      await noteOnCard(message, game.i18n.format("CARLRPG.Vehicle.Card.DamageDone", { vehicle: vehicle.name, slots }));
    });
  },
  async drivingAbsorb(message) {
    await run(message, "drivingAbsorb", async ({ driving, vehicle }) => {
      const degree = stepUpDegree(driving.degree);
      if (!await updateVehicle(vehicle, { "system.upgrades.shockAbsorbers.usedFloor": game.settings.get(SCOPE, "currentFloor") })) return;
      await commitDrivingRound(vehicle, degree, { checkId: driving.checkId });
      await updateCardMessage(message, { flags: { [SCOPE]: { driving: { degree, absorbed: true } } } });
      await noteOnCard(message, game.i18n.format("CARLRPG.Vehicle.Card.AbsorbDone", {
        result: game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), outcome: drivingOutcomeText("table6", degree),
      }));
    });
  },
  async drivingPark(message) {
    await run(message, "drivingPark", async ({ vehicle }) => {
      await updateVehicle(vehicle, { "system.parked": true });
      // Its result is used: no reroll or Intervene after this.
      await updateCardMessage(message, { flags: { [SCOPE]: { driving: { parked: true } } } });
      await noteOnCard(message, game.i18n.format("CARLRPG.Vehicle.Card.Parked", { vehicle: vehicle.name }));
    });
  },
};

/** Registry entries for module/chat/chat-listener.mjs (drawn by decorateDrivingCard). */
export const drivingActionEntries = Object.entries(handlers).map(([action, fn]) => ({
  action,
  custom: true,
  onClick: (event, message) => {
    event.preventDefault();
    return fn(message);
  },
}));
