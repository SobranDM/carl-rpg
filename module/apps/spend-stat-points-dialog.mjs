/**
 * Spend Stat Points dialog: one banked point buys exactly +1 to one Stat's
 * base value (Third Floor+ Crawler Advancement rule - a saferoom is needed
 * to distribute Stat points gained from leveling). Stays open across
 * multiple +/- clicks rather than closing after one change, mirroring
 * module/apps/gm-toolbox.mjs's increment/decrement-then-render pattern -
 * this is a live, repeatable editor, not a one-shot prompt (so it doesn't
 * use carl-dialog.mjs's showCarlDialog, which is for collect-once forms).
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ApplicationV2 } = foundry.applications.api;

export default class CarlSpendStatPointsDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @param {Actor} actor */
  constructor(actor, options = {}) {
    super({ id: `carl-spend-stat-points-${actor.id}`, ...options });
    this.actor = actor;
    // Snapshot each Stat's value as it stood when the dialog opened - the
    // decrement button only undoes points spent THIS session, it's never a
    // general way to lower a Stat below where it already was.
    this.initialStats = Object.fromEntries(
      Object.entries(actor.system.stats ?? {}).map(([key, stat]) => [key, stat.value])
    );
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
    return {
      bankedStatPoints: this.actor.system.bankedStatPoints ?? 0,
      stats,
    };
  }

  static async #onIncrementStat(event, target) {
    const key = target.dataset.key;
    const banked = this.actor.system.bankedStatPoints ?? 0;
    if (banked <= 0) return;
    const current = this.actor.system.stats[key]?.value ?? 0;
    await this.actor.update({
      [`system.stats.${key}.value`]: current + 1,
      "system.bankedStatPoints": banked - 1,
    });
    this.render();
  }

  static async #onDecrementStat(event, target) {
    const key = target.dataset.key;
    const current = this.actor.system.stats[key]?.value ?? 0;
    // Never below this Stat's value when the dialog opened - decrement only
    // undoes points spent this session, see constructor's initialStats.
    if (current <= (this.initialStats[key] ?? 1)) return;
    const banked = this.actor.system.bankedStatPoints ?? 0;
    await this.actor.update({
      [`system.stats.${key}.value`]: current - 1,
      "system.bankedStatPoints": banked + 1,
    });
    this.render();
  }
}
