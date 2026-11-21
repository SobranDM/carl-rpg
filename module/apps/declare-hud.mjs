/**
 * The Declare HUD (docs/combat-phases.md, "Declaring a Mob Attack"): a small
 * frameless panel in the bottom-right of the screen, beside the sidebar,
 * shown to a GM during a phased fight's Mob Action Declaration while they
 * control one or more of its Mob tokens. For each controlled Mob it lists
 * its printed Attacks as buttons and what it has already declared this
 * round (each removable), and it shows who is currently targeted.
 *
 * Flow: select the Mob, target its victims (T), click an Attack: it's
 * declared as it is, with no modifiers - except an Area Attack, which always
 * opens the dialog (who's in the zone, who's splashed). The button beside
 * it (Modify Roll) opens the usual Mob Attack dialog first (ruled
 * 2026-11-21).
 * CarlDice.rollMobAttack records the declaration (module/helpers/
 * declarations.mjs).
 *
 * One instance, kept at game.carlrpg.declareHud and re-rendered (debounced)
 * on token control/targeting and combat changes; it closes itself whenever
 * there's nothing to show.
 */
import CarlDice, { evaluateMobConstant } from "../dice/dice.mjs";
import { currentPhase, phasedCombatFor } from "../helpers/combat-phases.mjs";
import {
  declarationsByMob,
  describeDeclaration,
  removeDeclaration,
} from "../helpers/declarations.mjs";
import { mobAttacksOf } from "../helpers/mob-attacks.mjs";
import { isVehicle, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { actionBubbles } from "../helpers/actions.mjs";
import { currentFloor } from "../helpers/floor.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CarlDeclareHud extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "carl-declare-hud",
    tag: "aside",
    classes: ["carl-declare-hud"],
    window: { frame: false, positioned: false },
    actions: {
      declare: CarlDeclareHud.#onDeclare,
      declareModified: CarlDeclareHud.#onDeclareModified,
      removeDeclaration: CarlDeclareHud.#onRemove,
    },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/combat/declare-hud.hbs" },
  };

  /**
   * The controlled Mob tokens this HUD is for, each with its phased combat
   * in Declaration.
   * @returns {{token: Token, actor: Actor, combat: Combat}[]}
   */
  static declaringMobs() {
    if (!game.user.isGM || !canvas.ready) return [];
    return canvas.tokens.controlled.flatMap((token) => {
      const actor = token.actor;
      if (!actor || rollsLikeCrawler(actor) || isVehicle(actor)) return [];
      const combat = phasedCombatFor(actor);
      return combat && currentPhase(combat) === "declare" ? [{ token, actor, combat }] : [];
    });
  }

  /** Show, refresh or close the HUD to match the current selection. */
  refresh = foundry.utils.debounce(() => {
    if (CarlDeclareHud.declaringMobs().length) void this.render({ force: true });
    else if (this.rendered) void this.close({ animate: false });
  }, 50);

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const floor = currentFloor();
    context.mobs = CarlDeclareHud.declaringMobs().map(({ token, actor, combat }) => ({
      tokenId: token.id,
      name: token.name,
      img: actor.img,
      actions: actionsLeft(combat, actor),
      // Its Attacks (mobAttack items, module/helpers/mob-attacks.mjs).
      attacks: mobAttacksOf(actor).map((item) => ({
        id: item.id,
        name: item.name || game.i18n.localize("CARLRPG.MobAttack.Unnamed"),
        toHit: evaluateMobConstant(item.system.toHit, floor),
        damage: [item.system.damage, item.system.damageType].filter(Boolean).join(" "),
        isArea: !!item.system.isArea,
      })),
      declared: declarationsByMob(combat, {
        tokenUuid: token.document?.uuid,
        actorUuid: actor.uuid,
      }).map((d) => ({ id: d.id, label: describeDeclaration(d) })),
    }));
    context.targets = [...game.user.targets].map((t) => t.name).join(", ");
    return context;
  }

  /**
   * Insert into the column beside the sidebar, where it floats at the bottom
   * over the chat notifications (_combat-phases.scss) instead of pushing them
   * up.
   * @override
   */
  _insertElement(element) {
    const existing = document.getElementById(element.id);
    if (existing) existing.replaceWith(element);
    else (document.getElementById("ui-right-column-1") ?? document.body).append(element);
  }

  /**
   * Declare one of a Mob's Attacks against the current targets, with no
   * modifiers - no dialog, unless it's an Area Attack (declareFrom).
   * @this {CarlDeclareHud}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onDeclare(event, target) {
    return declareFrom(target, { skipDialog: true });
  }

  /**
   * Declare one, through the Mob Attack dialog (Modify Roll).
   * @this {CarlDeclareHud}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onDeclareModified(event, target) {
    return declareFrom(target, { skipDialog: false });
  }

  /**
   * Withdraw one of this round's declarations.
   * @this {CarlDeclareHud}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRemove(event, target) {
    const entry = CarlDeclareHud.declaringMobs().find(
      (m) => m.token.id === target.closest("[data-token-id]")?.dataset.tokenId,
    );
    if (entry) await removeDeclaration(entry.combat, target.dataset.id);
  }
}

/** Whether a declaration from the HUD is under way (declareFrom). */
let declaring = false;

/**
 * Declare the Attack a HUD button is for, from the Mob of its section,
 * against the current targets.
 * @param {HTMLElement} button  Carries data-attack-id.
 * @param {{skipDialog: boolean}} options
 */
async function declareFrom(button, { skipDialog }) {
  // One at a time: a double-click mustn't declare twice.
  if (declaring) return;
  const entry = CarlDeclareHud.declaringMobs().find(
    (m) => m.token.id === button.closest("[data-token-id]")?.dataset.tokenId,
  );
  if (!entry) return;
  if (!game.user.targets.size) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Declare.NoTargets"));
    return;
  }
  const attackId = button.dataset.attackId;
  // An Area Attack always asks: the dialog is where its splash is picked.
  const isArea = !!mobAttacksOf(entry.actor).find((item) => item.id === attackId)?.system.isArea;
  declaring = true;
  try {
    await CarlDice.rollMobAttack(entry.actor, attackId, { skipDialog: skipDialog && !isArea });
  } finally {
    declaring = false;
  }
}

/**
 * "1 + Move of 2" - a Mob's Actions left this round (helpers/actions.mjs).
 * @param {Combat} combat
 * @param {Actor} actor
 * @returns {string}
 */
function actionsLeft(combat, actor) {
  const combatant = combat.combatants.find((c) => c.actor === actor);
  if (!combatant) return "";
  const bubbles = actionBubbles(combat, combatant);
  const left = bubbles.filter((b) => !b.spent && b.pool !== "move").length;
  const moveLeft = bubbles.some((b) => !b.spent && b.pool === "move");
  return game.i18n.format(
    moveLeft ? "CARLRPG.Declare.ActionsLeftMove" : "CARLRPG.Declare.ActionsLeft",
    { left },
  );
}

/**
 * Create the GM's HUD and keep it in step with the selection, targets and
 * combat. Call once from the `ready` hook.
 */
export function registerDeclareHud() {
  if (!game.user.isGM) return;
  const hud = (game.carlrpg.declareHud = new CarlDeclareHud());
  const refresh = () => hud.refresh();
  for (const hook of [
    "controlToken",
    "targetToken",
    "canvasReady",
    "updateCombat",
    "deleteCombat",
    "createCombatant",
    "deleteCombatant",
    "updateActor",
  ]) {
    Hooks.on(hook, refresh);
  }
  refresh();
}
