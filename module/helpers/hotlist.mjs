/**
 * A crawler's Hotlist (p.98): ten slots of items, Spells or anything else
 * they want at the ready - the Combat tab's main panel (templates/actor/
 * parts/hotlist.hbs). Each slot stores an owned Item's id in
 * `system.hotlist` (older free text still shows; helpers/equip-slots.mjs).
 *  - "Spells need to be in your Hotlist to cast them in combat or other
 *    stressful situations" (p.204), "If a Spell ain't in your Hotlist, you
 *    can't cast it until you Retrieve it" (p.86); Cast a Spell is "a Spell
 *    or scroll in your Hotlist" (Table 3) - enforced in a running fight
 *    (spellOutsideHotlist).
 *  - "Use a Hotlist Item: Use a prepared consumable item or ready another
 *    Hotlist Item" - an Action; "A crawler can swap an item in their hands
 *    for the item in the Hotlist as part of the Use a Hotlist Item Action",
 *    free when a weapon is swapped as part of an Attack (useHotlistSlot).
 *  - "Retrieve: Move an item from a crawler's Inventory to their Hotlist" -
 *    an Action in a fight; pinning reminds, it doesn't stop you.
 *  - "Items in Hotlists do not grant you any added benefits" - nothing here
 *    equips anything except Ready, which puts the item in hand.
 */
import { isCrawler } from "./actor-kinds.mjs";
import { assignItemToSlot, resolveSlotValue } from "./equip-slots.mjs";
import { useConsumable } from "./consumables.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";

/** Slots in a Hotlist (p.98). */
export function hotlistSize() {
  return CONFIG.CARLRPG.characterListSlots.hotlist;
}

/**
 * The Hotlist as a full-length list of stored values ("" for empty).
 * @param {Actor} actor
 * @returns {string[]}
 */
function hotlistValues(actor) {
  const list = [...(actor.system.hotlist ?? [])];
  while (list.length < hotlistSize()) list.push("");
  return list;
}

/**
 * Is this Item in the actor's Hotlist?
 * @param {Actor} actor
 * @param {Item|string} item  An Item or its id.
 * @returns {boolean}
 */
export function isInHotlist(actor, item) {
  const id = typeof item === "string" ? item : item?.id;
  return !!id && (actor?.system?.hotlist ?? []).includes(id);
}

/**
 * Is this actor a combatant in a fight that has started?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function inRunningFight(actor) {
  if (!actor) return false;
  return game.combats.some((c) => c.started && c.combatants.some((cb) => cb.actor === actor));
}

/**
 * The item in this crawler's hands: what sits in the Main Hand or Off Hand
 * gear slot.
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {boolean}
 */
export function isInHand(actor, itemId) {
  const slots = actor.system.gearSlots ?? {};
  return !!itemId && (slots.mainHand === itemId || slots.offHand === itemId);
}

/**
 * The Hotlist panel's rows: each slot's item, what kind it is, and its one
 * action (Cast, Roll, Use or Ready).
 * @param {Actor} actor
 * @returns {object[]}
 */
export function hotlistRows(actor) {
  return hotlistValues(actor).map((value, index) => {
    const slot = { index, number: index + 1, ...resolveSlotValue(actor, value) };
    const item = slot.itemId ? actor.items.get(slot.itemId) : null;
    if (!item) return { ...slot, empty: !slot.name };
    const sys = item.system;
    const row = { ...slot, empty: false, type: item.type };
    if (item.type === "spell") {
      Object.assign(row, { kind: "spell", action: "Cast", rank: sys.rank, manaCost: sys.manaCost, active: !!sys.active });
    } else if (item.type === "skill" || item.type === "damageEffect") {
      Object.assign(row, { kind: "skill", action: "Roll", rank: sys.rank });
    } else if (item.type === "item" && sys.consumable?.kind) {
      Object.assign(row, { kind: "consumable", action: "Use", quantity: sys.quantity });
    } else if (item.type === "item") {
      const inHand = isInHand(actor, item.id);
      Object.assign(row, { kind: "gear", action: inHand ? null : "Ready", inHand });
    } else {
      Object.assign(row, { kind: "other", action: null });
    }
    return row;
  });
}

/**
 * Put an item in the first empty Hotlist slot, or take it out if it's
 * there. In a running fight, adding one is the Retrieve Action (reminded,
 * not enforced).
 * @param {Actor} actor
 * @param {Item} item
 * @returns {Promise<boolean>}  Whether the Hotlist changed.
 */
export async function toggleHotlist(actor, item) {
  if (!isCrawler(actor) || !item) return false;
  const list = hotlistValues(actor);
  const at = list.indexOf(item.id);
  if (at >= 0) {
    list[at] = "";
    await actor.update({ "system.hotlist": list });
    return true;
  }
  // A blank slot, or one whose item is gone, is free.
  const free = list.findIndex((value) => !resolveSlotValue(actor, value).name);
  if (free < 0) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Hotlist.Full"));
    return false;
  }
  list[free] = item.id;
  await actor.update({ "system.hotlist": list });
  if (inRunningFight(actor)) {
    ui.notifications.info(game.i18n.format("CARLRPG.Hotlist.RetrieveReminder", { name: item.name }));
  }
  return true;
}

/**
 * Must this Spell (or scroll) stay unused because it isn't in the
 * crawler's Hotlist during a fight? Only crawlers have a Hotlist.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {boolean}
 */
export function spellOutsideHotlist(actor, item) {
  if (!isCrawler(actor) || !item) return false;
  const castable = item.type === "spell" || (item.type === "item" && item.system.consumable?.kind === "scroll");
  return castable && inRunningFight(actor) && !isInHotlist(actor, item);
}

/**
 * Refuse a Spell or scroll cast from outside the Hotlist in a fight, with
 * the reason (p.86).
 * @param {Actor} actor
 * @param {Item} item
 * @returns {boolean}  true if refused.
 */
export function refuseSpellOutsideHotlist(actor, item) {
  if (!spellOutsideHotlist(actor, item)) return false;
  ui.notifications.warn(game.i18n.format("CARLRPG.Hotlist.NotInHotlist", { name: item.name }));
  return true;
}

/**
 * The Hotlist slot's button: Cast a Spell, Roll a Skill, Use a consumable,
 * or Ready a piece of gear - swap it into the Main Hand, and whatever was
 * there takes its Hotlist slot (p.98).
 * @param {Actor} actor
 * @param {number} index
 * @param {{skipDialog?: boolean}} [options]  For a consumable.
 * @returns {Promise<*>}
 */
export async function useHotlistSlot(actor, index, { skipDialog = false } = {}) {
  const id = hotlistValues(actor)[index];
  const item = id ? actor.items.get(id) : null;
  if (!item) return null;
  if (item.type === "item" && item.system.consumable?.kind) return useConsumable(actor, item, { skipDialog });
  if (item.type !== "item") return item.roll();
  return readyHotlistItem(actor, index, item);
}

/**
 * Ready a Hotlist item: into the Main Hand, swapping what was there into
 * its Hotlist slot.
 * @param {Actor} actor
 * @param {number} index
 * @param {Item} item
 * @returns {Promise<void>}
 */
async function readyHotlistItem(actor, index, item) {
  if (isInHand(actor, item.id)) return;
  const previousId = actor.system.gearSlots?.mainHand || "";
  const previous = previousId ? actor.items.get(previousId) : null;
  await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, item);
  const list = hotlistValues(actor);
  list[index] = previous ? previous.id : "";
  await actor.update({ "system.hotlist": list });
  const body = previous
    ? game.i18n.format("CARLRPG.Hotlist.ReadiedSwap", { name: actor.name, item: item.name, previous: previous.name })
    : game.i18n.format("CARLRPG.Hotlist.Readied", { name: actor.name, item: item.name });
  await createCardMessage({
    title: game.i18n.localize("CARLRPG.Hotlist.ReadyTitle"),
    img: item.img,
    body: `<p>${esc(body)}</p><p class="carl-hint">${esc(game.i18n.localize("CARLRPG.Hotlist.ReadyRule"))}</p>`,
    actor,
  });
}
