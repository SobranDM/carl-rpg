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
import { HANDS, WEAR_SLOT_OF_GEAR_SLOT, accessoryKindOf, canWear, fitsSlot, isConsumable, isTwoHanded, slotsOf } from "./gear.mjs";

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
  const refusal = slotRefusal(actor, slot, item);
  if (refusal) {
    ui.notifications?.warn(refusal);
    return;
  }
  const write = () => writeSlot(actor, slot, item, duringSwap);
  await (duringSwap ? write() : retrieve(actor, item, write));
}

/**
 * The first free doll slot this item is worn in, in its "Worn on" order
 * (CONFIG.CARLRPG.wearSlots) - for the Equipped box on a Character
 * (CarlRPGItem#_preUpdate; docs/gear-slots.md B). A two-handed item needs
 * both hands free. Held counts only if it's marked Held (a held item gives
 * nothing otherwise, and a hand holds anything by the doll).
 * @param {Actor} actor
 * @param {Item|object} item  The item, or a probe with its next `system`.
 * @returns {{slotType: "gear"|"accessory", slotKey: string}|null}
 */
export function freeSlotFor(actor, item) {
  const gearSlots = actor.system.gearSlots ?? {};
  // Empty, or holding only a deleted item's id (the doll shows it empty).
  const free = (key) => !slotHolds(actor, gearSlots[key]);
  const worn = new Set(slotsOf(item));
  for (const wear of Object.keys(CONFIG.CARLRPG.wearSlots).filter((key) => worn.has(key))) {
    if (wear === "accessory") {
      const raw = actor.system.accessories ?? [];
      if (raw.filter((id) => slotHolds(actor, id)).length >= CONFIG.CARLRPG.characterListSlots.accessories) continue;
      // Appended: the index past the stored list, as writeSlot reads it.
      const slot = { slotType: "accessory", slotKey: String(raw.length) };
      if (!slotRefusal(actor, slot, item)) return slot;
      continue;
    }
    if (wear === "held" && isTwoHanded(item)) {
      if (HANDS.every(free)) return { slotType: "gear", slotKey: HANDS[0] };
      continue;
    }
    const keys = Object.keys(WEAR_SLOT_OF_GEAR_SLOT).filter((key) => WEAR_SLOT_OF_GEAR_SLOT[key] === wear && key in gearSlots);
    for (const key of keys) if (free(key)) return { slotType: "gear", slotKey: key };
  }
  return null;
}

/**
 * Whether a stored slot value is a real item (or legacy free text) - not
 * empty, and not a deleted item's id.
 * @param {Actor} actor
 * @param {string} value
 * @returns {boolean}
 */
export function slotHolds(actor, value) {
  return !!value && !!resolveSlotValue(actor, value).name;
}

/**
 * Put an item in a free doll slot without touching its Equipped state -
 * the Equipped box's own update sets that (CarlRPGItem#_preUpdate). Also
 * takes it out of any other slot. A two-handed item in a hand fills both.
 * @param {Actor} actor
 * @param {{slotType: string, slotKey: string}} slot  From freeSlotFor.
 * @param {Item|object} item
 * @returns {Promise<void>}
 */
export async function placeInFreeSlot(actor, { slotType, slotKey }, item) {
  const gearSlots = Object.fromEntries(
    Object.entries(actor.system.gearSlots ?? {}).map(([key, id]) => [key, id === item.id ? "" : id]),
  );
  let accessories = (actor.system.accessories ?? []).filter((id) => id !== item.id && resolveSlotValue(actor, id).name);
  if (slotType === "gear") {
    for (const key of HANDS.includes(slotKey) && isTwoHanded(item) ? HANDS : [slotKey]) gearSlots[key] = item.id;
  } else accessories = [...accessories, item.id];
  await actor.update({ "system.gearSlots": gearSlots, "system.accessories": accessories });
}

/**
 * Take an item out of every doll slot without touching its Equipped state
 * (the Equipped box unticked).
 * @param {Actor} actor
 * @param {Item} item
 * @returns {Promise<void>}
 */
export async function takeOutOfSlots(actor, item) {
  if (!isItemWorn(actor, item.id)) return;
  const gearSlots = Object.fromEntries(
    Object.entries(actor.system.gearSlots ?? {}).map(([key, id]) => [key, id === item.id ? "" : id]),
  );
  await actor.update({
    "system.gearSlots": gearSlots,
    "system.accessories": (actor.system.accessories ?? []).filter((id) => id !== item.id),
  });
}

/**
 * Why this item can't go in this doll slot, or null if it can
 * (docs/gear-slots.md; p.98-99): it has no slot set, it isn't worn there,
 * or it's a second Belt or Cape (one of each, p.99 - the one it would
 * replace in that slot doesn't count).
 * @param {Actor} actor
 * @param {{slotType: string, slotKey: string}} slot
 * @param {Item} item
 * @returns {string|null}  The warning.
 */
export function slotRefusal(actor, { slotType, slotKey }, item) {
  const i18n = game.i18n;
  // A consumable is never worn, not even in a hand (docs/gear-slots.md).
  if (isConsumable(item)) return i18n.format("CARLRPG.Gear.ConsumableNotWorn", { item: item.name });
  // Anything else can be held in a hand (fitsSlot).
  if (!canWear(item) && !fitsSlot(item, { slotType, slotKey })) return i18n.format("CARLRPG.Gear.NoSlot", { item: item.name });
  if (!fitsSlot(item, { slotType, slotKey })) {
    const where = slotsOf(item).map((s) => i18n.localize(CONFIG.CARLRPG.wearSlots[s] ?? s)).join(", ");
    return i18n.format("CARLRPG.Gear.WrongSlot", { item: item.name, slots: where });
  }
  const kind = slotType === "accessory" ? accessoryKindOf(item) : "";
  if (kind) {
    // The same index writeSlot writes to, in the stored list.
    const list = actor.system.accessories ?? [];
    const target = Math.min(Number(slotKey), list.length);
    const other = list
      .map((id, i) => (i === target || id === item.id ? null : actor.items.get(id)))
      .find((worn) => worn && accessoryKindOf(worn) === kind);
    if (other) {
      return i18n.format("CARLRPG.Gear.OneKind", {
        kind: i18n.localize(CONFIG.CARLRPG.accessoryKinds[kind]), item: other.name,
      });
    }
  }
  return null;
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
  const displaced = [];
  let target = -1;
  if (slotType === "gear") {
    if (!(slotKey in gearSlots)) return;
    if (HANDS.includes(slotKey)) {
      // A two-handed item held now comes off when a hand is used (p.98)...
      for (const hand of HANDS) {
        const held = actor.items.get(gearSlots[hand]);
        if (held && isTwoHanded(held)) {
          displaced.push(held.id);
          gearSlots[hand] = "";
        }
      }
      // ...and a two-handed one fills both.
      const hands = isTwoHanded(item) ? HANDS : [slotKey];
      for (const hand of hands) {
        if (gearSlots[hand]) displaced.push(gearSlots[hand]);
        gearSlots[hand] = item.id;
      }
    } else {
      displaced.push(gearSlots[slotKey]);
      gearSlots[slotKey] = item.id;
    }
  } else if (slotType === "accessory") {
    target = Math.min(Number(slotKey), accessories.length);
    displaced.push(accessories[target]);
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
  for (const id of new Set(displaced)) {
    const old = id && id !== item.id ? actor.items.get(id) : null;
    if (old?.system.equipped && !isItemWorn(actor, old.id)) {
      updates.push({ _id: old.id, "system.equipped": false });
    }
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
      // A two-handed item leaves both hands (each hand holding it).
      const keys = HANDS.includes(slotKey) && item && isTwoHanded(item)
        ? HANDS.filter((hand) => actor.system.gearSlots[hand] === item.id) : [slotKey];
      await actor.update(Object.fromEntries(keys.map((key) => [`system.gearSlots.${key}`, ""])));
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
