/**
 * Who a heal takes (docs/rules-fixes.md A). A healing Skill or Spell's
 * "Heals" (ranked-item-base.mjs `heals`) says who it may be cast on:
 *  - "self": the caster only - Heal Self ("You can only cast this Spell on
 *    yourself") and Heal (Range: Self only). Targets are ignored: Foundry
 *    keeps the last Attack's target, which isn't a choice made for this.
 *  - "others": not yourself, pets or minions - Heal Others (p.206).
 *  - "pets": pets and minions only - Heal Critter ("May only be cast on
 *    pets and minions").
 *  - "anyone": Nature's Breath ("could be yourself ... May also target pets
 *    and minions").
 * Blank goes by the Range: "Self only" is "self", anything else "anyone".
 *
 * Like a potion (module/helpers/consumables.mjs): the targeted token is
 * healed; with nothing targeted, a heal that can take its caster heals the
 * caster. One target, unless an unlocked Upgrade tier heals every target
 * (`healAllTargets` - Heal Others Rank 15's 20ft Burst, the caster targets
 * the party members in it). A heal that can't take a target refuses.
 *
 * "Spells and effects that work on pets typically also work on minions"
 * (p.233): a Minion is a Pet actor with the Minion box (data/pet.mjs), so
 * "a pet or minion" is any `pet` actor.
 */
import { isPet, isVehicle } from "./actor-kinds.mjs";
import { effectiveRank } from "./modifiers.mjs";
import { cancelButton, showCarlDialog } from "../apps/carl-dialog.mjs";
import { esc } from "./html.mjs";

export const HEALS_MODES = Object.freeze(["self", "others", "pets", "anyone"]);

/**
 * The item's "Heals", or what its Range gives when blank.
 * @param {Item|{system: object}} item
 * @returns {"self"|"others"|"pets"|"anyone"}
 */
export function healsMode(item) {
  const sys = item?.system ?? {};
  if (HEALS_MODES.includes(sys.heals)) return sys.heals;
  return /^\s*self\b/i.test(String(sys.range ?? "")) ? "self" : "anyone";
}

/**
 * Does an Upgrade tier unlocked at the item's live Rank (modifiers.mjs
 * effectiveRank) heal every target?
 * @param {Item|{system: object}} item
 * @returns {boolean}
 */
export function healsAllTargets(item) {
  const sys = item?.system ?? {};
  const rank = effectiveRank(item);
  return (sys.upgrades ?? []).some((u) => u.healAllTargets && rank >= u.rankThreshold);
}

/** A pet or minion, for a heal's limits: any Pet actor (see above). */
export const isPetOrMinion = (actor) => isPet(actor);

/** The same creature (a token's actor, or the actor itself). */
function sameCreature(a, b) {
  return !!a && !!b && (a === b || a.uuid === b.uuid);
}

/**
 * Who this heal heals, or why it can't.
 * @param {Actor} caster
 * @param {Item} item  The healing Skill or Spell.
 * @param {{actor: Actor, uuid?: string, name?: string}[]} targets  The
 *   user's targeted tokens (their actors), in order.
 * @returns {{recipients: {actor: Actor, uuid: string, name: string}[]}|{refusal: string}}
 *   refusal: the warning to show (localized).
 */
export function resolveHealRecipients(caster, item, targets = []) {
  const mode = healsMode(item);
  const self = { actor: caster, uuid: caster.uuid, name: caster.name };
  const refuse = (key, data = {}) => ({ refusal: game.i18n.format(`CARLRPG.Heals.Refuse.${key}`, { spell: item.name, ...data }) });
  if (mode === "self") return { recipients: [self] };

  const list = targets.filter((t) => t?.actor);
  if (!list.length) {
    if (mode === "others") return refuse("NeedsTarget");
    if (mode === "pets" && !isPetOrMinion(caster)) return refuse("NeedsPet");
    return { recipients: [self] };
  }
  if (list.length > 1 && !healsAllTargets(item)) return refuse("OneTarget");

  const recipients = [];
  for (const t of list) {
    const actor = t.actor;
    const name = t.name || actor.name;
    if (isVehicle(actor)) return refuse("Vehicle", { name });
    if (mode === "others" && sameCreature(actor, caster)) return refuse("NotSelf");
    if (mode === "others" && isPetOrMinion(actor)) return refuse("NotPets", { name });
    if (mode === "pets" && !isPetOrMinion(actor)) return refuse("PetsOnly", { name });
    recipients.push({ actor, uuid: t.uuid || actor.uuid, name });
  }
  return { recipients };
}

/**
 * The user's targeted tokens, as resolveHealRecipients takes them.
 * @returns {{actor: Actor, uuid: string, name: string}[]}
 */
export function userHealTargets() {
  return [...(game.user.targets ?? [])]
    .filter((t) => t?.actor)
    .map((t) => ({ actor: t.actor, uuid: t.document?.uuid ?? t.actor.uuid, name: t.document?.name ?? t.name ?? t.actor.name }));
}

/**
 * A heal that could take its caster, with one other creature targeted:
 * heal them or yourself? Foundry keeps the last Attack's target, so the
 * caster is the default and healing the target the deliberate choice - as
 * a potion asks (consumables.mjs chooseRecipient).
 * @param {Item} item
 * @param {Actor} caster
 * @param {{actor: Actor, uuid: string, name: string}} target
 * @returns {Promise<{actor: Actor, uuid: string, name: string}|null>}  null when cancelled.
 */
export async function chooseHealRecipient(item, caster, target) {
  const choice = await showCarlDialog({
    title: item.name,
    content: `<div class="carl-dialog-body"><p>${esc(game.i18n.format("CARLRPG.Heals.ChooseRecipient", { spell: item.name, name: target.name }))}</p></div>`,
    classes: ["carl-heal-recipient"],
    buttons: [
      { action: "self", icon: "fa-solid fa-heart", label: game.i18n.localize("CARLRPG.Heals.HealYourself"), default: true, callback: () => "self" },
      { action: "target", icon: "fa-solid fa-hand-holding-medical", label: game.i18n.format("CARLRPG.Heals.HealTarget", { name: target.name }), callback: () => "target" },
      cancelButton(),
    ],
  });
  if (choice === "self") return { actor: caster, uuid: caster.uuid, name: caster.name };
  if (choice === "target") return target;
  return null;
}
