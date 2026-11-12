const { HandlebarsApplicationMixin } = foundry.applications.api;
const { DocumentSheetV2 } = foundry.applications.api;
import { onAddArrayItem, onDeleteArrayItem } from "../helpers/array-editor.mjs";
import { onToggleDrawer } from "../helpers/drawer-toggle.mjs";
import { addConditionToActor } from "../helpers/conditions.mjs";
import DragDropMixin from "./mixins/drag-drop-mixin.mjs";
import CarlSpendStatPointsDialog from "../apps/spend-stat-points-dialog.mjs";
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import {
  assignItemToSlot,
  clearSlot,
  isItemWorn,
  resolveSlotValue,
  unwearItem,
} from "../helpers/equip-slots.mjs";
import CarlDice from "../dice/dice.mjs";
import { isLootBoxItem, takeLootItem } from "../helpers/loot-box.mjs";

/** Skill list order on the sheet (skill.mjs `category`); anything else sorts last. */
const SKILL_CATEGORY_ORDER = ["attack", "utility", "passive"];

/** Position of a Skill's category in SKILL_CATEGORY_ORDER (unknown last). */
const skillCategoryRank = (category) =>
  SKILL_CATEGORY_ORDER.indexOf(category) + 1 || SKILL_CATEGORY_ORDER.length + 1;

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {DocumentSheetV2}
 * @mixes {HandlebarsApplication}
 * @mixes {DragDropMixin}
 */
export class CarlRPGActorSheet extends DragDropMixin(HandlebarsApplicationMixin(DocumentSheetV2)) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "sheet", "actor"],
    position: { width: 700, height: 680 },
    form: {
      submitOnChange: true,
    },
    actions: {
      editItem: CarlRPGActorSheet.#editItem,
      createItem: CarlRPGActorSheet.#createItem,
      deleteItem: CarlRPGActorSheet.#deleteItem,
      roll: CarlRPGActorSheet.#onRoll,
      rollEvade: CarlRPGActorSheet.#onRollEvade,
      rollMobAttack: CarlRPGActorSheet.#onRollMobAttack,
      rollStat: CarlRPGActorSheet.#onRollStat,
      toggleMark: CarlRPGActorSheet.#onToggleMark,
      toggleEquipped: CarlRPGActorSheet.#onToggleEquipped,
      addCondition: CarlRPGActorSheet.#onAddCondition,
      addArrayItem: CarlRPGActorSheet.#onAddArrayItem,
      deleteArrayItem: CarlRPGActorSheet.#onDeleteArrayItem,
      toggleDrawer: CarlRPGActorSheet.#onToggleDrawer,
      setHbValue: CarlRPGActorSheet.#onSetHbValue,
      setShieldValue: CarlRPGActorSheet.#onSetShieldValue,
      spendStatPoints: CarlRPGActorSheet.#onSpendStatPoints,
      clearSlot: CarlRPGActorSheet.#onClearSlot,
      sortList: CarlRPGActorSheet.#onSortList,
    },
  };

  /** @override */
  static TABS = {
    primary: {
      tabs: [
        { id: "abilities", label: "CARLRPG.Tab.Abilities" },
        { id: "items", label: "CARLRPG.Tab.Inventory" },
        { id: "features", label: "CARLRPG.Tab.Boons" },
        { id: "conditions", label: "CARLRPG.Tab.Conditions" },
        { id: "defenses", label: "CARLRPG.Tab.Defenses" },
        { id: "pet", label: "CARLRPG.Tab.Pet" },
        { id: "description", label: "CARLRPG.Tab.Description" },
      ],
      initial: "abilities",
    },
  };

  /** @override */
  static PARTS = {
    header: {
      template: "systems/carl-rpg/templates/actor/parts/header.hbs",
    },
    tabs: {
      template: "templates/generic/tab-navigation.hbs",
    },
    abilities: {
      template: "systems/carl-rpg/templates/actor/parts/abilities.hbs",
      scrollable: [""],
    },
    items: {
      template: "systems/carl-rpg/templates/actor/parts/items-list.hbs",
      scrollable: [""],
    },
    features: {
      template: "systems/carl-rpg/templates/actor/parts/features-list.hbs",
      scrollable: [""],
    },
    conditions: {
      template: "systems/carl-rpg/templates/actor/parts/conditions.hbs",
      scrollable: [""],
    },
    defenses: {
      template: "systems/carl-rpg/templates/actor/parts/defenses.hbs",
      scrollable: [""],
    },
    pet: {
      template: "systems/carl-rpg/templates/actor/parts/pet.hbs",
      scrollable: [""],
    },
    description: {
      template: "systems/carl-rpg/templates/actor/parts/description.hbs",
      scrollable: [""],
    },
  };

  /**
   * Tabs that only make sense for a Character (the printed sheet's Pet
   * page) - a Mob is a static stat block with no such bookkeeping.
   * @type {string[]}
   */
  static CHARACTER_ONLY_TABS = ["pet"];

  /**
   * Sortable columns per list: header `data-sort-key` -> item property path.
   * @type {Object<string, Object<string, string>>}
   */
  static LIST_SORT_KEYS = {
    skills: { name: "name", category: "system.category", rank: "system.rank" },
    spells: { name: "name", manaCost: "system.manaCost", rank: "system.rank" },
    gear: { name: "name", quantity: "system.quantity", weight: "system.weight" },
  };

  /**
   * Active column sort per list, set by clicking a header (asc -> desc ->
   * off). Kept on the sheet rather than the actor: it's a view preference,
   * and "off" falls back to _prepareItems' fixed order.
   * @type {Object<string, {key: string, dir: 1|-1}>}
   */
  #listSort = {};

  /** @override */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    const isMob = this.actor.type === "mob";
    parts.header.template = isMob
      ? `systems/carl-rpg/templates/actor/parts/header-mob.hbs`
      : `systems/carl-rpg/templates/actor/parts/header.hbs`;
    // Mob's stat-block layout (Level/Surprise/Evade/Move/DR, an Attacks
    // list) is different enough content from the PC-shaped Abilities tab
    // (banked stat points, class/race-driven bonuses) that branching inside
    // one template would fight the grid rather than reuse it - same
    // reasoning as the header swap above, just for a different part.
    parts.abilities.template = isMob
      ? `systems/carl-rpg/templates/actor/parts/abilities-mob.hbs`
      : `systems/carl-rpg/templates/actor/parts/abilities.hbs`;
    if (this.actor.type !== "character") {
      for (const id of CarlRPGActorSheet.CHARACTER_ONLY_TABS) delete parts[id];
    }
    return parts;
  }

  /** @override */
  _getTabsConfig(group) {
    const config = super._getTabsConfig(group);
    if (!config || group !== "primary" || this.actor.type === "character") return config;
    return {
      ...config,
      tabs: config.tabs.filter((t) => !CarlRPGActorSheet.CHARACTER_ONLY_TABS.includes(t.id)),
    };
  }

  /**
   * The Actor document managed by this sheet.
   * @type {Actor}
   */
  get actor() {
    return this.document;
  }

  /* -------------------------------------------- */

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    // For the tabs navigation part, convert tabs object to array. Must not
    // mutate `context.tabs` in place: core passes the SAME context object to
    // every part, so later tab parts would lose their `tabs[partId]` lookup,
    // render without "active", and lose their scroll position (see
    // item-sheet.mjs's _preparePartContext for the same fix).
    if (partId === "tabs" && context.tabs) {
      return { ...context, tabs: Object.values(context.tabs) };
    }
    // For tab content parts, provide the tab context
    else {
      const tab = context.tabs?.[partId];
      if (tab) {
        context.tab = tab;
      }
    }
    return context;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = context.document;
    const actorData = actor.system;

    // Add the actor's data to context for easier access, as well as flags.
    context.actor = actor;
    context.data = actor.toObject(); // Legacy compatibility
    context.system = actorData;
    context.flags = actor.flags;
    context.config = CONFIG.CARLRPG;

    // Floor is a single world-wide value owned by the GM Toolbox, shown
    // read-only here for player visibility - never per-actor. See
    // module/data/character.mjs#getRollData.
    context.currentFloor = game.settings.get("carl-rpg", "currentFloor");

    // Active Class/Race display (header.hbs) - resolved on Character actors
    // only, see module/data/character.mjs#prepareDerivedData. Undefined on
    // Mobs (no class/race fields there), which header-mob.hbs doesn't read.
    context.classId = actorData.classItem?.id ?? "";
    context.className = actorData.classItem?.name ?? "";
    context.raceId = actorData.raceItem?.id ?? "";
    context.raceName = actorData.raceItem?.name ?? "";

    // Read-only "remaining" display for stats-column.hbs's Spend Stat
    // Points fieldset on a Mob (a Character instead reads its own editable
    // system.bankedStatPoints directly - see mob.mjs's statPointsAvailable/
    // statPointsSpent docstring for why Mob has no equivalent stored pool).
    if (actor.type === "mob") {
      context.statPointsRemaining = Math.max(
        0,
        (actorData.statPointsAvailable ?? 0) - (actorData.statPointsSpent ?? 0),
      );
    }

    // Template convenience variables
    context.cssClass = [...this.options.classes, actor.type].join(" ");
    context.owner = actor.isOwner;

    // Add items array for compatibility with legacy getData() structure;
    // _prepareItems sorts each list.
    context.items = Array.from(actor.items.values());

    this._prepareItems(context);

    // Health Bar slot-pip visualization (whole slots, not raw HP, per the book).
    context.hbPips = this._buildHbPips(actorData.hb);
    // Shield-style pool (docs/known-gaps.md 1.4) - same pip shape as HB.
    context.shieldPips = this._buildHbPips(actorData.shield);

    // Fixed-length free-text lists (Hotlist, Accessories, Deity...) - see
    // CONFIG.CARLRPG.characterListSlots. Mobs have none of these fields.
    if (actor.type === "character") {
      context.textSlots = this._buildTextSlots(actorData);
      context.equipSlots = this._buildEquipSlots(actorData);
    }

    // Add roll data for TinyMCE editors.
    context.rollData = actor.getRollData();

    context.biographyHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      actor.system.biography ?? "",
      { relativeTo: actor, secrets: actor.isOwner, rollData: context.rollData },
    );

    return context;
  }

  /**
   * Organize and classify Items for the actor sheet's list tabs.
   * @param {Object} context The context to prepare.
   * @return {undefined}
   */
  _prepareItems(context) {
    const gear = [];
    const features = [];
    const skills = [];
    const spells = [];
    const damageEffects = [];
    const raceAndClass = [];

    for (let i of context.items) {
      i.img = i.img || Item.DEFAULT_ICON;
      if (i.type === "item") gear.push(i);
      else if (i.type === "feature") features.push(i);
      else if (i.type === "skill") skills.push(i);
      else if (i.type === "spell") spells.push(i);
      else if (i.type === "damageEffect") {
        i.parentSkillsText = (i.system.parentSkills ?? []).join(", ");
        damageEffects.push(i);
      }
      // Shown on the Boons tab (features-list.hbs) alongside Features, so a
      // Race/Class can be opened or deleted from the sheet - previously
      // only reachable via the header's single "active" link, with no
      // delete affordance and no visibility into a second, unlinked one
      // (e.g. mid Third-Floor re-selection). See _prepareContext's
      // classId/raceId for which one (if any) is the active reference.
      else if (i.type === "class" || i.type === "race") {
        i.typeLabel = game.i18n.localize(`TYPES.Item.${i.type}`);
        raceAndClass.push(i);
      }
    }

    // Fixed ordering for every list: Skills by category (Attack, Utility,
    // Passive) then name; everything else by name (Race before Class).
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang, { sensitivity: "base" });
    skills.sort((a, b) => (skillCategoryRank(a.system.category) - skillCategoryRank(b.system.category)) || byName(a, b));
    for (const list of [gear, features, spells, damageEffects]) list.sort(byName);
    raceAndClass.sort((a, b) => (a.type === b.type ? 0 : a.type === "race" ? -1 : 1) || byName(a, b));

    context.gear = gear;
    context.features = features;
    context.skills = skills;
    context.spells = spells;
    context.damageEffects = damageEffects;
    context.raceAndClass = raceAndClass;

    // Header-click column sort (see #onSortList) on top of the fixed order
    // above, which is what "off" falls back to. Damage Effects nest under
    // their Skill, so they move with it.
    context.listSort = {};
    for (const [list, keys] of Object.entries(CarlRPGActorSheet.LIST_SORT_KEYS)) {
      const sort = this.#listSort[list];
      if (sort) this._sortList(context[list], keys[sort.key], sort.dir);
      context.listSort[list] = Object.fromEntries(
        Object.keys(keys).map((key) => [
          key,
          sort?.key !== key ? "fa-sort" : sort.dir === 1 ? "fa-sort-up" : "fa-sort-down",
        ]),
      );
    }

    // Many-to-one Skill<->Damage Effect nesting for the merged Abilities
    // tab (see abilities.hbs / skills-section-body.hbs). A Damage Effect
    // intentionally renders under EVERY owned Skill it matches (not
    // partitioned) - matches the "select at the moment of the attack roll"
    // mechanic and damage-effect.mjs's own many-to-one parentSkills model.
    const skillNameSet = new Set(skills.map((s) => s.name));
    for (const skill of skills) {
      skill.damageEffects = damageEffects.filter((de) =>
        (de.system.parentSkills ?? []).includes(skill.name),
      );
    }
    context.unmatchedDamageEffects = damageEffects.filter(
      (de) => !(de.system.parentSkills ?? []).some((name) => skillNameSet.has(name)),
    );
  }

  /**
   * Sort a list of items in place by one property. Numbers compare as
   * numbers, everything else as text (numeric-aware, case-insensitive);
   * ties fall back to name. Skill category sorts in SKILL_CATEGORY_ORDER
   * (Attack, Utility, Passive), matching the default order.
   * @param {Item[]} items
   * @param {string} path Property path on the item, e.g. "system.rank".
   * @param {1|-1} dir 1 for ascending, -1 for descending.
   */
  _sortList(items, path, dir) {
    const value = (item) => {
      const v = foundry.utils.getProperty(item, path);
      return path === "system.category" ? skillCategoryRank(v) : v;
    };
    const compare = (a, b) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a ?? "").localeCompare(String(b ?? ""), undefined, {
            numeric: true,
            sensitivity: "base",
          });
    items.sort(
      (a, b) =>
        dir * compare(value(a), value(b)) ||
        compare(a.name, b.name),
    );
  }

  /**
   * Build the Health Bar slot-pip array for the header (whole slots, not raw
   * HP, per the book, p.93-94). Each slot shows the creature's CON Mod (the
   * per-slot damage threshold) and its cumulative percentage - percentages
   * start at 100% on the rightmost slot and divide evenly per Table 50
   * (p.270)'s Mob/Boss HB-slot guidance, generalizing beyond the Crawler
   * default of 10. The pip container wraps (see _hb-pips.scss), so this
   * works for any slot count, including large Boss tiers.
   * @param {{value: number, effectiveMax: number, slotValue: number}} hb
   * @returns {{index: number, filled: boolean, slotValue: number, percent: number, hue: number}[]|null}
   */
  _buildHbPips(hb) {
    const max = Math.max(0, hb?.effectiveMax ?? 0);
    if (max === 0) return null;
    return Array.from({ length: max }, (_, i) => {
      const percent = Math.round(((i + 1) / max) * 100);
      return {
        index: i + 1,
        filled: i < hb.value,
        slotValue: hb.slotValue,
        percent,
        hue: Math.round(percent * 1.3),
      };
    });
  }

  /**
   * Pad each fixed-length free-text list out to its sheet slot count, so the
   * sheet always renders the full set of inputs. Keys are camelCased from
   * the field path ("pet.attacks" -> "petAttacks").
   * @param {object} system The Character's system data.
   * @returns {Object<string, {index: number, number: number, value: string, name: string}[]>}
   */
  _buildTextSlots(system) {
    const slots = {};
    for (const [path, count] of Object.entries(CONFIG.CARLRPG.characterListSlots)) {
      const current = foundry.utils.getProperty(system, path) ?? [];
      const key = path.replace(/\.(\w)/g, (_, c) => c.toUpperCase());
      slots[key] = Array.from({ length: Math.max(count, current.length) }, (_, i) => ({
        index: i,
        number: i + 1,
        value: current[i] ?? "",
        name: `system.${path}.${i}`,
      }));
    }
    return slots;
  }

  /**
   * Inventory tab's Hotlist and Equipped slots (items-list.hbs), each
   * resolved to the owned Item it holds - see helpers/equip-slots.mjs.
   * @param {object} system The Character's system data.
   * @returns {{hotlist: object[], gear: object[], accessories: object[], accessoryCount: number, accessoryMax: number, canAddAccessory: boolean, nextAccessoryIndex: number}}
   */
  _buildEquipSlots(system) {
    const { hotlist: hotlistMax, accessories: accessoryMax } = CONFIG.CARLRPG.characterListSlots;
    const hotlist = Array.from({ length: Math.max(hotlistMax, system.hotlist.length) }, (_, i) => ({
      index: i,
      number: i + 1,
      ...resolveSlotValue(this.actor, system.hotlist[i]),
    }));
    const gear = Object.entries(CONFIG.CARLRPG.gearSlots).map(([key, { label, icon }]) => ({
      key,
      label,
      icon,
      ...resolveSlotValue(this.actor, system.gearSlots[key]),
    }));
    const accessories = system.accessories
      .map((value, i) => ({ index: i, ...resolveSlotValue(this.actor, value) }))
      .filter((slot) => slot.name);
    return {
      hotlist,
      gear,
      accessories,
      accessoryCount: accessories.length,
      accessoryMax,
      canAddAccessory: accessories.length < accessoryMax,
      nextAccessoryIndex: system.accessories.length,
    };
  }

  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    injectBloodSplatter(this);
  }

  /**
   * Handle editing an item.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The capturing HTML element.
   * @private
   */
  static #editItem(event, target) {
    // [data-item-id], not .item: the Skill details drawer's Edit button
    // sits in the drawer below the row and carries the id itself.
    const li = target.closest("[data-item-id]");
    const item = this.actor.items.get(li.dataset.itemId);
    item.sheet.render(true);
  }

  /**
   * Handle creating a new Owned Item for the actor.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The capturing HTML element.
   * @private
   */
  static async #createItem(event, target) {
    event.preventDefault();
    const type = target.dataset.type;
    const name = `New ${type.capitalize()}`;
    const itemData = {
      name: name,
      type: type,
    };
    return await Item.create(itemData, { parent: this.actor });
  }

  /**
   * Handle deleting an item.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The capturing HTML element.
   * @private
   */
  static async #deleteItem(event, target) {
    const li = target.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    await item.delete();
    // Use native DOM to hide the element
    li.style.display = "none";
    this.render(false);
  }

  /**
   * Handle clickable rolls.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The capturing HTML element.
   * @private
   */
  static #onRoll(event, target) {
    event.preventDefault();
    const dataset = target.dataset;

    // Handle item rolls (skill checks, attacks, spells, or a description card
    // for gear/features/damage effects - see CarlRPGItem#roll()).
    if (dataset.rollType) {
      if (dataset.rollType == "item") {
        const itemId = target.closest(".item").dataset.itemId;
        const item = this.actor.items.get(itemId);
        if (item) return item.roll();
      }
    }

    // Handle rolls that supply the formula directly.
    if (dataset.roll) {
      let label = dataset.label ? `[ability] ${dataset.label}` : "";
      let roll = new Roll(dataset.roll, this.actor.getRollData());
      roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: label,
        rollMode: game.settings.get("core", "rollMode"),
      });
      return roll;
    }
  }

  /**
   * Roll an Evade Check for this actor.
   * @private
   */
  static #onRollEvade(event, target) {
    event.preventDefault();
    return this.actor.rollEvadeCheck();
  }

  /**
   * Stat Check from the Stats column - CarlDice.rollStatCheck, so Debuffs
   * apply (templates/actor/parts/stats-column.hbs).
   * @private
   */
  static #onRollStat(event, target) {
    event.preventDefault();
    return CarlDice.rollStatCheck(this.actor, target.dataset.stat);
  }

  /**
   * Make one of a Mob's printed Attacks against the user's targets - see
   * CarlDice.rollMobAttack (templates/actor/parts/attacks-list.hbs).
   * @private
   */
  static #onRollMobAttack(event, target) {
    event.preventDefault();
    return CarlDice.rollMobAttack(this.actor, Number(target.dataset.index));
  }

  /**
   * Toggle the Skill Advancement mark on an owned Skill/Spell/Damage Effect.
   * @private
   */
  static #onToggleMark(event, target) {
    event.preventDefault();
    const li = target.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if (!item) return;
    return item.update({ "system.marked": !item.system.marked });
  }

  /**
   * Toggle an owned gear item's equipped state. An item sitting in an
   * Equipped gear/accessory slot is taken out of it instead.
   * @private
   */
  static #onToggleEquipped(event, target) {
    event.preventDefault();
    const li = target.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if (!item) return;
    if (this.actor.type === "character" && isItemWorn(this.actor, item.id)) {
      return unwearItem(this.actor, item);
    }
    return item.update({ "system.equipped": !item.system.equipped });
  }

  /**
   * Empty one Inventory-tab Hotlist/Equipped slot (its (x) button).
   * @private
   */
  static #onClearSlot(event, target) {
    event.preventDefault();
    return clearSlot(this.actor, target.closest("[data-slot-type]").dataset);
  }

  /**
   * Click a list's column header to sort by it: ascending, then
   * descending, then back to the default order (_prepareItems).
   * @private
   */
  static #onSortList(event, target) {
    event.preventDefault();
    const { list, sortKey } = target.dataset;
    const current = this.#listSort[list];
    if (current?.key !== sortKey) this.#listSort[list] = { key: sortKey, dir: 1 };
    else if (current.dir === 1) current.dir = -1;
    else delete this.#listSort[list];
    return this.render();
  }

  /**
   * Add a Condition (Debuff/Buff) from the picker, or a blank custom one.
   * @private
   */
  static async #onAddCondition(event, target) {
    event.preventDefault();
    const select = this.element.querySelector('select[name="newConditionKey"]');
    const key = select?.value;
    if (!key) return;
    await addConditionToActor(this.actor, key);
  }

  /**
   * Generic add/delete for editable array fields (Conditions).
   * @private
   */
  static #onAddArrayItem(event, target) {
    return onAddArrayItem(event, target, this.actor);
  }

  static #onDeleteArrayItem(event, target) {
    return onDeleteArrayItem(event, target, this.actor);
  }

  /**
   * Toggle a drawer's open/closed state. `data-scope="actor"` (whole-section
   * drawers) targets the actor's own `system.uiState.*`; `data-scope="item"`
   * (per-skill nested Damage Effects drawer) targets the owning Skill item's
   * `system.damageEffectsExpanded`, resolved from the closest `[data-item-id]`.
   * @private
   */
  static #onToggleDrawer(event, target) {
    const scope = target.dataset.scope;
    const doc =
      scope === "item"
        ? this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)
        : this.actor;
    return onToggleDrawer(event, target, doc);
  }

  /**
   * Click a Health Bar pip to set `hb.value` to that pip's position, unless
   * it's the currently last-filled pip - then decrement by one instead
   * (matches Foundry's own token resource-bar click convention).
   * @private
   */
  static #onSetHbValue(event, target) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    const clicked = Number(target.dataset.value);
    const current = this.actor.system.hb.value;
    const next = clicked === current ? clicked - 1 : clicked;
    return this.actor.update({ "system.hb.value": Math.max(0, next) });
  }

  /**
   * Same click-to-set / click-last-pip-to-decrement convention as
   * #onSetHbValue, against the Shield pool instead (docs/known-gaps.md 1.4).
   * @private
   */
  static #onSetShieldValue(event, target) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    const clicked = Number(target.dataset.value);
    const current = this.actor.system.shield.value;
    const next = clicked === current ? clicked - 1 : clicked;
    return this.actor.update({ "system.shield.value": Math.max(0, next) });
  }

  /**
   * Open the Spend Stat Points dialog (see module/apps/spend-stat-points-dialog.mjs).
   * @private
   */
  static #onSpendStatPoints(event, target) {
    event.preventDefault();
    new CarlSpendStatPointsDialog(this.actor).render({ force: true });
  }

  /* -------------------------------------------- */
  /*  Drag and Drop (see module/sheets/mixins/drag-drop-mixin.mjs)  */
  /* -------------------------------------------- */

  /**
   * Handle a dropped Item: create an embedded copy. Dropping an item back
   * onto its own Actor does nothing - every list has a fixed order
   * (_prepareItems), so manual reordering is gone - unless it lands on an
   * Inventory-tab Hotlist/Equipped slot, which puts it in that slot. A
   * newly created item dropped on a slot also goes into that slot.
   * @override
   */
  async _onDropItem(event, item) {
    if (!this.actor.isOwner) return null;
    const slot =
      this.actor.type === "character" ? event.target.closest("[data-slot-type]")?.dataset : null;
    if (this.actor.uuid === item.parent?.uuid) {
      if (!slot) return null;
      await assignItemToSlot(this.actor, slot, item);
      return item;
    }
    // Out of a Loot Box: move it (the box loses it), not copy. A player
    // only observes the box, so this may go through the GM - see
    // helpers/loot-box.mjs. A slot drop is skipped; the item lands in the
    // inventory list.
    if (isLootBoxItem(item)) return takeLootItem(item, this.actor);
    const keepId = !this.actor.items.has(item.id);
    const itemData = game.items.fromCompendium(item, { clearFolder: true, keepId });
    const created = await Item.create(itemData, { parent: this.actor, keepId });

    // Soft affordance, not an enforced rule: if this is the first Class or
    // Race item dropped on the actor, make it the active one. Doesn't
    // replace an already-active Class/Race - a second drop just sits there
    // unlinked until the player/GM manually updates system.class/race (or
    // removes the old item first), matching this project's "surface state,
    // don't gate" pattern elsewhere.
    if (created && this.actor.type === "character") {
      if (created.type === "class" && !this.actor.system.class) {
        await this.actor.update({ "system.class": created.id });
      } else if (created.type === "race" && !this.actor.system.race) {
        await this.actor.update({ "system.race": created.id });
      }
    }
    if (created && slot) await assignItemToSlot(this.actor, slot, created);

    return created ?? null;
  }
}
