import CarlRPGActorBase from "./actor-base.mjs";
import { aggregateActorBonuses } from "../helpers/modifiers.mjs";
import { linesToHtml, storyToHtml } from "../helpers/rich-text.mjs";
import { defineConditionsField } from "./shared/condition-entry.mjs";
import {
  defineStatsField, deriveStats, deriveDefenses, deriveMovement, deriveResourceCaps, creatureRollData,
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

    // The Details tab's free-form notes (details.hbs): rich text boxes like
    // Biography. They were once fixed slot lists and a four-part Story -
    // folded in by migrateData below.
    const richText = () => new fields.HTMLField({ required: true, blank: true, initial: "" });
    schema.story = richText();

    // The old Pet tab's Pet and Mount/Vehicle blocks (system.pet,
    // system.mount) are gone: they became Pet and Vehicle actors (the 0.6.0
    // migration, module/helpers/migration.mjs). Until it has run, CarlRPGActor.
    // migrateData keeps their values in a flag, as Foundry drops keys the
    // schema doesn't know.

    schema.importantKills = richText();
    schema.clubs = richText();
    schema.personalSpace = new fields.SchemaField({
      tier: text(),
      size: text(),
      notes: richText(),
    });
    // Worship (pp.163-164): the god, the church Tier (Acolyte/Devotee/
    // Zealot - CONFIG.CARLRPG.featureTiers), consecutive days toward the
    // next Boon ("every five consecutive days of worship", p.164) and the
    // offering/penance bookkeeping. The tithe is derived from the Tier and
    // penitence (module/helpers/worship.mjs), never stored. `notes` holds
    // the old free-text Deity box (migrateData below).
    schema.deity = new fields.SchemaField({
      name: text(),
      tier: new fields.StringField({
        required: true, blank: true, initial: "",
        choices: ["", ...Object.keys(CONFIG.CARLRPG.featureTiers)],
      }),
      worshipDays: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      // Consecutive missed daily offerings (p.163): 1 - no worship benefits
      // that day, 2 - a Divine Debuff, 3 - Fallen from Grace.
      missedOfferings: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0, max: 3 }),
      // Offenses under penance (p.312): 1 doubles the tithe, 2 quadruples it.
      penitence: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0, max: 2 }),
      shunned: new fields.BooleanField({ required: true, initial: false }),
      fallen: new fields.BooleanField({ required: true, initial: false }),
      notes: richText(),
    });
    // "Crawlers are limited to three Sponsors each" (p.284).
    schema.sponsors = richText();

    return schema;
  }

  /** @override */
  static migrateData(source) {
    CarlRPGCharacter.#migrateNotesToRichText(source);
    // The Deity rich text box became a structured block; its text is kept
    // as the block's notes. Runs after the slot-list fold above, so an old
    // array becomes HTML first. This only reshapes it in memory; the 0.6.0
    // Deity migration (module/helpers/migration.mjs) saves it, so a later
    // partial Deity edit can't be merged over the old string.
    if (typeof source.deity === "string") source.deity = { notes: source.deity };
    // The old free-text "Hands/Holding" gear slot became Main Hand.
    const gear = source.gearSlots;
    if (gear && "hands" in gear) {
      if (!gear.mainHand) gear.mainHand = gear.hands;
      delete gear.hands;
    }
    return super.migrateData(source);
  }

  /**
   * The Details tab's slot lists became rich text boxes: each non-empty
   * slot becomes its own paragraph (module/helpers/rich-text.mjs). Only the
   * old shapes are converted (an array, the four-part Story object, a
   * Personal Space with Amenities), so this runs once per document and a
   * box someone has since cleared stays cleared.
   * @param {object} source
   */
  static #migrateNotesToRichText(source) {
    for (const key of ["importantKills", "clubs", "deity", "sponsors"]) {
      if (Array.isArray(source[key])) source[key] = linesToHtml(source[key]);
    }
    // Amenities joins the notes only while they're still the old list - the
    // database keeps an old "amenities" key after the box is saved, and it
    // must not be added again on every load.
    const space = source.personalSpace;
    if (space && Array.isArray(space.notes)) {
      const amenities = String(space.amenities ?? "").trim();
      const amenitiesLabel = game.i18n?.localize?.("CARLRPG.Actor.Amenities");
      const head = amenities
        ? `<p><strong>${foundry.utils.escapeHTML(amenitiesLabel && amenitiesLabel !== "CARLRPG.Actor.Amenities" ? amenitiesLabel : "Amenities")}:</strong> ${foundry.utils.escapeHTML(amenities)}</p>`
        : "";
      space.notes = head + linesToHtml(space.notes);
    }
    if (space && "amenities" in space) delete space.amenities;
    if (source.story && typeof source.story === "object") source.story = storyToHtml(source.story);
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
    deriveMovement(this);
    deriveResourceCaps(this);
  }

  getRollData() {
    return creatureRollData(this, this.attributes.level.value);
  }
}
