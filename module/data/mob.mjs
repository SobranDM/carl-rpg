import CarlRPGActorBase from "./actor-base.mjs";
import { getStatMod } from "../helpers/rules.mjs";
import { aggregateActorBonuses, computeActiveShieldSlots } from "../helpers/modifiers.mjs";

/**
 * Mob actor ("Building a Mob", p.270-272) - a GM-built monster/NPC stat
 * block. Covers both a plain trash Mob (`mobTier` blank) and a Boss
 * (`mobTier` one of Table 50's severity tiers) with the same schema; which
 * one an instance is only changes the stat-point budget and HB-slot count
 * formulas (see prepareDerivedData), not the fields available.
 */
export default class CarlRPGMob extends CarlRPGActorBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.mobTier = new fields.StringField({
      required: false, blank: true, initial: "",
      choices: ["", "neighborhood", "borough", "city", "province", "country", "floor"],
    });

    // Plain GM-set number, no XP/leveling-up mechanism (Mobs don't accrue
    // Levels through play like Characters do - see actor.mjs's _preUpdate,
    // which only ever fires off system.attributes.level.value, a Character-
    // only path). Feeds the stat-point budget and HB-slot-count formulas
    // below - see CONFIG.CARLRPG.mobBaseStat/mobStatPointsPerLevel/
    // bossSeverity (module/helpers/config.mjs).
    schema.level = new fields.NumberField({ ...requiredInteger, initial: 1, min: 1 });

    // Free text, matching race.mjs's own size field exactly (e.g.
    // "Colossal (7)") - nothing in this codebase reads size as a structured
    // enum, so a closed dropdown here would just be dead config.
    schema.size = new fields.StringField({ required: false, blank: true, initial: "" });
    // Flavor text (e.g. "Humanoid", "Undead"). Named creatureType, not type,
    // to avoid colliding with actor.type/system.type in templates.
    schema.creatureType = new fields.StringField({ required: false, blank: true, initial: "" });
    // Free text (e.g. "20+S") - the book gives no fixed Move formula ("20+S
    // is typical... higher or lower works fine"), so this is GM-typed prose,
    // not a computed value.
    schema.move = new fields.StringField({ required: false, blank: true, initial: "" });

    // Explicit GM override of the computed HB-slot count (see
    // prepareDerivedData's hbSlotsRule). null (default) means "use the
    // formula"; set once a GM wants to deviate from it, or preserved by the
    // one-time actor-type migration for a Mob that already had a hand-set
    // hb.max before this field existed (see carl-rpg.mjs's ready hook).
    schema.hbSlotsOverride = new fields.NumberField({ required: false, nullable: true, integer: true, initial: null, min: 1 });

    // Structured Attacks list, matching the printed stat block's own shape
    // (name/to-hit formula/damage formula+type/range/on-hit effect prose) -
    // deliberately not Skill/Spell items, which most Mob attacks in print
    // never are. A Mob that genuinely needs a real itemized Skill can still
    // own one; this is the common case, not a replacement for that.
    schema.attacks = new fields.ArrayField(
      new fields.SchemaField({
        name: new fields.StringField({ required: false, blank: true, initial: "" }),
        toHit: new fields.StringField({ required: false, blank: true, initial: "" }),
        damage: new fields.StringField({ required: false, blank: true, initial: "" }),
        damageType: new fields.StringField({
          required: true, blank: true, initial: "",
          choices: ["", ...Object.keys(CONFIG.CARLRPG.damageTypes)],
        }),
        range: new fields.StringField({ required: false, blank: true, initial: "" }),
        effect: new fields.StringField({ required: false, blank: true, initial: "" }),
      }),
      { required: false, initial: [] }
    );

    const statKeys = Object.keys(CONFIG.CARLRPG.stats);
    const statsSchema = {};
    for (const stat of statKeys) {
      statsSchema[stat] = new fields.SchemaField({
        // See character.mjs: value is the editable base, bonus/effective/mod
        // are derived-only every pass and must never be written back to
        // value. initial 1 (not Character's 3) matches "Mobs have a base of
        // 1 in each stat" (p.270) - a freshly-created Mob starts at the
        // plain (non-Boss) base; switching mobTier to a Boss tier doesn't
        // retroactively bump existing values, only the stat-point budget
        // the Spend Stat Points dialog computes against.
        value: new fields.NumberField({ ...requiredInteger, initial: 1, min: 1 }),
        bonus: new fields.NumberField({ ...requiredInteger, initial: 0 }),
        effective: new fields.NumberField({ ...requiredInteger, initial: 1 }),
        mod: new fields.NumberField({ ...requiredInteger, initial: 0 }),
        label: new fields.StringField({ required: true, blank: true }),
      });
    }
    schema.stats = new fields.SchemaField(statsSchema);

    // Active Debuffs/Buffs (Table 11) - same shape as character.mjs. Needed
    // here too since Mobs are the far more common target of an Attack's
    // "Apply to Target(s)" button (module/chat/target-effects-card.mjs) than
    // other player characters.
    schema.conditions = new fields.ArrayField(
      new fields.SchemaField({
        id: new fields.StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
        key: new fields.StringField({ required: true, blank: false }), // key into CONFIG.CARLRPG.debuffs, or "custom"
        label: new fields.StringField({ required: false, blank: true, initial: "" }),
        stacks: new fields.NumberField({ ...requiredInteger, initial: 1, min: 1 }),
        remaining: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
        source: new fields.StringField({ required: false, blank: true, initial: "" }),
      }),
      { required: false, initial: [] }
    );

    return schema;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (!this.stats) return;

    // See CarlRPGCharacter#prepareDerivedData - aggregateActorBonuses never
    // mutates this.stats[*].value directly, only the derived-only bonus/mod.
    aggregateActorBonuses(this);

    for (const key in this.stats) {
      if (!this.stats[key]) continue;
      const bonus = this.bonuses?.[`stats.${key}`] ?? 0;
      const cap = this.caps?.[`stats.${key}`];
      const effective = cap !== undefined ? Math.min(this.stats[key].value + bonus, cap) : this.stats[key].value + bonus;
      this.stats[key].bonus = bonus;
      this.stats[key].effective = effective;
      this.stats[key].mod = getStatMod(effective);
      this.stats[key].label = game.i18n.localize(CONFIG.CARLRPG.stats[key]) ?? key;
    }

    // See CarlRPGCharacter#prepareDerivedData - same DR/Resistance derivation,
    // kept here too since the schema (actor-base.mjs) is shared and a Mob
    // could in principle own a feature granting either.
    this.drBonus = this.bonuses?.dr ?? 0;
    this.drEffective = this.caps?.dr !== undefined
      ? Math.min(this.dr + this.drBonus, this.caps.dr)
      : this.dr + this.drBonus;
    this.resistancesEffective = { ...this.resistances, ...this.grantedResistances };

    // Surprise/Evade (p.271): "10 + Stat Mod", with +Floor appended live at
    // display time only (see abilities-mob.hbs) - never baked into these
    // values, since Floor changes without this Mob being re-saved. This
    // mirrors (but deliberately doesn't share code with) dice.mjs's
    // rollAttack targetDifficulty formula for a non-PvP Evade Difficulty -
    // one is a GM-facing reference display, the other is roll-time combat
    // math; kept separate so a future change to one doesn't silently drift
    // the other without a test catching it.
    this.surpriseBase = 10 + (this.stats.int?.mod ?? 0);
    this.evadeBase = 10 + (this.stats.dex?.mod ?? 0);

    // Stat-point budget (p.270-272) - guidance only, never enforced beyond
    // the Spend Stat Points dialog's own UI (module/apps/spend-stat-points-
    // dialog.mjs), which is where this is actually read/spent from. A plain
    // Mob (mobTier blank) uses CARLRPG.mobBaseStat/mobStatPointsPerLevel;
    // a Boss tier uses Table 50's statBase/statsPerLevel instead - these are
    // two DISTINCT rules in the book (Table 50 only tabulates Boss tiers),
    // never conflated here.
    const tier = this.mobTier ? CONFIG.CARLRPG.bossSeverity[this.mobTier] : null;
    this.statPointsBase = tier ? tier.statBase : CONFIG.CARLRPG.mobBaseStat;
    this.statPointsPerLevel = tier ? tier.statsPerLevel : CONFIG.CARLRPG.mobStatPointsPerLevel;
    this.statPointsAvailable = this.level * this.statPointsPerLevel;
    const statTotal = Object.values(this.stats).reduce((sum, s) => sum + (s.value ?? 0), 0);
    this.statPointsSpent = statTotal - (5 * this.statPointsBase);

    // HB slots (p.270): a plain Mob's slot count equals its Level, capped at
    // 10; a Boss instead uses Table 50's per-tier base + the current Floor.
    // hbSlotsOverride lets the GM hand-set a different count (null, the
    // default, means "use the formula"). hb.max is a real schema field
    // (actor-base.mjs) that gets overwritten every derived-data pass here,
    // the same pattern actor-base.mjs's own mana.max already uses for a
    // fully-derived resource.
    const floor = game.settings.get("carl-rpg", "currentFloor");
    this.hbSlotsRule = tier ? tier.hbSlotsBase + floor : Math.min(this.level, 10);
    this.hb.max = this.hbSlotsOverride ?? this.hbSlotsRule;
    if (this.hb.value > this.hb.max) this.hb.value = this.hb.max;

    this.hb.slotValue = this.stats.con?.mod ?? 0;
    this.hb.bonusMax = this.bonuses?.["hb.max"] ?? 0;
    this.hb.effectiveMax = this.hb.max + this.hb.bonusMax;
    // "You gain Mana Points equal to your Enhanced Intelligence Stat" (p.110) -
    // the bonused/effective value, not the raw base .value (see
    // character.mjs's identical fix - Mobs share the same rule).
    this.mana.max = (this.stats.int?.effective ?? 0) + (this.bonuses?.["mana.max"] ?? 0);

    // Shield-style pool (docs/known-gaps.md 1.4) - see character.mjs. Mobs
    // almost never own a toggled shield spell, but the schema is shared via
    // actor-base.mjs, so this must derive correctly if one somehow does.
    this.shield.slotValue = this.stats.con?.mod ?? 0;
    this.shield.effectiveMax = computeActiveShieldSlots(this.parent?.items ? Array.from(this.parent.items) : []);
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
    if (this.skills) data.skills = foundry.utils.deepClone(this.skills);
    data.lvl = this.level;
    // Floor is a single world-wide value, owned by the GM Toolbox - never
    // stored per-actor. See CarlRPGCharacter#getRollData.
    data.floor = game.settings.get("carl-rpg", "currentFloor");
    return data;
  }
}
