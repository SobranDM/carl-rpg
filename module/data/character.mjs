import CarlRPGActorBase from "./actor-base.mjs";
import { aggregateActorBonuses } from "../helpers/modifiers.mjs";
import { defineConditionsField } from "./shared/condition-entry.mjs";
import {
  defineStatsField, deriveStats, deriveDefenses, deriveResourceCaps, creatureRollData,
} from "./shared/derive-creature.mjs";

export default class CarlRPGCharacter extends CarlRPGActorBase {
  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.attributes = new fields.SchemaField({
      level: new fields.SchemaField({
        // Levels increase Stats only, never Skills (Crawler Advancement, p. 169).
        // Current level cap is 250 per the rules.
        value: new fields.NumberField({ ...requiredInteger, initial: 1, min: 1, max: 250 }),
      }),
    });

    // Stat points banked but not yet spent (Third Floor+ requires a saferoom
    // to distribute Stat points gained from leveling).
    schema.bankedStatPoints = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });

    // (AI Favor, Popularity, Gold, Move and Step live under system.details.)
    // "Keep a running total of all your grinding hours and erase it only when
    // you level up... You gain a Level when you grind a number of hours equal
    // to your current Level" (p.171) - reset by CarlRPGActor#_preUpdate.
    schema.grindLevelHours = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });

    // The _id of this Character's active Class/Race Item (Race & Class
    // Selection, p.127). An explicit reference, not "the sole owned item of
    // that type" - nothing hard-blocks owning a second class/race-type item
    // (e.g. mid Third-Floor tandem re-selection), so this field is what
    // actually names which one is active. Every Character has a Race from
    // creation; Class starts unset and is first chosen at the Third Floor.
    schema.class = new fields.StringField({ required: false, blank: true, initial: "" });
    schema.race = new fields.StringField({ required: false, blank: true, initial: "" });

    // Shape and derivation shared with Mobs and Pets: data/shared/derive-creature.mjs.
    schema.stats = defineStatsField(3);

    // Active Debuffs/Buffs (Table 11) - shape in data/shared/condition-entry.mjs.
    schema.conditions = defineConditionsField();

    // "Each crawler may only consume two Stat potions and two Skill potions
    // during the entirety of their short life" (p.218) - counted by
    // module/helpers/consumables.mjs.
    schema.permanentPotions = new fields.SchemaField({
      stat: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      skill: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
    });

    // Roll20 / printed character sheet parity: free-text bookkeeping with no
    // mechanical hook. Fixed-length lists render a set number of inputs (see
    // CONFIG.CARLRPG.characterListSlots); storage is a plain string array.
    const text = () => new fields.StringField({ required: true, blank: true, initial: "" });
    const textList = () => new fields.ArrayField(text(), { required: true, initial: [] });
    const optionalInteger = { required: true, nullable: true, integer: true, initial: null };

    schema.details = new fields.SchemaField({
      pronouns: text(),
      crawlerNumber: text(),
      popularity: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      aiFavor: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      move: new fields.NumberField({ ...requiredInteger, initial: 20, min: 0 }),
      step: new fields.NumberField({ ...requiredInteger, initial: 10, min: 0 }),
      // Gold takes one Inventory slot however much there is (p.23).
      gold: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      size: new fields.NumberField({
        ...requiredInteger,
        initial: 4,
        choices: Object.keys(CONFIG.CARLRPG.sizes).map(Number),
      }),
    });

    // "External Buffs (Max 3)" - buffs granted by someone else, noted next to
    // the portrait. Mechanical buffs still go through conditions/items.
    schema.externalBuffs = textList();

    // Inventory tab's Hotlist and Equipped slots: each entry is an owned
    // Item id (older free text still displays, see helpers/equip-slots.mjs).
    // Gear slot keys match CONFIG.CARLRPG.gearSlots.
    schema.hotlist = textList();
    schema.gearSlots = new fields.SchemaField(
      Object.fromEntries(Object.keys(CONFIG.CARLRPG.gearSlots).map((key) => [key, text()])),
    );
    schema.accessories = textList();
    schema.story = new fields.SchemaField({
      pastTrauma: text(),
      looseEnds: text(),
      regrets: text(),
      notes: text(),
    });

    // Pet / Mount-Vehicle: kept as an inline stat block (as on the printed
    // sheet) rather than a linked Actor. hb is slots remaining / total slots.
    const companionHb = () =>
      new fields.SchemaField({
        value: new fields.NumberField({ ...requiredInteger, initial: 10, min: 0 }),
        max: new fields.NumberField({ ...requiredInteger, initial: 10, min: 0 }),
      });
    schema.pet = new fields.SchemaField({
      name: text(),
      level: new fields.NumberField(optionalInteger),
      str: new fields.NumberField(optionalInteger),
      int: new fields.NumberField(optionalInteger),
      con: new fields.NumberField(optionalInteger),
      dex: new fields.NumberField(optionalInteger),
      cha: new fields.NumberField(optionalInteger),
      dr: new fields.NumberField(optionalInteger),
      evade: new fields.NumberField(optionalInteger),
      move: new fields.NumberField(optionalInteger),
      size: text(),
      attacks: textList(),
      special: text(),
      hb: companionHb(),
    });
    schema.mount = new fields.SchemaField({
      name: text(),
      size: text(),
      move: new fields.NumberField(optionalInteger),
      occupants: new fields.NumberField(optionalInteger),
      dr: new fields.NumberField(optionalInteger),
      accessories: text(),
      hb: companionHb(),
    });

    schema.importantKills = textList();
    schema.clubs = textList();
    schema.personalSpace = new fields.SchemaField({
      tier: text(),
      size: text(),
      amenities: text(),
      notes: textList(),
    });
    schema.deity = textList();
    // "Crawlers are limited to three Sponsors each" (p.284) - three slots
    // (CONFIG.CARLRPG.characterListSlots.sponsors).
    schema.sponsors = textList();

    return schema;
  }

  /** @override */
  static migrateData(source) {
    // The old free-text "Hands/Holding" gear slot became Main Hand.
    const gear = source.gearSlots;
    if (gear && "hands" in gear) {
      if (!gear.mainHand) gear.mainHand = gear.hands;
      delete gear.hands;
    }
    return super.migrateData(source);
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (!this.stats) return;

    // Aggregate every embedded item's structured `changes`/`upgrades` into
    // this.skills/this.bonuses/this.conditionalModifiers. This never
    // mutates this.stats[*].value or other schema-backed fields directly -
    // see module/helpers/modifiers.mjs for why (base value vs. sheet input
    // vs. derived/effective value must stay separate fields, or bonuses
    // silently compound on every save). Note: any `@stats.*.mod` reference
    // inside a ChangeEntry formula resolves against last pass's mod value
    // here (mod is computed below, after aggregation) - a one-render-behind
    // staleness that self-corrects, traded for not needing a two-pass dance.
    aggregateActorBonuses(this);

    // Resolve the active Class/Race Item (for header.hbs display and the
    // Favored-Class Mana-surcharge lookup in module/dice/dice.mjs). A stale
    // reference - the item was deleted without clearing system.class/race -
    // resolves to null rather than erroring.
    this.classItem = this.class ? (this.parent?.items.get(this.class) ?? null) : null;
    this.raceItem = this.race ? (this.parent?.items.get(this.race) ?? null) : null;

    deriveStats(this);
    deriveDefenses(this);
    deriveResourceCaps(this);
  }

  getRollData() {
    return creatureRollData(this, this.attributes.level.value);
  }
}
