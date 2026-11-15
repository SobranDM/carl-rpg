/**
 * A crawler's players run its Pet and its Vehicle too: whoever owns the
 * crawler (OWNER level) is made an owner of them. Shared by Pet and Vehicle
 * creation (module/data/pet.mjs, vehicle.mjs), the Pet bond's sync
 * (module/helpers/pets.mjs) and the 0.6.0 Pet tab migration
 * (companion-migration.mjs). Ownership is only ever added, never lowered.
 */

/**
 * The users who own this actor at OWNER level - its players (and any GM
 * listed by name), never the "default" level.
 * @param {Actor|{ownership?: object}|null} actor
 * @returns {string[]}  User ids.
 */
export function ownerIds(actor) {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  return Object.entries(actor?.ownership ?? {})
    .filter(([id, level]) => id !== "default" && level >= OWNER)
    .map(([id]) => id);
}

/**
 * This ownership, with these users made owners.
 * @param {object|null|undefined} ownership  An ownership object (not changed).
 * @param {string[]} ids  User ids.
 * @returns {object}  A new ownership object.
 */
export function withOwners(ownership, ids) {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  return { ...(ownership ?? {}), ...Object.fromEntries(ids.map((id) => [id, OWNER])) };
}
