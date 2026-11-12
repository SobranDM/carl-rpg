/**
 * Inventory tab's Hotlist and Equipped slots (items-list.hbs). Each slot
 * stores an owned Item's id in a Character's `system.hotlist`,
 * `system.gearSlots.<key>` or `system.accessories`. Older free-text values
 * (typed on the old Hotlist tab, or a CrawlerForge import's item names) are
 * still shown as plain text until something is dropped over them.
 *
 * "Worn" means sitting in a gear slot or an accessory slot: a worn item is
 * marked equipped, and unticking its Equipped box takes it back out.
 */

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
 * Put an owned Item into a Hotlist, gear or accessory slot. Gear and
 * accessory slots also mark it equipped, move it out of any other worn slot
 * (an item is only worn once), and unequip whatever it replaced.
 * @param {Actor} actor
 * @param {{slotType: "hotlist"|"gear"|"accessory", slotKey: string}} slot
 *   `slotKey` is the gear slot key, or the list index for hotlist/accessory
 *   (an index past the end of accessories appends).
 * @param {Item} item  Must already be embedded on `actor`.
 * @returns {Promise<void>}
 */
export async function assignItemToSlot(actor, { slotType, slotKey }, item) {
  const system = actor.system;

  if (slotType === "hotlist") {
    const hotlist = padList(system.hotlist, CONFIG.CARLRPG.characterListSlots.hotlist);
    hotlist[Number(slotKey)] = item.id;
    await actor.update({ "system.hotlist": hotlist });
    return;
  }

  // Only gear is worn - a Skill or Spell has no Equipped state to set.
  if (item.type !== "item") {
    ui.notifications?.warn(game.i18n.localize("CARLRPG.Actor.SlotGearOnly"));
    return;
  }

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
  if (accessories.length > max && accessories.length > wornAccessories) return;

  await actor.update({ "system.gearSlots": gearSlots, "system.accessories": accessories });

  const updates = [];
  if (!item.system.equipped) updates.push({ _id: item.id, "system.equipped": true });
  const old = displaced && displaced !== item.id ? actor.items.get(displaced) : null;
  if (old?.system.equipped && !isItemWorn(actor, old.id)) {
    updates.push({ _id: old.id, "system.equipped": false });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/**
 * Take an owned Item out of every gear and accessory slot and unequip it.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {Promise<void>}
 */
export async function unwearItem(actor, item) {
  const gearSlots = Object.fromEntries(
    Object.entries(actor.system.gearSlots).map(([key, id]) => [key, id === item.id ? "" : id]),
  );
  const accessories = actor.system.accessories.filter((id) => id !== item.id);
  await actor.update({ "system.gearSlots": gearSlots, "system.accessories": accessories });
  if (item.system.equipped) await item.update({ "system.equipped": false });
}

/**
 * Empty one slot (its (x) button). A gear/accessory slot's item is
 * unequipped too, unless it's still worn somewhere else.
 * @param {Actor} actor
 * @param {{slotType: "hotlist"|"gear"|"accessory", slotKey: string}} slot
 * @returns {Promise<void>}
 */
export async function clearSlot(actor, { slotType, slotKey }) {
  const system = actor.system;
  let removed;
  if (slotType === "hotlist") {
    const hotlist = padList(system.hotlist, CONFIG.CARLRPG.characterListSlots.hotlist);
    hotlist[Number(slotKey)] = "";
    await actor.update({ "system.hotlist": hotlist });
    return;
  } else if (slotType === "gear") {
    removed = system.gearSlots[slotKey];
    await actor.update({ [`system.gearSlots.${slotKey}`]: "" });
  } else if (slotType === "accessory") {
    const index = Number(slotKey);
    removed = system.accessories[index];
    await actor.update({ "system.accessories": system.accessories.filter((_, i) => i !== index) });
  } else return;

  const item = removed ? actor.items.get(removed) : null;
  if (item?.system.equipped && !isItemWorn(actor, item.id)) {
    await item.update({ "system.equipped": false });
  }
}

/** Copy a string list, padded with "" out to at least `length` entries. */
function padList(list, length) {
  const copy = [...(list ?? [])];
  while (copy.length < length) copy.push("");
  return copy;
}
