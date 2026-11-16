import CarlRPGActorBase from "./actor-base.mjs";
import { staticEvade } from "../helpers/rules.mjs";
import { aggregateActorBonuses } from "../helpers/modifiers.mjs";
import { defineConditionsField } from "./shared/condition-entry.mjs";
import {
  defineStatsField, deriveStats, deriveDefenses, deriveResourceCaps, creatureRollData,
} from "./shared/derive-creature.mjs";
import { collectDebuffRows, resolveDifficultyRows } from "../helpers/debuff-effects.mjs";

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
    // Levels through play like Characters and Pets do - see actor.mjs's
    // _preUpdate, which only ever fires off system.attributes.level.value, a
    // path Mobs don't have). Feeds the stat-point budget and HB-slot-count formulas
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

    // Actions a round (helpers/actions.mjs). An Elite, like a Boss (any
    // mobTier), gets "1 Action per crawler each round, unless their Stat
    // Block says otherwise" (p.81); a plain Mob 1 Move + 1 Action (p.270).
    // actionsPerRound: a stat block's own count, used instead of either.
    schema.isElite = new fields.BooleanField({ required: true, initial: false });
    schema.actionsPerRound = new fields.NumberField({ required: false, nullable: true, integer: true, initial: null, min: 0 });

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

    // Shape shared with Characters and Pets (data/shared/derive-creature.mjs).
    // initial 1 (not a Character's 3) matches "Mobs have a base of 1 in each
    // stat" (p.270) - a freshly-created Mob starts at the plain (non-Boss)
    // base; switching mobTier to a Boss tier doesn't retroactively bump
    // existing values, only the stat-point budget the Spend Stat Points
    // dialog computes against.
    schema.stats = defineStatsField(1);

    // Active Debuffs/Buffs (Table 11) - same shape as character.mjs. Needed
    // here too since Mobs are the far more common target of an Attack's
    // "Apply to Target(s)" button (module/chat/target-effects-card.mjs) than
    // other player characters.
    schema.conditions = defineConditionsField();

    return schema;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (!this.stats) return;

    // See CarlRPGCharacter#prepareDerivedData - aggregateActorBonuses never
    // mutates this.stats[*].value directly, only the derived-only bonus/mod.
    aggregateActorBonuses(this);

    deriveStats(this);
    // Shared DR/Resistance derivation - a Mob can own a feature granting either.
    deriveDefenses(this);

    // Surprise/Evade (p.271): "10 + Stat Mod", with +Floor appended live at
    // display time only (see abilities-mob.hbs) - never baked into these
    // values, since Floor changes without this Mob being re-saved.
    // This Mob's Debuffs adjust both (p.96: Disadvantage -5, "-X" -X, Woozy
    // drops the DEX Mod) through the same helper dice.mjs's rollAttack and
    // rollOpposedSkillCheck use for the live roll-time Difficulty
    // (module/helpers/debuff-effects.mjs), so the sheet's number and the
    // roll's can't drift apart. Only rows that are on by default count here;
    // the roll dialog is where a per-roll call (e.g. sight-based Blinded on
    // a Surprise check) gets made. *DebuffDelta lets the sheet flag a
    // debuffed value.
    const evade = resolveDifficultyRows(staticEvade(this), collectDebuffRows(this, "evade", { ownAction: false }));
    const surprise = resolveDifficultyRows(10 + (this.stats.int?.mod ?? 0), collectDebuffRows(this, "check", { ownAction: false }));
    this.evadeBase = evade.difficulty;
    this.evadeDebuffDelta = evade.delta;
    this.surpriseBase = surprise.difficulty;
    this.surpriseDebuffDelta = surprise.delta;

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

    deriveResourceCaps(this);
  }

  getRollData() {
    return creatureRollData(this, this.level);
  }
}
