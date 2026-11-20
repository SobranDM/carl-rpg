import { pickerGroups } from "./actor-picker.mjs";
import { awardAchievement, awardedCopy, revokeAchievement } from "../helpers/achievements.mjs";
import {
  achievementLibrary,
  createLibraryAchievement,
  deleteLibraryAchievement,
  ensureAchievementLibrary,
  libraryAchievements,
  updateLibraryAchievement,
} from "../helpers/achievement-library.mjs";
import { boxTierRank } from "../helpers/boxes.mjs";
import { enrichDescription, itemDescriptions, itemTooltips } from "../helpers/rich-text.mjs";
import { labelChoices } from "../helpers/html.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The GM's Achievements window (docs/loot-and-achievements.md): every
 * achievement is made, edited and awarded here (ruled 2026-11-19); they're
 * kept in the Achievements library, a world compendium the GM never needs
 * to open (helpers/achievement-library.mjs).
 *
 * Crawlers across the top - those whose player is online, and the rest if
 * "Show offline" is ticked - and achievements down the side, by grade. Each
 * cell is the achievement's icon: dimmed until the crawler has it (click to
 * award it), lit once awarded, with a check once its loot box is opened.
 * Click (or right-click) an awarded one to take it back, after a
 * confirmation. New Achievement, or an achievement's name, opens its editor
 * below the grid.
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
      newAchievement: AchievementGrid.#onNew,
      editAchievement: AchievementGrid.#onEdit,
      closeEditor: AchievementGrid.#onCloseEditor,
      deleteAchievement: AchievementGrid.#onDelete,
    },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/achievement-grid.hbs" },
  };

  /** Crawlers whose player isn't online are shown too. */
  showOffline = false;

  /** The uuid of the achievement open in the editor. */
  editing = null;

  /** Hook ids to remove on close. */
  #hooks = [];

  /** The library's achievements, loaded once until one changes. */
  #cache = null;

  /**
   * Open the window (GM; one window). Makes the library if it's missing.
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
    ensureAchievementLibrary().then(() => app.render({ force: true }));
    return app;
  }

  /**
   * The library's achievements, by grade (Bronze first), then name.
   * @returns {Promise<Item[]>}
   */
  async definitions() {
    this.#cache ??= await libraryAchievements();
    return [...this.#cache].sort(
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
    const editing = defs.find((d) => d.uuid === this.editing) ?? null;
    if (!editing) this.editing = null;
    return {
      showOffline: this.showOffline,
      columns: columns.map((a) => ({ id: a.id, name: a.name, img: a.img })),
      rows: defs.map((def) => ({
        uuid: def.uuid,
        name: def.name,
        img: def.img,
        tooltip: tooltips[def.uuid],
        editing: def.uuid === this.editing,
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
      editor: editing
        ? {
            uuid: editing.uuid,
            name: editing.name,
            img: editing.img,
            system: editing.system,
            gradeChoices: labelChoices(CONFIG.CARLRPG.lootBoxTiers),
            descriptionHTML: await enrichDescription(editing.system.description, editing, {
              secrets: true,
            }),
          }
        : null,
    };
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // A crawler's achievements and boxes, the library's achievements,
    // crawlers coming and going, a player logging in or out. Never once
    // closed (it would reopen).
    const redraw = () => {
      if (this.rendered) this.render();
    };
    const items = (item) => {
      if (!["achievement", "box"].includes(item?.type)) return;
      if (item.pack && item.pack === achievementLibrary()?.collection) this.#cache = null;
      redraw();
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
    for (const cell of this.element.querySelectorAll(".carl-grid-cell[data-state]")) {
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.#onRevoke(cell);
      });
    }
    // The editor: each field saves as it changes.
    const editor = this.element.querySelector(".carl-achievement-editor");
    if (!editor) return;
    for (const field of editor.querySelectorAll("input[name], select[name], textarea[name]")) {
      field.addEventListener("change", () => {
        const value = field.type === "checkbox" ? field.checked : field.value;
        this.#save({ [field.name]: value });
      });
    }
    editor.querySelector("prose-mirror")?.addEventListener("change", (event) => {
      this.#save({ "system.description": event.currentTarget.value ?? "" });
    });
  }

  /** @override */
  async _onClose(options) {
    for (const [hook, id] of this.#hooks) Hooks.off(hook, id);
    this.#hooks = [];
    await super._onClose(options);
  }

  /** The achievement open in the editor. */
  async #editingDoc() {
    return (await this.definitions()).find((d) => d.uuid === this.editing) ?? null;
  }

  /** Save an edit to the achievement open in the editor. */
  async #save(changes) {
    const def = await this.#editingDoc();
    if (def) await updateLibraryAchievement(def, changes);
  }

  /** The crawler and achievement a cell is for. */
  async #cellTargets(cell) {
    const actor = game.actors.get(cell.dataset.actorId);
    const uuid = cell.closest("[data-uuid]")?.dataset.uuid ?? "";
    const definition = (await this.definitions()).find((d) => d.uuid === uuid) ?? null;
    return { actor, definition };
  }

  /**
   * A dimmed cell: award it. A lit one: take it back, after asking (ruled
   * 2026-11-19 - a left-click as well as a right-click).
   */
  static async #onAward(event, target) {
    const { actor, definition } = await this.#cellTargets(target);
    if (!actor || !definition) return;
    if (awardedCopy(actor, definition.uuid)) return this.#onRevoke(target);
    await awardAchievement(definition, actor);
  }

  static #onToggleOffline() {
    this.showOffline = !this.showOffline;
    this.render();
  }

  /** New Achievement: made in the library, and opened in the editor. */
  static async #onNew() {
    const def = await createLibraryAchievement();
    if (!def) return;
    this.#cache = null;
    this.editing = def.uuid;
    this.render();
  }

  /** An achievement's name: its editor (again: closed). */
  static #onEdit(event, target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid ?? null;
    this.editing = this.editing === uuid ? null : uuid;
    this.render();
  }

  static #onCloseEditor() {
    this.editing = null;
    this.render();
  }

  /** Delete the achievement in the editor, after asking. */
  static async #onDelete() {
    const def = await this.#editingDoc();
    if (!def) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CARLRPG.Achievement.Grid.DeleteTitle") },
      content: `<p>${game.i18n.format("CARLRPG.Achievement.Grid.DeleteText", {
        achievement: foundry.utils.escapeHTML(def.name),
      })}</p>`,
    });
    if (!ok) return;
    await deleteLibraryAchievement(def);
    this.#cache = null;
    this.editing = null;
    this.render();
  }

  /** Take an award back, after asking. */
  async #onRevoke(cell) {
    const { actor, definition } = await this.#cellTargets(cell);
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
