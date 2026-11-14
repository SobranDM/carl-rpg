/**
 * Command Pet - "Guiding a pet in combat" (p.232):
 *   "You can persuade your pet to experience the joy of combat by making an
 *   INT-Opposed Animal Handling Skill Check as an Action."
 *  - Success: "the pet fights alongside you for the entire combat. The pet
 *    gets two Actions just like crawlers, but may only use them to Evade,
 *    Move, or Attack. Also, a pet only attacks once per round." (restricted)
 *  - Amazing Success or better: "the pet gets its two Actions to use as it,
 *    or you, please." (free)
 *  - Standard Fail: "the animal stays out of the fight, but you may try
 *    again with future Actions." (stayingOut) A Near Miss counts as one.
 *  - Major Fail or worse: "it runs out of sight and hides, and you must find
 *    it after the fight and coax it out." (hiding)
 * The Difficulty is the Pet's INT: "a base 10, +1 for their INT Mod, and +
 * Floor" (p.230).
 *
 * The result is stored on the Pet (system.command, with the combat it was
 * rolled in), shown on its sheet and as a token status icon (module/helpers/
 * pets.mjs syncPetCommandStatus), and cleared when that combat ends
 * (resetPetCommands). The code has no Action economy, so "restricted" is
 * shown, not enforced.
 */
import CarlDice from "../dice/dice.mjs";
import { CARLRPG } from "./config.mjs";
import { degreeBadge } from "./rules.mjs";
import { isPet } from "./actor-kinds.mjs";
import { petOwner } from "./pets.mjs";
import { cleanSkillLikeCopy, findOwnedSkillLike, findSkillLikeItem } from "./race-class-grants.mjs";
import { createCardMessage, createRollMessage, esc } from "../chat/chat-card.mjs";

/** Results that settle the Pet for the rest of the fight - only "staying out" can be retried. */
const SETTLED_STATES = ["free", "restricted", "hiding"];

/**
 * The started fight a Pet is in: one with the Pet or its crawler among the
 * combatants (a Pet that stays out may never join the tracker). Not
 * game.combat - that's whichever fight this user's tracker shows.
 * @param {Actor} pet
 * @returns {Combat|null}
 */
export function petFight(pet) {
  const owner = petOwner(pet);
  const involved = (c) => c.combatants.some((cb) => cb.actor === pet || (owner && cb.actor === owner));
  return game.combats.find((c) => c.started && involved(c)) ?? null;
}

/**
 * The command state a Degree of Success gives.
 * @param {string} degree  A CARLRPG.degreesOfSuccess key.
 * @returns {"free"|"restricted"|"stayingOut"|"hiding"}
 */
export function commandStateForDegree(degree) {
  if (degree === "criticalHit" || degree === "amazingSuccess") return "free";
  if (degree === "standardSuccess") return "restricted";
  if (degree === "nearMissFail" || degree === "standardFail") return "stayingOut";
  return "hiding";
}

/**
 * The Command Pet Difficulty: 10 + the Pet's INT Mod + Floor.
 * @param {Actor} pet
 * @returns {number}
 */
export function commandDifficulty(pet) {
  return 10 + (pet.system.stats.int?.mod ?? 0) + game.settings.get("carl-rpg", "currentFloor");
}

/**
 * Whether this user may roll Command Pet for this Pet: the GM, or someone
 * who owns both the Pet and its crawler (the roll is the crawler's). A
 * dedicated mount is ridden, not commanded (p.232).
 * @param {Actor} pet
 * @param {User} [user]
 * @returns {boolean}
 */
export function canCommandPet(pet, user = game.user) {
  if (!isPet(pet) || pet.system.isMount) return false;
  const owner = petOwner(pet);
  if (!owner) return false;
  return user.isGM || (pet.testUserPermission(user, "OWNER") && owner.testUserPermission(user, "OWNER"));
}

/**
 * The Pet's current command result, for its sheet. A result from a combat
 * that no longer exists is shown as none.
 * @param {Actor} pet
 * @returns {{state: string, active: boolean, selected: string, label: string, rule: string,
 *   stateChoices: Object<string, string>, canCommand: boolean}}
 */
export function describePetCommand(pet) {
  const { state, combatId } = pet.system.command;
  const active = !!state && game.combats.has(combatId);
  const def = CARLRPG.petCommandStates[state];
  return {
    state,
    active,
    selected: active ? state : "",
    label: active && def ? game.i18n.localize(def.label) : "",
    rule: active ? game.i18n.localize(`CARLRPG.Pet.Command.Rules.${state}`) : "",
    stateChoices: Object.fromEntries(Object.entries(CARLRPG.petCommandStates).map(([key, d]) => [key, d.label])),
    canCommand: canCommandPet(pet),
  };
}

/**
 * The crawler's Animal Handling Skill, or - untrained - an unsaved Rank 0
 * copy from the compendium, which rolls with Disadvantage and is never
 * marked for Advancement (nothing on the crawler to mark).
 * @param {Actor} owner
 * @returns {Promise<{skill: Item, trained: boolean}>}
 */
async function animalHandlingFor(owner) {
  const owned = findOwnedSkillLike(owner, "Animal Handling", ["skill"]);
  if (owned) return { skill: owned, trained: true };
  const source = await findSkillLikeItem("Animal Handling");
  const data = cleanSkillLikeCopy(
    source ?? { name: "Animal Handling", type: "skill", img: "icons/svg/pawprint.svg", system: { governingStat: "cha", category: "utility" } },
    0,
  );
  data._id = foundry.utils.randomID();
  return { skill: new CONFIG.Item.documentClass(data, { parent: owner }), trained: false };
}

/**
 * Roll Command Pet for a Pet in the running combat: its crawler's Animal
 * Handling against the Pet's INT, posted as one card and stored on the Pet.
 * @param {Actor} pet
 * @param {{skipDialog?: boolean}} [options]
 * @returns {Promise<string|null>}  The new command state, or null if not rolled.
 */
export async function commandPet(pet, { skipDialog = false } = {}) {
  if (!isPet(pet) || pet.system.isMount) return null;
  const owner = petOwner(pet);
  const warn = (key, data) => {
    ui.notifications.warn(game.i18n.format(`CARLRPG.Pet.Command.${key}`, { name: pet.name, ...data }));
    return null;
  };
  if (!owner) return warn("NoOwner");
  if (!canCommandPet(pet)) return warn("NotAllowed");
  const combat = petFight(pet);
  if (!combat) return warn("NeedsCombat");
  const current = pet.system.command;
  if (current.combatId === combat.id && SETTLED_STATES.includes(current.state)) {
    return warn("AlreadyResolved", { state: game.i18n.localize(CARLRPG.petCommandStates[current.state].label) });
  }

  const { skill, trained } = await animalHandlingFor(owner);
  const difficulty = commandDifficulty(pet);
  const result = await CarlDice.rollOpposedSkillCheck(owner, skill, {
    difficulty, opponent: null, skipDialog, post: false, markUse: trained,
  });
  if (!result) return null;

  const state = commandStateForDegree(result.degree);
  const stateLabel = game.i18n.localize(CARLRPG.petCommandStates[state].label);
  const body = [
    `<p><strong>${esc(stateLabel)}</strong>: ${esc(game.i18n.localize(`CARLRPG.Pet.Command.Rules.${state}`))}</p>`,
    trained ? "" : `<p class="carl-hint">${esc(game.i18n.localize("CARLRPG.Pet.Command.Untrained"))}</p>`,
    result.debuffNote ?? "",
  ].join("");
  await createRollMessage({
    rolls: [result.roll],
    rollMeta: [{ label: skill.name, detail: `vs. ${pet.name}`, breakdown: result.breakdown }],
    title: game.i18n.format("CARLRPG.Pet.Command.Title", { name: pet.name }),
    subtitle: game.i18n.localize(CARLRPG.degreesOfSuccess[result.degree]),
    img: pet.img,
    badge: degreeBadge(result.degree),
    body,
    actor: owner,
  });
  await pet.update({ "system.command": { state, combatId: combat.id, round: combat.round } });
  return state;
}

/**
 * When a combat ends, every Pet commanded in it goes back to no result -
 * including Pets that stayed out or ran off and were never combatants. A
 * Pet that hid still has to be found (p.232). Active GM only.
 * @param {Combat} combat
 * @returns {Promise<void>}
 */
export async function resetPetCommands(combat) {
  const pets = game.actors.filter((a) => isPet(a) && a.system.command.combatId === combat.id);
  for (const pet of pets) {
    if (pet.system.command.state === "hiding") {
      await createCardMessage({
        title: pet.name,
        img: pet.img,
        body: `<p>${esc(game.i18n.format("CARLRPG.Pet.Command.HidingAfterFight", { name: pet.name }))}</p>`,
        actor: petOwner(pet) ?? pet,
      });
    }
    await pet.update({ "system.command": { state: "", combatId: "", round: null } });
  }
}
