import { pickerGroups } from "./actor-picker.mjs";
import {
  achievementBox,
  achievementBoxOf,
  achievementCategories,
  achievementSections,
  collapsedCategories,
  searchText,
  toggleCategory,
  awardAchievement,
  awardedCopy,
  preparedBoxFor,
  revokeAchievement,
  setPreparedBoxFor,
} from "../helpers/achievements.mjs";
import {
  achievementLibrary,
  createLibraryAchievement,
  deleteLibraryAchievement,
  ensureAchievementLibrary,
  libraryAchievements,
  updateLibraryAchievement,
} from "../helpers/achievement-library.mjs";
import { boxDraftForForge, clearBoxContents, prepareBox } from "../helpers/boxes.mjs";
import { generateLoot } from "../helpers/loot.mjs";
import LootForge from "./loot-forge.mjs";
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
 * "Show offline" is ticked - and achievements down the side: alphabetical,
 * a category's achievements grouped under its name, Bronze to Celestial
 * (helpers/achievements.mjs achievementSections). Each
 * cell is the achievement's icon: dimmed until the crawler has it (click to
 * award it), lit once awarded, with a check once its loot box is opened.
 * Click an awarded one to take it back, after a confirmation. Right-click
 * any to prepare that crawler's loot box for it. New Achievement, or an achievement's name, opens its editor
 * in a column beside the grid; the window has a set height, and each
 * column scrolls on its own (ruled 2026-11-21). For an achievement with a loot box, the editor lists the
 * crawlers: the GM can prepare what each one's box holds (ruled 2026-11-19:
 * per crawler) - before it's awarded, or after, until it's opened.
 */
export default class AchievementGrid extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "carl-achievement-grid",
    classes: ["carl-rpg", "carl-achievement-grid"],
    window: { title: "CARLRPG.Achievement.Grid.Title", icon: "fas fa-trophy", resizable: true },
    // A set height, so the list and the editor beside it each scroll on
    // their own (ruled 2026-11-21); wide enough for both.
    position: { width: 1000, height: 700 },
    actions: {
      award: AchievementGrid.#onAward,
      toggleOffline: AchievementGrid.#onToggleOffline,
      toggleCategory: AchievementGrid.#onToggleCategory,
      newAchievement: AchievementGrid.#onNew,
      editAchievement: AchievementGrid.#onEdit,
      closeEditor: AchievementGrid.#onCloseEditor,
      deleteAchievement: AchievementGrid.#onDelete,
      prepareFor: AchievementGrid.#onPrepareFor,
      clearFor: AchievementGrid.#onClearFor,
    },
  };

  /** @override */
  static PARTS = {
    // Awarding redraws the window: each column keeps where it was scrolled.
    body: {
      template: "systems/carl-rpg/templates/apps/achievement-grid.hbs",
      scrollable: [".carl-grid-scroll", ".carl-achievement-editor"],
    },
  };

  /**
   * Crawlers whose player isn't online are shown too. Until the GM ticks or
   * unticks it (null), it's on when no player is online (ruled 2026-11-19).
   * @type {boolean|null}
   */
  showOffline = null;

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
   * The library's achievements (in no order: achievementSections orders
   * them for the window).
   * @returns {Promise<Item[]>}
   */
  async definitions() {
    this.#cache ??= await libraryAchievements();
    return [...this.#cache];
  }

  /** @override */
  async _prepareContext(options) {
    const groups = pickerGroups();
    const showOffline = this.showOffline ?? !groups.active.length;
    const columns = [...groups.active, ...(showOffline ? groups.other : [])];
    const defs = await this.definitions();
    const tooltips = {};
    for (const def of defs) {
      tooltips[def.uuid] = itemTooltips([def], await itemDescriptions([def]))[def.id];
    }
    const editing = defs.find((d) => d.uuid === this.editing) ?? null;
    if (!editing) this.editing = null;
    const collapsed = collapsedCategories();
    const rowOf = (def) => ({
      uuid: def.uuid,
      name: def.name,
      img: def.img,
      tooltip: tooltips[def.uuid],
      editing: def.uuid === this.editing,
      cells: columns.map((actor) => {
        const copy = awardedCopy(actor, def.uuid);
        const data = { name: actor.name, achievement: def.name };
        const tooltip = [
          game.i18n.format(
            copy ? "CARLRPG.Achievement.Grid.Awarded" : "CARLRPG.Achievement.Grid.Award",
            data,
          ),
        ];
        // Right-click: this crawler's loot box, until it's opened.
        if (def.system.lootBox && boxState(actor, def).canPrepare) {
          tooltip.push(game.i18n.localize("CARLRPG.Achievement.Grid.RightClickPrepare"));
        }
        return {
          actorId: actor.id,
          state: copy ? (copy.system.rewarded ? "rewarded" : "awarded") : "none",
          tooltip: tooltip.join(" "),
        };
      }),
    });
    return {
      showOffline,
      search: this.#search,
      columns: columns.map((a) => ({ id: a.id, name: a.name, img: a.img })),
      // Grouped by category, alphabetical (helpers/achievements.mjs).
      // A category folded by its heading shows only that (ruled 2026-11-21).
      sections: achievementSections(defs).map((section) => ({
        key: section.key,
        category: section.category,
        collapsed: !!section.key && collapsed.has(section.key),
        count: section.items.length,
        // What the search box finds it by: its name or its category.
        rows: section.items.map((def) => ({
          ...rowOf(def),
          search: searchText(`${def.name} ${section.category ?? ""}`),
        })),
      })),
      // A category heading spans the achievement column and every crawler's.
      span: columns.length + 1,
      editor: editing
        ? {
            uuid: editing.uuid,
            name: editing.name,
            img: editing.img,
            system: editing.system,
            gradeChoices: labelChoices(CONFIG.CARLRPG.lootBoxTiers),
            categories: achievementCategories(defs),
            descriptionHTML: await enrichDescription(editing.system.description, editing, {
              secrets: true,
            }),
            boxes: editing.system.lootBox
              ? columns.map((actor) => ({
                  actorId: actor.id,
                  name: actor.name,
                  ...boxState(actor, editing),
                }))
              : null,
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
    // A crawler's box prepared ahead of its award (a flag on the crawler).
    this.#hooks.push([
      "updateActor",
      Hooks.on("updateActor", (actor, changed) => {
        if (foundry.utils.hasProperty(changed, "flags.carl-rpg")) redraw();
      }),
    ]);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    // The search box filters as it's typed in, without a redraw (which
    // would take the cursor out of it); a redraw keeps what's in it.
    const search = this.element.querySelector(".carl-grid-search");
    search?.addEventListener("input", () => {
      this.#search = search.value;
      this.#applySearch();
    });
    this.#applySearch();
    // Right-click a trophy: that crawler's loot box for it, as in the
    // editor (ruled 2026-11-19). Taking an award back is a left-click.
    for (const cell of this.element.querySelectorAll(".carl-grid-cell")) {
      cell.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        const { actor, definition } = await this.#cellTargets(cell);
        if (actor && definition) await this.#prepareFor(definition, actor);
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

  /** A category's heading: fold or unfold it. */
  /** What's in the search box (ruled 2026-11-21). */
  #search = "";

  /**
   * Show only the achievements whose name or category holds the search
   * text, in any category, folded or not (a fold opens while searching);
   * a category with none is hidden, and a line says when nothing matches.
   */
  #applySearch() {
    const root = this.element;
    if (!root) return;
    const query = searchText(this.#search);
    root.querySelector(".carl-grid")?.classList.toggle("carl-grid-searching", !!query);
    let shown = 0;
    for (const group of root.querySelectorAll(".carl-grid-table tbody")) {
      let any = false;
      for (const row of group.querySelectorAll("tr.carl-grid-row")) {
        const hit = !query || row.dataset.search.includes(query);
        row.hidden = !hit;
        if (hit) {
          any = true;
          shown++;
        }
      }
      group.hidden = !!query && !any;
    }
    root.querySelector(".carl-grid-no-match")?.toggleAttribute("hidden", !query || shown > 0);
  }

  static async #onToggleCategory(event, target) {
    await toggleCategory(target.dataset.key);
    this.render();
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

  /**
   * Prepare one crawler's loot box for the achievement in the editor, in
   * the Loot Forge: its box if it has been awarded (until it's opened),
   * else what it will hold when it is - a roll for them to start from.
   */
  static async #onPrepareFor(event, target) {
    const def = await this.#editingDoc();
    const actor = game.actors.get(target.closest("[data-actor-id]")?.dataset.actorId);
    if (def && actor) await this.#prepareFor(def, actor);
  }

  /**
   * Open the Loot Forge on a crawler's loot box for an achievement: nothing
   * for one that gives no box, or whose box is opened.
   * @param {Item} def
   * @param {Actor} actor
   */
  async #prepareFor(def, actor) {
    if (!def.system.lootBox) {
      ui.notifications.info(game.i18n.localize("CARLRPG.Achievement.Grid.NoLootBox"));
      return;
    }
    const copy = awardedCopy(actor, def.uuid);
    const box = copy ? achievementBoxOf(copy) : null;
    if (copy && !box) {
      ui.notifications.info(game.i18n.localize("CARLRPG.Achievement.Grid.BoxOpened"));
      return;
    }
    const tierKey = achievementBox(def)?.tierKey ?? def.system.grade;
    const draft = box
      ? await boxDraftForForge(box)
      : (foundry.utils.deepClone(preparedBoxFor(actor, def)) ??
        (await generateLoot(tierKey, { recipient: actor })));
    if (!draft) return;
    await LootForge.open({
      draft,
      recipient: actor,
      title: game.i18n.format("CARLRPG.Achievement.Grid.PrepareTitle", {
        name: actor.name,
        achievement: def.name,
      }),
      onSave: (saved) => (box ? prepareBox(box, saved) : setPreparedBoxFor(actor, def, saved)),
    });
  }

  /** Back to a roll when the box is opened, for one crawler. */
  static async #onClearFor(event, target) {
    const def = await this.#editingDoc();
    const actor = game.actors.get(target.closest("[data-actor-id]")?.dataset.actorId);
    if (!def || !actor) return;
    const copy = awardedCopy(actor, def.uuid);
    const box = copy ? achievementBoxOf(copy) : null;
    if (box) await clearBoxContents(box);
    else if (!copy) await setPreparedBoxFor(actor, def, null);
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

/**
 * Where a crawler's loot box for an achievement stands, for the editor:
 * opened; awarded and waiting (prepared, or to be rolled); or not awarded
 * yet (prepared ahead, or to be rolled).
 * @returns {{label: string, canPrepare: boolean, prepared: boolean}}
 */
function boxState(actor, definition) {
  const copy = awardedCopy(actor, definition.uuid);
  const key = (k) => `CARLRPG.Achievement.Grid.Box.${k}`;
  if (copy) {
    const box = achievementBoxOf(copy);
    if (!box) return { label: key("Opened"), canPrepare: false, prepared: false };
    const prepared = box.system.contents.mode === "prepared";
    return {
      label: key(prepared ? "AwardedPrepared" : "AwardedRandom"),
      canPrepare: true,
      prepared,
    };
  }
  const prepared = !!preparedBoxFor(actor, definition);
  return { label: key(prepared ? "Prepared" : "Random"), canPrepare: true, prepared };
}
