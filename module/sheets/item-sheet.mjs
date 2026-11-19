const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;
import { onAddArrayItem, onDeleteArrayItem } from '../helpers/array-editor.mjs';
import CarlDice from '../dice/dice.mjs';
import { injectBloodSplatter } from '../helpers/window-chrome.mjs';
import { needsWeapon } from '../helpers/weapons.mjs';
import { keepStoredForBlankNumbers, mergeSystemSubmit } from "../helpers/form-arrays.mjs";
import { isConsumable, isShield, isTwoHanded, isWeapon, slotsOf } from '../helpers/gear.mjs';
import { effectiveRank, shieldDrState } from '../helpers/modifiers.mjs';
import { repairShield } from '../helpers/shield-block.mjs';
import { enrichDescription } from "../helpers/rich-text.mjs";

const ATTRIBUTES_TEMPLATES = {
  item: 'systems/carl-rpg/templates/item/parts/attributes-item.hbs',
  feature: 'systems/carl-rpg/templates/item/parts/attributes-feature.hbs',
  skill: 'systems/carl-rpg/templates/item/parts/attributes-skill.hbs',
  damageEffect: 'systems/carl-rpg/templates/item/parts/attributes-damage-effect.hbs',
  spell: 'systems/carl-rpg/templates/item/parts/attributes-spell.hbs',
  class: 'systems/carl-rpg/templates/item/parts/attributes-class.hbs',
  race: 'systems/carl-rpg/templates/item/parts/attributes-race.hbs',
  mobAttack: 'systems/carl-rpg/templates/item/parts/attributes-mob-attack.hbs',
};

/**
 * Types drawn as one page (no tabs): a Mob Attack (docs/mob-sheet.md) and
 * gear (docs/skill-item-sheets.md). Their part isn't a `.tab` section, so
 * _onRender has no tab to activate.
 */
const SINGLE_PAGE_TYPES = ['mobAttack', 'item'];

const RANKED_TYPES = ['skill', 'spell', 'damageEffect'];

/** Does this Upgrade tier set any driving perk (module/data/shared/upgrade-tier.mjs)? */
function hasVehiclePerk(upgrade) {
  return !!(Number(upgrade.vehicleMove) || upgrade.vehicleAttackOk || upgrade.vehicleEvadeAdvantage || upgrade.vehicleStuntAdvantage);
}

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheetV2}
 * @mixes {HandlebarsApplication}
 */
export class CarlRPGItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
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
      showTab: CarlRPGItemSheet.#onShowTab,
      revealPart: CarlRPGItemSheet.#onRevealPart,
      addDamageType: CarlRPGItemSheet.#onAddDamageType,
      removeCure: CarlRPGItemSheet.#onRemoveCure,
      toggleWornSlot: CarlRPGItemSheet.#onToggleWornSlot,
      repairShield: CarlRPGItemSheet.#onRepairShield,
    }
  };

  /**
   * Optional parts of an Upgrade tier shown from its add bar before they
   * hold anything (upgrade-tier.hbs): "heal-<upgradeId>", "dt-<upgradeId>",
   * "shield-<upgradeId>", "vehicle-<upgradeId>".
   * @type {Set<string>}
   */
  #revealed = new Set();

  /** Compact Bonus / Debuff rows the user has open, by data-row-key. */
  #openRows = new Set();

  /** Row keys already drawn (null before the first render): a new one opens. */
  #seenRows = null;

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
   * The form submits arrays as index-keyed objects holding only the fields
   * it has inputs for, and Foundry replaces an array outright - so an
   * entry's other fields (an Upgrade tier's Shield slots, a Bonus
   * condition's id) would be lost on any edit. Merge the submission onto
   * the stored data first (module/helpers/form-arrays.mjs).
   * @override
   */
  _processFormData(event, form, formData) {
    // A cleared number input keeps the stored value (form-arrays.mjs).
    keepStoredForBlankNumbers(formData.object, this.item.system, form);
    const data = super._processFormData(event, form, formData);
    if (data.system && typeof data.system === "object") data.system = mergeSystemSubmit(this.item.system, data.system);
    return data;
  }

  /**
   * This system doesn't use ActiveEffect documents (modifiers are Item
   * ChangeEntries - see module/helpers/modifiers.mjs), so a dropped one is
   * ignored rather than copied onto the Item as core would.
   * @override
   */
  async _onDropActiveEffect(event, effect) {
    return null;
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
    if (group === 'primary' && SINGLE_PAGE_TYPES.includes(this.item?.type)) {
      return { tabs: [{ id: 'attributes', label: 'CARLRPG.Tab.Main' }], initial: 'attributes' };
    }
    if (group === 'primary' && RANKED_TYPES.includes(this.item?.type)) {
      // Each Rank tab says whether its Upgrades apply at the current Rank -
      // the live one (gear's "+1 Rank" counts), as the tab content shows.
      const rank = effectiveRank(this.item);
      const tier = (n) => ({
        id: `rank${n}`,
        label: `CARLRPG.Ranked.Rank${n}`,
        icon: rank >= n ? 'fas fa-lock-open' : 'fas fa-lock',
      });
      return {
        tabs: [{ id: 'main', label: 'CARLRPG.Tab.Main' }, tier(5), tier(10), tier(15)],
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
    } else if (SINGLE_PAGE_TYPES.includes(this.item.type)) {
      // One page: its description is a section of it.
      delete parts.tabs;
      delete parts.description;
      parts.attributes.template = ATTRIBUTES_TEMPLATES[this.item.type];
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
      context.tierUnlocked = context.liveRank >= context.rankThreshold;
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
    // Only a Spell's Upgrade cards offer Shield slots (upgrade-tier.hbs).
    context.isSpell = item.type === "spell";
    // Only a Skill's Upgrade cards offer the Vehicle part (driving perks).
    context.isSkill = item.type === "skill";
    // A Pet's Ranks are the current Floor (data/ranked-item-base.mjs) and
    // never advance - show that Rank read-only instead of the stored one.
    context.petRank = item.system.rankIsFloor ? item.system.rank : null;
    context.canRollAdvancement = context.isRanked && !!item.actor && context.petRank === null;
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
      // The live Rank decides what's unlocked: on an actor, the effective
      // Rank with worn gear's and Buffs' "+N Skill" (ruled 2026-11-18; a
      // Pet's is the Floor); elsewhere the item's own.
      context.liveRank = effectiveRank(item);
      context.upgradeOverview = this.#upgradeOverview(context, context.liveRank);
      context.headerChips = this.#headerChips(item, context);
      context.damageSummary = this.#damageSummary(item.system.baseDamage);
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

    // Suggestions for a gear item's Weapon Skill: the rulebook's Weapon
    // Skills plus the owner's other Attack Skills that need a weapon
    // (homebrew). Free text either way.
    if (item.type === "item") {
      const owned = item.actor
        ? item.actor.items.filter((i) => i.type === "skill" && needsWeapon(item.actor, i)).map((i) => i.name)
        : [];
      context.weaponSkillNames = [...new Set([...CONFIG.CARLRPG.weaponSkills, ...owned])].sort();
      context.gear = this.#gearContext(item, itemData, context.weaponSkillNames);
      context.headerChips = this.#gearChips(item);
    }

    // Template convenience variables
    context.cssClass = this.options.classes.join(' ');
    context.owner = item.isOwner;

    // Retrieve the roll data for TinyMCE editors.
    context.rollData = item.getRollData();

    context.descriptionHTML = await enrichDescription(item.system.description, item, { rollData: context.rollData });

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
      const all = (upgrade.damageTypes ?? []).map((value, dtIndex) => ({ value, dtIndex }));
      const damageTypeEntries = all.filter((entry) => entry.value);
      // "+ Damage type" (#onAddDamageType) shows one blank entry to pick in.
      if (this.#revealed.has(`dt-${upgrade.id}`)) {
        const blank = all.findLast((entry) => !entry.value);
        if (blank) damageTypeEntries.push(blank);
      }
      const showHeal = !!(upgrade.healDice || upgrade.healToFull || upgrade.healMend || upgrade.healAllTargets)
        || this.#revealed.has(`heal-${upgrade.id}`);
      // Once shown, it stays for this sheet's session (cleared mid-edit).
      if (showHeal) this.#revealed.add(`heal-${upgrade.id}`);
      // A Spell's Shield slots from this Rank (only a Spell's sheet offers it).
      const showShield = Number(upgrade.shieldSlots) > 0 || this.#revealed.has(`shield-${upgrade.id}`);
      if (showShield) this.#revealed.add(`shield-${upgrade.id}`);
      // A driving Skill's vehicle perks from this Rank (only a Skill's sheet offers it).
      const showVehicle = hasVehiclePerk(upgrade) || this.#revealed.has(`vehicle-${upgrade.id}`);
      if (showVehicle) this.#revealed.add(`vehicle-${upgrade.id}`);
      (buckets[key] ?? buckets.rank5).push({
        upgrade, index, damageTypeEntries, showHeal, showShield, showVehicle, showDamageTypes: damageTypeEntries.length > 0,
      });
    });
    return buckets;
  }

  /**
   * The Main tab's Upgrades overview (ranked-fields.hbs): one row per Rank
   * tier - Unlocked at the current Rank or Locked - and a one-line summary
   * of what it gives: each Upgrade's description's first line, or what it
   * holds ("2 Bonuses · 1 Debuff").
   * @param {object} context  With rank5/rank10/rank15 buckets.
   * @param {number} rank     The live Rank.
   * @returns {object[]}
   */
  #upgradeOverview(context, rank) {
    const i18n = game.i18n;
    const count = (n, one, many) => (n ? i18n.format(n === 1 ? one : many, { n }) : null);
    const sumUp = ({ upgrade, damageTypeEntries, showHeal, showShield, showVehicle }) => {
      const line = String(upgrade.description ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line) return line;
      const parts = [
        count(upgrade.changes?.length ?? 0, "CARLRPG.ItemSheet.Count.Bonus", "CARLRPG.ItemSheet.Count.Bonuses"),
        count(upgrade.targetEffects?.length ?? 0, "CARLRPG.ItemSheet.Count.Debuff", "CARLRPG.ItemSheet.Count.Debuffs"),
        damageTypeEntries.some((e) => e.value) ? i18n.localize("CARLRPG.Ranked.DamageTypeSplit") : null,
        showHeal ? i18n.localize("CARLRPG.ItemSheet.Group.Healing") : null,
        showShield ? i18n.localize("CARLRPG.Spell.ShieldSlots") : null,
        showVehicle ? i18n.localize("CARLRPG.Ranked.Vehicle.Title") : null,
        upgrade.armorPiercing ? i18n.localize("CARLRPG.ArmorPiercing.Label") : null,
      ].filter(Boolean);
      return parts.join(" · ") || i18n.localize("CARLRPG.ItemSheet.EmptyUpgrade");
    };
    return [5, 10, 15].map((n) => {
      const entries = context[`rank${n}`] ?? [];
      return {
        tab: `rank${n}`,
        label: `CARLRPG.Ranked.Rank${n}`,
        unlocked: rank >= n,
        count: entries.length,
        summary: entries.length ? entries.map(sumUp).join(" · ") : i18n.localize("CARLRPG.ItemSheet.NoUpgrade"),
      };
    });
  }

  /**
   * Chips under a Skill, Spell or Damage Effect's name (header.hbs):
   * Category and Attack type (Skills), Mana cost (Spells), Rank, governing
   * Stat, and Marked when it is.
   * @param {Item} item
   * @param {object} context
   * @returns {{label: string, tone: string, icon?: string, tooltip?: string}[]}
   */
  #headerChips(item, context) {
    const cfg = CONFIG.CARLRPG;
    const t = (key) => game.i18n.localize(key);
    const sys = item.system;
    const chips = [];
    if (item.type === "skill") {
      if (sys.category) {
        chips.push({ label: t(cfg.skillCategories[sys.category] ?? sys.category), tone: sys.category === "attack" ? "accent" : "neutral" });
      }
      if (context.isAttackFlavored && sys.attackType) {
        chips.push({ label: t(cfg.attackTypes[sys.attackType] ?? sys.attackType), tone: sys.attackType === "ranged" ? "blue" : "neutral" });
      }
    }
    if (item.type === "spell" && Number(sys.manaCost) > 0) {
      chips.push({ label: game.i18n.format("CARLRPG.ItemSheet.ManaChip", { n: sys.manaCost }), tone: "blue" });
    }
    chips.push({ label: game.i18n.format("CARLRPG.ItemSheet.RankChip", { n: context.liveRank }), tone: "neutral" });
    if (sys.governingStat) {
      chips.push({ label: t(cfg.statAbbreviations[sys.governingStat] ?? sys.governingStat), tone: "neutral" });
    }
    if (sys.marked) {
      chips.push({ label: t("CARLRPG.Ranked.Marked"), tone: "gold", icon: "fas fa-bookmark", tooltip: t("CARLRPG.ItemSheet.MarkedHint") });
    }
    // A CrawlerForge import's own invention (helpers/crawlerforge-import.mjs).
    if (item.getFlag("carl-rpg", "crawlerforge")?.notInRulebook) {
      chips.push({ label: t("CARLRPG.CrawlerForge.NotInRulebook"), tone: "gold", icon: "fas fa-triangle-exclamation", tooltip: t("CARLRPG.CrawlerForge.NotInRulebookHint") });
    }
    return chips;
  }

  /**
   * The gear sheet's optional parts (attributes-item.hbs): each shown once
   * it holds something or was added from an add bar (#revealed: "consumable",
   * "c-heal", "c-mana", "c-cures", "c-permanent", "c-buff"), the Cures as
   * pills, and a new On-hit Debuff's defaults - a weapon's starts "Only
   * with" its Weapon Skill, on an Amazing Success (the book's "AS:", p.116).
   * @param {Item} item
   * @param {object} itemData  item.toObject()
   * @param {string[]} weaponSkillNames
   * @returns {object}
   */
  #gearContext(item, itemData, weaponSkillNames) {
    const cfg = CONFIG.CARLRPG;
    const sys = itemData.system;
    const c = sys.consumable ?? {};
    const shown = (key) => this.#revealed.has(key);
    const set = (v) => v !== null && v !== undefined && v !== "";
    const used = {
      heal: set(c.heal?.slots) || !!c.heal?.full || !!c.heal?.mend,
      mana: set(c.mana?.amount) || !!c.mana?.full,
      cures: (c.cures ?? []).length > 0,
      permanent: !!c.permanent?.kind,
      buff: !!(c.buff?.label || c.buff?.duration || (c.buff?.changes ?? []).length
        || set(c.buff?.perRound?.hb) || set(c.buff?.perRound?.mana)),
    };
    const parts = Object.fromEntries(Object.entries(used).map(([k, v]) => [k, v || shown(`c-${k}`)]));
    // Once shown, a part stays for this sheet's session: clearing its only
    // value mid-edit doesn't whisk it away.
    for (const [k, v] of Object.entries(parts)) if (v) this.#revealed.add(`c-${k}`);
    const debuffName = (key) => game.i18n.localize(cfg.debuffs[key]?.label ?? key);
    const cures = (c.cures ?? []).map((key) => ({ key, label: debuffName(key) }));
    const weaponSkill = String(sys.weaponSkill ?? "").trim();
    const ownedAttacks = item.actor
      ? item.actor.items.filter((i) => i.type === "skill" && i.system.category === "attack").map((i) => i.name)
      : [];
    const showBonuses = (sys.changes ?? []).length > 0;
    const showDebuffs = (sys.targetEffects ?? []).length > 0;
    const showConsumable = !!c.kind || shown("consumable");
    if (showConsumable) this.#revealed.add("consumable");
    // Where it's worn (gear.mjs): a pill per slot; a weapon or a Shield is always Held.
    const worn = new Set(slotsOf(item));
    const weapon = isWeapon(item);
    const shield = isShield(item);
    const wearSlots = Object.entries(cfg.wearSlots).map(([key, label]) => ({
      key, label: game.i18n.localize(label), on: worn.has(key), locked: key === "held" && (weapon || shield),
      lockedHint: weapon ? "CARLRPG.Gear.HeldByWeapon" : "CARLRPG.Gear.HeldByShield",
    }));
    return {
      isConsumable: isConsumable(item),
      // A weapon offers Armor-Piercing (its Attacks); wearable gear, Anti-Piercing.
      isWeapon: weapon,
      // A Shield (Shield Block, p.198): its DR left after Shield damage, and Repair.
      shield: shield ? shieldDrState(item) : null,
      wearSlots,
      wearable: worn.size > 0,
      held: worn.has("held"),
      accessory: worn.has("accessory"),
      showBonuses,
      showDebuffs,
      showConsumable,
      addBar: !showBonuses || !showDebuffs || !showConsumable,
      potionLike: c.kind === "potion" || c.kind === "other",
      spellLike: c.kind === "scroll" || c.kind === "spellbook",
      consumableSummary: c.kind === "potion" ? game.i18n.localize("CARLRPG.ItemSheet.Consumable.SicknessNote") : "",
      parts,
      partsHidden: Object.values(parts).some((v) => !v),
      cures,
      cureChoices: Object.keys(cfg.debuffs).filter((key) => !(c.cures ?? []).includes(key))
        .map((key) => ({ key, label: debuffName(key) })),
      onlyWithNames: [...new Set([...weaponSkillNames, ...ownedAttacks])].sort(),
      debuffTemplate: JSON.stringify({
        debuffKey: "", stacks: 1, critOnly: false, amazingSuccessOnly: !!weaponSkill, label: "",
        skills: weaponSkill ? [weaponSkill] : [], handToHandOnly: false,
      }),
    };
  }

  /**
   * Chips under a gear item's name (header.hbs): Weapon · its Skill, Armor,
   * its consumable kind, Equipped, and how many.
   * @param {Item} item
   * @returns {{label: string, tone: string, icon?: string}[]}
   */
  #gearChips(item) {
    const sys = item.system;
    const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
    const chips = [];
    const weaponSkill = String(sys.weaponSkill ?? "").trim();
    if (weaponSkill) chips.push({ label: t("CARLRPG.ItemSheet.WeaponChip", { skill: weaponSkill }), tone: "accent" });
    // Where it's worn: "Head", "Held · Two-handed", "Belt".
    const worn = slotsOf(item).filter((s) => !(s === "held" && weaponSkill));
    if (worn.length && worn.length < Object.keys(CONFIG.CARLRPG.wearSlots).length) {
      const names = worn.map((s) => (s === "accessory" && sys.accessoryKind
        ? t(CONFIG.CARLRPG.accessoryKinds[sys.accessoryKind]) : t(CONFIG.CARLRPG.wearSlots[s])));
      chips.push({ label: names.join(" / "), tone: "neutral" });
    } else if (worn.length) {
      chips.push({ label: t("CARLRPG.Gear.AnySlot"), tone: "neutral" });
    }
    if (isTwoHanded(item)) chips.push({ label: t("CARLRPG.Gear.TwoHanded"), tone: "neutral" });
    if (isShield(item)) {
      chips.push({ label: t("CARLRPG.ShieldBlock.ShieldChip"), tone: "neutral", icon: "fas fa-shield" });
      if (shieldDrState(item).broken) chips.push({ label: t("CARLRPG.ShieldBlock.Broken"), tone: "accent", icon: "fas fa-heart-crack" });
    }
    const kind = sys.consumable?.kind;
    if (kind) chips.push({ label: t(`CARLRPG.ItemSheet.KindChip.${kind}`), tone: "blue" });
    if (sys.equipped) chips.push({ label: t("CARLRPG.Item.Equipped"), tone: "good", icon: "fas fa-check" });
    chips.push({ label: `×${sys.quantity ?? 1}`, tone: "neutral" });
    return chips;
  }

  /**
   * "1d8 + STR · Slashing" for the Damage section's title.
   * @param {object} [base]  system.baseDamage
   * @returns {string}
   */
  #damageSummary(base) {
    const cfg = CONFIG.CARLRPG;
    if (!base) return "";
    const stat = base.stat ? game.i18n.localize(cfg.statAbbreviations[base.stat] ?? base.stat) : "";
    const roll = [base.dice, stat].filter(Boolean).join(" + ");
    const type = base.damageType ? game.i18n.localize(cfg.damageTypes[base.damageType] ?? base.damageType) : "";
    return [roll, type].filter(Boolean).join(" · ");
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

    this.#restoreOpenRows();
    this.#wireGearInputs();
  }

  /**
   * The gear sheet's add-on-change controls (attributes-item.hbs,
   * target-effects-editor.hbs): an "Only with" Skill typed in, a Cure
   * picked. They have no name, and their change stops here, so the form's
   * own submit doesn't race the write.
   */
  #wireGearInputs() {
    for (const input of this.element.querySelectorAll("input.carl-only-with-add[data-add-to]")) {
      input.addEventListener("change", (event) => {
        event.stopPropagation();
        const value = input.value.trim();
        const path = input.dataset.addTo;
        if (!value || !path) return;
        const current = foundry.utils.getProperty(this.item, path) ?? [];
        if (current.some((s) => String(s).trim().toLowerCase() === value.toLowerCase())) return this.render();
        onAddArrayItem(event, { dataset: { path, template: JSON.stringify(value) } }, this.item);
      });
    }
    for (const select of this.element.querySelectorAll("select.carl-cure-picker")) {
      select.addEventListener("change", (event) => {
        event.stopPropagation();
        const key = select.value;
        if (!key) return;
        const cures = this.item._source.system.consumable?.cures ?? [];
        if (!cures.includes(key)) this.item.update({ "system.consumable.cures": [...cures, key] });
      });
    }
  }

  /**
   * Compact Bonus / Debuff rows (changes-editor.hbs, target-effects-
   * editor.hbs) stay open across the re-render every edit causes, and a
   * row that wasn't there last render (just added) opens to be filled in.
   */
  #restoreOpenRows() {
    const firstRender = this.#seenRows === null;
    const seen = this.#seenRows ?? new Set();
    for (const row of this.element.querySelectorAll("details[data-row-key]")) {
      const key = row.dataset.rowKey;
      if (this.#openRows.has(key) || (!firstRender && !seen.has(key))) {
        row.open = true;
        this.#openRows.add(key);
      }
      seen.add(key);
      row.addEventListener("toggle", () => {
        if (row.open) this.#openRows.add(key);
        else this.#openRows.delete(key);
      });
    }
    this.#seenRows = seen;
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

  /** A "Worn on" pill: add or remove a slot it can be worn in (gear.mjs). */
  static async #onToggleWornSlot(event, target) {
    event.preventDefault();
    const key = target.dataset.slot;
    if (!key || !(key in CONFIG.CARLRPG.wearSlots)) return;
    const slots = new Set(this.item._source.system.slots ?? []);
    if (slots.has(key)) slots.delete(key);
    else slots.add(key);
    const ordered = Object.keys(CONFIG.CARLRPG.wearSlots).filter((s) => slots.has(s));
    return this.item.update({ "system.slots": ordered });
  }

  /** A Shield's Repair: "a broken shield and lost DR can be Repaired" (p.198) - its Shield damage cleared. */
  static async #onRepairShield(event) {
    event.preventDefault();
    if (!isShield(this.item) || !this.item.system.shieldDamage) return;
    await repairShield(this.item);
    ui.notifications.info(game.i18n.format("CARLRPG.ShieldBlock.Repaired", { name: this.item.name }));
  }

  /** A Cure pill's ×: the consumable no longer cures that Debuff. */
  static async #onRemoveCure(event, target) {
    event.preventDefault();
    const key = target.dataset.key;
    const cures = this.item._source.system.consumable?.cures ?? [];
    if (!key || !cures.includes(key)) return;
    return this.item.update({ "system.consumable.cures": cures.filter((k) => k !== key) });
  }

  /** The Upgrades overview's rows open their Rank tab. */
  static #onShowTab(event, target) {
    event.preventDefault();
    const tab = target.dataset.tab;
    if (tab) this.changeTab(tab, "primary");
  }

  /** An Upgrade tier's add bar: show an optional part (Healing, Shield slots). */
  static #onRevealPart(event, target) {
    event.preventDefault();
    const key = target.dataset.reveal;
    if (!key) return;
    this.#revealed.add(key);
    return this.render();
  }

  /**
   * An Upgrade tier's "+ Damage type": a blank entry to pick in, shown
   * though blank (#groupUpgradesByRank hides stored blanks otherwise).
   * Reuses a blank one already stored rather than adding another.
   */
  static async #onAddDamageType(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.index);
    const upgrade = this.item.system.upgrades?.[index];
    if (!upgrade) return;
    this.#revealed.add(`dt-${upgrade.id}`);
    if ((upgrade.damageTypes ?? []).some((value) => !value)) return this.render();
    const path = `system.upgrades.${index}.damageTypes`;
    return onAddArrayItem(event, { dataset: { path, template: '""' } }, this.item);
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
    const grants = this.item._source.system.skillChoiceGrants ?? [];
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
      value: String(Number(grant.amount) || 1),
      label: grant.category
        ? game.i18n.format('CARLRPG.SkillChoice.ResolvedLabel', { category: grant.category })
        : '',
    };
    const changes = [...foundry.utils.deepClone(this.item._source.system.changes ?? []), newChange];
    const remainingGrants = grants.filter((_, i) => i !== index);
    await this.item.update({ 'system.changes': changes, 'system.skillChoiceGrants': remainingGrants });
  }
}
