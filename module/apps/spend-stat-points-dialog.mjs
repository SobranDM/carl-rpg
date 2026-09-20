/**
 * Spend Stat Points dialog: one available point buys exactly +1 to one
 * Stat's base value. On a Character, that pool is a banked total accrued
 * via leveling up (Third Floor+ Crawler Advancement rule - a saferoom is
 * needed to distribute Stat points gained from leveling), stored in
 * system.bankedStatPoints and decremented/incremented alongside the Stat
 * itself. On a Mob, there is no such stored pool - "Building a Mob" (p.270-
 * 272) instead computes the total available fresh from the Mob's current
 * Level and Tier every time (mob.mjs's statPointsAvailable/statPointsSpent),
 * so spending there just changes the Stat; "remaining" recomputes itself
 * automatically on the next render. See #remainingPoints/#spendPoint below
 * for where that branch actually lives - everything else (the dialog shell,
 * the +/- UI, the session-start floor on decrementing) is shared.
 *
 * Stays open across multiple +/- clicks rather than closing after one
 * change, mirroring module/apps/gm-toolbox.mjs's increment/decrement-then-
 * render pattern - this is a live, repeatable editor, not a one-shot prompt
 * (so it doesn't use carl-dialog.mjs's showCarlDialog, which is for
 * collect-once forms).
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ApplicationV2 } = foundry.applications.api;

export default class CarlSpendStatPointsDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @param {Actor} actor */
  constructor(actor, options = {}) {
    super({ id: `carl-spend-stat-points-${actor.id}`, ...options });
    this.actor = actor;
    this.isMob = actor.type === "mob";
    // Snapshot each Stat's value as it stood when the dialog opened - the
    // decrement button only undoes points spent THIS session, it's never a
    // general way to lower a Stat below where it already was.
    this.initialStats = Object.fromEntries(
      Object.entries(actor.system.stats ?? {}).map(([key, stat]) => [key, stat.value])
    );
  }

  /**
   * Points available to spend right now. A Character reads its own stored
   * pool; a Mob's is a pure function of Level/Tier, recomputed by mob.mjs's
   * prepareDerivedData every pass - never stored, so there's nothing to
   * decrement/increment here beyond the Stat itself (see #spendPoint).
   */
  #remainingPoints() {
    if (this.isMob) {
      const sys = this.actor.system;
      return Math.max(0, (sys.statPointsAvailable ?? 0) - (sys.statPointsSpent ?? 0));
    }
    return this.actor.system.bankedStatPoints ?? 0;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "carl-spend-stat-points"],
    window: {
      title: "CARLRPG.SpendStatPoints.Title",
      icon: "fas fa-arrow-up",
    },
    position: { width: 320, height: "auto" },
    actions: {
      incrementStat: CarlSpendStatPointsDialog.#onIncrementStat,
      decrementStat: CarlSpendStatPointsDialog.#onDecrementStat,
    },
  };

  /** @override */
  get title() {
    return game.i18n.format("CARLRPG.SpendStatPoints.TitleFor", { name: this.actor.name });
  }

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/spend-stat-points.hbs" },
  };

  /** @override */
  async _prepareContext(options) {
    const stats = Object.entries(this.actor.system.stats ?? {}).map(([key, stat]) => ({
      key,
      label: stat.label,
      value: stat.value,
      effective: stat.effective,
      atInitial: stat.value <= (this.initialStats[key] ?? stat.value),
    }));
    const sys = this.actor.system;
    return {
      isMob: this.isMob,
      remainingPoints: this.#remainingPoints(),
      // Mob-only reference line so the GM can see the math behind the
      // number, not just trust it - see mob.mjs's statPointsBase/
      // statPointsPerLevel docstring for the Table 50 / p.270 source.
      statPointsBase: sys.statPointsBase,
      statPointsPerLevel: sys.statPointsPerLevel,
      level: sys.level,
      mobTier: sys.mobTier,
      stats,
    };
  }

  static async #onIncrementStat(event, target) {
    const key = target.dataset.key;
    if (this.#remainingPoints() <= 0) return;
    const current = this.actor.system.stats[key]?.value ?? 0;
    const updates = { [`system.stats.${key}.value`]: current + 1 };
    // A Character's "remaining" is a stored pool that must be decremented
    // alongside the Stat; a Mob's is derived fresh from Level/Tier/current
    // stat totals every pass, so incrementing the Stat alone is already
    // enough for #remainingPoints() to read correctly next render.
    if (!this.isMob) updates["system.bankedStatPoints"] = (this.actor.system.bankedStatPoints ?? 0) - 1;
    await this.actor.update(updates);
    this.render();
  }

  static async #onDecrementStat(event, target) {
    const key = target.dataset.key;
    const current = this.actor.system.stats[key]?.value ?? 0;
    // Never below this Stat's value when the dialog opened - decrement only
    // undoes points spent this session, see constructor's initialStats.
    if (current <= (this.initialStats[key] ?? 1)) return;
    const updates = { [`system.stats.${key}.value`]: current - 1 };
    if (!this.isMob) updates["system.bankedStatPoints"] = (this.actor.system.bankedStatPoints ?? 0) + 1;
    await this.actor.update(updates);
    this.render();
  }
}
