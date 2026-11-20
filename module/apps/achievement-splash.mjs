import { enrichDescription } from "../helpers/rich-text.mjs";
import { playSound } from "../helpers/sounds.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The New Achievement! splash (docs/loot-and-achievements.md; p.17's
 * pop-ups): the achievement's icon, name, description and reward. Shown
 * only to the player whose crawler earned it, and it stays until they close
 * it, so they can read it out to the table (ruled 2026-11-19). Closing it
 * marks the copy seen; one not yet seen (its player was offline) shows when
 * they next log in.
 */
export default class AchievementSplash extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @param {Item} achievement  An awarded copy. */
  constructor(achievement, options = {}) {
    super({ id: `carl-achievement-${achievement.id}`, ...options });
    this.achievement = achievement;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "carl-achievement-splash"],
    // No window chrome: the paint-splash banner is the splash, with its own
    // X (the built-in "close" action).
    window: { frame: false, title: "CARLRPG.Achievement.New" },
    position: { width: 680, height: "auto", top: 90 },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/achievement-splash.hbs" },
  };

  /**
   * Is this client the one to show a copy's splash? Its crawler's player:
   * not the GM, who awarded it.
   * @param {Item} achievement
   * @returns {boolean}
   */
  static showsHere(achievement) {
    const actor = achievement?.parent;
    return (
      achievement?.type === "achievement" &&
      !achievement.system.seen &&
      !game.user.isGM &&
      actor?.type === "character" &&
      actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    );
  }

  /**
   * Show a copy's splash (once per copy, however often it's asked for).
   * @param {Item} achievement
   * @returns {AchievementSplash}
   */
  static show(achievement) {
    const existing = foundry.applications.instances.get(`carl-achievement-${achievement.id}`);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const app = new AchievementSplash(achievement);
    app.render({ force: true });
    // Its player hears it (not the GM, who awarded it).
    if (AchievementSplash.showsHere(achievement)) playSound("achievement");
    return app;
  }

  /**
   * Show this player the splashes of new achievements: as they're awarded,
   * and on login any they haven't closed yet. Call from `ready`.
   */
  static registerHooks() {
    Hooks.on("createItem", (item) => {
      if (AchievementSplash.showsHere(item)) AchievementSplash.show(item);
    });
    for (const actor of game.actors) {
      for (const item of actor.items) {
        if (AchievementSplash.showsHere(item)) AchievementSplash.show(item);
      }
    }
  }

  /** @override */
  async _prepareContext(options) {
    const item = this.achievement;
    return {
      img: item.img,
      name: item.name,
      crawler: item.parent?.name ?? "",
      descriptionHTML: await enrichDescription(item.system.description, item),
      reward: item.system.reward,
    };
  }

  /**
   * Escape doesn't close it - it stays until its X is clicked (ruled
   * 2026-11-19).
   * @override
   */
  async close(options = {}) {
    if (options.closeKey) return this;
    return super.close(options);
  }

  /**
   * Closed: seen. (A copy deleted meanwhile has nothing to mark.)
   * @override
   */
  async _onClose(options) {
    await super._onClose(options);
    const item = this.achievement;
    if (item?.parent?.items.get(item.id) && !item.system.seen && item.isOwner) {
      await item.update({ "system.seen": true });
    }
  }
}
