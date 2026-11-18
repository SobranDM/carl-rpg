/**
 * A Pet's link to its crawler, and what follows from it (Pets, p.228-232;
 * docs/companions-and-vehicles.md):
 *  - "As a member of the party, pets level up when the crawlers do ... they
 *    level up twice as fast as crawlers do until they reach level 15,
 *    gaining 2 levels at a time. Once at level 15, they level up at the same
 *    rate as crawlers" (p.231). Mounts never level (p.232).
 *  - Pets start with Slice Attack, and Aggressive Pets "Gain the Back Claw
 *    and Bite Skills (Rank = Floor)" (p.231) - granted from the compendium.
 *  - The Command Pet status icons on the token (module/helpers/pet-command.mjs).
 */
import { isCrawler, isPet } from "./actor-kinds.mjs";
import { findOwnedSkillLike, learnSkillLike } from "./race-class-grants.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { ownerIds, withOwners } from "./ownership.mjs";

/**
 * The crawler a Pet is bonded to, if it still exists.
 * @param {Actor} pet
 * @returns {Actor|null}
 */
export function petOwner(pet) {
  const id = pet?.system?.ownerId;
  return id ? (game.actors.get(id) ?? null) : null;
}

/**
 * Every Pet (and mount) bonded to this crawler.
 * @param {Actor} owner
 * @returns {Actor[]}
 */
export function bondedPets(owner) {
  if (!owner) return [];
  return game.actors.filter((a) => isPet(a) && a.system.ownerId === owner.id);
}

/**
 * A Pet's Level after its crawler gains `crawlerLevels` Levels: +2 per
 * crawler Level until 15 (never past it on the way), then +1.
 * @param {number} level  The Pet's current Level.
 * @param {number} crawlerLevels
 * @returns {number}
 */
export function petLevelAfter(level, crawlerLevels) {
  const cap = CONFIG.CARLRPG.petLevelStepCap;
  let next = level;
  for (let i = 0; i < crawlerLevels; i++) next = next < cap ? Math.min(next + 2, cap) : next + 1;
  return Math.min(next, 250);
}

/**
 * Level up every non-mount Pet bonded to this crawler after it gained
 * `delta` Levels. Each Pet's own _preUpdate then banks its 3 Stat Points per
 * Level (documents/actor.mjs). Run by the active GM, who can edit every Pet.
 * @param {Actor} owner
 * @param {number} delta
 * @returns {Promise<void>}
 */
export async function levelBondedPets(owner, delta) {
  if (!isCrawler(owner) || !(delta > 0)) return;
  for (const pet of bondedPets(owner)) {
    if (pet.system.isMount) continue;
    const level = pet.system.attributes.level.value;
    await pet.update({ "system.attributes.level.value": petLevelAfter(level, delta) });
  }
}

/**
 * The Skills a Pet should own from its rules: Slice Attack always, its
 * Role's Skills, and Taunt or Catcher if that Special Ability is chosen.
 * Missing ones are learned from the compendium (learnSkillLike - Rank is
 * irrelevant, a Pet's Ranks are the Floor). Nothing is ever removed: a
 * changed Role leaves the old Skills for the GM to delete.
 * @param {Actor} pet
 * @returns {Promise<void>}
 */
export async function grantPetSkills(pet) {
  if (!isPet(pet)) return;
  const sys = pet.system;
  const names = [...CONFIG.CARLRPG.petStartingSkills, ...(CONFIG.CARLRPG.petRoleSkills[sys.role] ?? [])];
  if (sys.specialAbilities.tauntOrCatcher === "taunt") names.push("Taunt");
  if (sys.specialAbilities.tauntOrCatcher === "catcher") names.push("Catcher");
  // Queued per Pet, so two quick updates can't both learn the same Skill.
  await queueForActor(pet.uuid, async () => {
    for (const name of names) {
      if (!findOwnedSkillLike(pet, name)) await learnSkillLike(pet, name, 0);
    }
  });
}

/**
 * Whoever plays the Pet's crawler (its OWNER-level users) can run the Pet
 * too - roll its Attacks and Evades, and Command it. Only adds ownership,
 * never removes any. Active GM only.
 * @param {Actor} pet
 * @returns {Promise<void>}
 */
export async function syncPetOwnership(pet) {
  const owner = petOwner(pet);
  if (!owner) return;
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const missing = ownerIds(owner).filter((id) => (pet.ownership?.[id] ?? 0) < OWNER);
  if (!missing.length) return;
  await pet.update({ ownership: withOwners(pet.ownership, missing) });
}

/**
 * Show a Pet's Command Pet result as one token status icon (and so in the
 * combat tracker), turning the others off. The schema field stays the
 * source of truth; a result from a combat that no longer exists shows none.
 * @param {Actor} pet
 * @returns {Promise<void>}
 */
export async function syncPetCommandStatus(pet) {
  if (!isPet(pet)) return;
  const { state, combatId } = pet.system.command;
  const active = state && game.combats.has(combatId) ? state : "";
  for (const [key, def] of Object.entries(CONFIG.CARLRPG.petCommandStates)) {
    const on = key === active;
    if (pet.statuses?.has(def.status) !== on) await pet.toggleStatusEffect(def.status, { active: on });
  }
}
