const { HandlebarsApplicationMixin } = foundry.applications.api;
const { DocumentSheetV2 } = foundry.applications.api;
import { onAddArrayItem, onDeleteArrayItem } from '../helpers/array-editor.mjs';
import { onToggleDrawer } from '../helpers/drawer-toggle.mjs';
import { addConditionToActor } from '../helpers/conditions.mjs';
import DragDropMixin from './mixins/drag-drop-mixin.mjs';
import CarlSpendStatPointsDialog from '../apps/spend-stat-points-dialog.mjs';

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {DocumentSheetV2}
 * @mixes {HandlebarsApplication}
 * @mixes {DragDropMixin}
 */
export class CarlRPGActorSheet extends DragDropMixin(HandlebarsApplicationMixin(DocumentSheetV2)) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ['carl-rpg', 'sheet', 'actor'],
    position: { width: 700, height: 680 },
    form: {
      submitOnChange: true
    },
    actions: {
      editItem: CarlRPGActorSheet.#editItem,
      createItem: CarlRPGActorSheet.#createItem,
      deleteItem: CarlRPGActorSheet.#deleteItem,
      roll: CarlRPGActorSheet.#onRoll,
      rollEvade: CarlRPGActorSheet.#onRollEvade,
      toggleMark: CarlRPGActorSheet.#onToggleMark,
      toggleEquipped: CarlRPGActorSheet.#onToggleEquipped,
      addCondition: CarlRPGActorSheet.#onAddCondition,
      addArrayItem: CarlRPGActorSheet.#onAddArrayItem,
      deleteArrayItem: CarlRPGActorSheet.#onDeleteArrayItem,
      toggleDrawer: CarlRPGActorSheet.#onToggleDrawer,
      setHbValue: CarlRPGActorSheet.#onSetHbValue,
      setShieldValue: CarlRPGActorSheet.#onSetShieldValue,
      spendStatPoints: CarlRPGActorSheet.#onSpendStatPoints,
    }
  };

  /** @override */
  static TABS = {
    primary: {
      tabs: [
        { id: "abilities", label: "CARLRPG.Tab.Abilities" },
        { id: "items", label: "CARLRPG.Tab.Inventory" },
        { id: "features", label: "CARLRPG.Tab.Boons" },
        { id: "conditions", label: "CARLRPG.Tab.Conditions" },
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
    description: {
      template: "systems/carl-rpg/templates/actor/parts/description.hbs",
      scrollable: [""],
    },
  };

  /** @override */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    parts.header.template = this.actor.type === 'npc'
      ? `systems/carl-rpg/templates/actor/parts/header-npc.hbs`
      : `systems/carl-rpg/templates/actor/parts/header.hbs`;
    return parts;
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
    // For the tabs navigation part, convert tabs object to array
    if (partId === 'tabs' && context.tabs) {
      context.tabs = Object.values(context.tabs);
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
    // NPCs (no class/race fields there), which header-npc.hbs doesn't read.
    context.classId = actorData.classItem?.id ?? "";
    context.className = actorData.classItem?.name ?? "";
    context.raceId = actorData.raceItem?.id ?? "";
    context.raceName = actorData.raceItem?.name ?? "";

    // Template convenience variables
    context.cssClass = [...this.options.classes, actor.type].join(' ');
    context.owner = actor.isOwner;

    // Add items array for compatibility with legacy getData() structure
    context.items = Array.from(actor.items.values());
    context.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));

    this._prepareItems(context);

    // Health Bar slot-pip visualization (whole slots, not raw HP, per the book).
    context.hbPips = this._buildHbPips(actorData.hb);
    // Shield-style pool (docs/known-gaps.md 1.4) - same pip shape as HB.
    context.shieldPips = this._buildHbPips(actorData.shield);

    // Add roll data for TinyMCE editors.
    context.rollData = actor.getRollData();

    context.biographyHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      actor.system.biography ?? "",
      { relativeTo: actor, secrets: actor.isOwner, rollData: context.rollData }
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

    for (let i of context.items) {
      i.img = i.img || Item.DEFAULT_ICON;
      if (i.type === 'item') gear.push(i);
      else if (i.type === 'feature') features.push(i);
      else if (i.type === 'skill') skills.push(i);
      else if (i.type === 'spell') spells.push(i);
      else if (i.type === 'damageEffect') {
        i.parentSkillsText = (i.system.parentSkills ?? []).join(', ');
        damageEffects.push(i);
      }
    }

    context.gear = gear;
    context.features = features;
    context.skills = skills;
    context.spells = spells;
    context.damageEffects = damageEffects;

    // Many-to-one Skill<->Damage Effect nesting for the merged Abilities
    // tab (see abilities.hbs / skills-section-body.hbs). A Damage Effect
    // intentionally renders under EVERY owned Skill it matches (not
    // partitioned) - matches the "select at the moment of the attack roll"
    // mechanic and damage-effect.mjs's own many-to-one parentSkills model.
    const skillNameSet = new Set(skills.map((s) => s.name));
    for (const skill of skills) {
      skill.damageEffects = damageEffects.filter((de) =>
        (de.system.parentSkills ?? []).includes(skill.name)
      );
    }
    context.unmatchedDamageEffects = damageEffects.filter((de) =>
      !(de.system.parentSkills ?? []).some((name) => skillNameSet.has(name))
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

  /* -------------------------------------------- */

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const activeTab = this.tabGroups?.primary ?? this.constructor.TABS.primary.initial;
    if (activeTab && this.element.querySelector(`.tab[data-group="primary"][data-tab="${activeTab}"]`)) {
      this.changeTab(activeTab, "primary", { force: true, updatePosition: false });
    }
  }

  /**
   * Handle editing an item.
   * @param {PointerEvent} event   The originating click event.
   * @param {HTMLElement} target   The capturing HTML element.
   * @private
   */
  static #editItem(event, target) {
    const li = target.closest('.item');
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
    const li = target.closest('.item');
    const item = this.actor.items.get(li.dataset.itemId);
    await item.delete();
    // Use native DOM to hide the element
    li.style.display = 'none';
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
      if (dataset.rollType == 'item') {
        const itemId = target.closest('.item').dataset.itemId;
        const item = this.actor.items.get(itemId);
        if (item) return item.roll();
      }
    }

    // Handle rolls that supply the formula directly.
    if (dataset.roll) {
      let label = dataset.label ? `[ability] ${dataset.label}` : '';
      let roll = new Roll(dataset.roll, this.actor.getRollData());
      roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: label,
        rollMode: game.settings.get('core', 'rollMode'),
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
   * Toggle the Skill Advancement mark on an owned Skill/Spell/Damage Effect.
   * @private
   */
  static #onToggleMark(event, target) {
    event.preventDefault();
    const li = target.closest('.item');
    const item = this.actor.items.get(li.dataset.itemId);
    if (!item) return;
    return item.update({ "system.marked": !item.system.marked });
  }

  /**
   * Toggle an owned gear item's equipped state.
   * @private
   */
  static #onToggleEquipped(event, target) {
    event.preventDefault();
    const li = target.closest('.item');
    const item = this.actor.items.get(li.dataset.itemId);
    if (!item) return;
    return item.update({ "system.equipped": !item.system.equipped });
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
    const doc = scope === 'item'
      ? this.actor.items.get(target.closest('[data-item-id]')?.dataset.itemId)
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
   * Handle a dropped Item: create an embedded copy, or sort if it was
   * already embedded on this same Actor.
   * @override
   */
  async _onDropItem(event, item) {
    if (!this.actor.isOwner) return null;
    if (this.actor.uuid === item.parent?.uuid) {
      const result = await this._onSortItem(event, item);
      return result?.length ? item : null;
    }
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

    return created ?? null;
  }

  /**
   * Sort an existing embedded Item relative to its siblings, based on where
   * it was dropped in one of the sheet's item lists.
   * @param {DragEvent} event
   * @param {Item} item
   * @returns {Promise<Item[]>|void}
   * @protected
   */
  _onSortItem(event, item) {
    const dropTarget = event.target.closest("[data-item-id]");
    if (!dropTarget) return;
    const targetId = dropTarget.dataset.itemId;
    if (targetId === item.id) return;
    const target = this.actor.items.get(targetId);
    if (!target) return;

    const siblings = [];
    for (const el of dropTarget.parentElement.children) {
      const siblingId = el.dataset?.itemId;
      if (!siblingId || siblingId === item.id) continue;
      const sibling = this.actor.items.get(siblingId);
      if (sibling) siblings.push(sibling);
    }

    const sortUpdates = foundry.utils.performIntegerSort(item, { target, siblings });
    const updateData = sortUpdates.map((u) => ({ ...u.update, _id: u.target._id }));
    return this.actor.updateEmbeddedDocuments("Item", updateData);
  }
}
