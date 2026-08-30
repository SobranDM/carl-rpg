import CarlDice from "../dice/dice.mjs";

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
