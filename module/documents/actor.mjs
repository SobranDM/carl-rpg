import CarlDice from "../dice/dice.mjs";
import { recheckLevelGatedGrants } from "../helpers/race-class-grants.mjs";

/**
 * Extend the base Actor document.
 * @extends {Actor}
 */
export class CarlRPGActor extends Actor {
  /** @override */
  prepareData() {
    super.prepareData();
  }

  /** @override */
  prepareBaseData() {
    super.prepareBaseData();
  }

  /** @override */
  prepareDerivedData() {
    super.prepareDerivedData();
  }

  /**
   * "When a crawler gains a Level, they also get 3 Stat points to assign"
   * (Crawler Advancement, p.169) - grant `3 x levelDelta` into the same
   * `bankedStatPoints` field module/apps/spend-stat-points-dialog.mjs
   * spends from, whenever this actor's Level actually increases (a GM
   * decrementing Level to correct a mistake doesn't claw points back,
   * consistent with this project's "once baked in, they stay" philosophy
   * for other permanent grants). Mutates `changed` directly so the points
   * land in the SAME update operation as the Level change, rather than a
   * second separate write - covers every path that can change Level (the
   * GM Toolbox's Party Level Up button, the sheet's own Level field, a
   * future Boss-kill/PvP Level-award action), not just one specific caller.
   * @override
   */
  async _preUpdate(changed, options, user) {
    const allowed = await super._preUpdate(changed, options, user);
    if (allowed === false) return false;

    const newLevel = foundry.utils.getProperty(changed, "system.attributes.level.value");
    if (newLevel !== undefined) {
      const delta = Number(newLevel) - (this.system.attributes?.level?.value ?? 0);
      if (delta > 0) {
        const currentBanked = this.system.bankedStatPoints ?? 0;
        foundry.utils.setProperty(changed, "system.bankedStatPoints", currentBanked + 3 * delta);
      }
    }
  }

  /**
   * Re-check every owned class/race item's level-gated grants (e.g. Bune's
   * "At Level 50, +2 Dexterity") whenever Level changes - a grant that
   * wasn't eligible when the Race/Class was added needs a second chance to
   * bake into base once the gate is crossed. See
   * module/helpers/race-class-grants.mjs.
   * @override
   */
  async _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if (game.user.id !== userId) return;
    if (foundry.utils.hasProperty(changed, "system.attributes.level.value")) {
      await recheckLevelGatedGrants(this);
    }
  }

  /** @override */
  getRollData() {
    return { ...super.getRollData(), ...this.system.getRollData?.() ?? null };
  }

  /**
   * Roll an Evade Check (Interrupt) for this Actor. See module/dice/dice.mjs.
   * @param {{difficulty?: number|null, skipDialog?: boolean}} [options]
   */
  async rollEvadeCheck(options = {}) {
    return CarlDice.rollEvadeCheck(this, options);
  }

  /**
   * Roll a Skill Advancement Check for one owned Skill/Spell/Damage Effect.
   * @param {string} itemId
   * @param {{apply?: boolean, silent?: boolean}} [options]
   */
  async rollAdvancementCheck(itemId, options = {}) {
    const item = this.items.get(itemId);
    if (!item) return null;
    return CarlDice.rollAdvancementCheck(this, item, options);
  }

  /**
   * Roll Skill Advancement Checks for every currently-marked owned
   * Skill/Spell/Damage Effect, optionally restricted to Rank <=4 (the
   * two-hour real-world-timer cadence) vs Rank >=5 (the per-floor cadence).
   * See Crawler Advancement, p. 169. Intended for the GM Toolbox (Milestone 4)
   * but usable directly for testing.
   * @param {{rankFilter?: "lte4"|"gte5"|"all"}} [options]
   * @returns {Promise<Array<{item: Item, success: boolean, newRank: number}>>}
   */
  async rollMarkedAdvancementChecks({ rankFilter = "all" } = {}) {
    const results = [];
    const marked = this.items.filter((i) =>
      ["skill", "spell", "damageEffect"].includes(i.type) && i.system.marked
    );
    for (const item of marked) {
      const rank = item.system.rank ?? 0;
      if (rankFilter === "lte4" && rank > 4) continue;
      if (rankFilter === "gte5" && rank < 5) continue;
      const { success, newRank } = await CarlDice.rollAdvancementCheck(this, item, { silent: true });
      results.push({ item, success, newRank });
    }
    return results;
  }
}
