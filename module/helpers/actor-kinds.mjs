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
 * Rolls its own d20 Attacks and Evades and acts in the Crawler phase:
 * crawlers and their Pets. Everything else rolls nothing - its to-hit and
 * Evade are static Difficulties (Mobs, p.267-272).
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const rollsLikeCrawler = (a) => ["character", "pet"].includes(typeOf(a));

/**
 * Dead at 0% HB, with no Dying countdown: everything but a crawler ("Mobs
 * die instantly at 0% HB", p.94; Pets p.231).
 * @param {Actor|{type?: string}|string|null|undefined} a
 */
export const diesAtZeroHb = (a) => !isCrawler(a);
