/**
 * What kind of creature an Actor is, for the rules that differ between them.
 * Most of the system used to ask "is this a Character?" and treat everything
 * else as a Mob; Pets (docs/companions-and-vehicles.md) sit in between - they
 * roll their own Attacks and Evades like a crawler (the owner rolls for them,
 * Pets p.231-232) but die outright at 0% HB like a Mob ("Pet-class Mobs and
 * Earth-born pets die instantly at 0% Health Bar", p.231). So the old single
 * question splits into these.
 *
 * Each takes an Actor, anything `{type}`-shaped (a rebuilt row, a chat flag)
 * or a bare type string.
 */

/** @param {Actor|{type?: string}|string|null|undefined} a */
const typeOf = (a) => (typeof a === "string" ? a : a?.type) ?? null;

/**
 * A real crawler: Dying, AI Favor, grinding, Race/Class, permanent potions.
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const isCrawler = (a) => typeOf(a) === "character";

/** @param {Actor|{type?: string}|string|null|undefined} a */
export const isPet = (a) => typeOf(a) === "pet";

/**
 * A Pet marked Minion (module/data/pet.mjs, p.233): no Command Check - it
 * counts as commanded in any fight, its two Actions its controller's to use
 * (actions.mjs petCommanded, pet-command.mjs). A dedicated mount isn't one.
 * @param {Actor|{type?: string, system?: object}|null|undefined} a
 */
export const isMinion = (a) =>
  isPet(a) && typeof a === "object" && !!a.system?.isMinion && !a.system?.isMount;

/**
 * Rolls its own d20 Attacks and Evades and acts in the Crawler phase:
 * crawlers and their Pets. Everything else rolls nothing - its to-hit and
 * Evade are static Difficulties (Mobs, p.267-272).
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const rollsLikeCrawler = (a) => ["character", "pet"].includes(typeOf(a));

/**
 * A Vehicle (p.72-73): an object - no Stats, Actions or Evade, never a
 * combatant (its occupants are), destroyed (exploding) at 0% HB.
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const isVehicle = (a) => typeOf(a) === "vehicle";

/**
 * Can carry Debuffs and Buffs (system.conditions). Vehicles can't: "Ships
 * are objects. They are Immune to ... all Debuffs that have biological
 * effects" (p.584), simplified to every Debuff.
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const takesConditions = (a) => !isVehicle(a) && typeOf(a) !== "lootBox";

/**
 * Dead at 0% HB, with no Dying countdown: everything but a crawler ("Mobs
 * die instantly at 0% HB", p.94; Pets p.231).
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const diesAtZeroHb = (a) => !isCrawler(a);
