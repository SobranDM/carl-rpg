/**
 * The Declare HUD (docs/combat-phases.md, "Declaring a Mob Attack"): a small
 * frameless panel in the bottom-right of the screen, beside the sidebar,
 * shown to a GM during a phased fight's Mob Action Declaration while they
 * control one or more of its Mob tokens. For each controlled Mob it lists
 * its printed Attacks as buttons and what it has already declared this
 * round (each removable), and it shows who is currently targeted.
 *
 * Flow: select the Mob, target its victims (T), click an Attack. That opens
 * the usual Mob Attack dialog (Shift-click skips it) and CarlDice.
 * rollMobAttack records the declaration (module/helpers/declarations.mjs).
 *
 * One instance, kept at game.carlrpg.declareHud and re-rendered (debounced)
 * on token control/targeting and combat changes; it closes itself whenever
 * there's nothing to show.
 */
import CarlDice, { evaluateMobConstant } from "../dice/dice.mjs";
import { currentPhase, phasedCombatFor } from "../helpers/combat-phases.mjs";
import { declarationsByMob, describeDeclaration, removeDeclaration } from "../helpers/declarations.mjs";
import { isAreaMobAttack } from "../helpers/area.mjs";
import { isVehicle, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";

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
    const floor = game.settings.get("carl-rpg", "currentFloor");
    context.mobs = CarlDeclareHud.declaringMobs().map(({ token, actor, combat }) => ({
      tokenId: token.id,
      name: token.name,
      img: actor.img,
      attacks: (actor.system.attacks ?? []).map((attack, index) => ({
        index,
        name: attack.name || game.i18n.localize("CARLRPG.MobAttack.Unnamed"),
        toHit: evaluateMobConstant(attack.toHit, floor),
        damage: [attack.damage, attack.damageType].filter(Boolean).join(" "),
        isArea: isAreaMobAttack(attack),
      })),
      declared: declarationsByMob(combat, { tokenUuid: token.document?.uuid, actorUuid: actor.uuid })
        .map((d) => ({ id: d.id, label: describeDeclaration(d) })),
    }));
    context.targets = [...game.user.targets].map((t) => t.name).join(", ");
    return context;
  }

  /**
   * Insert into the column beside the sidebar, under the chat notifications,
   * so the two stack rather than overlap.
   * @override
   */
  _insertElement(element) {
    const existing = document.getElementById(element.id);
    if (existing) existing.replaceWith(element);
    else (document.getElementById("ui-right-column-1") ?? document.body).append(element);
  }

  /**
   * Declare one of a Mob's Attacks against the current targets.
   * @this {CarlDeclareHud}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onDeclare(event, target) {
    const entry = CarlDeclareHud.declaringMobs().find((m) => m.token.id === target.closest("[data-token-id]")?.dataset.tokenId);
    if (!entry) return;
    if (!game.user.targets.size) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Declare.NoTargets"));
      return;
    }
    await CarlDice.rollMobAttack(entry.actor, Number(target.dataset.index), { skipDialog: event.shiftKey });
  }

  /**
   * Withdraw one of this round's declarations.
   * @this {CarlDeclareHud}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRemove(event, target) {
    const entry = CarlDeclareHud.declaringMobs().find((m) => m.token.id === target.closest("[data-token-id]")?.dataset.tokenId);
    if (entry) await removeDeclaration(entry.combat, target.dataset.id);
  }
}

/**
 * Create the GM's HUD and keep it in step with the selection, targets and
 * combat. Call once from the `ready` hook.
 */
export function registerDeclareHud() {
  if (!game.user.isGM) return;
  const hud = game.carlrpg.declareHud = new CarlDeclareHud();
  const refresh = () => hud.refresh();
  for (const hook of ["controlToken", "targetToken", "canvasReady", "updateCombat", "deleteCombat",
    "createCombatant", "deleteCombatant", "updateActor"]) {
    Hooks.on(hook, refresh);
  }
  refresh();
}
