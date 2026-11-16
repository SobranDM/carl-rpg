/**
 * The Combat Tracker, with the phased PvE round (module/helpers/
 * combat-phases.mjs; docs/combat-phases.md):
 *  - a phase bar under the encounter header - Declaration, Reaction,
 *    Resolution, Crawler Actions, Clean Up - with the current step lit, for
 *    everyone; before round 1 the GM gets a "Crawlers surprise the Mobs" toggle;
 *  - combatants listed as two groups, Mobs then Crawlers (each crawler
 *    followed by its Pets), with no initiative column - there's no initiative
 *    in a PvE fight (p.80);
 *  - the GM's footer: Next Phase (named for what it does), Previous Phase
 *    while it is still safe, and End Combat - instead of core's turn arrows.
 * A PvP fight (crawlers only, p.87) and a world with phases switched off
 * render exactly as core's tracker does.
 */
import { PHASE_BAR_STEPS, currentPhase, usesPhases } from "../helpers/combat-phases.mjs";
import { isCrawler, isPet, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { declaredAttacks, describeDeclaration, removeDeclaration } from "../helpers/declarations.mjs";
import {
  actionBubbles, actionRecord, adjustActions, buyFavorAction, resetActions, spendBubble, undoAction,
} from "../helpers/actions.mjs";

const { CombatTracker } = foundry.applications.sidebar.tabs;
const TEMPLATES = "systems/carl-rpg/templates/combat";

export class CarlRPGCombatTracker extends CombatTracker {
  /** @override */
  static DEFAULT_OPTIONS = {
    actions: {
      toggleSurprise: CarlRPGCombatTracker.#onToggleSurprise,
      removeDeclaration: CarlRPGCombatTracker.#onRemoveDeclaration,
      actionBubble: CarlRPGCombatTracker.#onActionBubble,
      favorAction: CarlRPGCombatTracker.#onFavorAction,
    },
  };

  /** @override */
  static PARTS = {
    header: {
      template: "templates/sidebar/tabs/combat/header.hbs",
    },
    phases: {
      template: `${TEMPLATES}/phase-bar.hbs`,
    },
    tracker: {
      template: `${TEMPLATES}/tracker.hbs`,
      templates: [`${TEMPLATES}/combatant.hbs`],
      scrollable: [""],
    },
    footer: {
      template: `${TEMPLATES}/footer.hbs`,
    },
  };

  /** @inheritDoc */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if (partId === "phases" || partId === "footer") this._preparePhaseContext(context);
    return context;
  }

  /**
   * What the phase bar and the phased footer need.
   * @param {object} context
   * @protected
   */
  _preparePhaseContext(context) {
    const i18n = game.i18n;
    const combat = this.viewed;
    const step = currentPhase(combat);
    const index = PHASE_BAR_STEPS.indexOf(step);
    const phases = usesPhases(combat);
    const showSurpriseToggle = game.user.isGM && phases && !combat.started;
    context.carl = {
      usesPhases: phases,
      phased: !!step,
      showBar: !!step || showSurpriseToggle,
      step,
      round: combat?.round ?? 0,
      surprise: step === "surprise",
      steps: PHASE_BAR_STEPS.map((key, i) => ({
        key,
        number: i + 1,
        label: i18n.localize(`CARLRPG.Phase.Bar.${key}`),
        active: key === step,
        done: index > i,
      })),
      stepLabel: step ? i18n.localize(`CARLRPG.Phase.Step.${step}`) : "",
      showSurpriseToggle,
      surpriseChecked: !!combat?.getFlag("carl-rpg", "surprise"),
      nextLabel: step ? i18n.localize(`CARLRPG.Phase.Next.${step}`) : "",
      nextIcon: { surprise: "fa-forward", declare: "fa-shield-halved", react: "fa-lock", resolve: "fa-forward", act: "fa-flag-checkered" }[step] ?? "fa-forward",
      canRewind: step === "react",
      // The GM's list of this round's declared Attacks (p.81), while declaring.
      showDeclared: game.user.isGM && step === "declare",
      declared: game.user.isGM && step === "declare"
        ? declaredAttacks(combat).map((d) => ({ id: d.id, mob: d.mobName, label: describeDeclaration(d) }))
        : [],
    };
  }

  /**
   * In a PvE fight, split the combatants into Mobs and Crawlers (each
   * crawler followed by its Pets).
   * @inheritDoc
   */
  async _prepareTrackerContext(context, options) {
    await super._prepareTrackerContext(context, options);
    const combat = this.viewed;
    if (!usesPhases(combat) || !context.turns) return;
    if (currentPhase(combat)) for (const turn of context.turns) turn.actions = this._prepareActionContext(combat, turn.id);
    const actorOf = (turn) => combat.combatants.get(turn.id)?.actor ?? null;
    const mobs = [];
    const crawlers = [];
    const pets = [];
    for (const turn of context.turns) {
      const actor = actorOf(turn);
      if (isPet(actor)) pets.push(turn);
      else if (rollsLikeCrawler(actor)) crawlers.push(turn);
      else mobs.push(turn);
    }
    const party = [];
    const placed = new Set();
    for (const turn of crawlers) {
      party.push(turn);
      const crawler = actorOf(turn);
      if (!crawler) continue;
      const own = pets.filter((pet) => actorOf(pet)?.system?.ownerId === crawler.id);
      own.forEach((pet) => placed.add(pet));
      party.push(...own);
    }
    party.push(...pets.filter((pet) => !placed.has(pet)));
    context.phaseGroups = [
      { key: "mobs", label: game.i18n.localize("CARLRPG.Phase.Group.Mobs"), turns: mobs },
      { key: "crawlers", label: game.i18n.localize("CARLRPG.Phase.Group.Crawlers"), turns: party },
    ].filter((group) => group.turns.length);
  }

  /**
   * A combatant's Action bubbles (helpers/actions.mjs): green Actions, a
   * Mob's yellow Move, AI Favor's gold one - red once spent, naming what on.
   * Its owner (or the GM) clicks a bubble to spend it, or a red one to undo.
   * @param {Combat} combat
   * @param {string} combatantId
   * @returns {object|null}
   * @protected
   */
  _prepareActionContext(combat, combatantId) {
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) return null;
    const i18n = game.i18n;
    const canClick = combatant.isOwner;
    const bubbles = actionBubbles(combat, combatant).map((b) => ({
      pool: b.pool,
      spent: !!b.spent,
      entryId: b.spent?.id ?? "",
      tooltip: b.spent
        ? i18n.format(canClick ? "CARLRPG.Actions.SpentOnUndo" : "CARLRPG.Actions.SpentOn", {
          label: b.spent.label || i18n.localize("CARLRPG.Actions.Other"),
        })
        : i18n.localize(`CARLRPG.Actions.Pool.${b.pool}`),
    }));
    const actor = combatant.actor;
    const canFavor = canClick && isCrawler(actor) && !actionRecord(combat, combatantId).favor
      && (actor.system.details?.aiFavor ?? 0) >= 1;
    return { bubbles, canClick, canFavor };
  }

  /**
   * The GM's +1 / -1 / Reset for a combatant's Actions this round.
   * @inheritDoc
   */
  _getEntryContextOptions() {
    const options = super._getEntryContextOptions();
    const phased = () => game.user.isGM && !!currentPhase(this.viewed);
    const id = (li) => li.dataset.combatantId;
    return [
      { label: "CARLRPG.Actions.Menu.Add", icon: "fa-solid fa-circle-plus", visible: phased,
        onClick: (event, li) => adjustActions(this.viewed, id(li), 1) },
      { label: "CARLRPG.Actions.Menu.Remove", icon: "fa-solid fa-circle-minus", visible: phased,
        onClick: (event, li) => adjustActions(this.viewed, id(li), -1) },
      { label: "CARLRPG.Actions.Menu.Reset", icon: "fa-solid fa-rotate-left", visible: phased,
        onClick: (event, li) => resetActions(this.viewed, id(li)) },
      ...options,
    ];
  }

  /**
   * Click a bubble: spend an unspent one (a Move, Help, Call a Play...), or
   * undo a spent one (a misclick - a player's undo is reported to the GM).
   * @this {CarlRPGCombatTracker}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onActionBubble(event, target) {
    event.stopPropagation();
    const combat = this.viewed;
    const combatantId = target.closest("[data-combatant-id]")?.dataset.combatantId;
    const combatant = combat?.combatants.get(combatantId);
    if (!combatant?.isOwner) return;
    // A red one: undo what it was spent on, and give it back.
    if (target.dataset.entryId) await undoAction(combat, combatantId, target.dataset.entryId);
    else await spendBubble(combat, combatantId, target.dataset.pool);
  }

  /**
   * A crawler's AI Favor Action (p.61): 1 AI Favor for an extra non-Attack
   * Action this round.
   * @this {CarlRPGCombatTracker}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onFavorAction(event, target) {
    event.stopPropagation();
    const combatant = this.viewed?.combatants.get(target.closest("[data-combatant-id]")?.dataset.combatantId);
    if (combatant?.actor) await buyFavorAction(combatant.actor);
  }

  /**
   * The GM's "Crawlers surprise the Mobs" toggle, before round 1.
   * @this {CarlRPGCombatTracker}
   * @param {PointerEvent} event
   * @param {HTMLInputElement} target
   */
  static async #onToggleSurprise(event, target) {
    const combat = this.viewed;
    if (!game.user.isGM || !combat || combat.started) return;
    await combat.setSurprise(target.checked);
  }

  /**
   * Withdraw one of this round's declared Attacks.
   * @this {CarlRPGCombatTracker}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRemoveDeclaration(event, target) {
    if (this.viewed) await removeDeclaration(this.viewed, target.dataset.id);
  }
}
