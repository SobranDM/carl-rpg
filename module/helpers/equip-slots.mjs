/**
 * Inventory tab's Hotlist and Equipped slots (items-list.hbs). Each slot
 * stores an owned Item's id in a Character's `system.hotlist`,
 * `system.gearSlots.<key>` or `system.accessories`. Older free-text values
 * (typed on the old Hotlist tab, or a CrawlerForge import's item names) are
 * still shown as plain text until something is dropped over them.
 *
 * "Worn" means sitting in a gear slot or an accessory slot: a worn item is
 * marked equipped, and unticking its Equipped box takes it back out.
 *
 * Worn gear and the Hotlist are exclusive - "Items in Hotlists do not grant
 * you any added benefits" (p.98) - so wearing a Hotlist item takes it out of
 * the Hotlist (hotlistWithout).
 */

import { refuseWhileSwapping } from "./swap-lock.mjs";
import { noteGear, takeAction } from "./actions.mjs";

/** A stored value that looks like a Foundry document id, not free text. */
const ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/**
 * Resolve one stored slot value for display.
 * @param {Actor} actor
 * @param {string} value  An owned Item id, or legacy free text.
 * @returns {{itemId: string, name: string, img: string|null}}
 */
export function resolveSlotValue(actor, value) {
  const item = value ? actor.items.get(value) : null;
  if (item) return { itemId: item.id, name: item.name, img: item.img };
  // A dangling id (the item was deleted) reads as an empty slot.
  const text = value && !ID_PATTERN.test(value) ? value : "";
  return { itemId: "", name: text, img: null };
}

/**
 * Whether an owned Item currently sits in a gear or accessory slot.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {boolean}
 */
export function isItemWorn(actor, itemId) {
  const { gearSlots, accessories } = actor.system;
  return Object.values(gearSlots ?? {}).includes(itemId) || (accessories ?? []).includes(itemId);
}

/**
 * The Hotlist with this item taken out, or null if it isn't there.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {string[]|null}
 */
export function hotlistWithout(actor, itemId) {
  const list = actor.system.hotlist ?? [];
  if (!itemId || !list.includes(itemId)) return null;
  return list.map((id) => (id === itemId ? "" : id));
}

/**
 * Put an owned Item into a gear or accessory slot (the Hotlist has its own
 * rules: hotlist.mjs's placeInHotlist). It's marked equipped, move it out of any other worn slot
 * (an item is only worn once) and out of the Hotlist, and unequip whatever
 * it replaced.
 * @param {Actor} actor
 * @param {{slotType: "gear"|"accessory", slotKey: string}} slot
 *   `slotKey` is the gear slot key, or the list index for an accessory
 *   (an index past the end appends).
 * @param {Item} item  Must already be embedded on `actor`.
 * @param {{duringSwap?: boolean}} [options]  duringSwap: a Hotlist swap's
 *   own write (hotlist.mjs), allowed through the swap lock and part of the
 *   swap's Action. Otherwise, in a fight, it's the Retrieve Action (retrieve).
 * @returns {Promise<void>}
 */
export async function assignItemToSlot(actor, slot, item, { duringSwap = false } = {}) {
  if (!duringSwap && refuseWhileSwapping(actor)) return;
  // Only gear is worn - a Skill or Spell has no Equipped state to set.
  if (item.type !== "item") {
    ui.notifications?.warn(game.i18n.localize("CARLRPG.Actor.SlotGearOnly"));
    return;
  }
  const write = () => writeSlot(actor, slot, item, duringSwap);
  await (duringSwap ? write() : retrieve(actor, item, write));
}

/**
 * Putting gear on or taking it off: in a fight that's the Retrieve Action
 * (p.86; helpers/actions.mjs) - refused with none left, and spent only if
 * the item's worn state actually changed. Everything it moves (the item it
 * replaces, the Hotlist) is part of the one Action.
 * @param {Actor} actor
 * @param {Item} item
 * @param {() => Promise<*>} change
 * @returns {Promise<void>}
 */
async function retrieve(actor, item, change) {
  await takeAction(actor, "other", game.i18n.format("CARLRPG.Actions.Label.Retrieve", { item: item.name }), async (ctx) => {
    const before = wornState(actor, item.id);
    noteGear(actor);
    await change();
    if (wornState(actor, item.id) !== before) ctx.use();
    else ctx.free();
  });
}

/**
 * Where an item is worn, as one comparable string: equipped or not, the gear
 * slots holding it, and whether it's an Accessory.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {string}
 */
export function wornState(actor, itemId) {
  const item = actor.items.get(itemId);
  const slots = Object.entries(actor.system.gearSlots ?? {}).filter(([, id]) => id === itemId).map(([key]) => key);
  const accessory = (actor.system.accessories ?? []).includes(itemId);
  return `${!!item?.system.equipped}|${slots.sort().join(",")}|${accessory}`;
}

/** assignItemToSlot's writes. */
async function writeSlot(actor, { slotType, slotKey }, item, duringSwap) {
  noteGear(actor);
  const system = actor.system;
  const gearSlots = Object.fromEntries(
    Object.entries(system.gearSlots).map(([key, id]) => [key, id === item.id ? "" : id]),
  );
  const wornAccessories = system.accessories.filter((id) => resolveSlotValue(actor, id).name).length;
  let accessories = [...system.accessories];
  let displaced;
  let target = -1;
  if (slotType === "gear") {
    if (!(slotKey in gearSlots)) return;
    displaced = gearSlots[slotKey];
    gearSlots[slotKey] = item.id;
  } else if (slotType === "accessory") {
    target = Math.min(Number(slotKey), accessories.length);
    displaced = accessories[target];
    accessories[target] = item.id;
  } else return;
  // Also drops blank and deleted-item entries, so they never use up the 10.
  accessories = accessories.filter(
    (id, i) => (id !== item.id || i === target) && resolveSlotValue(actor, id).name,
  );
  // The cap only refuses a drop that adds an accessory past it - a list
  // already over (old data) must not block gear-slot drops or swaps.
  const max = CONFIG.CARLRPG.characterListSlots.accessories;
  if (accessories.length > max && accessories.length > wornAccessories) {
    ui.notifications?.warn(game.i18n.format("CARLRPG.Actor.AccessoriesFull", { max }));
    return;
  }

  const hotlist = hotlistWithout(actor, item.id);
  await actor.update({
    "system.gearSlots": gearSlots,
    "system.accessories": accessories,
    ...(hotlist ? { "system.hotlist": hotlist } : {}),
  });

  const updates = [];
  if (!item.system.equipped) updates.push({ _id: item.id, "system.equipped": true });
  const old = displaced && displaced !== item.id ? actor.items.get(displaced) : null;
  if (old?.system.equipped && !isItemWorn(actor, old.id)) {
    updates.push({ _id: old.id, "system.equipped": false });
  }
  // Paid for by this Retrieve, or the swap's Action (CarlRPGItem#_preUpdate).
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { carlSwap: duringSwap, carlInAction: true });
}

/**
 * Take an owned Item out of every gear and accessory slot and unequip it.
 * @param {Actor} actor
 * @param {Item} item
 * @param {{duringSwap?: boolean}} [options]  As assignItemToSlot.
 * @returns {Promise<void>}
 */
export async function unwearItem(actor, item, { duringSwap = false } = {}) {
  if (!duringSwap && refuseWhileSwapping(actor)) return;
  const write = async () => {
    noteGear(actor);
    const gearSlots = Object.fromEntries(
      Object.entries(actor.system.gearSlots).map(([key, id]) => [key, id === item.id ? "" : id]),
    );
    const accessories = actor.system.accessories.filter((id) => id !== item.id);
    await actor.update({ "system.gearSlots": gearSlots, "system.accessories": accessories });
    if (item.system.equipped) await item.update({ "system.equipped": false }, { carlSwap: duringSwap, carlInAction: true });
  };
  await (duringSwap ? write() : retrieve(actor, item, write));
}

/**
 * Empty one slot (its (x) button). A gear/accessory slot's item is
 * unequipped too, unless it's still worn somewhere else.
 * @param {Actor} actor
 * @param {{slotType: "hotlist"|"gear"|"accessory", slotKey: string}} slot
 * Taking something out of the Hotlist is free; out of a worn slot it's the
 * Retrieve Action in a fight (retrieve).
 * @returns {Promise<void>}
 */
export async function clearSlot(actor, { slotType, slotKey }) {
  if (refuseWhileSwapping(actor)) return;
  const system = actor.system;
  if (slotType === "hotlist") {
    const hotlist = padList(system.hotlist, CONFIG.CARLRPG.characterListSlots.hotlist);
    hotlist[Number(slotKey)] = "";
    await actor.update({ "system.hotlist": hotlist });
    return;
  }
  if (!["gear", "accessory"].includes(slotType)) return;
  const removed = slotType === "gear" ? system.gearSlots[slotKey] : system.accessories[Number(slotKey)];
  const item = removed ? actor.items.get(removed) : null;
  const write = async () => {
    noteGear(actor);
    if (slotType === "gear") {
      await actor.update({ [`system.gearSlots.${slotKey}`]: "" });
    } else {
      const index = Number(slotKey);
      await actor.update({ "system.accessories": actor.system.accessories.filter((_, i) => i !== index) });
    }
    if (item?.system.equipped && !isItemWorn(actor, item.id)) await item.update({ "system.equipped": false }, { carlInAction: true });
  };
  // A slot holding a typed name (no item) costs nothing to clear.
  await (item ? retrieve(actor, item, write) : write());
}

/** Copy a string list, padded with "" out to at least `length` entries. */
export function padList(list, length) {
  const copy = [...(list ?? [])];
  while (copy.length < length) copy.push("");
  return copy;
}
