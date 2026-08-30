const { HandlebarsApplicationMixin } = foundry.applications.api;
const { DocumentSheetV2 } = foundry.applications.api;
import { onAddArrayItem, onDeleteArrayItem } from '../helpers/array-editor.mjs';
import CarlDice from '../dice/dice.mjs';

const ATTRIBUTES_TEMPLATES = {
  item: 'systems/carl-rpg/templates/item/parts/attributes-item.hbs',
  feature: 'systems/carl-rpg/templates/item/parts/attributes-feature.hbs',
  skill: 'systems/carl-rpg/templates/item/parts/attributes-skill.hbs',
  damageEffect: 'systems/carl-rpg/templates/item/parts/attributes-damage-effect.hbs',
  spell: 'systems/carl-rpg/templates/item/parts/attributes-spell.hbs',
  class: 'systems/carl-rpg/templates/item/parts/attributes-class.hbs',
  race: 'systems/carl-rpg/templates/item/parts/attributes-race.hbs',
};

const RANKED_TYPES = ['skill', 'spell', 'damageEffect'];

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {DocumentSheetV2}
 * @mixes {HandlebarsApplication}
 */
export class CarlRPGItemSheet extends HandlebarsApplicationMixin(DocumentSheetV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ['carl-rpg', 'sheet', 'item'],
    position: { width: 560, height: 620 },
    form: {
      submitOnChange: true
    },
    actions: {
      roll: CarlRPGItemSheet.#onRoll,
      rollAdvancement: CarlRPGItemSheet.#onRollAdvancement,
      addArrayItem: CarlRPGItemSheet.#onAddArrayItem,
      deleteArrayItem: CarlRPGItemSheet.#onDeleteArrayItem,
    }
  };

  /** @override */
  static TABS = {
    primary: {
      tabs: [
        { id: "description", label: "Description" },
        { id: "attributes", label: "Attributes" },
      ],
      initial: "description",
    },
  };

  /** @override */
  static PARTS = {
    header: {
      template: "systems/carl-rpg/templates/item/parts/header.hbs",
    },
    tabs: {
      template: "templates/generic/tab-navigation.hbs",
    },
    description: {
      template: "systems/carl-rpg/templates/item/parts/description.hbs",
      scrollable: [""],
    },
    attributes: {
      template: "systems/carl-rpg/templates/item/parts/attributes-item.hbs",
      scrollable: [""],
    },
  };

  /**
   * The Item document managed by this sheet.
   * @type {Item}
   */
  get item() {
    return this.document;
  }

  /** @override */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    parts.attributes.template = ATTRIBUTES_TEMPLATES[this.item.type] ?? ATTRIBUTES_TEMPLATES.item;
    return parts;
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
    const item = context.document;

    // Use a safe clone of the item data for further operations.
    const itemData = item.toObject();

    // Add the item's data to context for easier access, as well as flags.
    context.item = item;
    context.data = itemData; // Legacy compatibility
    context.system = itemData.system;
    context.flags = itemData.flags;
    context.config = CONFIG.CARLRPG;
    context.itemTypeLabel = `TYPES.Item.${item.type}`;
    context.isRanked = RANKED_TYPES.includes(item.type);
    context.canRollAdvancement = context.isRanked && !!item.actor;

    // Suggestions for the Skill Rank / Skill Damage ChangeEntry target field
    // (see changes-editor.hbs) - Skill/Spell/Damage Effect names are
    // homebrew with no master list (module/helpers/modifiers.mjs), so this
    // is only ever a convenience autocomplete, never a closed dropdown.
    // Empty for an unowned/compendium item, which has no actor to source
    // names from - the target field still accepts free text either way.
    context.actorSkillNames = item.actor
      ? [...new Set(
          item.actor.items
            .filter(i => RANKED_TYPES.includes(i.type))
            .map(i => i.name)
        )].sort()
      : [];

    // Template convenience variables
    context.cssClass = this.options.classes.join(' ');
    context.owner = item.isOwner;

    // Retrieve the roll data for TinyMCE editors.
    context.rollData = item.getRollData();

    context.descriptionHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      item.system.description ?? "",
      { relativeTo: item, secrets: item.isOwner, rollData: context.rollData }
    );

    return context;
  }

  /* -------------------------------------------- */

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const activeTab = this.tabGroups?.primary
      ?? this.constructor.TABS.primary.initial;
    if (activeTab && this.element.querySelector(`.tab[data-group="primary"][data-tab="${activeTab}"]`)) {
      this.changeTab(activeTab, "primary", { force: true, updatePosition: false });
    }
  }

  /* -------------------------------------------- */

  /**
   * Handle clicking the item's roll button (skill check / attack / description card).
   * @private
   */
  static #onRoll(event, target) {
    event.preventDefault();
    return this.item.roll();
  }

  /**
   * Handle rolling a Skill Advancement Check directly from the item sheet.
   * @private
   */
  static #onRollAdvancement(event, target) {
    event.preventDefault();
    if (!this.item.actor) return;
    return CarlDice.rollAdvancementCheck(this.item.actor, this.item);
  }

  /**
   * Generic add/delete for editable array fields (Upgrades, Changes,
   * Conditions, string lists). See module/helpers/array-editor.mjs.
   * @private
   */
  static #onAddArrayItem(event, target) {
    return onAddArrayItem(event, target, this.item);
  }

  static #onDeleteArrayItem(event, target) {
    return onDeleteArrayItem(event, target, this.item);
  }
}
