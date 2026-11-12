import CarlRPGActorBase from "./actor-base.mjs";
import { getStatMod } from "../helpers/rules.mjs";
import { aggregateActorBonuses, computeActiveShieldSlots } from "../helpers/modifiers.mjs";

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

    const statKeys = Object.keys(CONFIG.CARLRPG.stats);
    const statsSchema = {};
    for (const stat of statKeys) {
      statsSchema[stat] = new fields.SchemaField({
        // Base value - GM/player-editable, NEVER touched by the modifier
        // engine. `bonus`/`effective`/`mod` are derived-only every
        // prepareDerivedData pass; mod is computed from effective
        // (value+bonus), not value alone. `effective` exists purely so the
        // sheet can show the summed total instead of making the reader do
        // the arithmetic themselves.
        value: new fields.NumberField({ ...requiredInteger, initial: 3, min: 1 }),
        bonus: new fields.NumberField({ ...requiredInteger, initial: 0 }),
        effective: new fields.NumberField({ ...requiredInteger, initial: 3 }),
        mod: new fields.NumberField({ ...requiredInteger, initial: 0 }),
        label: new fields.StringField({ required: true, blank: true }),
      });
    }
    schema.stats = new fields.SchemaField(statsSchema);

    // Active Debuffs/Buffs (Table 11). Their effects come from each entry's
    // CONFIG.CARLRPG.debuffs mechanics (module/helpers/debuff-effects.mjs,
    // round-end.mjs), not the item ChangeEntry engine.
    schema.conditions = new fields.ArrayField(
      new fields.SchemaField({
        id: new fields.StringField({
          required: true,
          blank: false,
          initial: () => foundry.utils.randomID(),
        }),
        key: new fields.StringField({ required: true, blank: false }), // key into CONFIG.CARLRPG.debuffs, or "custom"
        label: new fields.StringField({ required: false, blank: true, initial: "" }),
        stacks: new fields.NumberField({ ...requiredInteger, initial: 1, min: 1 }),
        remaining: new fields.NumberField({
          required: false,
          nullable: true,
          integer: true,
          initial: null,
        }),
        source: new fields.StringField({ required: false, blank: true, initial: "" }),
      }),
      { required: false, initial: [] },
    );

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

    for (const key in this.stats) {
      if (!this.stats[key]) continue;
      const bonus = this.bonuses?.[`stats.${key}`] ?? 0;
      const cap = this.caps?.[`stats.${key}`];
      const effective =
        cap !== undefined
          ? Math.min(this.stats[key].value + bonus, cap)
          : this.stats[key].value + bonus;
      this.stats[key].bonus = bonus;
      this.stats[key].effective = effective;
      this.stats[key].mod = getStatMod(effective);
      this.stats[key].label = game.i18n.localize(CONFIG.CARLRPG.stats[key]) ?? key;
    }

    // DR: system.dr stays the flat GM/player-editable base (never mutated
    // here, same reasoning as stats.*.value above); drBonus/drEffective are
    // derived-only, from any "resource" ChangeEntry targeting "dr" (e.g. a
    // Race/Class's "+N DR Buff"), with an optional capMax ceiling.
    this.drBonus = this.bonuses?.dr ?? 0;
    this.drEffective =
      this.caps?.dr !== undefined
        ? Math.min(this.dr + this.drBonus, this.caps.dr)
        : this.dr + this.drBonus;

    // Resistances: system.resistances stays the flat GM/player-editable base
    // per-damage-type enum; a Race/Class's "resistance" ChangeEntry (e.g.
    // "Immunity to Poison") overrides that base for its specific type only,
    // in resistancesEffective (derived-only, read by module/helpers/
    // damage-pipeline.mjs and shown on the sheet - the base itself is never
    // mutated, so removing the granting item reverts to the GM-set default).
    this.resistancesEffective = { ...this.resistances, ...this.grantedResistances };

    // Derived resource caps: HB slot value from (effective) CON Mod, HB
    // effective max = base max + any "hb.max" resource bonus, Mana max 1:1
    // with INT score plus any "mana.max" resource bonus.
    this.hb.slotValue = this.stats.con?.mod ?? 0;
    this.hb.bonusMax = this.bonuses?.["hb.max"] ?? 0;
    this.hb.effectiveMax = this.hb.max + this.hb.bonusMax;
    // "You gain Mana Points equal to your Enhanced Intelligence Stat. Not
    // the Stat Mod this time, but the actual value." (p.110) - "Enhanced"
    // means the bonused/effective Stat value, not the raw base .value, so
    // a live (non-baked) INT bonus from gear/feature/spell isn't silently
    // dropped from Max Mana.
    this.mana.max = (this.stats.int?.effective ?? 0) + (this.bonuses?.["mana.max"] ?? 0);

    // Shield-style pool (docs/known-gaps.md 1.4): fully derived from
    // whichever owned toggled spell is currently active - see actor-base.mjs.
    // The clamp handles a spell being deactivated mid-session, or its Rank
    // dropping, so the pool visually/mechanically shrinks to match.
    this.shield.slotValue = this.stats.con?.mod ?? 0;
    this.shield.effectiveMax = computeActiveShieldSlots(
      this.parent?.items ? Array.from(this.parent.items) : [],
    );
    if (this.shield.value > this.shield.effectiveMax) this.shield.value = this.shield.effectiveMax;
  }

  getRollData() {
    const data = {};

    if (this.stats) {
      data.stats = {};
      for (let [k, v] of Object.entries(this.stats)) {
        data.stats[k] = foundry.utils.deepClone(v);
      }
    }

    if (this.skills) {
      data.skills = foundry.utils.deepClone(this.skills);
    }

    data.lvl = this.attributes.level.value;
    // Floor is a single world-wide value (every crawler is on the same
    // floor), owned by the GM Toolbox - never stored per-actor.
    data.floor = game.settings.get("carl-rpg", "currentFloor");

    return data;
  }
}
