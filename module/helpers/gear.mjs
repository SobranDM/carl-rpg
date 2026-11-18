/**
 * What a piece of gear is and where it's worn (docs/gear-slots.md; Gear
 * Slots, p.98-99) - the one place every other module asks:
 *  - `system.slots`: where it can be worn (CONFIG.CARLRPG.wearSlots: Head,
 *    Torso, Arms, Held, Gloves, Legs, Feet, Accessory) - several for the
 *    book's "Accessory or Head", all for "Any". A Weapon Skill always makes
 *    it Held as well. Empty: it can't be worn until one is set;
 *  - `system.twoHanded`: Held in both hands ("Limitation: Two-Handed");
 *  - `system.accessoryKind`: Belt or Cape (one of each at most, p.99);
 *  - a weapon by its Weapon Skill, a consumable by its kind - never worn.
 * The Equipment Doll's slots (CONFIG.CARLRPG.gearSlots) map onto these:
 * Main and Off Hand are Held. Any gear can be held in a hand (ruled
 * 2026-11-17, the one exception: you "hold things in your hands", p.98),
 * but only gear marked Held gives its bonuses there (givesBonuses).
 * Also the 0.7.0 migration's guesses (guessGearSlots) and the importers'
 * "Gear Slot:" line (parseGearSlotLine).
 */
import { slugifySkillName } from "./modifiers.mjs";
import { parseGearSlotLine, slotsFromName } from "./gear-text.mjs";

// The text readers live in gear-text.mjs (no Foundry globals, for the PDF
// parsers); re-exported here for everything else.
export { SLOT_NAME_TERMS, WEAR_SLOT_KEYS, parseGearSlotLine, slotsFromName } from "./gear-text.mjs";

/** A doll slot (CONFIG.CARLRPG.gearSlots key) -> where-worn key. */
export const WEAR_SLOT_OF_GEAR_SLOT = Object.freeze({
  mainHand: "held", offHand: "held", head: "head", torso: "torso", arms: "arms",
  gloves: "gloves", legs: "legs", feet: "feet",
});

/** The hands: a two-handed item fills both. */
export const HANDS = Object.freeze(["mainHand", "offHand"]);

const isGear = (item) => item?.type === "item";

/** A consumable (a Potion, a Scroll...): used, never worn. */
export function isConsumable(item) {
  return isGear(item) && !!item.system?.consumable?.kind;
}

/** A weapon: gear with a Weapon Skill. */
export function isWeapon(item) {
  return isGear(item) && !!String(item.system?.weaponSkill ?? "").trim();
}

/**
 * Where this gear can be worn: its slots, plus Held for a weapon. None for
 * a consumable or anything else not gear.
 * @param {Item} item
 * @returns {string[]}  CONFIG.CARLRPG.wearSlots keys.
 */
export function slotsOf(item) {
  if (!isGear(item) || isConsumable(item)) return [];
  const slots = new Set((item.system?.slots ?? []).filter(Boolean));
  if (isWeapon(item)) slots.add("held");
  return [...slots];
}

/** Can it be worn at all (it has a slot)? */
export function canWear(item) {
  return slotsOf(item).length > 0;
}

/** Held in both hands? */
export function isTwoHanded(item) {
  return !!item?.system?.twoHanded && slotsOf(item).includes("held");
}

/** "belt", "cape" or "" (an Accessory's kind, p.99). */
export function accessoryKindOf(item) {
  return slotsOf(item).includes("accessory") ? (item.system?.accessoryKind ?? "") : "";
}

/**
 * Does it fit this Equipment Doll slot?
 * @param {Item} item
 * @param {{slotType: "gear"|"accessory", slotKey: string}} slot
 * @returns {boolean}
 */
export function fitsSlot(item, { slotType, slotKey }) {
  if (!isGear(item)) return false;
  // Anything can be held (p.98) - it just gives nothing there unless Held.
  if (slotType === "gear" && HANDS.includes(slotKey)) return true;
  const slots = slotsOf(item);
  if (slotType === "accessory") return slots.includes("accessory");
  if (slotType === "gear") return slots.includes(WEAR_SLOT_OF_GEAR_SLOT[slotKey]);
  return false;
}

/**
 * Does this equipped gear give its bonuses (Bonuses, DR, On-hit Debuffs)?
 * Equipped, and not merely held: gear in a hand that isn't marked Held is
 * just being carried there (ruled 2026-11-17).
 * @param {Item} item
 * @returns {boolean}
 */
export function givesBonuses(item) {
  if (!isGear(item) || !item.system?.equipped) return false;
  const gearSlots = item.actor?.system?.gearSlots;
  if (!gearSlots) return true;
  const inHand = HANDS.some((hand) => gearSlots[hand] === item.id);
  return !inHand || slotsOf(item).includes("held");
}

/**
 * Is this equipped gear somewhere it may be (the 0.7.0 migration)? In a
 * hand (anything may be held), or it has a slot at all.
 * @param {Item} item
 * @returns {boolean}
 */
export function heldOrWearable(item) {
  const gearSlots = item?.actor?.system?.gearSlots;
  return canWear(item) || (!!gearSlots && HANDS.some((hand) => gearSlots[hand] === item.id));
}

/**
 * Is this gear item a weapon for this Skill (its Weapon Skill names it)?
 * @param {Item|null} item
 * @param {Item} skill
 * @returns {boolean}
 */
export function isWeaponFor(item, skill) {
  if (!isGear(item)) return false;
  // Blank means "not a weapon". Checked before slugifying, which turns a
  // blank name into "unknown" - the slug of any name with no Latin letters
  // or digits, too.
  const weaponSkill = String(item.system?.weaponSkill ?? "").trim();
  return !!weaponSkill && slugifySkillName(weaponSkill) === slugifySkillName(skill?.name ?? "");
}

/**
 * The slot type an equipped item's DR counts in (docs/gear-slots.md): DR
 * stacks across slot types, but within one only the best piece counts (a
 * second pair of gloves adds nothing, p.225). Both hands are one type
 * (Held). Accessories stack with each other (null: no group).
 *  - On a Character, the doll slot it's worn in;
 *  - equipped with no doll slot (a Pet, a Mob, the Equipped box), its
 *    first slot that isn't Accessory.
 * @param {Item} item
 * @param {object} [actorSystem]  The wearer's system data.
 * @returns {string|null}
 */
export function drGroupOf(item, actorSystem) {
  const gearSlots = actorSystem?.gearSlots;
  if (gearSlots) {
    const key = Object.keys(gearSlots).find((k) => gearSlots[k] === item.id);
    if (key) return WEAR_SLOT_OF_GEAR_SLOT[key] ?? key;
    if ((actorSystem.accessories ?? []).includes(item.id)) return null;
  }
  return slotsOf(item).find((s) => s !== "accessory") ?? null;
}

/**
 * The 0.7.0 migration's guess at where gear goes (docs/gear-slots.md Q5,
 * C), from the first of: a "Gear Slot:" line in its description (the
 * book's own word), its name, a Weapon Skill (Held), the doll slot it's
 * worn in. A "Two-Handed" limitation in the description makes it
 * two-handed. null when nothing tells.
 * @param {Item} item
 * @param {{wornIn?: string|null}} [options]  wornIn: a where-worn key it's worn in now.
 * @returns {{slots: string[], twoHanded: boolean, accessoryKind: string, from: string}|null}
 */
export function guessGearSlots(item, { wornIn = null } = {}) {
  if (!isGear(item) || isConsumable(item)) return null;
  const text = descriptionText(item.system?.description);
  const twoHandedText = /limitation:\s*two[- ]handed|requires two hands/i.test(text);
  const line = text.match(/Gear Slot:\s*([^\n.]*)/i)?.[1];
  const fromLine = line ? parseGearSlotLine(line) : null;
  const fromName = slotsFromName(item.name);
  const kind = fromName?.accessoryKind ?? "";
  if (fromLine) return { slots: fromLine.slots, twoHanded: fromLine.twoHanded || twoHandedText, accessoryKind: kind, from: "line" };
  if (fromName) return { slots: fromName.slots, twoHanded: twoHandedText, accessoryKind: kind, from: "name" };
  if (isWeapon(item)) return { slots: ["held"], twoHanded: twoHandedText, accessoryKind: "", from: "weapon" };
  if (wornIn) return { slots: [wornIn], twoHanded: twoHandedText && wornIn === "held", accessoryKind: "", from: "worn" };
  return null;
}

/** An HTML description as plain text, a line per block. */
function descriptionText(html) {
  return String(html ?? "")
    .replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
