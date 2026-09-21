const { HandlebarsApplicationMixin } = foundry.applications.api;
const { DocumentSheetV2 } = foundry.applications.api;
import { onAddArrayItem, onDeleteArrayItem } from '../helpers/array-editor.mjs';
import CarlDice from '../dice/dice.mjs';
import { injectBloodSplatter } from '../helpers/window-chrome.mjs';

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
      resolveSkillChoice: CarlRPGItemSheet.#onResolveSkillChoice,
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

  /**
   * Ranked types (Skill/Spell/Damage Effect) get 4 tabs instead of the
   * usual Description/Attributes pair - Main (non-rank fields + the shared
   * rank/damage/heal preamble + Description) and one tab per Rank
   * 5/10/15 Upgrade tier, so a tier's own Changes/Target Effects/Damage
   * Type Split content isn't all competing for space on one page. Every
   * other item type is untouched (still the static `TABS.primary`
   * default via `super._getTabsConfig`).
   * @override
   */
  _getTabsConfig(group) {
    if (group === 'primary' && RANKED_TYPES.includes(this.item?.type)) {
      return {
        tabs: [
          { id: 'main', label: 'CARLRPG.Tab.Main' },
          { id: 'rank5', label: 'CARLRPG.Ranked.Rank5' },
          { id: 'rank10', label: 'CARLRPG.Ranked.Rank10' },
          { id: 'rank15', label: 'CARLRPG.Ranked.Rank15' },
        ],
        initial: 'main',
      };
    }
    return super._getTabsConfig(group);
  }

  /** @override */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    if (RANKED_TYPES.includes(this.item.type)) {
      delete parts.description;
      delete parts.attributes;
      parts.main = { template: ATTRIBUTES_TEMPLATES[this.item.type], scrollable: [""] };
      const rankTabTemplate = "systems/carl-rpg/templates/item/parts/rank-tab.hbs";
      parts.rank5 = { template: rankTabTemplate, scrollable: [""] };
      parts.rank10 = { template: rankTabTemplate, scrollable: [""] };
      parts.rank15 = { template: rankTabTemplate, scrollable: [""] };
    } else {
      parts.attributes.template = ATTRIBUTES_TEMPLATES[this.item.type] ?? ATTRIBUTES_TEMPLATES.item;
    }
    return parts;
  }

  /* -------------------------------------------- */

  /** @override */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    // For the tabs navigation part, convert tabs object to array. This
    // MUST NOT mutate `context.tabs` in place - Foundry's core render loop
    // calls this method once per part, passing the SAME shared context
    // object reference every time, so an in-place reassignment here would
    // permanently turn `context.tabs` into an array for every part
    // rendered afterward (header/tabs run first, then main/rank5/rank10/
    // rank15), breaking the `context.tabs?.[partId]` object-keyed lookup
    // below for all of them - leaving every tab content section's
    // `context.tab` unset and, for rank-tab.hbs (which needs `tab.id` for
    // its `data-tab` attribute), its section permanently un-selectable.
    if (partId === 'tabs' && context.tabs) {
      return { ...context, tabs: Object.values(context.tabs) };
    }
    // For tab content parts, provide the tab context
    const tab = context.tabs?.[partId];
    if (tab) {
      context.tab = tab;
    }
    // The 3 Rank tabs share one template (rank-tab.hbs) - point it at the
    // right pre-grouped bucket (context.rank5/rank10/rank15, already built
    // by #groupUpgradesByRank in _prepareContext) and the matching
    // rankThreshold (for the tab's own "Add Upgrade" link), since the
    // shared template has no other way to know which of the 3 it is.
    if (partId === 'rank5' || partId === 'rank10' || partId === 'rank15') {
      context.entries = context[partId];
      context.rankThreshold = Number(partId.slice('rank'.length));
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
    // Gates ranked-fields.hbs's Base Damage/Heal fieldsets (and
    // attributes-skill.hbs's AttackType) - one shared flag computed per
    // type so that shared partial doesn't need to know each type's own
    // "is this attack-flavored" signal. Skill's isAttack boolean used to
    // exist separately from category - an audit found every authored
    // Skill kept the two in lockstep, so it was removed as pure
    // duplication (see module/documents/item.mjs's roll() routing).
    context.isAttackFlavored = item.type === "skill" ? item.system.category === "attack"
      : item.type === "spell" ? !!item.system.castingKeywords?.includes("attack")
      : item.type === "damageEffect"; // always attack-flavored, no heal concept
    if (context.isRanked) {
      Object.assign(context, this.#groupUpgradesByRank(itemData.system.upgrades));
    }

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

  /**
   * Group a Ranked item's flat `system.upgrades` array (each entry carries
   * its own `rankThreshold` - there's no fixed 3-slot structure) into the
   * 3 buckets, one per Rank tab (rank-tab.hbs) - see _getTabsConfig/
   * _configureRenderParts. String keys
   * (`rank5`/`rank10`/`rank15`), not numeric, so `{{#each rank5}}` is a
   * valid Handlebars dot-path. Each bucketed entry keeps its ORIGINAL
   * index into the full array - required by deleteArrayItem's data-index
   * and every field's `name="system.upgrades.{{index}}...."` path in
   * upgrade-tier.hbs.
   * Also pre-filters each upgrade's own `damageTypes` down to only its
   * non-blank entries (`damageTypeEntries`, each `{value, dtIndex}` -
   * `dtIndex` is that entry's ORIGINAL index into the real damageTypes
   * array, needed for deleteArrayItem/name paths). The old fixed-2-slot UI
   * always rendered (and could submitOnChange-save) two selects even when
   * the GM never touched them, leaving many existing Upgrades with
   * `damageTypes: ["", ""]` sitting in storage - blank entries the actual
   * roll logic already ignores (damage-pipeline.mjs/dice.mjs filter them
   * out too), so the sheet shouldn't display them as if they were real,
   * intentionally-added rows either.
   * @param {object[]} upgrades
   * @returns {{rank5: {upgrade: object, index: number, damageTypeEntries: {value: string, dtIndex: number}[]}[], rank10: object[], rank15: object[]}}
   */
  #groupUpgradesByRank(upgrades = []) {
    const buckets = { rank5: [], rank10: [], rank15: [] };
    upgrades.forEach((upgrade, index) => {
      const key = `rank${upgrade.rankThreshold}`;
      const damageTypeEntries = (upgrade.damageTypes ?? [])
        .map((value, dtIndex) => ({ value, dtIndex }))
        .filter((entry) => entry.value);
      (buckets[key] ?? buckets.rank5).push({ upgrade, index, damageTypeEntries });
    });
    return buckets;
  }

  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    injectBloodSplatter(this);
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    // this.tabGroups.primary starts out as the STATIC TABS.primary.initial
    // ("description") before this sheet's own dynamic _getTabsConfig
    // override ever runs, so for a Ranked item (whose tabs are main/rank5/
    // rank10/rank15, not description/attributes) it's already set to a tab
    // that doesn't exist here. Fall back to the dynamic initial whenever
    // the current value doesn't match an actual rendered tab, not just
    // when it's unset, or no tab ever ends up active.
    let activeTab = this.tabGroups?.primary;
    if (!activeTab || !this.element.querySelector(`.tab[data-group="primary"][data-tab="${activeTab}"]`)) {
      activeTab = this._getTabsConfig('primary')?.initial;
    }
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

  /**
   * Resolve one "+X in a Skill of your choice" grant (class.mjs/race.mjs's
   * skillChoiceGrants) into a real, permanent ChangeEntry once the player
   * has picked a target Skill - see attributes-class.hbs/attributes-race.hbs
   * for the picker input this reads from. Removes the resolved grant so it
   * can't be spent twice; the materialized ChangeEntry is otherwise a normal
   * entry the player can still hand-edit via the Changes editor afterward.
   * @private
   */
  static async #onResolveSkillChoice(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.index);
    const grants = this.item.system.skillChoiceGrants ?? [];
    const grant = grants[index];
    if (!grant) return;
    const input = this.element.querySelector(`[data-skill-choice-input="${index}"]`);
    const skillName = input?.value?.trim();
    if (!skillName) {
      ui.notifications.warn(game.i18n.localize('CARLRPG.SkillChoice.NeedName'));
      return;
    }
    const newChange = {
      targetType: 'skillRank',
      target: skillName,
      mode: 'add',
      value: String(grant.amount),
      label: grant.category
        ? game.i18n.format('CARLRPG.SkillChoice.ResolvedLabel', { category: grant.category })
        : '',
    };
    const changes = [...(this.item.system.changes ?? []), newChange];
    const remainingGrants = grants.filter((_, i) => i !== index);
    await this.item.update({ 'system.changes': changes, 'system.skillChoiceGrants': remainingGrants });
  }
}
