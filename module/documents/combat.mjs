import { processRoundEnd, processCombatEnd } from "../helpers/round-end.mjs";
import { resetPetCommands } from "../helpers/pet-command.mjs";
import { isCrawler, isPet, isVehicle, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import {
  currentPhase,
  isPhased,
  nextPhase,
  postPhaseNotice,
  previousPhase,
  roundStartPhase,
  syncPhaseState,
  usesPhases,
} from "../helpers/combat-phases.mjs";

/**
 * Initiative stand-ins for a PvE fight, where the book has no initiative at
 * all: "Normally, combat occurs when Mobs encounter the crawlers and the Mobs
 * go first" and crawlers then act "in any order" (Combat, p.80-82). Giving
 * every combatant a fixed value lists Mobs first and stops the tracker from
 * asking anyone to roll.
 */
export const PVE_INITIATIVE = { mob: 20, character: 10 };

/** @param {Actor|null|undefined} actor */
function pveInitiativeFor(actor) {
  // Pets act in the Crawler phase alongside their crawler (p.232).
  return rollsLikeCrawler(actor) ? PVE_INITIATIVE.character : PVE_INITIATIVE.mob;
}

/**
 * Combat document for Carl RPG.
 *  - Debuff automation runs on Foundry's own round lifecycle (module/helpers/
 *    round-end.mjs). Combat#_onEndRound runs on exactly one designated GM
 *    client, once per round ended (including skipped rounds), never on a
 *    rewind.
 *  - Combat order (p.80-87): a fight with any Mob is PvE - no initiative, Mobs
 *    first (PVE_INITIATIVE). A fight between crawlers only is PvP - "At the
 *    start of each round of PvP combat, each player rolls for initiative:
 *    d20 + DEX" (CONFIG.Combat.initiative), re-rolled every round.
 *  - A started PvE fight runs the phased round instead of turns (module/
 *    helpers/combat-phases.mjs): there is no current combatant (`turn` is
 *    null), Next/Previous Turn step through the phases, and a round only ends
 *    from the Crawler Action Phase. PvP keeps core's turns.
 */
export class CarlRPGCombat extends Combat {
  /**
   * Every round change of a phased fight - starting it, ending a round,
   * rewinding one - writes the new round's step in the same update, and
   * leaves no combatant "on turn".
   * @override
   */
  async _preUpdate(changed, options, user) {
    const allowed = await super._preUpdate(changed, options, user);
    if (allowed === false) return false;
    if (
      typeof changed.round === "number" &&
      changed.round !== this.round &&
      changed.round >= 1 &&
      usesPhases(this)
    ) {
      const surprise = this.round === 0 && !!this.getFlag("carl-rpg", "surprise");
      foundry.utils.setProperty(
        changed,
        "flags.carl-rpg.phase",
        roundStartPhase(changed.round, surprise),
      );
      changed.turn = null;
    }
  }

  /** Next Phase in a phased fight (the tracker's button calls this). @override */
  async nextTurn() {
    if (isPhased(this)) return nextPhase(this);
    return super.nextTurn();
  }

  /** @override */
  async previousTurn() {
    if (isPhased(this)) return previousPhase(this);
    return super.previousTurn();
  }

  /**
   * A phased round only ends from the Crawler Action Phase (End Round):
   * ending it earlier would skip Mob Attack Resolution.
   * @override
   */
  async nextRound() {
    if (isPhased(this) && currentPhase(this) !== "act") {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Phase.FinishRoundFirst"));
      return this;
    }
    return super.nextRound();
  }

  /**
   * Before round 1: whether the crawlers surprise the Mobs (p.80) - round 1
   * then opens with their one free Action.
   * @param {boolean} value
   * @returns {Promise<this>}
   */
  async setSurprise(value) {
    if (this.started) return this;
    return this.setFlag("carl-rpg", "surprise", !!value);
  }

  /**
   * Whether every combatant is a crawler (PvP) - an empty combat isn't.
   * Crawlers' Pets don't decide it either way: crawlers + their Pets is
   * still PvP, and a Pet rolls d20 + DEX like everyone else. Nor do vehicles
   * (which are never combatants anyway - see CarlRPGCombatant).
   */
  get isPvP() {
    const combatants = this.combatants.contents.filter(
      (c) => !isPet(c.actor) && !isVehicle(c.actor),
    );
    return combatants.length > 0 && combatants.every((c) => isCrawler(c.actor));
  }

  /**
   * Give every combatant that has no initiative yet its fixed PvE value - a
   * combatant the GM has already placed (or that rolled in PvP) keeps its
   * spot. Active GM only (any user may add combatants, but only a GM can
   * set others').
   * @returns {Promise<void>}
   */
  async syncPveInitiative() {
    if (!game.users.activeGM?.isSelf || this.isPvP) return;
    // The debounced sync can fire after the combat was deleted (a quick
    // add-then-end, or a test) - nothing left to update.
    if (!game.combats.has(this.id)) return;
    const updates = this.combatants
      .filter((c) => c.initiative === null || c.initiative === undefined)
      .map((c) => ({ _id: c.id, initiative: pveInitiativeFor(c.actor) }));
    if (updates.length) await this.updateEmbeddedDocuments("Combatant", updates);
  }

  /** One sync for a burst of new combatants (adding 8 tokens at once), not one each. */
  queuePveSync = foundry.utils.debounce(() => void this.syncPveInitiative(), 100);

  /** @override */
  async _onStartRound(context) {
    await super._onStartRound(context);
    if (this.isPvP) {
      // Re-rolled every round (p.87); only the active GM runs this hook.
      await this.rollInitiative(
        this.combatants.map((c) => c.id),
        { updateTurn: false },
      );
    } else {
      await this.syncPveInitiative();
      // A new phased round opens at its first step - say so in chat.
      if (isPhased(this) && !context?.skipped)
        await postPhaseNotice(this, currentPhase(this), { roundStart: true });
    }
  }

  /** @override */
  async _onEndRound(context) {
    await super._onEndRound(context);
    // Starting a combat "ends" round 0 - nothing has happened yet.
    if (!(context?.round >= 1)) return;
    await processRoundEnd(this, context.round);
  }

  /** @override */
  _onDelete(options, userId) {
    super._onDelete(options, userId);
    // _onDelete runs on every client; only the active GM cleans up, and only
    // for a combat that actually started.
    if (!game.user.isActiveGM || !this.started) return;
    void processCombatEnd(this);
    // Command Pet results last "for the entire combat" (p.232).
    resetPetCommands(this).catch((err) => console.error("CarlRPG | pet command reset failed", err));
  }
}

/**
 * Combatant: in a PvE fight, arrives with its fixed initiative already set
 * (so nobody is prompted to roll); adding a Mob to a crawlers-only combat
 * fills in anyone still without initiative (one debounced sync per burst).
 */
export class CarlRPGCombatant extends Combatant {
  /** @override */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;
    // "They do not have Actions" (Vehicles, p.72): the people in it fight,
    // the vehicle doesn't take turns.
    if (isVehicle(this.actor)) {
      ui.notifications.warn(
        game.i18n.format("CARLRPG.Vehicle.NotACombatant", { name: this.actor.name }),
      );
      return false;
    }
    if (this.initiative !== null && this.initiative !== undefined) return;
    const combat = this.parent;
    const pve =
      !rollsLikeCrawler(this.actor) ||
      combat?.combatants.some((c) => !rollsLikeCrawler(c.actor) && !isVehicle(c.actor));
    if (pve) this.updateSource({ initiative: pveInitiativeFor(this.actor) });
  }

  /** @override */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    const combat = this.parent;
    if (combat instanceof CarlRPGCombat) {
      combat.queuePveSync();
      // A Mob joining a running PvP fight makes it phased mid-round.
      void syncPhaseState(combat).catch((err) => console.error("CarlRPG | phase sync failed", err));
    }
  }
}
