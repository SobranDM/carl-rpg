import { pickerGroups } from "./actor-picker.mjs";
import { awardAchievement, awardedCopy, revokeAchievement } from "../helpers/achievements.mjs";
import { boxTierRank } from "../helpers/boxes.mjs";
import { itemDescriptions, itemTooltips } from "../helpers/rich-text.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The GM's Achievements grid (docs/loot-and-achievements.md): crawlers
 * across the top - those whose player is online, and the rest if "Show
 * offline" is ticked - and achievements down the side: the Items sidebar's,
 * and one compendium's. Each cell is the achievement's icon: dimmed until
 * the crawler has it (click to award it), lit once awarded, with a check
 * once its loot box is opened. Click (or right-click) an awarded one to take
 * it back, after a confirmation.
 */
export default class AchievementGrid extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "carl-achievement-grid",
    classes: ["carl-rpg", "carl-achievement-grid"],
    window: { title: "CARLRPG.Achievement.Grid.Title", icon: "fas fa-trophy", resizable: true },
    position: { width: 720, height: "auto" },
    actions: {
      award: AchievementGrid.#onAward,
      toggleOffline: AchievementGrid.#onToggleOffline,
    },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/achievement-grid.hbs" },
  };

  /** Crawlers whose player isn't online are shown too. */
  showOffline = false;

  /** Hook ids to remove on close. */
  #hooks = [];

  /**
   * Open the grid (GM; one window).
   * @returns {AchievementGrid|null}
   */
  static open() {
    if (!game.user.isGM) return null;
    const existing = foundry.applications.instances.get("carl-achievement-grid");
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const app = new AchievementGrid();
    app.render({ force: true });
    return app;
  }

  /** The chosen compendium's achievements, loaded once: {packId, docs}. */
  #packCache = null;

  /**
   * The achievements the grid lists: the Items sidebar's, then the chosen
   * compendium's (loaded once per compendium); by grade, Bronze first, then
   * name.
   * @returns {Promise<Item[]>}
   */
  async definitions() {
    const defs = game.items.filter((i) => i.type === "achievement");
    const packId = game.settings.get("carl-rpg", "achievementGridPack");
    if (this.#packCache?.packId !== packId) {
      const pack = game.packs.get(packId);
      const docs =
        pack?.documentName === "Item" ? await pack.getDocuments({ type: "achievement" }) : [];
      this.#packCache = { packId, docs };
    }
    defs.push(...this.#packCache.docs);
    return defs.sort(
      (a, b) =>
        boxTierRank(a.system.grade) - boxTierRank(b.system.grade) || a.name.localeCompare(b.name),
    );
  }

  /** @override */
  async _prepareContext(options) {
    const groups = pickerGroups();
    const columns = [...groups.active, ...(this.showOffline ? groups.other : [])];
    const defs = await this.definitions();
    const tooltips = {};
    for (const def of defs) {
      tooltips[def.uuid] = itemTooltips([def], await itemDescriptions([def]))[def.id];
    }
    const packId = game.settings.get("carl-rpg", "achievementGridPack");
    return {
      showOffline: this.showOffline,
      columns: columns.map((a) => ({ id: a.id, name: a.name, img: a.img })),
      rows: defs.map((def) => ({
        uuid: def.uuid,
        name: def.name,
        img: def.img,
        tooltip: tooltips[def.uuid],
        cells: columns.map((actor) => {
          const copy = awardedCopy(actor, def.uuid);
          return {
            actorId: actor.id,
            state: copy ? (copy.system.rewarded ? "rewarded" : "awarded") : "none",
            tooltip: game.i18n.format(
              copy ? "CARLRPG.Achievement.Grid.Awarded" : "CARLRPG.Achievement.Grid.Award",
              { name: actor.name, achievement: def.name },
            ),
          };
        }),
      })),
      packId,
      packChoices: {
        "": "CARLRPG.Achievement.Grid.NoPack",
        ...Object.fromEntries(
          game.packs.filter((p) => p.documentName === "Item").map((p) => [p.collection, p.title]),
        ),
      },
    };
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // A crawler's achievements and boxes, crawlers coming and going, a
    // player logging in or out. Never once closed (it would reopen).
    const redraw = () => {
      if (this.rendered) this.render();
    };
    const items = (item) => {
      if (["achievement", "box"].includes(item?.type)) {
        // A compendium achievement edited: load them again.
        if (item.pack) this.#packCache = null;
        redraw();
      }
    };
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
      this.#hooks.push([hook, Hooks.on(hook, items)]);
    }
    for (const hook of ["createActor", "deleteActor", "userConnected"]) {
      this.#hooks.push([hook, Hooks.on(hook, redraw)]);
    }
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector("select[name=packId]")?.addEventListener("change", async (event) => {
      await game.settings.set("carl-rpg", "achievementGridPack", event.target.value);
      this.render();
    });
    for (const cell of this.element.querySelectorAll(".carl-grid-cell[data-state]")) {
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.#onRevoke(cell);
      });
    }
  }

  /** @override */
  async _onClose(options) {
    for (const [hook, id] of this.#hooks) Hooks.off(hook, id);
    this.#hooks = [];
    await super._onClose(options);
  }

  /** The crawler and achievement a cell is for. */
  static async #cellTargets(cell) {
    const actor = game.actors.get(cell.dataset.actorId);
    const definition = await fromUuid(cell.closest("[data-uuid]")?.dataset.uuid ?? "");
    return { actor, definition };
  }

  /**
   * A dimmed cell: award it. A lit one: take it back, after asking (ruled
   * 2026-11-19 - a left-click as well as a right-click).
   */
  static async #onAward(event, target) {
    const { actor, definition } = await AchievementGrid.#cellTargets(target);
    if (!actor || !definition) return;
    if (awardedCopy(actor, definition.uuid)) return this.#onRevoke(target);
    await awardAchievement(definition, actor);
  }

  static #onToggleOffline() {
    this.showOffline = !this.showOffline;
    this.render();
  }

  /** Right-click an awarded cell: take it back, after asking. */
  async #onRevoke(cell) {
    const { actor, definition } = await AchievementGrid.#cellTargets(cell);
    const copy = definition ? awardedCopy(actor, definition.uuid) : null;
    if (!copy) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CARLRPG.Achievement.Grid.RevokeTitle") },
      content: `<p>${game.i18n.format("CARLRPG.Achievement.Grid.RevokeText", {
        name: foundry.utils.escapeHTML(actor.name),
        achievement: foundry.utils.escapeHTML(copy.name),
      })}</p>`,
    });
    if (ok) await revokeAchievement(copy);
  }
}
