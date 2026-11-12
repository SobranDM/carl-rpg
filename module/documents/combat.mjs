import { processRoundEnd, processCombatEnd } from "../helpers/round-end.mjs";

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
  return actor?.type === "character" ? PVE_INITIATIVE.character : PVE_INITIATIVE.mob;
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
 */
export class CarlRPGCombat extends Combat {
  /** Whether every combatant is a crawler (PvP) - an empty combat isn't. */
  get isPvP() {
    const combatants = this.combatants.contents;
    return combatants.length > 0 && combatants.every((c) => c.actor?.type === "character");
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
      await this.rollInitiative(this.combatants.map((c) => c.id), { updateTurn: false });
    } else {
      await this.syncPveInitiative();
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
    if (this.initiative !== null && this.initiative !== undefined) return;
    const combat = this.parent;
    const pve = this.actor?.type !== "character"
      || combat?.combatants.some((c) => c.actor?.type !== "character");
    if (pve) this.updateSource({ initiative: pveInitiativeFor(this.actor) });
  }

  /** @override */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    const combat = this.parent;
    if (combat instanceof CarlRPGCombat) combat.queuePveSync();
  }
}
