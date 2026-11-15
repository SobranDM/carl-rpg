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
import { isPet, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { declaredAttacks, describeDeclaration, removeDeclaration } from "../helpers/declarations.mjs";

const { CombatTracker } = foundry.applications.sidebar.tabs;
const TEMPLATES = "systems/carl-rpg/templates/combat";

export class CarlRPGCombatTracker extends CombatTracker {
  /** @override */
  static DEFAULT_OPTIONS = {
    actions: {
      toggleSurprise: CarlRPGCombatTracker.#onToggleSurprise,
      removeDeclaration: CarlRPGCombatTracker.#onRemoveDeclaration,
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
