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
import CarlDice, { checkSubtitle } from "../dice/dice.mjs";
import { noteUndo, takeAction } from "./actions.mjs";
import { CARLRPG } from "./config.mjs";
import { degreeBadge, opposedDifficulty } from "./rules.mjs";
import { isMinion, isPet } from "./actor-kinds.mjs";
import { petOwner } from "./pets.mjs";
import { skillOrUntrainedCopy } from "./race-class-grants.mjs";
import { effectiveRank } from "./modifiers.mjs";
import { createCardMessage, createRollMessage } from "../chat/chat-card.mjs";
import { esc } from "./html.mjs";
import { currentFloor } from "./floor.mjs";
import { fightWhere } from "./fights.mjs";

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
  return fightWhere((cb) => cb.actor === pet || (!!owner && cb.actor === owner));
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
  return opposedDifficulty(pet.system.stats.int?.mod, currentFloor());
}

/**
 * Whether this user may roll Command Pet for this Pet: the GM, or someone
 * who owns both the Pet and its crawler (the roll is the crawler's). A
 * dedicated mount is ridden, not commanded (p.232), and a Minion needs no
 * Command Check (p.233).
 * @param {Actor} pet
 * @param {User} [user]
 * @returns {boolean}
 */
export function canCommandPet(pet, user = game.user) {
  if (!isPet(pet) || pet.system.isMount || isMinion(pet)) return false;
  const owner = petOwner(pet);
  if (!owner) return false;
  return user.isGM || (pet.testUserPermission(user, "OWNER") && owner.testUserPermission(user, "OWNER"));
}

/**
 * The Pet's current command result, for its sheet. A result from a combat
 * that no longer exists is shown as none.
 * @param {Actor} pet
 * A Minion has no Command Check: it shows as one (`minion`).
 * @returns {{state: string, active: boolean, selected: string, label: string, rule: string,
 *   stateChoices: Object<string, string>, canCommand: boolean, minion: boolean}}
 */
export function describePetCommand(pet) {
  const { state, combatId } = pet.system.command;
  const minion = isMinion(pet);
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
    minion,
  };
}

/**
 * The Skill the crawler commands its Pet with: its own Skill with the
 * Commands pets box (Animal Handling in the book, or a GM's homebrew one) -
 * the highest live Rank of them. With none, Animal Handling by name, or an
 * unsaved untrained copy.
 * @param {Actor} owner
 * @returns {Promise<{skill: Item, trained: boolean}>}
 */
export function commandSkillFor(owner) {
  const boxed = owner.items.filter((i) => i.type === "skill" && i.system?.commandsPets);
  if (boxed.length) {
    const best = boxed.reduce((a, b) => (effectiveRank(b) > effectiveRank(a) ? b : a));
    return Promise.resolve({ skill: best, trained: true });
  }
  return skillOrUntrainedCopy(owner, "Animal Handling", { img: "icons/svg/pawprint.svg", system: { governingStat: "cha" } });
}

/**
 * Roll Command Pet for a Pet in the running combat: its crawler's Animal
 * Handling (commandSkillFor: its Skill with the Commands pets box) against
 * the Pet's INT, posted as one card and stored on the Pet.
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
  // "One command spurs them all into action" (p.233): no Check to roll.
  if (isMinion(pet)) return warn("MinionNoCheck");
  if (!owner) return warn("NoOwner");
  if (!canCommandPet(pet)) return warn("NotAllowed");
  const combat = petFight(pet);
  if (!combat) return warn("NeedsCombat");
  const current = pet.system.command;
  if (current.combatId === combat.id && SETTLED_STATES.includes(current.state)) {
    return warn("AlreadyResolved", { state: game.i18n.localize(CARLRPG.petCommandStates[current.state].label) });
  }

  // Commanding is the crawler's Action (p.232; helpers/actions.mjs).
  const label = game.i18n.format("CARLRPG.Actions.Label.CommandPet", { name: pet.name });
  return takeAction(owner, "other", label, () => rollCommand(owner, pet, combat, { skipDialog }));
}

/** commandPet's Check and its result, inside the crawler's Action. */
async function rollCommand(owner, pet, combat, { skipDialog }) {
  const { skill, trained } = await commandSkillFor(owner);
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
    subtitle: checkSubtitle(result.degree, result.difficulty),
    img: pet.img,
    badge: degreeBadge(result.degree),
    body,
    actor: owner,
  });
  // Undone: the Pet back to how it was before.
  noteUndo(owner, { t: "set", uuid: pet.uuid, data: { "system.command": foundry.utils.deepClone(pet.system.toObject().command) } });
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
