/**
 * Vehicle actions (Vehicles, p.72-73; module/data/vehicle.mjs): boarding
 * and getting out, choosing the driver, parking, presets, and the GM relay
 * that lets a player do these on a vehicle they don't own.
 *  - Boarding a stationary vehicle uses 10 feet of Move. Boarding a moving
 *    one takes a Move Action and a DEX Stat Check vs 10 + Move ÷ 2; on a
 *    failure you don't get in. Getting out isn't covered by the book -
 *    treated like dismounting a mount, a Move Action (p.232).
 *  - Only one driver at a time; naming a new one moves the old to a seat.
 *  - Vehicle writes from someone who doesn't own it go to the active GM (the
 *    loot-box.mjs pattern), who re-checks them: only the paths players use
 *    in play, and only for actors the sender owns.
 */
import CarlDice from "../dice/dice.mjs";
import { isVehicle, rollsLikeCrawler } from "./actor-kinds.mjs";
import {
  invalidateSeatIndex, occupantKey, resolveOccupant, vehicleSeatOf, vehicleStatus,
} from "./vehicle-state.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { isHitDegree } from "./rules.mjs";
import { noteUndo, takeAction } from "./actions.mjs";

const SOCKET = "system.carl-rpg";
const FLAG_SCOPE = "carl-rpg";

/**
 * Redraw the Driving Check cards on screen (the chat log, its pop-out, a
 * notification) - for one vehicle, or every vehicle. Only cards already
 * drawn: core's updateMessage would insert one that isn't, out of order.
 * @param {string} [vehicleUuid]
 */
function redrawDrivingCards(vehicleUuid) {
  if (!ui.chat) return;
  const ids = new Set([...document.querySelectorAll("[data-message-id]")].map((li) => li.dataset.messageId));
  for (const id of ids) {
    const message = game.messages.get(id);
    const driving = message?.flags?.[FLAG_SCOPE]?.driving;
    if (driving && (!vehicleUuid || driving.vehicleUuid === vehicleUuid)) ui.chat.updateMessage(message);
  }
}
const UPDATE_ACTION = "vehicleUpdate";

/** System paths a player may change on a vehicle they don't own (via the GM). */
const RELAYED_PATHS = [
  "system.occupants",
  "system.round",
  "system.parked",
  "system.nextCheckAdvantage",
  "system.upgrades.nitrous",
  "system.upgrades.shockAbsorbers.usedFloor",
  "system.upgrades.fuzzyDice.usedFloor",
];

/**
 * Update a vehicle: directly if this user owns it, otherwise through the
 * active GM. A change the GM would refuse (relayAllowed) is refused here, so
 * callers only report what actually happens.
 * @param {Actor} vehicle
 * @param {object} changes  An update object (flat or nested).
 * @returns {Promise<boolean>}  Whether the change was made or sent to the GM.
 */
export async function updateVehicle(vehicle, changes) {
  if (vehicle.isOwner) {
    await vehicle.update(changes);
    return true;
  }
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Vehicle.NeedsGM"));
    return false;
  }
  if (!relayAllowed(vehicle, changes, game.user)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Vehicle.NotYourVehicle"));
    return false;
  }
  game.socket.emit(SOCKET, { action: UPDATE_ACTION, vehicleUuid: vehicle.uuid, changes });
  return true;
}

/**
 * Whether a relayed change is one the sender may make: only whitelisted
 * paths, and occupant changes only for actors the sender owns (a demoted
 * driver aside), with the sender owning someone aboard for everything else.
 * @param {Actor} vehicle
 * @param {object} changes
 * @param {User} user
 * @returns {boolean}
 */
export function relayAllowed(vehicle, changes, user) {
  const flat = foundry.utils.flattenObject(changes);
  const paths = Object.keys(flat);
  if (!paths.length || !paths.every((p) => RELAYED_PATHS.some((allowed) => p === allowed || p.startsWith(`${allowed}.`)))) {
    return false;
  }
  if (!upgradeUseAllowed(vehicle, flat)) return false;
  const owns = (uuid) => resolveOccupant(uuid)?.testUserPermission(user, "OWNER") ?? false;
  const before = vehicle.system.occupants;
  // Read the list itself (whether or not flattening went into the array).
  const after = changes["system.occupants"] ?? foundry.utils.getProperty(changes, "system.occupants");
  if (after) {
    const roleOf = (list, uuid) => list.find((o) => o.uuid === uuid)?.role ?? null;
    const uuids = new Set([...before.map((o) => o.uuid), ...after.map((o) => o.uuid)]);
    for (const uuid of uuids) {
      const was = roleOf(before, uuid);
      const now = roleOf(after, uuid);
      if (was === now) continue;
      // Someone else's driver demoted to a seat by the sender's new driver.
      if (was === "driver" && now === "passenger") continue;
      if (!owns(uuid)) return false;
    }
    if (paths.every((p) => p.startsWith("system.occupants"))) return true;
  }
  return before.some((o) => owns(o.uuid)) || (after ?? []).some((o) => owns(o.uuid));
}

/**
 * Upgrade changes a player may make: fire a fitted Nitrous (installed off,
 * running for its 3 rounds, no longer), or mark a once-per-Floor upgrade
 * used on this Floor - never re-arm or refill one.
 * @param {Actor} vehicle
 * @param {Object<string, *>} flat  Flattened changes.
 * @returns {boolean}
 */
function upgradeUseAllowed(vehicle, flat) {
  const nitrousInstalled = flat["system.upgrades.nitrous.installed"];
  const nitrousEnds = flat["system.upgrades.nitrous.endsAt"];
  if (nitrousInstalled !== undefined || nitrousEnds !== undefined) {
    const seconds = CONFIG.CARLRPG.nitrousRounds * (CONFIG.time.roundTime || 10);
    if (!vehicle.system.upgrades.nitrous.installed || nitrousInstalled !== false) return false;
    if (!(typeof nitrousEnds === "number" && nitrousEnds <= game.time.worldTime + seconds + 1)) return false;
  }
  const floor = game.settings.get("carl-rpg", "currentFloor");
  for (const key of ["shockAbsorbers", "fuzzyDice"]) {
    const used = flat[`system.upgrades.${key}.usedFloor`];
    if (used !== undefined && used !== floor) return false;
  }
  return true;
}

/** Register once, from the `ready` hook. */
export function registerVehicleSocket() {
  game.socket.on(SOCKET, async (payload, senderId) => {
    if (payload?.action !== UPDATE_ACTION) return;
    if (!game.users.activeGM?.isSelf) return;
    const user = game.users.get(senderId);
    const vehicle = await fromUuid(payload.vehicleUuid);
    if (!user || !isVehicle(vehicle) || !payload.changes) return;
    if (!relayAllowed(vehicle, payload.changes, user)) return;
    await vehicle.update(payload.changes);
  });
}

/**
 * Re-render every open Vehicle sheet when something its Move depends on
 * changes: the combat round, a fight starting or ending, the clock
 * (Nitrous), or a driver's Skills.
 */
export function registerVehicleHooks() {
  /** Open Vehicle sheets. */
  const openSheets = () => [...foundry.applications.instances.values()]
    .filter((app) => app.rendered && isVehicle(app.document));
  const rerender = foundry.utils.debounce(() => {
    // Only what shows Move - a full render would drop typing on Details.
    for (const app of openSheets()) app.render({ parts: ["header", "abilities"] });
  }, 50);
  // A change to an actor (or its Skills) only matters if it's aboard an open one.
  const aboardOpenVehicle = (actor) => !!actor && !isVehicle(actor)
    && openSheets().some((app) => app.document.system.occupants.some((o) => o.uuid === actor.uuid));
  for (const hook of ["updateCombat", "deleteCombat", "createCombatant", "deleteCombatant", "updateWorldTime"]) {
    Hooks.on(hook, rerender);
  }
  for (const hook of ["updateItem", "createItem", "deleteItem"]) {
    Hooks.on(hook, (item) => {
      if (aboardOpenVehicle(item.parent)) rerender();
    });
  }
  Hooks.on("updateActor", (actor) => {
    if (aboardOpenVehicle(actor)) rerender();
  });

  // A Driving Check card's round buttons show only while the vehicle's
  // round is that card's (vehicle-driving.mjs drivingCardCurrent). Redraw
  // the cards when that can change: the vehicle's round (a player's Check
  // reaches the vehicle through the GM after its card is posted, and a
  // later Check takes the buttons off the older card), or the fight's round
  // moving on, starting or ending.
  Hooks.on("updateActor", (actor, changes) => {
    if (!isVehicle(actor) || !foundry.utils.hasProperty(changes, "system.round")) return;
    redrawDrivingCards(actor.uuid);
  });
  Hooks.on("updateCombat", (combat, changes) => {
    if ("round" in changes || "started" in changes) redrawDrivingCards();
  });
  for (const hook of ["createCombat", "deleteCombat"]) Hooks.on(hook, () => redrawDrivingCards());

  // vehicleSeatOf's index: who sits where changes with a vehicle (its
  // occupants, or it coming or going), a token (an unlinked vehicle's), the
  // fights in progress or the viewed scene (vehiclesInPlay).
  for (const hook of ["createActor", "updateActor", "deleteActor"]) {
    Hooks.on(hook, (actor) => {
      if (isVehicle(actor)) invalidateSeatIndex();
    });
  }
  for (const hook of ["createToken", "updateToken", "deleteToken", "deleteScene", "canvasReady",
    "createCombat", "updateCombat", "deleteCombat"]) {
    Hooks.on(hook, invalidateSeatIndex);
  }
}

/**
 * Board a vehicle (p.72). Refused when full or already aboard; a creature
 * that rolls (a crawler or Pet) boarding a moving vehicle makes the DEX
 * Check, and stays out on a failure. Leaving another vehicle first.
 * @param {Actor} vehicle
 * @param {Actor} actor
 * @param {{role?: "driver"|"passenger", skipDialog?: boolean}} [options]
 * @returns {Promise<boolean>}  Whether the actor got in.
 */
export async function boardVehicle(vehicle, actor, { role = "passenger", skipDialog = false } = {}) {
  if (!isVehicle(vehicle) || !actor || isVehicle(actor)) return false;
  const loc = (key, data = {}) => game.i18n.format(`CARLRPG.Vehicle.${key}`, { name: actor.name, vehicle: vehicle.name, ...data });
  const key = occupantKey(actor);
  if (vehicle.system.occupants.some((o) => o.uuid === key)) {
    ui.notifications.info(loc("AlreadyAboard"));
    return false;
  }
  const status = vehicleStatus(vehicle);
  if (status.occupantCount >= status.capacity) {
    ui.notifications.warn(loc("Full", { capacity: status.capacity }));
    return false;
  }

  if (vehicle.system.parked || status.currentMove <= 0 || !rollsLikeCrawler(actor)) {
    return takeSeat(vehicle, actor, role, loc("BoardStationary"));
  }
  // Boarding a moving vehicle is a Move Action (helpers/actions.mjs), spent
  // on the attempt; the DEX Check is part of it.
  const label = game.i18n.format("CARLRPG.Actions.Label.Board", { vehicle: vehicle.name });
  const boarded = await takeAction(actor, "move", label, async (ctx) => {
    const result = await CarlDice.rollStatCheck(actor, "dex", {
      difficulty: status.boardDifficulty, skipDialog, returnResult: true, title: loc("BoardCheckTitle"), within: ctx,
    });
    if (!result) return false;
    ctx.use();
    if (!isHitDegree(result.degree)) {
      ui.notifications.info(loc("BoardFailed"));
      return false;
    }
    return takeSeat(vehicle, actor, role, loc("BoardMoving", { dc: status.boardDifficulty }));
  });
  return !!boarded;
}

/**
 * Seat a boarding actor (boardVehicle), leaving any other vehicle first,
 * and post the card.
 * @returns {Promise<boolean>}
 */
async function takeSeat(vehicle, actor, role, note) {
  const key = occupantKey(actor);
  const other = vehicleSeatOf(actor);
  if (other && other.vehicle !== vehicle) await exitVehicle(other.vehicle, actor, { silent: true });

  const occupants = vehicle.system.toObject().occupants
    .map((o) => (role === "driver" && o.role === "driver" ? { ...o, role: "passenger" } : o));
  occupants.push({ uuid: key, role, name: actor.name });
  // Undone: this one out again - anyone else's seat is their own business.
  noteUndo(actor, { t: "seat", uuid: vehicle.uuid, key, entry: null });
  if (!await updateVehicle(vehicle, { "system.occupants": occupants })) return false;
  await createCardMessage({ title: vehicle.name, img: vehicle.img, body: `<p>${esc(note)}</p>`, actor });
  return true;
}

/**
 * Get out of a vehicle - a Move Action, like dismounting (p.232).
 * @param {Actor} vehicle
 * @param {Actor|string} actorOrUuid
 * @param {{silent?: boolean}} [options]
 * @returns {Promise<boolean>}  Whether they got out.
 */
export async function exitVehicle(vehicle, actorOrUuid, { silent = false } = {}) {
  const key = typeof actorOrUuid === "string" ? actorOrUuid : occupantKey(actorOrUuid);
  const leaving = vehicle.system.occupants.find((o) => o.uuid === key);
  if (!leaving) return false;
  // A Move Action in a fight (helpers/actions.mjs) - not when it's part of
  // boarding another vehicle (silent), which already paid.
  const actor = resolveOccupant(key);
  const leave = async () => {
    // Undone: back in their seat (helpers/action-undo.mjs).
    const seat = vehicle.system.toObject().occupants.find((o) => o.uuid === key);
    noteUndo(actor, { t: "seat", uuid: vehicle.uuid, key, entry: seat ?? null });
    const occupants = vehicle.system.toObject().occupants.filter((o) => o.uuid !== key);
    if (!await updateVehicle(vehicle, { "system.occupants": occupants })) return false;
    if (silent) return true;
    const body = game.i18n.format("CARLRPG.Vehicle.Exited", { name: actor?.name ?? leaving.name, vehicle: vehicle.name });
    await createCardMessage({ title: vehicle.name, img: vehicle.img, body: `<p>${esc(body)}</p>`, actor: actor ?? undefined });
    return true;
  };
  if (silent || !actor) return leave();
  return !!(await takeAction(actor, "move", game.i18n.format("CARLRPG.Actions.Label.Exit", { vehicle: vehicle.name }), leave));
}

/**
 * Make one occupant the driver; whoever drove before takes a seat.
 * @param {Actor} vehicle
 * @param {string} uuid
 * @returns {Promise<void>}
 */
export async function setDriver(vehicle, uuid) {
  const occupants = vehicle.system.toObject().occupants.map((o) => ({
    ...o, role: o.uuid === uuid ? "driver" : "passenger",
  }));
  await updateVehicle(vehicle, { "system.occupants": occupants });
}

/**
 * Park the vehicle, or set off. A parked vehicle has Move 0 (attacks
 * against it are at Difficulty 10) and boarding it costs only 10 feet.
 * Either way the last Driving Check's result (a stall, a ram's Move loss)
 * is over - outside a fight nothing else ends it.
 * @param {Actor} vehicle
 * @returns {Promise<boolean>}
 */
export async function toggleParked(vehicle) {
  return updateVehicle(vehicle, {
    "system.parked": !vehicle.system.parked,
    "system.round": { combatId: "", checkId: "", round: null, degree: "", critChoice: "", ramFactor: 1 },
  });
}

/**
 * Fire the Nitrous Oxide: "Double Move for 3 rounds" (p.73) - on the clock,
 * which combat rounds advance 10 seconds each. One charge: it's used up
 * until the GM ticks it as installed again.
 * @param {Actor} vehicle
 * @returns {Promise<void>}
 */
export async function activateNitrous(vehicle) {
  const nitrous = vehicle.system.upgrades.nitrous;
  if (!nitrous.installed) return;
  const seconds = CONFIG.CARLRPG.nitrousRounds * (CONFIG.time.roundTime || 10);
  const fired = await updateVehicle(vehicle, {
    "system.upgrades.nitrous": { installed: false, endsAt: game.time.worldTime + seconds },
  });
  if (!fired) return;
  const body = game.i18n.format("CARLRPG.Vehicle.NitrousFired", { vehicle: vehicle.name, rounds: CONFIG.CARLRPG.nitrousRounds });
  await createCardMessage({ title: vehicle.name, img: vehicle.img, body: `<p>${esc(body)}</p>` });
}

/**
 * Fill in a vehicle's stats from Table 7.
 * @param {Actor} vehicle
 * @param {string} key  A CONFIG.CARLRPG.vehiclePresets key.
 * @returns {Promise<void>}
 */
export async function applyVehiclePreset(vehicle, key) {
  const preset = CONFIG.CARLRPG.vehiclePresets[key];
  if (!preset) return;
  await vehicle.update({
    "system.model": game.i18n.localize(preset.label),
    "system.move": preset.move,
    "system.size": preset.size,
    "system.dr": preset.dr,
    "system.occupancy": preset.occupancy,
    "system.cargo": preset.cargo,
    "system.driveSkill": preset.driveSkill,
  });
}
