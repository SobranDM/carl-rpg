/**
 * A crawler's Hotlist (p.98): ten slots of items, Spells or anything else
 * they want at the ready - the Combat tab's main panel (templates/actor/
 * parts/hotlist.hbs). Each slot stores an owned Item's id in
 * `system.hotlist` (older free text still shows; helpers/equip-slots.mjs).
 *
 * Filling a slot: click an empty one and pick (promptHotlistPick), or the
 * star on an Inventory/Spell row (toggleHotlist). What can go in
 * (canHotlist): a Spell the crawler has Ranks in, a consumable with some
 * left, or gear that isn't worn - "Items in Hotlists do not grant you any
 * added benefits", so worn gear and the Hotlist are exclusive (wearing a
 * Hotlist item takes it out: equip-slots.mjs's assignItemToSlot).
 *  - "Retrieve: Pull an item from your Inventory to your hand or the floor,
 *    or add it to your Hotlist. You cannot use that item during your current
 *    Action" (p.86) - in a fight, filling a slot posts a Retrieve card
 *    (Actions aren't counted). Outside a fight it's "at the speed of
 *    thought".
 *
 * Using a slot: click it (useHotlistSlot).
 *  - A Spell casts. "Spells need to be in your Hotlist to cast them in
 *    combat or other stressful situations" (p.204) - in a running fight, a
 *    Spell or consumable from outside the Hotlist is refused
 *    (refuseOutsideHotlist).
 *  - A consumable is used, after a confirmation (consumables.mjs).
 *  - Gear swaps into the Main Hand; what was there takes its slot. In a fight
 *    that's the Use a Hotlist Item Action, or free "as part of the Attack
 *    Action" when swapping weapons (p.98) - the crawler picks which.
 */
import { isCrawler } from "./actor-kinds.mjs";
import { assignItemToSlot, hotlistWithout, isItemWorn, padList, resolveSlotValue, unwearItem } from "./equip-slots.mjs";
import { useConsumable } from "./consumables.mjs";
import { ownedRank } from "./modifiers.mjs";
import { withoutOutclassedUnarmed } from "./hand-to-hand.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { cancelButton, showCarlDialog } from "../apps/carl-dialog.mjs";
import { beginSwap, endSwap, refuseWhileSwapping } from "./swap-lock.mjs";

export { refuseWhileSwapping };

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
  return padList(actor.system.hotlist, hotlistSize());
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

/** Worn: in a gear or accessory slot, or equipped with no slot. */
function isWorn(actor, item) {
  return !!item.system.equipped || isItemWorn(actor, item.id);
}


/**
 * Why this item can't go in the Hotlist (a lang key), or null if it can.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {string|null}
 */
function hotlistRefusal(actor, item) {
  if (!isCrawler(actor) || item?.parent !== actor) return "CARLRPG.Hotlist.Refuse.Other";
  if (item.type === "spell") return ownedRank(actor, item) >= 1 ? null : "CARLRPG.Hotlist.Refuse.Untrained";
  if (item.type !== "item") return "CARLRPG.Hotlist.Refuse.Other";
  // Worn and in the Hotlist are exclusive - consumables too (p.98).
  if (isWorn(actor, item)) return "CARLRPG.Hotlist.Refuse.Worn";
  if (item.system.consumable?.kind) return (item.system.quantity ?? 1) >= 1 ? null : "CARLRPG.Hotlist.Refuse.NoneLeft";
  return null;
}

/**
 * Can this item go in the Hotlist? A Spell with Ranks, a consumable with
 * some left, or gear that isn't worn.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {boolean}
 */
export function canHotlist(actor, item) {
  return !hotlistRefusal(actor, item);
}

/**
 * The picker's choices: everything that can go in the Hotlist and isn't
 * there yet, grouped and sorted by name.
 * @param {Actor} actor
 * @returns {{key: string, label: string, entries: {id: string, name: string, img: string, detail: string}[]}[]}
 */
export function hotlistCandidates(actor) {
  const groups = { spells: [], consumables: [], gear: [] };
  for (const item of actor.items) {
    if (isInHotlist(actor, item) || !canHotlist(actor, item)) continue;
    const entry = { id: item.id, name: item.name, img: item.img, detail: "" };
    if (item.type === "spell") {
      entry.detail = game.i18n.format("CARLRPG.Hotlist.SpellDetail", { rank: ownedRank(actor, item), mana: item.system.manaCost ?? 0 });
      groups.spells.push(entry);
    } else if (item.system.consumable?.kind) {
      entry.detail = `×${item.system.quantity ?? 1}`;
      groups.consumables.push(entry);
    } else {
      groups.gear.push(entry);
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang, { sensitivity: "base" });
  return Object.entries(groups)
    .filter(([, entries]) => entries.length)
    .map(([key, entries]) => ({ key, label: game.i18n.localize(`CARLRPG.Hotlist.Pick.Group.${key}`), entries: entries.sort(byName) }));
}

/**
 * The Hotlist panel's rows: each slot's item, what kind it is, and what a
 * click does (Cast, Roll, Use or Ready).
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
      Object.assign(row, { kind: "spell", action: "Cast", rank: ownedRank(actor, item), manaCost: sys.manaCost, active: !!sys.active });
    } else if (item.type === "skill" || item.type === "damageEffect") {
      // Older data only: Skills can't be put in the Hotlist any more
      // (hotlistRefusal), but one already there still rolls.
      Object.assign(row, { kind: "skill", action: "Roll", rank: sys.rank });
    } else if (item.type === "item" && sys.consumable?.kind) {
      Object.assign(row, { kind: "consumable", action: "Use", quantity: sys.quantity });
    } else if (item.type === "item") {
      // Worn and in the Hotlist only happens with older data: nothing to do.
      const inHand = isInHand(actor, item.id);
      const worn = !inHand && isWorn(actor, item);
      Object.assign(row, { kind: "gear", action: inHand || worn ? null : "Ready", inHand, worn });
    } else {
      Object.assign(row, { kind: "other", action: null });
    }
    return row;
  });
}

/**
 * Put an item in a Hotlist slot - the picker and the star. It leaves any
 * other slot it was in. In a fight, that's the Retrieve Action: a card says
 * so.
 * @param {Actor} actor
 * @param {number} index
 * @param {Item} item
 * @param {{expectEmpty?: boolean}} [options]  expectEmpty: refuse if the
 *   slot has filled since it was chosen (the picker waits on a dialog).
 * @returns {Promise<boolean>}  Whether it went in.
 */
export async function placeInHotlist(actor, index, item, { expectEmpty = false } = {}) {
  if (refuseWhileSwapping(actor)) return false;
  const refusal = hotlistRefusal(actor, item);
  if (refusal) {
    ui.notifications.warn(game.i18n.format(refusal, { name: item?.name ?? "?" }));
    return false;
  }
  if (expectEmpty && resolveSlotValue(actor, hotlistValues(actor)[index]).name) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Hotlist.SlotTaken", { number: index + 1 }));
    return false;
  }
  const list = padList(hotlistWithout(actor, item.id) ?? actor.system.hotlist, hotlistSize());
  list[index] = item.id;
  await actor.update({ "system.hotlist": list });
  if (inRunningFight(actor)) await postRetrieveCard(actor, item);
  return true;
}

/**
 * The star: put an item in the first empty Hotlist slot, or take it out if
 * it's there.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {Promise<boolean>}  Whether the Hotlist changed.
 */
export async function toggleHotlist(actor, item) {
  if (!isCrawler(actor) || !item || refuseWhileSwapping(actor)) return false;
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
  return placeInHotlist(actor, free, item);
}

/**
 * Click an empty slot: pick something to put in it. A click on an entry
 * picks it at once; the radios also work from the keyboard with Add.
 * @param {Actor} actor
 * @param {number} index
 * @returns {Promise<boolean>}  Whether the slot was filled.
 */
export async function promptHotlistPick(actor, index) {
  const groups = hotlistCandidates(actor);
  if (!groups.length) {
    ui.notifications.info(game.i18n.localize("CARLRPG.Hotlist.Pick.NothingToAdd"));
    return false;
  }
  const picked = await showCarlDialog({
    title: game.i18n.format("CARLRPG.Hotlist.Pick.Title", { number: index + 1 }),
    template: "systems/carl-rpg/templates/dialog/hotlist-pick.hbs",
    context: { groups },
    classes: ["carl-hotlist-pick-dialog"],
    // A fixed width, so filtering doesn't resize the window to each new
    // longest name (long names are cut off with an ellipsis instead).
    position: { width: 480 },
    buttons: [
      {
        action: "add",
        icon: "fa-solid fa-plus",
        label: "CARLRPG.Hotlist.Pick.Add",
        default: true,
        // The checked one - with a lone entry, form.elements.pick is that
        // input itself, whose value is set whether or not it's checked.
        callback: (event, button) => button.form.querySelector('input[name="pick"]:checked')?.value || null,
      },
      cancelButton(),
    ],
    onRender: (event, dialog) => wirePicker(dialog.element ?? dialog),
  });
  const item = picked ? actor.items.get(picked) : null;
  if (!item) return false;
  return placeInHotlist(actor, index, item, { expectEmpty: true });
}

/**
 * The picker's wiring: the filter hides entries that don't match; a mouse
 * click on an entry picks it (keyboard arrows only move the selection -
 * their synthesized clicks have no `detail`).
 * @param {HTMLElement} root
 */
function wirePicker(root) {
  if (!(root instanceof HTMLElement)) return;
  const filter = root.querySelector("[data-carl-pick-filter]");
  // Enter in the filter would submit the dialog with nothing picked.
  filter?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  filter?.addEventListener("input", () => {
    const text = filter.value.trim().toLowerCase();
    for (const entry of root.querySelectorAll(".carl-hotlist-pick-entry")) {
      entry.hidden = !!text && !entry.dataset.name.toLowerCase().includes(text);
      // Add must not take something the filter has hidden.
      const radio = entry.querySelector('input[name="pick"]');
      if (entry.hidden && radio) radio.checked = false;
    }
    for (const group of root.querySelectorAll(".carl-hotlist-pick-group")) {
      group.hidden = ![...group.querySelectorAll(".carl-hotlist-pick-entry")].some((e) => !e.hidden);
    }
  });
  // A label click also forwards a click to its radio: pick only once.
  let picked = false;
  for (const entry of root.querySelectorAll(".carl-hotlist-pick-entry")) {
    entry.addEventListener("click", (event) => {
      if (event.detail < 1 || picked) return;
      const radio = entry.querySelector('input[name="pick"]');
      if (!radio) return;
      picked = true;
      radio.checked = true;
      root.querySelector('button[data-action="add"]')?.click();
    });
  }
}

/** In a fight, adding to the Hotlist is the Retrieve Action (p.86). */
async function postRetrieveCard(actor, item) {
  await createCardMessage({
    title: game.i18n.localize("CARLRPG.Hotlist.Retrieve.Title"),
    img: item.img,
    body: `<p>${esc(game.i18n.format("CARLRPG.Hotlist.Retrieve.Body", { name: actor.name, item: item.name }))}</p>`
      + `<p class="carl-hint">${esc(game.i18n.localize("CARLRPG.Hotlist.Retrieve.Rule"))}</p>`,
    actor,
  });
}

/**
 * Must this Spell or consumable stay unused because it isn't in the
 * crawler's Hotlist during a fight? Spells: p.86/p.204; consumables: Use a
 * Hotlist Item, or Retrieve it first (p.86). Only crawlers have a Hotlist.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {boolean}
 */
export function outsideHotlist(actor, item) {
  if (!isCrawler(actor) || !item) return false;
  const needsHotlist = item.type === "spell" || (item.type === "item" && !!item.system.consumable?.kind);
  return needsHotlist && inRunningFight(actor) && !isInHotlist(actor, item);
}

/**
 * Refuse a Spell or consumable used from outside the Hotlist in a fight,
 * with the reason (p.86).
 * @param {Actor} actor
 * @param {Item} item
 * @returns {boolean}  true if refused.
 */
export function refuseOutsideHotlist(actor, item) {
  if (!outsideHotlist(actor, item)) return false;
  ui.notifications.warn(game.i18n.format("CARLRPG.Hotlist.NotInHotlist", { name: item.name }));
  return true;
}

/**
 * Click a Hotlist slot: Cast a Spell, Roll a Skill, Use a consumable, or
 * Ready a piece of gear (into the Main Hand; what was there takes the slot).
 * @param {Actor} actor
 * @param {number} index
 * @param {{skipDialog?: boolean}} [options]  No confirmation for a
 *   consumable, and a plain swap (the Action) for gear in a fight.
 * @returns {Promise<*>}
 */
export async function useHotlistSlot(actor, index, { skipDialog = false } = {}) {
  const id = hotlistValues(actor)[index];
  const item = id ? actor.items.get(id) : null;
  if (!item) return null;
  if (refuseWhileSwapping(actor)) return null;
  if (item.type === "item" && item.system.consumable?.kind) return useConsumable(actor, item, { skipDialog });
  if (item.type !== "item") return item.roll();
  if (isWorn(actor, item)) return null;

  // Nothing else may move this crawler's things until the swap is done
  // (swap-lock.mjs) - a Swap and Attack holds it through its Attack dialog.
  beginSwap(actor);
  try {
    // Out of a fight, a swap is "at the speed of thought": no card.
    if (!inRunningFight(actor)) {
      const { failed } = await readyHotlistItem(actor, index, item);
      return !failed;
    }
    return await combatSwap(actor, index, item, { skipDialog });
  } finally {
    endSwap(actor);
  }
}

/**
 * Gear clicked in a fight: the Use a Hotlist Item Action, or free as part
 * of an Attack (p.98). The Attack swaps first, so the new weapon's worn
 * bonuses apply; a cancelled Attack swaps back.
 * @returns {Promise<*>}
 */
async function combatSwap(actor, index, item, { skipDialog }) {
  const choice = skipDialog ? "swap" : await promptCombatSwap(actor, index, item);
  if (!choice) return null;
  const swap = await readyHotlistItem(actor, index, item);
  if (swap.failed) return null;
  if (choice === "swap") {
    await postReadyCard(actor, item, swap, { free: false });
    return true;
  }
  const skill = actor.items.get(choice);
  let result = null;
  try {
    result = skill ? await skill.roll() : null;
  } catch (err) {
    await undoOrRecord(actor, index, item, swap);
    throw err;
  }
  if (!result) {
    await undoOrRecord(actor, index, item, swap);
    return null;
  }
  await postReadyCard(actor, item, swap, { free: true });
  return result;
}

/**
 * Ask how a fight's swap happens: "Swap" (an Action), or one "Swap and
 * Attack" per Attack Skill (free).
 * @returns {Promise<string|null>}  "swap", an Attack Skill's id, or null.
 */
async function promptCombatSwap(actor, index, item) {
  const previousId = actor.system.gearSlots?.mainHand || "";
  const previous = previousId ? actor.items.get(previousId) : null;
  // The same Attacks the Combat tab lists (an outranked Unarmed Combat isn't).
  const attacks = withoutOutclassedUnarmed(actor, actor.items
    .filter((i) => i.type === "skill" && i.system.category === "attack")
    .sort((a, b) => a.name.localeCompare(b.name)));
  const body = previous
    ? game.i18n.format("CARLRPG.Hotlist.Swap.BodySwap", { item: item.name, previous: previous.name })
    : game.i18n.format("CARLRPG.Hotlist.Swap.Body", { item: item.name });
  return showCarlDialog({
    title: game.i18n.format("CARLRPG.Hotlist.Swap.Title", { item: item.name }),
    content: `<div class="carl-dialog-body"><p>${esc(body)}</p><p class="carl-dialog-hint">${esc(game.i18n.localize("CARLRPG.Hotlist.Swap.Rule"))}</p></div>`,
    classes: ["carl-hotlist-swap-dialog"],
    buttons: [
      { action: "swap", icon: "fa-solid fa-right-left", label: "CARLRPG.Hotlist.Swap.Action", default: true, callback: () => "swap" },
      ...attacks.map((skill) => ({
        action: `attack-${skill.id}`,
        icon: "fa-solid fa-hand-fist",
        label: game.i18n.format("CARLRPG.Hotlist.Swap.AttackWith", { skill: esc(skill.name) }),
        callback: () => skill.id,
      })),
      cancelButton(),
    ],
  });
}

/**
 * Swap a Hotlist item into the Main Hand; whatever was there takes its slot
 * - unless it's still worn somewhere else (older data with one item in both
 * hands), when the slot is left empty: worn gear can't be in the Hotlist.
 * Silent - the caller posts the card (postReadyCard) if one is due.
 * @param {Actor} actor
 * @param {number} index
 * @param {Item} item
 * @returns {Promise<{previous: Item|null, stowed: boolean, failed: boolean}>}
 *   previous: what was in the Main Hand; stowed: it took the slot; failed:
 *   the item didn't reach the Main Hand (nothing else was changed).
 */
async function readyHotlistItem(actor, index, item) {
  const previousId = actor.system.gearSlots?.mainHand || "";
  const previous = previousId && previousId !== item.id ? actor.items.get(previousId) ?? null : null;
  // Wearing it takes it out of the Hotlist (equip-slots.mjs); the slot then
  // takes the previous item - written directly, as a swap isn't a Retrieve.
  await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, item, { duringSwap: true });
  if (actor.system.gearSlots?.mainHand !== item.id) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Hotlist.Swap.Failed", { item: item.name }));
    return { previous, stowed: false, failed: true };
  }
  const now = previous ? actor.items.get(previous.id) : null;
  const stowed = !!now && !isWorn(actor, now);
  const list = hotlistValues(actor);
  list[index] = stowed ? now.id : "";
  await actor.update({ "system.hotlist": list });
  return { previous, stowed, failed: false };
}

/**
 * Put things back after a cancelled (or failed) Swap and Attack - only if
 * nothing else has moved them since: the previous item back in the Main
 * Hand, the clicked one back in its slot. If that can't be done, the swap
 * stands as the Use a Hotlist Item Action, and its card says so.
 * @param {Actor} actor
 * @param {number} index
 * @param {Item} item
 * @param {{previous: Item|null, stowed: boolean}} swap  readyHotlistItem's result.
 */
async function undoOrRecord(actor, index, item, swap) {
  const { previous, stowed } = swap;
  const unchanged = actor.system.gearSlots?.mainHand === item.id
    && hotlistValues(actor)[index] === (stowed ? previous.id : "");
  const record = async () => {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Hotlist.Swap.UndoSkipped"));
    await postReadyCard(actor, item, swap, { free: false });
  };
  if (!unchanged) return record();
  const back = previous ? actor.items.get(previous.id) : null;
  if (back && !stowed) {
    // It never left another slot (older data, in both hands): only the Main
    // Hand goes back to it - assignItemToSlot would take it out of the other.
    await actor.update({ "system.gearSlots.mainHand": back.id });
    if (!isItemWorn(actor, item.id) && item.system.equipped) {
      await item.update({ "system.equipped": false }, { carlSwap: true });
    }
  } else if (back) {
    // Back into the Main Hand: it leaves the slot, and the clicked item is
    // taken off.
    await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, back, { duringSwap: true });
    if (actor.system.gearSlots?.mainHand !== back.id) return record();
  } else {
    await unwearItem(actor, item, { duringSwap: true });
  }
  const list = hotlistValues(actor);
  list[index] = item.id;
  await actor.update({ "system.hotlist": list });
}

/**
 * The card for a swap in a fight: an Action, or free with the Attack.
 * @param {Actor} actor
 * @param {Item} item
 * @param {{previous: Item|null, stowed: boolean}} swap
 * @param {{free: boolean}} options
 */
async function postReadyCard(actor, item, { previous, stowed }, { free }) {
  // Only name what was swapped out if it went to the Hotlist.
  if (!stowed) previous = null;
  const body = previous
    ? game.i18n.format("CARLRPG.Hotlist.ReadiedSwap", { name: actor.name, item: item.name, previous: previous.name })
    : game.i18n.format("CARLRPG.Hotlist.Readied", { name: actor.name, item: item.name });
  const rule = game.i18n.localize(free ? "CARLRPG.Hotlist.ReadyFreeRule" : "CARLRPG.Hotlist.ReadyRule");
  await createCardMessage({
    title: game.i18n.localize("CARLRPG.Hotlist.ReadyTitle"),
    img: item.img,
    body: `<p>${esc(body)}</p><p class="carl-hint">${esc(rule)}</p>`,
    actor,
  });
}
