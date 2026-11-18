const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
import { onAddArrayItem, onDeleteArrayItem } from "../helpers/array-editor.mjs";
import { onToggleDrawer } from "../helpers/drawer-toggle.mjs";
import { addConditionToActor } from "../helpers/conditions.mjs";
import { cooldownSignature } from "../helpers/cooldowns.mjs";
import DragDropMixin from "./mixins/drag-drop-mixin.mjs";
import CarlSpendStatPointsDialog from "../apps/spend-stat-points-dialog.mjs";
import CrawlerCreation from "../apps/crawler-creation.mjs";
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import {
  assignItemToSlot,
  slotRefusal,
  clearSlot,
  isItemWorn,
  resolveSlotValue,
  unwearItem,
} from "../helpers/equip-slots.mjs";
import CarlDice, { evaluateMobConstant } from "../dice/dice.mjs";
import { MOB_ATTACK_TYPE, attackKind, mobAttacksOf } from "../helpers/mob-attacks.mjs";
import { isLootBoxItem, takeLootItem } from "../helpers/loot-box.mjs";
import { useConsumable } from "../helpers/consumables.mjs";
import { isCrawler, isPet, isVehicle, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { resolveOccupant, vehicleOccupants, vehicleStatus } from "../helpers/vehicle-state.mjs";
import {
  activateNitrous, applyVehiclePreset, boardVehicle, exitVehicle, setDriver, toggleParked, updateVehicle,
} from "../helpers/vehicles.mjs";
import { canDrive, rollDrivingCheck } from "../helpers/vehicle-driving.mjs";
import {
  canHotlist, hotlistRows, isInHotlist, promptHotlistPick, refuseWhileSwapping, toggleHotlist, useHotlistSlot,
} from "../helpers/hotlist.mjs";
import { rollRam } from "../helpers/vehicle-ram.mjs";
import { fireVehicleWeapon } from "../helpers/vehicle-weapons.mjs";
import { petOwner } from "../helpers/pets.mjs";
import { commandPet, describePetCommand, petFight } from "../helpers/pet-command.mjs";
import { showCarlDialog } from "../apps/carl-dialog.mjs";
import { PERMANENT_POTION_LIMIT } from "../helpers/consumables.mjs";
import {
  boonAvailable, deityBenefitApplies, describeDeity, receiveBoon, tierRank, worshipSuspended,
} from "../helpers/worship.mjs";
import { evadeModifier } from "../helpers/rules.mjs";
import { describeDefenses } from "../helpers/bonus-sources.mjs";
import { keepStoredForBlankNumbers, mergeSubmitted } from '../helpers/form-arrays.mjs';
import { attackDifficultyParts } from '../helpers/attack-targets.mjs';
import { resolveDifficultyRows } from '../helpers/debuff-effects.mjs';

/** Skill list order on the sheet (skill.mjs `category`); anything else sorts last. */
const SKILL_CATEGORY_ORDER = ["attack", "utility", "passive"];

/** Position of a Skill's category in SKILL_CATEGORY_ORDER (unknown last). */
const skillCategoryRank = (category) =>
  SKILL_CATEGORY_ORDER.indexOf(category) + 1 || SKILL_CATEGORY_ORDER.length + 1;

/**
 * "2 Resist · 1 Immune": a summary of an actor's effective Resistances
 * (the Resistances button, abilities.hbs / abilities-mob.hbs).
 * @param {object} sys  The actor's system data.
 * @returns {string}
 */
function resistanceSummary(sys) {
  const counts = { resist: 0, immune: 0, vulnerable: 0 };
  for (const state of Object.values(sys.resistancesEffective ?? {})) {
    if (state in counts) counts[state] += 1;
  }
  return Object.entries(counts)
    .filter(([, n]) => n)
    .map(([state, n]) => game.i18n.format(`CARLRPG.Actor.ResistSummary.${state}`, { n }))
    .join(" · ");
}

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheetV2}
 * @mixes {HandlebarsApplication}
 * @mixes {DragDropMixin}
 */
export class CarlRPGActorSheet extends DragDropMixin(HandlebarsApplicationMixin(ActorSheetV2)) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "sheet", "actor"],
    position: { width: 700, height: 750 },
    form: {
      submitOnChange: true,
    },
    actions: {
      editItem: CarlRPGActorSheet.#editItem,
      createItem: CarlRPGActorSheet.#createItem,
      deleteItem: CarlRPGActorSheet.#deleteItem,
      roll: CarlRPGActorSheet.#onRoll,
      rollEvade: CarlRPGActorSheet.#onRollEvade,
      chooseAttack: CarlRPGActorSheet.#onChooseAttack,
      rollMobAttack: CarlRPGActorSheet.#onRollMobAttack,
      rollStat: CarlRPGActorSheet.#onRollStat,
      toggleMark: CarlRPGActorSheet.#onToggleMark,
      toggleEquipped: CarlRPGActorSheet.#onToggleEquipped,
      useItem: CarlRPGActorSheet.#onUseItem,
      addCondition: CarlRPGActorSheet.#onAddCondition,
      addArrayItem: CarlRPGActorSheet.#onAddArrayItem,
      deleteArrayItem: CarlRPGActorSheet.#onDeleteArrayItem,
      toggleDrawer: CarlRPGActorSheet.#onToggleDrawer,
      setHbValue: CarlRPGActorSheet.#onSetHbValue,
      setShieldValue: CarlRPGActorSheet.#onSetShieldValue,
      spendStatPoints: CarlRPGActorSheet.#onSpendStatPoints,
      createCrawler: CarlRPGActorSheet.#onCreateCrawler,
      clearSlot: CarlRPGActorSheet.#onClearSlot,
      sortList: CarlRPGActorSheet.#onSortList,
      commandPet: CarlRPGActorSheet.#onCommandPet,
      openPetOwner: CarlRPGActorSheet.#onOpenPetOwner,
      drivingCheck: CarlRPGActorSheet.#onDrivingCheck,
      stopCheck: CarlRPGActorSheet.#onStopCheck,
      ramVehicle: CarlRPGActorSheet.#onRamVehicle,
      boardVehicle: CarlRPGActorSheet.#onBoardVehicle,
      boardSelected: CarlRPGActorSheet.#onBoardSelected,
      exitVehicle: CarlRPGActorSheet.#onExitVehicle,
      setDriver: CarlRPGActorSheet.#onSetDriver,
      openOccupant: CarlRPGActorSheet.#onOpenOccupant,
      toggleParked: CarlRPGActorSheet.#onToggleParked,
      resetVehicleRound: CarlRPGActorSheet.#onResetVehicleRound,
      activateNitrous: CarlRPGActorSheet.#onActivateNitrous,
      fireVehicleWeapon: CarlRPGActorSheet.#onFireVehicleWeapon,
      useHotlist: CarlRPGActorSheet.#onUseHotlist,
      pickHotlist: CarlRPGActorSheet.#onPickHotlist,
      toggleHotlist: CarlRPGActorSheet.#onToggleHotlist,
      applyVehiclePreset: CarlRPGActorSheet.#onApplyVehiclePreset,
      resetUpgradeUse: CarlRPGActorSheet.#onResetUpgradeUse,
      showResistances: CarlRPGActorSheet.#onShowResistances,
      receiveBoon: CarlRPGActorSheet.#onReceiveBoon,
      addWorshipDay: CarlRPGActorSheet.#onAddWorshipDay,
      setMissedOfferings: CarlRPGActorSheet.#onSetMissedOfferings,
      toggleMobResistances: CarlRPGActorSheet.#onToggleMobResistances,
    },
  };

  /** Whether a Mob's Resistances grid is open under its Defenses (abilities-mob.hbs). */
  #mobResistancesOpen = false;

  /** @override */
  static TABS = {
    primary: {
      tabs: [
        { id: "abilities", label: "CARLRPG.Tab.Abilities" },
        { id: "skills", label: "CARLRPG.Tab.Skills" },
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
    skills: {
      template: "systems/carl-rpg/templates/actor/parts/skills-tab.hbs",
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
    // A Pet's or Vehicle's Details tab (PART_TEMPLATES picks per type).
    pet: {
      template: "systems/carl-rpg/templates/actor/parts/pet-details.hbs",
      scrollable: [""],
    },
    description: {
      template: "systems/carl-rpg/templates/actor/parts/description.hbs",
      scrollable: [""],
    },
  };

  /**
   * Which primary tabs each actor type shows. A Pet's and a Vehicle's "pet"
   * slot is its Details tab - the setup it rarely needs in play
   * (pet-details.hbs, vehicle-details.hbs). A Character has none: its old
   * Pet page became Pet and Vehicle actors (helpers/companion-migration.mjs).
   * @type {Object<string, string[]>}
   */
  static TABS_BY_TYPE = {
    // A Character's first tab is Combat (Stats, Defenses, Hotlist,
    // Attacks); Skills and Spells have their own. Its Defenses are on the
    // Combat tab's Stats column and Size is in the header, so it has no
    // Defenses tab.
    character: ["abilities", "skills", "items", "features", "conditions", "description"],
    // A Mob's (docs/mob-sheet.md) as the Character's: Combat (Stats,
    // Defenses with its DR and Resistances, Attacks), Skills, Inventory,
    // Boons, Debuffs, Notes - no Defenses tab.
    mob: ["abilities", "skills", "items", "features", "conditions", "description"],
    pet: ["abilities", "items", "features", "conditions", "defenses", "pet", "description"],
    // An object: no Boons, Debuffs or Defenses tab (Resistances are on its
    // Details tab). Its "abilities" slot is the Vehicle tab, "items" Cargo.
    vehicle: ["abilities", "items", "pet", "description"],
  };

  /**
   * Per-type templates for the parts whose layout differs by type. A Mob's
   * and a Pet's stat block (Level/Evade/Move/DR row, Attacks or Role
   * extras) is different enough from the PC-shaped Abilities tab (banked
   * stat points, class/race-driven bonuses) that branching inside one
   * template would fight the grid rather than reuse it.
   * @type {Object<string, Object<string, string>>}
   */
  static PART_TEMPLATES = {
    header: {
      character: "systems/carl-rpg/templates/actor/parts/header.hbs", mob: "systems/carl-rpg/templates/actor/parts/header-mob.hbs", pet: "systems/carl-rpg/templates/actor/parts/header-pet.hbs", vehicle: "systems/carl-rpg/templates/actor/parts/header-vehicle.hbs",
    },
    abilities: {
      character: "systems/carl-rpg/templates/actor/parts/abilities.hbs", mob: "systems/carl-rpg/templates/actor/parts/abilities-mob.hbs", pet: "systems/carl-rpg/templates/actor/parts/abilities-pet.hbs", vehicle: "systems/carl-rpg/templates/actor/parts/vehicle.hbs",
    },
    pet: { pet: "systems/carl-rpg/templates/actor/parts/pet-details.hbs", vehicle: "systems/carl-rpg/templates/actor/parts/vehicle-details.hbs" },
    // A Character's "features" slot is its Benefits tab: Race and Class
    // benefits, the Deity block and other perks.
    features: { character: "systems/carl-rpg/templates/actor/parts/benefits.hbs" },
    description: { character: "systems/carl-rpg/templates/actor/parts/details.hbs" },
  };

  /**
   * Per-type tab label overrides: a Character's "description" slot is its
   * Details tab (details.hbs, the printed sheet's notes); a Pet has no
   * Inventory of its own ("You have to hold on to all their stuff", p.232) -
   * only the gear it wears - and its "pet" slot is its Details tab.
   * @type {Object<string, Object<string, string>>}
   */
  static TAB_LABELS_BY_TYPE = {
    character: { abilities: "CARLRPG.Tab.Combat", features: "CARLRPG.Tab.Benefits", description: "CARLRPG.Tab.Details" },
    mob: { abilities: "CARLRPG.Tab.Combat", conditions: "CARLRPG.Tab.Debuffs", description: "CARLRPG.Tab.Notes" },
    pet: { items: "CARLRPG.Tab.PetGear", pet: "CARLRPG.Tab.Details" },
    vehicle: { abilities: "CARLRPG.Tab.Vehicle", items: "CARLRPG.Tab.Cargo", pet: "CARLRPG.Tab.Details" },
  };

  /**
   * The primary tabs this sheet's actor shows.
   * @returns {string[]}
   */
  get #tabIds() {
    return CarlRPGActorSheet.TABS_BY_TYPE[this.actor.type] ?? CarlRPGActorSheet.TABS_BY_TYPE.mob;
  }

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

  /**
   * Rows of an array of objects (the Conditions tab) submit only the fields
   * they show, keyed by index ("system.conditions.0.label"). Foundry
   * replaces an array outright, so each submitted row is merged onto the
   * stored entry here, at any depth (module/helpers/form-arrays.mjs, as the
   * item sheet does) - otherwise an edit would drop the fields no input
   * shows (a condition's key and id, a timed Buff's changes and expiry).
   * Arrays of plain values (the Hotlist's text slots) are left to Foundry.
   * @override
   */
  _processFormData(event, form, formData) {
    // A cleared number input (Level, a Stat, Gold) keeps the stored value
    // rather than resetting to its initial (form-arrays.mjs).
    keepStoredForBlankNumbers(formData.object, this.actor.system, form);
    const data = super._processFormData(event, form, formData);
    const submitted = data.system;
    if (!submitted || typeof submitted !== "object") return data;
    const source = this.actor.system.toObject();
    if (isPet(this.actor) && submitted.command) this.#processCommandOverride(submitted);
    if (isVehicle(this.actor) && submitted.round) this.#processVehicleRoundOverride(submitted);
    for (const [key, value] of Object.entries(submitted)) {
      const current = source[key];
      if (!Array.isArray(current) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      if (!current.some((entry) => entry && typeof entry === "object")) continue;
      submitted[key] = mergeSubmitted(current, value);
    }
    return data;
  }

  /**
   * The Pet header's GM override select (header-pet.hbs) submits with every
   * form change. Only an actual change counts: it's recorded for the
   * running fight, like a rolled result, and picking "none" clears it.
   * @param {object} submitted  The submitted system data.
   */
  #processCommandOverride(submitted) {
    const picked = submitted.command.state ?? "";
    if (picked === describePetCommand(this.actor).selected) {
      delete submitted.command;
      return;
    }
    const fight = picked ? petFight(this.actor) : null;
    submitted.command = fight
      ? { state: picked, combatId: fight.id, round: fight.round }
      : { state: "", combatId: "", round: null };
  }

  /**
   * A Vehicle's GM "This round" select (vehicle-details.hbs) submits with
   * every change; only an actual change counts. It's the round result for
   * the vehicle's current fight (or outside one) - how a Mob-driven vehicle,
   * whose driver doesn't roll, gets a Table 6 result.
   * @param {object} submitted
   */
  #processVehicleRoundOverride(submitted) {
    const picked = submitted.round.degree ?? "";
    const status = vehicleStatus(this.actor);
    if (picked === status.roundDegree) {
      delete submitted.round;
      return;
    }
    const current = this.actor.system.round;
    submitted.round = {
      combatId: status.fight?.id ?? "",
      // Set by hand: no Driving Check card's buttons may change it now.
      checkId: "",
      round: status.fight?.round ?? null,
      degree: picked,
      critChoice: "",
      ramFactor: status.roundActive ? current.ramFactor : 1,
    };
  }

  /** @override */
  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    const type = this.actor.type;
    for (const [partId, byType] of Object.entries(CarlRPGActorSheet.PART_TEMPLATES)) {
      if (parts[partId] && byType[type]) parts[partId].template = byType[type];
    }
    const tabIds = this.#tabIds;
    for (const id of CarlRPGActorSheet.TABS.primary.tabs.map((t) => t.id)) {
      if (!tabIds.includes(id)) delete parts[id];
    }
    return parts;
  }

  /** @override */
  _getTabsConfig(group) {
    const config = super._getTabsConfig(group);
    if (!config || group !== "primary") return config;
    const tabIds = this.#tabIds;
    const labels = CarlRPGActorSheet.TAB_LABELS_BY_TYPE[this.actor.type] ?? {};
    return {
      ...config,
      tabs: config.tabs
        .filter((t) => tabIds.includes(t.id))
        .map((t) => (labels[t.id] ? { ...t, label: labels[t.id] } : t)),
    };
  }

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
    // The cooldown chips as drawn now - redrawn when they change
    // (module/helpers/cooldowns.mjs refreshCooldownSheets).
    this._carlCooldownSig = cooldownSignature(actor);

    // Add the actor's data to context for easier access, as well as flags.
    context.actor = actor;
    context.data = actor.toObject(); // Legacy compatibility
    context.system = actorData;
    context.flags = actor.flags;
    context.config = CONFIG.CARLRPG;
    context.isCharacter = isCrawler(actor);
    context.isMob = actor.type === "mob";
    context.isPet = isPet(actor);
    context.isVehicle = isVehicle(actor);
    context.isGM = game.user.isGM;
    // The Create Crawler wizard (apps/crawler-creation.mjs): only until a
    // Character has been through it, for everyone (the GM too).
    context.canCreateCrawler = actor.type === "character" && actor.isOwner
      && !actor.getFlag("carl-rpg", "chargen")?.done;
    // An HB slot count the GM can hand-set over the rule (hb-bar.hbs). A
    // Pet's is set up once, on its Details tab.
    context.hbOverridable = context.isMob;
    // A dedicated mount never levels, so it has no Stat Points to spend.
    context.canSpendStatPoints = !(context.isPet && actorData.isMount);

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

    if (context.isPet) context.pet = this.#preparePetContext(actor, context.currentFloor);
    if (context.isVehicle) context.vehicle = this.#prepareVehicleContext(actor, context.currentFloor);

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

    // Fixed-length free-text lists (Hotlist, Accessories...) - see
    // CONFIG.CARLRPG.characterListSlots. Mobs have none of these fields.
    if (actor.type === "character") {
      context.textSlots = this._buildTextSlots(actorData);
      context.equipSlots = this._buildEquipSlots(actorData);
      // The Combat tab (abilities.hbs): the Hotlist. Attacks are made from
      // the Attack! button (CarlDice.chooseAttack).
      const rows = hotlistRows(actor);
      context.hotlist = { rows, used: rows.filter((r) => !r.empty).length, size: rows.length };
      this.#prepareCrawlerContext(context);
    }

    // Add roll data for TinyMCE editors.
    context.rollData = actor.getRollData();

    const enrich = (html) => foundry.applications.ux.TextEditor.implementation.enrichHTML(
      html ?? "",
      { relativeTo: actor, secrets: actor.isOwner, rollData: context.rollData },
    );
    context.biographyHTML = await enrich(actor.system.biography);
    context.drawerHTML = await this.#prepareDrawerDescriptions(context);
    if (context.isMob) {
      context.mobAttacks = await this.#prepareMobAttacks(enrich, context.currentFloor);
      this.#prepareMobContext(context);
    }
    if (context.isCharacter) {
      await this.#prepareDetailsBoxes(context, enrich);
      await this.#prepareBenefits(context, enrich);
    }

    return context;
  }

  /**
   * The Skill and Spell detail drawers' descriptions (skills-section-body.hbs,
   * spells-section-body.hbs), enriched as the Item sheet does: links and
   * inline rolls drawn, GM Secret blocks only for an owner. Only open
   * drawers - opening one is an update, which re-renders the sheet.
   * @param {object} context
   * @returns {Promise<Record<string, string>>}  HTML by item id.
   */
  async #prepareDrawerDescriptions(context) {
    const open = [...(context.skills ?? []), ...(context.spells ?? [])]
      .filter((item) => item.system.detailsExpanded && item.system.description);
    const html = await Promise.all(open.map((item) => foundry.applications.ux.TextEditor.implementation.enrichHTML(
      item.system.description,
      { relativeTo: item, secrets: item.isOwner, rollData: item.getRollData() },
    )));
    return Object.fromEntries(open.map((item, i) => [item.id, html[i]]));
  }

  /**
   * The Character Details tab's rich text boxes (details.hbs), in layout
   * order: Personal Space's notes sit in its own fieldset with Tier/Size.
   * @param {object} context
   * @param {(html: string) => Promise<string>} enrich
   */
  async #prepareDetailsBoxes(context, enrich) {
    const sys = context.system;
    context.detailsHTML = { personalSpace: await enrich(sys.personalSpace.notes) };
    const boxes = [
      { field: "sponsors", label: "CARLRPG.Actor.Sponsors", hint: "CARLRPG.Actor.SponsorsHint" },
      { field: "clubs", label: "CARLRPG.Actor.Clubs" },
      { field: "importantKills", label: "CARLRPG.Actor.ImportantKills", wide: true },
      { field: "story", label: "CARLRPG.Actor.Story", wide: true },
    ];
    context.detailsBoxes = await Promise.all(boxes.map(async (box) => ({
      ...box,
      name: `system.${box.field}`,
      value: sys[box.field] ?? "",
      html: await enrich(sys[box.field]),
    })));
  }

  /**
   * A Character's header Mana bar (mana-bar.hbs), the Combat tab's
   * Defenses block (stats-column.hbs), the Details tab's Potions used and
   * whether the Skills tab shows its Spells section.
   * @param {object} context
   */
  #prepareCrawlerContext(context) {
    const sys = context.system;
    const mana = sys.mana;
    context.manaPercent = mana.max > 0 ? Math.round(Math.min(1, Math.max(0, mana.value / mana.max)) * 100) : 0;
    // The same terms CarlDice.rollEvadeCheck adds to the d20.
    context.evadeTotal = evadeModifier(sys);
    // Evade, DR, Move and Step with their source tooltips (bonus-sources.mjs).
    context.defenses = describeDefenses(sys);
    context.resistanceSummary = resistanceSummary(sys);
    context.potions = {
      limit: PERMANENT_POTION_LIMIT,
      stat: sys.permanentPotions.stat,
      skill: sys.permanentPotions.skill,
    };
    context.hasSpells = context.spells.length > 0;
  }

  /**
   * A Mob's Combat tab (abilities-mob.hbs; docs/mob-sheet.md): Surprise and
   * Evade at today's Floor beside the stat block's "+F" form, whether its
   * Resistances grid is open and their summary, the Attacks' heading, and
   * whether the Skills tab shows Spells.
   * @param {object} context
   */
  #prepareMobContext(context) {
    const sys = context.system;
    const floor = Number(context.currentFloor) || 0;
    // Evade today is the Difficulty an Attack on it rolls against - its
    // Debuffs and, riding a moving vehicle, the occupant's bonus (p.72) -
    // with the rows that are on by default, as the sheet's "+F" value.
    const evade = attackDifficultyParts(this.actor, floor);
    context.mobDefenses = {
      surprise: (Number(sys.surpriseBase) || 0) + floor,
      evade: resolveDifficultyRows(evade.base, evade.rows).difficulty,
      resistancesOpen: this.#mobResistancesOpen,
    };
    context.resistanceSummary = resistanceSummary(sys);
    context.hasSpells = (context.spells ?? []).length > 0;
    const areas = (context.mobAttacks ?? []).filter((a) => a.kind === "area").length;
    context.mobAttackSummary = areas
      ? game.i18n.format("CARLRPG.MobAttack.CountWithArea", { n: context.mobAttacks.length, area: areas })
      : String((context.mobAttacks ?? []).length);
  }

  /**
   * The Benefits tab (benefits.hbs): a panel per Race and Class showing its
   * description - its benefits list, the play reference - active ones
   * first; the Deity block with the deity's tiered benefit features; and
   * every other (untiered) feature.
   * @param {object} context
   * @param {(html: string) => Promise<string>} enrich
   */
  async #prepareBenefits(context, enrich) {
    const sys = context.system;
    const activeIds = new Set([context.raceId, context.classId].filter(Boolean));
    const ordered = [...context.raceAndClass].sort((a, b) =>
      (activeIds.has(a.id) ? 0 : 1) - (activeIds.has(b.id) ? 0 : 1));
    context.benefitPanels = await Promise.all(ordered.map(async (item) => ({
      id: item.id,
      name: item.name,
      img: item.img,
      typeLabel: item.typeLabel,
      active: activeIds.has(item.id),
      expanded: sys.uiState[`${item.type}Expanded`] ?? true,
      togglePath: `system.uiState.${item.type}Expanded`,
      html: await enrich(item.system.description),
    })));

    // A tiered feature is one of the deity's church benefits. One that
    // doesn't apply - above the crawler's Tier, or while worship is
    // suspended - still lists, dimmed, so it can be opened or deleted; the
    // modifier engine skips it (aggregateActorBonuses).
    const inactiveHint = worshipSuspended(sys.deity) ? "CARLRPG.Deity.BenefitSuspended" : "CARLRPG.Deity.TierNotReached";
    const row = (item) => ({
      _id: item.id,
      name: item.name,
      img: item.img,
      tierLabel: item.system.tier ? CONFIG.CARLRPG.featureTiers[item.system.tier] : "",
      applies: deityBenefitApplies(item, sys.deity),
      inactiveHint,
    });
    const tiered = context.features.filter((f) => f.system.tier);
    tiered.sort((a, b) => tierRank(a.system.tier) - tierRank(b.system.tier));
    context.deity = {
      ...describeDeity(sys.deity),
      benefits: tiered.map(row),
      notesHTML: await enrich(sys.deity.notes),
    };
    context.perks = context.features.filter((f) => !f.system.tier).map(row);
  }

  /**
   * A Vehicle sheet's context (header-vehicle.hbs, vehicle.hbs,
   * vehicle-details.hbs): its motion this round, who is aboard and what
   * this user may do with them.
   * @param {Actor} vehicle
   * @param {number} floor
   * @returns {object}
   */
  #prepareVehicleContext(vehicle, floor) {
    const sys = vehicle.system;
    const cfg = CONFIG.CARLRPG;
    const isGM = game.user.isGM;
    const status = vehicleStatus(vehicle);
    const owns = (actor) => isGM || !!actor?.isOwner;
    const occupants = vehicleOccupants(vehicle).map((o) => ({
      uuid: o.uuid,
      role: o.role,
      roleLabel: cfg.vehicleRoles[o.role],
      name: o.actor?.name ?? o.name,
      img: o.actor?.img ?? null,
      missing: !o.actor,
      canExit: owns(o.actor) || vehicle.isOwner,
      canDrive: o.role !== "driver" && !!o.actor && owns(o.actor),
    }));
    const driver = status.driver;
    // Who "Board" puts in: this player's selected token or their crawler,
    // if it isn't aboard already. The GM boards selected tokens instead.
    let boarder = null;
    if (!isGM) {
      const token = (canvas.tokens?.controlled ?? []).find((t) => t.actor?.isOwner && !isVehicle(t.actor));
      boarder = token?.actor ?? game.user.character ?? null;
      if (boarder && sys.occupants.some((o) => o.uuid === boarder.uuid)) boarder = null;
    }
    const loc = (key) => game.i18n.localize(key);
    const degreeLabel = status.roundDegree ? loc(cfg.degreesOfSuccess[status.roundDegree]) : "";
    let roundLabel = "";
    if (!sys.parked && (status.roundDegree || (status.roundActive && sys.round.ramFactor < 1))) {
      roundLabel = [
        degreeLabel ? game.i18n.format("CARLRPG.Vehicle.RoundResult", { result: degreeLabel }) : "",
        status.roundActive && sys.round.ramFactor < 1 ? loc("CARLRPG.Vehicle.Ram.MoveLost") : "",
      ].filter(Boolean).join(" - ");
    }
    const full = status.occupantCount >= status.capacity;
    return {
      status,
      driver,
      full,
      driveSkillLabel: cfg.vehicleDriveSkills[sys.driveSkill]?.label ?? "",
      occupants,
      boarder,
      canBoard: !!boarder && !full,
      canDrive: canDrive(vehicle),
      canControl: isGM || vehicle.isOwner || owns(driver),
      roundLabel,
      moveHint: game.i18n.format("CARLRPG.Vehicle.MoveHint", { max: status.maxMove, base: sys.move, bonus: status.driveBonus }),
      nitrousReady: sys.upgrades.nitrous.installed && !status.nitrousActive,
      weapons: sys.attacks.map((w, index) => ({
        ...w,
        index,
        damageTypeLabel: w.damageType ? loc(cfg.damageTypes[w.damageType]) : "",
        canFire: occupants.some((o) => !o.missing && owns(resolveOccupant(o.uuid)) && rollsLikeCrawler(resolveOccupant(o.uuid))),
      })),
      perFloor: ["shockAbsorbers", "fuzzyDice"]
        .filter((key) => sys.upgrades[key].installed)
        .map((key) => ({ label: `CARLRPG.Vehicle.Upgrades.${key}`, available: sys.upgrades[key].usedFloor !== floor })),
      presetChoices: Object.fromEntries(Object.entries(cfg.vehiclePresets).map(([k, p]) => [k, p.label])),
      driveSkillChoices: Object.fromEntries(Object.entries(cfg.vehicleDriveSkills).map(([k, s]) => [k, s.label])),
      degreeChoices: cfg.degreesOfSuccess,
    };
  }

  /**
   * The Pet header's owner link and Command Pet block (header-pet.hbs).
   * @param {Actor} pet
   * @param {number} floor
   * @returns {object}
   */
  #preparePetContext(pet, floor) {
    const owner = petOwner(pet);
    const ownerChoices = Object.fromEntries(game.actors
      .filter((a) => isCrawler(a) && a.testUserPermission(game.user, "LIMITED"))
      .map((a) => [a.id, a.name]));
    // Keep a set owner selectable even if this user can't see it.
    if (pet.system.ownerId && !ownerChoices[pet.system.ownerId]) {
      ownerChoices[pet.system.ownerId] = owner?.name ?? pet.system.ownerId;
    }
    const command = describePetCommand(pet);
    return {
      owner,
      ownerChoices,
      isBonded: pet.system.attitude === "bonded",
      traits: this.#petTraits(pet),
      command,
      commandDifficulty: pet.system.commandBase + floor,
      canCommand: command.canCommand,
      tauntOrCatcherChoices: {
        taunt: game.i18n.localize("CARLRPG.Pet.Taunt"),
        catcher: game.i18n.localize("CARLRPG.Pet.Catcher"),
      },
    };
  }

  /**
   * What a Pet's Role, Special Abilities and Level 15 benefit do, for the
   * Abilities tab's reference list (chosen on the Details tab).
   * @param {Actor} pet
   * @returns {{label: string, text?: string}[]}
   */
  #petTraits(pet) {
    const sys = pet.system;
    const loc = (key) => game.i18n.localize(key);
    const abilities = sys.specialAbilities;
    const traits = [];
    if (sys.role && !sys.isMount) {
      traits.push({ label: loc(CONFIG.CARLRPG.petRoles[sys.role]), text: loc(`CARLRPG.Pet.RoleRules.${sys.role}`) });
    }
    if (abilities.move60) traits.push({ label: loc("CARLRPG.Pet.Move60") });
    if (abilities.altMove) {
      traits.push({ label: `${loc(CONFIG.CARLRPG.petAltMoves[abilities.altMove])} ${sys.altMoveValue}ft` });
    }
    if (abilities.tauntOrCatcher) {
      traits.push({ label: loc(`CARLRPG.Pet.${abilities.tauntOrCatcher === "taunt" ? "Taunt" : "Catcher"}`), text: loc("CARLRPG.Pet.RankIsFloor") });
    }
    if (abilities.heightenedSenses) {
      traits.push({ label: loc("CARLRPG.Pet.HeightenedSenses"), text: loc("CARLRPG.Pet.HeightenedSensesHint") });
    }
    if (abilities.resistance) {
      traits.push({ label: loc("CARLRPG.Pet.Resistance"), text: loc(CONFIG.CARLRPG.damageTypes[abilities.resistance]) });
    }
    if (sys.matureBenefit) traits.push({ label: loc("CARLRPG.Pet.MatureBenefit"), text: sys.matureBenefit });
    return traits;
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
    if (this.actor.type === "character") {
      for (const item of gear) {
        item.worn = item.system.equipped || isItemWorn(this.actor, item.id);
        item.inHotlist = isInHotlist(this.actor, item.id);
        // Worn gear can't be in the Hotlist (p.98: no benefits there).
        item.showHotlistPin = item.inHotlist || canHotlist(this.actor, item);
      }
      for (const spell of spells) {
        spell.inHotlist = isInHotlist(this.actor, spell.id);
        spell.showHotlistPin = spell.inHotlist || canHotlist(this.actor, spell);
      }
      // Worn gear lists first (a stable sort keeps the name order within).
      gear.sort((a, b) => (a.worn ? 0 : 1) - (b.worn ? 0 : 1));
    }
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
   * the field path ("external.buffs" -> "externalBuffs").
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
   * The Inventory's Equipment Doll (items-list.hbs): each gear slot and
   * worn Accessory, resolved to the owned Item it holds - see
   * helpers/equip-slots.mjs. A drop on a slot wears the item there
   * (_onDropItem); its (x) takes it off (#onClearSlot).
   * @param {object} system The Character's system data.
   * @returns {{gear: object[], accessories: object[], accessoryCount: number, accessoryMax: number, canAddAccessory: boolean, nextAccessoryIndex: number}}
   */
  _buildEquipSlots(system) {
    const accessoryMax = CONFIG.CARLRPG.characterListSlots.accessories;
    const gear = Object.entries(CONFIG.CARLRPG.gearSlots).map(([key, { label, icon }]) => ({
      key, label, icon, ...resolveSlotValue(this.actor, system.gearSlots[key]),
    }));
    // Keep each Accessory's index in the list (clearSlot removes by it).
    const accessories = system.accessories
      .map((value, i) => ({ index: i, ...resolveSlotValue(this.actor, value) }))
      .filter((slot) => slot.name);
    return {
      gear,
      accessories,
      accessoryCount: accessories.length,
      accessoryMax,
      canAddAccessory: accessories.length < accessoryMax,
      nextAccessoryIndex: system.accessories.length,
    };
  }

  /* -------------------------------------------- */

  /**
   * Dragging gear off a Character's own sheet: the Equipment Doll lights the
   * slots it can go in and dims the rest (docs/gear-slots.md;
   * equip-slots.mjs slotRefusal), until the drag ends.
   * @override
   */
  _onDragStart(event) {
    super._onDragStart(event);
    if (this.actor.type !== "character") return;
    const row = event.target.closest?.("[data-item-id]");
    const item = this.actor.items.get(row?.dataset.itemId);
    const panel = this.element.querySelector(".carl-equip-panel");
    if (item?.type !== "item" || !panel) return;
    panel.classList.add("is-dragging");
    for (const slot of panel.querySelectorAll(".carl-equip-slot[data-slot-type]")) {
      slot.classList.toggle("is-fit", !slotRefusal(this.actor, slot.dataset, item));
    }
    const clear = () => {
      panel.classList.remove("is-dragging");
      for (const slot of panel.querySelectorAll(".is-fit")) slot.classList.remove("is-fit");
    };
    document.addEventListener("dragend", clear, { once: true });
  }

  /** A Mob's Resistances button: open or close the grid under its Defenses. */
  static #onToggleMobResistances(event) {
    event.preventDefault();
    this.#mobResistancesOpen = !this.#mobResistancesOpen;
    return this.render();
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    injectBloodSplatter(this);
    // A Character just made from the Actors sidebar (core renders its sheet
    // with renderContext "createActor") opens the Create Crawler wizard.
    if (options.renderContext === "createActor" && context.canCreateCrawler && !this.actor.items.size) {
      CrawlerCreation.open(this.actor);
    }
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
    const name = target.dataset.name ? game.i18n.localize(target.dataset.name) : `New ${type.capitalize()}`;
    const itemData = {
      name: name,
      type: type,
    };
    // The Benefits tab's Church Benefits list makes a Boon at a Tier.
    if (target.dataset.tier) itemData.system = { tier: target.dataset.tier };
    // A new Attack goes last in the Mob's list.
    if (type === MOB_ATTACK_TYPE) itemData.sort = Math.max(0, ...mobAttacksOf(this.actor).map((i) => i.sort ?? 0)) + 1000;
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
   * The Combat tab's Attack! button: pick an Attack Skill the crawler can
   * use now, then the Attack dialog (CarlDice.chooseAttack).
   * @private
   */
  static #onChooseAttack(event, target) {
    event.preventDefault();
    return CarlDice.chooseAttack(this.actor);
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
    // A Mob's Attack by its item; a Vehicle's weapon (fired as a Mob Attack
    // by its crew) by its place in the Vehicle's list.
    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const ref = itemId ?? (target.dataset.index !== undefined ? Number(target.dataset.index) : null);
    return ref === null ? null : CarlDice.rollMobAttack(this.actor, ref);
  }

  /**
   * A Mob's Attacks as the Combat tab's rows (abilities-mob.hbs): the
   * chat cards' row shape - a kind chip, the name with its range, damage
   * type and Debuffs under it, the to-hit and damage on the right, and the
   * printed effect in the expander (docs/mob-sheet.md).
   * @param {(html: string) => Promise<string>} enrich
   * @param {number} floor
   * @returns {Promise<object[]>}
   */
  async #prepareMobAttacks(enrich, floor) {
    const { damageTypes, debuffs, mobAttackKinds } = CONFIG.CARLRPG;
    return Promise.all(mobAttacksOf(this.actor).map(async (item) => {
      const sys = item.system;
      const kind = attackKind(sys);
      return {
        id: item.id,
        name: item.name,
        img: item.img,
        kind,
        kindLabel: mobAttackKinds[kind],
        kindIcon: { melee: "fa-hand-fist", ranged: "fa-bullseye", area: "fa-burst" }[kind],
        toHit: sys.toHit,
        toHitValue: evaluateMobConstant(sys.toHit, floor),
        damage: sys.damage,
        notes: [
          sys.range,
          sys.damageType ? game.i18n.localize(damageTypes[sys.damageType] ?? sys.damageType) : "",
          sys.isArea && sys.splash ? game.i18n.localize("CARLRPG.MobAttack.Splash") : "",
        ].filter(Boolean),
        effects: (sys.targetEffects ?? []).filter((te) => te.debuffKey).map((te) => ({
          label: te.label || game.i18n.localize(debuffs[te.debuffKey]?.label ?? te.debuffKey),
          when: `CARLRPG.MobAttack.TriggerShort.${te.trigger || "hit"}`,
        })),
        descriptionHTML: await enrich(sys.description),
      };
    }));
  }

  /**
   * Toggle the Skill Advancement mark on an owned Skill/Spell/Damage Effect.
   * @private
   */
  static #onToggleMark(event, target) {
    event.preventDefault();
    // A Pet's Ranks are the Floor and never advance (p.231).
    if (isPet(this.actor)) return;
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
    // In a fight either is the Retrieve Action (helpers/equip-slots.mjs,
    // CarlRPGItem#_preUpdate).
    if (this.actor.type === "character" && isItemWorn(this.actor, item.id)) return unwearItem(this.actor, item);
    // Equipping takes it out of the Hotlist (CarlRPGItem#_preUpdate).
    return item.update({ "system.equipped": !item.system.equipped });
  }

  /**
   * Use a consumable - a Potion, Scroll, Spellbook... (module/helpers/
   * consumables.mjs) - from its inventory row or its Hotlist slot.
   * @private
   */
  static #onUseItem(event, target) {
    event.preventDefault();
    const itemId = target.dataset.itemId ?? target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    return useConsumable(this.actor, item);
  }

  /**
   * A Hotlist row's button: Cast, Roll, Use or Ready (module/helpers/hotlist.mjs).
   * @private
   */
  static #onUseHotlist(event, target) {
    event.preventDefault();
    const index = Number(target.closest("[data-slot-key]")?.dataset.slotKey);
    if (Number.isNaN(index)) return;
    return useHotlistSlot(this.actor, index);
  }

  /**
   * An empty Hotlist slot: pick something to put in it.
   * @private
   */
  static #onPickHotlist(event, target) {
    event.preventDefault();
    const index = Number(target.closest("[data-slot-key]")?.dataset.slotKey);
    if (Number.isNaN(index)) return;
    return promptHotlistPick(this.actor, index);
  }

  /**
   * The star on an Inventory or Spell row: pin it to the Hotlist, or unpin.
   * @private
   */
  static #onToggleHotlist(event, target) {
    event.preventDefault();
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if (item) return toggleHotlist(this.actor, item);
  }

  /**
   * Empty one Hotlist or Equipment Doll slot (its (x) button).
   * @private
   */
  static #onClearSlot(event, target) {
    event.preventDefault();
    const slot = target.closest("[data-slot-type]").dataset;
    // Taking something out of the Hotlist is free; taking off gear is a
    // Retrieve (helpers/equip-slots.mjs).
    return clearSlot(this.actor, slot);
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
  /**
   * Command Pet (p.232) - the owner's Animal Handling Check
   * (module/helpers/pet-command.mjs).
   * @private
   */
  static #onCommandPet(event, target) {
    event.preventDefault();
    return commandPet(this.actor);
  }

  /**
   * Open the bonded crawler's sheet from the Pet header.
   * @private
   */
  static #onOpenPetOwner(event, target) {
    event.preventDefault();
    return petOwner(this.actor)?.sheet.render({ force: true });
  }

  /* Vehicles (module/helpers/vehicles.mjs, vehicle-driving.mjs, vehicle-ram.mjs). */

  /** The driver's Driving Check (Table 6). @private */
  static #onDrivingCheck(event, target) {
    event.preventDefault();
    return rollDrivingCheck(this.actor);
  }

  /** Stopping in time: Driving vs 10 + Move ÷ 5 (p.72). @private */
  static #onStopCheck(event, target) {
    event.preventDefault();
    return rollDrivingCheck(this.actor, { mode: "stop" });
  }

  /** Ram the targeted token(s) (p.73). @private */
  static #onRamVehicle(event, target) {
    event.preventDefault();
    return rollRam(this.actor);
  }

  /** Board with this player's selected token or crawler. @private */
  static #onBoardVehicle(event, target) {
    event.preventDefault();
    const token = (canvas.tokens?.controlled ?? []).find((t) => t.actor?.isOwner && !isVehicle(t.actor));
    const actor = token?.actor ?? game.user.character;
    if (!actor) return ui.notifications.warn(game.i18n.localize("CARLRPG.Vehicle.NoBoarder"));
    return boardVehicle(this.actor, actor);
  }

  /** GM: board every selected token (the way to put unlinked Mobs aboard). @private */
  static async #onBoardSelected(event, target) {
    event.preventDefault();
    const actors = (canvas.tokens?.controlled ?? []).map((t) => t.actor).filter((a) => a && !isVehicle(a));
    if (!actors.length) return ui.notifications.warn(game.i18n.localize("CARLRPG.Vehicle.NoneSelected"));
    for (const actor of actors) await boardVehicle(this.actor, actor);
  }

  /** @private */
  static #onExitVehicle(event, target) {
    event.preventDefault();
    return exitVehicle(this.actor, target.dataset.uuid);
  }

  /** @private */
  static #onSetDriver(event, target) {
    event.preventDefault();
    return setDriver(this.actor, target.dataset.uuid);
  }

  /** @private */
  static #onOpenOccupant(event, target) {
    event.preventDefault();
    return resolveOccupant(target.dataset.uuid)?.sheet.render({ force: true });
  }

  /** @private */
  static #onToggleParked(event, target) {
    event.preventDefault();
    return toggleParked(this.actor);
  }

  /** GM: back to full Move for this round. @private */
  static #onResetVehicleRound(event, target) {
    event.preventDefault();
    return updateVehicle(this.actor, {
      "system.round": { combatId: "", checkId: "", round: null, degree: "", critChoice: "", ramFactor: 1 },
    });
  }

  /** @private */
  static #onActivateNitrous(event, target) {
    event.preventDefault();
    return activateNitrous(this.actor);
  }

  /** A crawler occupant fires a built-in weapon. @private */
  static #onFireVehicleWeapon(event, target) {
    event.preventDefault();
    return fireVehicleWeapon(this.actor, Number(target.dataset.index));
  }

  /** Fill in the picked Table 7 preset. @private */
  static #onApplyVehiclePreset(event, target) {
    event.preventDefault();
    const key = this.element.querySelector("[data-vehicle-preset]")?.value;
    if (key) return applyVehiclePreset(this.actor, key);
  }

  /** GM: make a once-per-Floor upgrade available again. @private */
  static #onResetUpgradeUse(event, target) {
    event.preventDefault();
    return this.actor.update({ [`system.upgrades.${target.dataset.upgrade}.usedFloor`]: null });
  }

  /**
   * The Combat tab's Resistances button: a read-only list of each damage
   * type the crawler resists, is immune or vulnerable to, and where it comes
   * from (dialog/resistances.hbs). Resistances come from the Race, Class,
   * worn gear and Buffs, so they aren't edited here.
   * @private
   */
  static async #onShowResistances(event, target) {
    event.preventDefault();
    await showCarlDialog({
      title: game.i18n.format("CARLRPG.Actor.ResistancesTitle", { name: this.actor.name }),
      template: "systems/carl-rpg/templates/dialog/resistances.hbs",
      context: { rows: CarlRPGActorSheet.#resistanceRows(this.actor.system) },
      classes: ["carl-resistances-dialog"],
      buttons: [{ action: "close", icon: "fa-solid fa-check", label: "CARLRPG.Dialog.Close", default: true }],
    });
  }

  /**
   * One row per damage type with a Resistance, Immunity or Vulnerability:
   * its state and what grants it - an item or Buff's name, or the actor's
   * own base value (set before Resistances were display-only, or by import).
   * @param {object} sys  A Character's system data.
   * @returns {{label: string, state: string, stateLabel: string, source: string}[]}
   */
  static #resistanceRows(sys) {
    const { damageTypes, resistanceStates } = CONFIG.CARLRPG;
    return Object.entries(damageTypes)
      .map(([type, label]) => {
        const state = sys.resistancesEffective?.[type] ?? "none";
        const granted = type in (sys.grantedResistances ?? {});
        return {
          label,
          state,
          stateLabel: resistanceStates[state] ?? state,
          source: granted ? (sys.grantedResistanceSources?.[type] ?? "") : game.i18n.localize("CARLRPG.Actor.ResistanceBase"),
        };
      })
      .filter((row) => row.state !== "none");
  }

  /**
   * The Deity block's "Receive a Boon": roll Table 63 into a 30-hour Buff
   * and take five days off the count (module/helpers/worship.mjs). Only
   * once one is due, with a Tier and worship not suspended - the GM can
   * grant one at any time.
   * @private
   */
  static #onReceiveBoon(event, target) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    if (!game.user.isGM && !boonAvailable(this.actor.system.deity)) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Deity.BoonNotAvailable"));
      return;
    }
    return receiveBoon(this.actor);
  }

  /**
   * One more consecutive day of worship (the Deity block's +1).
   * @private
   */
  static #onAddWorshipDay(event, target) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    return this.actor.update({ "system.deity.worshipDays": this.actor.system.deity.worshipDays + 1 });
  }

  /**
   * A missed-offering pip: set the count, or clicking the last filled pip
   * takes one off (the HB pips' convention, #onSetHbValue). Recording a
   * miss breaks the streak of consecutive days toward a Boon (p.164).
   * @private
   */
  static #onSetMissedOfferings(event, target) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    const clicked = Number(target.dataset.value);
    const current = this.actor.system.deity.missedOfferings;
    const next = Math.max(0, clicked === current ? clicked - 1 : clicked);
    const update = { "system.deity.missedOfferings": next };
    if (next > current) update["system.deity.worshipDays"] = 0;
    return this.actor.update(update);
  }

  static #onSpendStatPoints(event, target) {
    event.preventDefault();
    if (isPet(this.actor) && this.actor.system.isMount) return;
    new CarlSpendStatPointsDialog(this.actor).render({ force: true });
  }

  /**
   * Open the Create Crawler wizard (its button shows only until the
   * Character has been through it).
   * @private
   */
  static #onCreateCrawler(event) {
    event.preventDefault();
    if (this.actor.getFlag("carl-rpg", "chargen")?.done) return;
    CrawlerCreation.open(this.actor);
  }

  /* -------------------------------------------- */
  /*  Drag and Drop (see module/sheets/mixins/drag-drop-mixin.mjs)  */
  /* -------------------------------------------- */

  /**
   * Dropping an Actor on a Vehicle's sheet boards it (p.72). Other sheets
   * keep core's no-op.
   * @override
   */
  async _onDropActor(event, actor) {
    if (!isVehicle(this.actor)) return super._onDropActor(event, actor);
    const boarded = await boardVehicle(this.actor, actor);
    return boarded ? actor : null;
  }

  /**
   * Handle a dropped Item: create an embedded copy. Dropping an item back
   * onto its own Actor does nothing - every list has a fixed order
   * (_prepareItems), so manual reordering is gone - unless it lands on a
   * gear or accessory slot, which puts it in that slot. A newly created item
   * dropped on a slot also goes into that slot. Hotlist slots don't take
   * drops (click one to fill it).
   * @override
   */
  async _onDropItem(event, item) {
    if (!this.actor.isOwner) return null;
    // A Vehicle carries gear as Cargo; it has no Skills, Boons or Class.
    if (isVehicle(this.actor) && item.type !== "item") {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Vehicle.OnlyCargo"));
      return null;
    }
    // A Mob's Attack is a stat block line: only a Mob has one.
    if (item.type === MOB_ATTACK_TYPE && this.actor.type !== "mob") {
      ui.notifications.warn(game.i18n.localize("CARLRPG.MobAttack.MobsOnly"));
      return null;
    }
    // A Pet has no Class or Race ("Pets don't have a Class", p.232).
    if (isPet(this.actor) && ["class", "race"].includes(item.type)) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Pet.NoClassOrRace"));
      return null;
    }
    // The Hotlist is filled by clicking a slot (or the star), not by
    // dropping on it: a drop there is an ordinary drop on the sheet.
    const slotData = this.actor.type === "character" ? event.target.closest("[data-slot-type]")?.dataset : null;
    const slot = slotData?.slotType === "hotlist" ? null : slotData;
    // A drop on a gear or accessory slot during a Hotlist swap is refused
    // whole, rather than creating the item and skipping the slot.
    if (slot && refuseWhileSwapping(this.actor)) return null;
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
    // don't gate" pattern elsewhere. An id whose item is gone (deleted
    // before CarlRPGActor cleared it) counts as none.
    if (created && this.actor.type === "character" && (created.type === "class" || created.type === "race")) {
      const key = created.type;
      if (!this.actor.items.has(this.actor.system[key])) {
        await this.actor.update({ [`system.${key}`]: created.id });
      }
    }
    if (created && slot) await assignItemToSlot(this.actor, slot, created);

    return created ?? null;
  }
}
