export const CARLRPG = {};

/**
 * The Five Core Stats (Playing the Game, p. 56). No Wisdom - DCC uses
 * Strength, Dexterity, Constitution, Intelligence, Charisma.
 * @type {Object}
 */
CARLRPG.stats = {
  str: "CARLRPG.Stat.Str.long",
  dex: "CARLRPG.Stat.Dex.long",
  con: "CARLRPG.Stat.Con.long",
  int: "CARLRPG.Stat.Int.long",
  cha: "CARLRPG.Stat.Cha.long",
};

CARLRPG.statAbbreviations = {
  str: "CARLRPG.Stat.Str.abbr",
  dex: "CARLRPG.Stat.Dex.abbr",
  con: "CARLRPG.Stat.Con.abbr",
  int: "CARLRPG.Stat.Int.abbr",
  cha: "CARLRPG.Stat.Cha.abbr",
};

/**
 * Table 2: Stat Mods (Playing the Game, p. 57). Stepped lookup, not a linear
 * formula - verified directly against the source PDF (non -layout extraction
 * of book page 57 / PDF page 59).
 * Each entry is [minValue, maxValue, modifier]. maxValue may be Infinity.
 * @type {Array<[number, number, number]>}
 */
CARLRPG.statModTable = [
  [1, 2, 1],
  [3, 5, 2],
  [6, 9, 3],
  [10, 19, 4],
  [20, 49, 5],
  [50, 99, 6],
  [100, 149, 7],
  [150, 199, 8],
  [200, 299, 9],
  [300, Infinity, 10],
];

/**
 * Table 37: Rank Damage Dice (Skills, Spells & Gear, p. 174ish). Used by
 * Upgrades that say "Add 1 Rank damage die" instead of a literal die.
 * Explicitly NOT doubled on a Critical Hit, unlike base damage dice.
 * Each entry is [minRank, maxRank, formula].
 * @type {Array<[number, number, string]>}
 */
CARLRPG.rankDamageDiceTable = [
  [1, 1, "1"],
  [2, 3, "1d2"],
  [4, 5, "1d4"],
  [6, 7, "1d6"],
  [8, 9, "1d8"],
  [10, 11, "1d10"],
  [12, 13, "1d12"],
  [14, 15, "1d8 + 1d6"],
  [16, 17, "2d8"],
  [18, 19, "1d10 + 1d8"],
  [20, 20, "2d10"],
];

/**
 * Table 10: Damage Types (Playing the Game, p. 93).
 * @type {Object}
 */
CARLRPG.damageTypes = {
  acid: "CARLRPG.DamageType.Acid",
  bludgeoning: "CARLRPG.DamageType.Bludgeoning",
  electric: "CARLRPG.DamageType.Electric",
  fire: "CARLRPG.DamageType.Fire",
  force: "CARLRPG.DamageType.Force",
  holy: "CARLRPG.DamageType.Holy",
  ice: "CARLRPG.DamageType.Ice",
  necrotic: "CARLRPG.DamageType.Necrotic",
  piercing: "CARLRPG.DamageType.Piercing",
  poison: "CARLRPG.DamageType.Poison",
  psychic: "CARLRPG.DamageType.Psychic",
  slashing: "CARLRPG.DamageType.Slashing",
  sonic: "CARLRPG.DamageType.Sonic",
};

/**
 * Table 10's Resistance/Vulnerability/Immunity states (Playing the Game,
 * p. 93), keyed per damage type on an Actor's `system.resistances` (see
 * module/data/actor-base.mjs). "none" is the default - most damage types on
 * most actors. See module/helpers/damage-pipeline.mjs for how these combine
 * with the flat `dr` field into the actual damage-reduction pipeline.
 */
CARLRPG.resistanceStates = {
  none: "CARLRPG.ResistanceState.None",
  resist: "CARLRPG.ResistanceState.Resist",
  vulnerable: "CARLRPG.ResistanceState.Vulnerable",
  immune: "CARLRPG.ResistanceState.Immune",
};

/**
 * Size categories, keyed by their numeric size value (the same 1-8 scale
 * the Roll20 sheet's Size select uses, e.g. "Medium (4)").
 * @type {Object}
 */
CARLRPG.sizes = {
  1: "CARLRPG.Size.Tiny",
  2: "CARLRPG.Size.Small",
  3: "CARLRPG.Size.Petite",
  4: "CARLRPG.Size.Medium",
  5: "CARLRPG.Size.Large",
  6: "CARLRPG.Size.Huge",
  7: "CARLRPG.Size.Colossal",
  8: "CARLRPG.Size.Gargantuan",
};

/**
 * Worn gear slots in the Inventory tab's Equipped section (items-list.hbs).
 * Each slot holds an owned Item's id; `icon` is the empty-slot placeholder
 * (game-icons.net art, see assets/gear-slots/CREDITS.md).
 * Listed in grid order: the template places each one by its key as a CSS
 * grid-area (see _crawler-pages.scss's .carl-gear-grid).
 */
CARLRPG.gearSlots = {
  head: { label: "CARLRPG.GearSlot.Head", icon: gearIcon("head") },
  arms: { label: "CARLRPG.GearSlot.Arms", icon: gearIcon("arms") },
  torso: { label: "CARLRPG.GearSlot.Torso", icon: gearIcon("torso") },
  gloves: { label: "CARLRPG.GearSlot.Gloves", icon: gearIcon("gloves") },
  mainHand: { label: "CARLRPG.GearSlot.MainHand", icon: gearIcon("mainHand") },
  legs: { label: "CARLRPG.GearSlot.Legs", icon: gearIcon("legs") },
  offHand: { label: "CARLRPG.GearSlot.OffHand", icon: gearIcon("offHand") },
  feet: { label: "CARLRPG.GearSlot.Feet", icon: gearIcon("feet") },
};

/** Empty accessory slot placeholder, same art set as CARLRPG.gearSlots. */
CARLRPG.accessoryIcon = gearIcon("accessory");

function gearIcon(name) {
  return `systems/carl-rpg/assets/gear-slots/${name}.svg`;
}

/** The crawler's story notes on the Description tab. */
CARLRPG.storyFields = {
  pastTrauma: "CARLRPG.Actor.PastTrauma",
  looseEnds: "CARLRPG.Actor.LooseEnds",
  regrets: "CARLRPG.Actor.Regrets",
  notes: "CARLRPG.Actor.Notes",
};

/**
 * Fixed slot counts for the Character's free-text list fields, matching the
 * printed/Roll20 sheet ("Accessories (Max 10)", "External Buffs (Max 3)"...).
 * The sheet always renders exactly this many inputs per list.
 * @type {Object<string, number>}
 */
CARLRPG.characterListSlots = {
  externalBuffs: 3,
  hotlist: 10,
  accessories: 10,
  importantKills: 10,
  clubs: 5,
  deity: 5,
  sponsors: 3,
  "personalSpace.notes": 7,
  "pet.attacks": 2,
};

/** Modifier application modes, mirroring Foundry core's ActiveEffect/DataField#applyChange type enum. */
CARLRPG.changeModes = {
  add: "CARLRPG.ChangeMode.Add",
  subtract: "CARLRPG.ChangeMode.Subtract",
  multiply: "CARLRPG.ChangeMode.Multiply",
  override: "CARLRPG.ChangeMode.Override",
  upgrade: "CARLRPG.ChangeMode.Upgrade",
  downgrade: "CARLRPG.ChangeMode.Downgrade",
};

/**
 * Per-targetType allow-list of which CARLRPG.changeModes options the Change
 * Entry editor's Mode dropdown actually offers (see
 * templates/item/parts/changes-editor.hbs and module/helpers/modifiers.mjs's
 * accumulateBonus doc comment for the full reasoning).
 *
 * "skillRank" is the only targetType where a ChangeEntry's `current` is the
 * real, live value (the owned Skill/Spell/Damage-Effect item's actual
 * system.rank), not a per-render bonus-bag accumulator that starts at 0
 * every aggregation pass - so Override ("set Rank to exactly X"), Upgrade
 * ("at least Rank X"), and Downgrade ("at most Rank X") are all semantically
 * sound there. For "stat"/"resource"/"rollMode"/"custom", those same three
 * modes only ever look like they work when exactly one item contributes to
 * that key (Override then equals what Add would've produced against a
 * zeroed accumulator) - with two contributing items the second Override
 * silently clobbers the first item's contribution instead of "overriding the
 * effective value" the way the label implies. Add/Subtract stay correct for
 * any number of contributors regardless; Multiply is now ALSO correct for
 * any number of contributors wherever a real base value is available to
 * scale (currently: "stat" targets, and "resource" target "dr" only - see
 * accumulateBonus's doc comment and applyOneChange's "resource" case for
 * exactly why "hb.max"/"mana.max" don't qualify) and is otherwise left as
 * the pre-existing current*value no-op-for-a-first-contributor arithmetic
 * for "rollMode"/"custom" (no real base exists for an arbitrary bag key) and
 * for "hb.max"/"mana.max" specifically - unchanged by this fix either way,
 * but still offered since it's genuinely computed, just not always useful.
 * Add/Subtract/Multiply are offered as a group for all of "stat"/"resource"/
 * "rollMode"/"custom" regardless of which of those get Multiply's real fix,
 * since none of the three ever mis-fires the way Override/Upgrade/Downgrade
 * do on this path.
 *
 * "advancementBonus" is narrower still: applyOneChange's own "advancementBonus"
 * case (module/helpers/modifiers.mjs) never even reads `change.mode` - it
 * unconditionally does `advancementBonuses[key] += value`, so Subtract and
 * Multiply are ALSO no-ops there today (Subtract only "works" if the author
 * manually types a negative value; Multiply does nothing), not just
 * Override/Upgrade/Downgrade. That's a separate, pre-existing gap from the
 * one this fix targets (not the zeroed-accumulator issue - mode is ignored
 * entirely, not miscomputed) and out of scope to fix here, but the dropdown
 * should not offer options that visibly do nothing, so only Add is listed.
 *
 * A targetType absent from this map (currently just "skillDamage") gets the
 * full CARLRPG.changeModes list unfiltered - skillDamage implements Multiply
 * and Override itself, entirely separately from accumulateBonus (see
 * applyOneChange's "skillDamage" case pushing into entry.damage.multipliers/
 * .overrides), so its dropdown is deliberately left alone here.
 *
 * NOT applied to "resistance": that targetType's Mode dropdown is already a
 * pre-existing, separate oddity (applyOneChange's "resistance" case is pure
 * SET semantics and never reads change.mode at all, for any of the six
 * options) - out of scope for this fix, left as-is.
 *
 * Also NOT applied to a Class/Race item's "stat" ChangeEntry specifically -
 * see the `changeModeChoices` Handlebars helper (module/carl-rpg.mjs) for why
 * (those bake into the actor's real base value via race-class-grants.mjs,
 * never through accumulateBonus at all, so all six modes are correct there).
 */
CARLRPG.changeModesByTarget = {
  stat: ["add", "subtract", "multiply"],
  resource: ["add", "subtract", "multiply"],
  rollMode: ["add", "subtract", "multiply"],
  custom: ["add", "subtract", "multiply"],
  advancementBonus: ["add"],
  skillRank: ["add", "subtract", "multiply", "override", "upgrade", "downgrade"],
};

/** Only meaningful when a ChangeEntry.targetType is "skillDamage" - see change-entry.mjs. */
CARLRPG.damageDiceKinds = {
  base: "CARLRPG.DamageDiceKind.Base",
  rankDie: "CARLRPG.DamageDiceKind.RankDie",
  flat: "CARLRPG.DamageDiceKind.Flat",
  multiplier: "CARLRPG.DamageDiceKind.Multiplier",
};

/** What kind of thing a ChangeEntry.target points at. */
CARLRPG.changeTargetTypes = {
  stat: "CARLRPG.ChangeTarget.Stat",
  skillRank: "CARLRPG.ChangeTarget.SkillRank",
  skillDamage: "CARLRPG.ChangeTarget.SkillDamage",
  resource: "CARLRPG.ChangeTarget.Resource",
  rollMode: "CARLRPG.ChangeTarget.RollMode",
  custom: "CARLRPG.ChangeTarget.Custom",
  resistance: "CARLRPG.ChangeTarget.Resistance",
  advancementBonus: "CARLRPG.ChangeTarget.AdvancementBonus",
};

/**
 * The fixed, known set of ChangeEntry.target values for targetType
 * "resource" - the only two resource-bonus keys actually consumed anywhere
 * (see character.mjs/mob.mjs#prepareDerivedData). Unlike Skill Rank/Skill
 * Damage targets (arbitrary homebrew skill names with no master list), this
 * is a genuinely closed, enumerable set, so it gets a real dropdown.
 */
CARLRPG.resourceTargets = {
  "hb.max": "CARLRPG.ResourceTarget.HbMax",
  "mana.max": "CARLRPG.ResourceTarget.ManaMax",
  dr: "CARLRPG.ResourceTarget.Dr",
};

/**
 * The fixed, known set of ChangeEntry.target values for targetType
 * "rollMode" - "evadeBonus" is the only roll-time convention key actually
 * consumed anywhere (CarlDice.rollEvadeCheck reads sys.bonuses.evadeBonus
 * directly), so this is also a genuinely closed set, unlike "custom" (kept
 * free text - it's deliberately the escape hatch for anything not covered
 * by the other five categories).
 */
CARLRPG.rollModeTargets = {
  evadeBonus: "CARLRPG.RollModeTarget.EvadeBonus",
};

CARLRPG.skillCategories = {
  attack: "CARLRPG.SkillCategory.Attack",
  utility: "CARLRPG.SkillCategory.Utility",
  passive: "CARLRPG.SkillCategory.Passive",
};

CARLRPG.attackTypes = {
  melee: "CARLRPG.AttackType.Melee",
  ranged: "CARLRPG.AttackType.Ranged",
};

/**
 * Governs when a nominally-Passive Skill can still mark for Skill
 * Advancement (Crawler Advancement, p. 169). Most Passive Skills never mark;
 * a few (Dodge, Cockroach, Escape Plan, etc.) mark until Rank 5 then lock to
 * magical-means-only advancement.
 */
CARLRPG.advancementGates = {
  normal: "CARLRPG.AdvancementGate.Normal",
  "passive-until-5": "CARLRPG.AdvancementGate.PassiveUntil5",
  "magic-only": "CARLRPG.AdvancementGate.MagicOnly",
};

CARLRPG.castingKeywords = {
  attack: "CARLRPG.CastingKeyword.Attack",
  passive: "CARLRPG.CastingKeyword.Passive",
  interrupt: "CARLRPG.CastingKeyword.Interrupt",
  areaOfEffect: "CARLRPG.CastingKeyword.AreaOfEffect",
  mindControl: "CARLRPG.CastingKeyword.MindControl",
  heal: "CARLRPG.CastingKeyword.Heal",
};

CARLRPG.mobTiers = {
  neighborhood: "CARLRPG.MobTier.Neighborhood",
  borough: "CARLRPG.MobTier.Borough",
  city: "CARLRPG.MobTier.City",
  province: "CARLRPG.MobTier.Province",
  country: "CARLRPG.MobTier.Country",
  floor: "CARLRPG.MobTier.Floor",
};

/**
 * "Building a Mob" (p.270-272): a plain (non-Boss) Mob's stat-point budget -
 * a base of 1 in each Stat, and 3 points to spend per Level (e.g. a Level 6
 * Mob has 18 points to distribute). This is a DISTINCT rule from
 * bossSeverity below, not an implicit "tier 0" row of it - the book only
 * tabulates Boss severity in Table 50; a blank mobTier always uses these two
 * constants instead, never a bossSeverity lookup. See mob.mjs#prepareDerivedData.
 */
CARLRPG.mobBaseStat = 1;
CARLRPG.mobStatPointsPerLevel = 3;

/**
 * Table 50: Boss Severity (p.270). Every Boss tier shares the same base of 5
 * in each Stat (statBase, vs. a plain Mob's 1 above) - keyed per-tier here
 * anyway so a lookup never has to special-case it separately. hbSlotsBase is
 * added to the current Floor for a Boss's total HB slot count; a plain Mob
 * instead uses min(Level, 10) - see mob.mjs#prepareDerivedData.
 */
CARLRPG.bossSeverity = {
  neighborhood: { statBase: 5, statsPerLevel: 3, hbSlotsBase: 10 },
  borough: { statBase: 5, statsPerLevel: 4, hbSlotsBase: 15 },
  city: { statBase: 5, statsPerLevel: 5, hbSlotsBase: 20 },
  province: { statBase: 5, statsPerLevel: 6, hbSlotsBase: 25 },
  country: { statBase: 5, statsPerLevel: 8, hbSlotsBase: 30 },
  floor: { statBase: 5, statsPerLevel: 10, hbSlotsBase: 40 },
};

/**
 * Randomized Magic Items (Skills, Spells & Gear, p.219-220): a loot box's
 * tier sets how many times to roll on the Item Type sub-table it lands on
 * to build up one item's properties (0 for Bronze - the item stays
 * mundane, no rolls at all), and `xValues` is the book's own GM-facing
 * guidance text for what a "+X Stat/Skill Bonus" result is worth at that
 * tier - deliberately never auto-rolled/computed (see module/helpers/
 * loot.mjs), since Platinum+ are percentages needing a specific
 * character's current Stat to resolve, and Buffs/Inherent Spells/Passive
 * Skill results already have no master list to automate against either.
 */
CARLRPG.lootBoxTiers = {
  bronze: { label: "CARLRPG.LootBox.Bronze.Label", rolls: 0 },
  silver: {
    label: "CARLRPG.LootBox.Silver.Label",
    rolls: 1,
    xValues: "CARLRPG.LootBox.Silver.XValues",
  },
  gold: { label: "CARLRPG.LootBox.Gold.Label", rolls: 2, xValues: "CARLRPG.LootBox.Gold.XValues" },
  platinum: {
    label: "CARLRPG.LootBox.Platinum.Label",
    rolls: 3,
    xValues: "CARLRPG.LootBox.Platinum.XValues",
  },
  legendary: {
    label: "CARLRPG.LootBox.Legendary.Label",
    rolls: 4,
    xValues: "CARLRPG.LootBox.Legendary.XValues",
  },
  celestial: {
    label: "CARLRPG.LootBox.Celestial.Label",
    rolls: 5,
    xValues: "CARLRPG.LootBox.Celestial.XValues",
  },
};

/** Boon tiers (Crawler Advancement, p. 168's Acolyte/Devotee/Zealot pattern). */
CARLRPG.featureTiers = {
  acolyte: "CARLRPG.FeatureTier.Acolyte",
  devotee: "CARLRPG.FeatureTier.Devotee",
  zealot: "CARLRPG.FeatureTier.Zealot",
};

/**
 * Table 11: Debuffs (Playing the Game, p. 96-97). Each entry carries:
 *  - `label` / `effect` / `mobEffect` - localized display text. `mobEffect`,
 *    where present, is the p.96 "Debuffs on Mobs or NPCs" rewording for a
 *    creature that never rolls its own d20 (shown on the Conditions tab
 *    tooltip via module/carl-rpg.mjs's `debuffEffectHint` helper).
 *  - `durationType` / `durationValue` - the default duration. For
 *    "rounds", `durationValue` counts END-OF-ROUND ticks, not rounds started:
 *    "until the end of the next round" is 2 (the end of the round it was
 *    applied in, then the end of the next one). Ticked down automatically by
 *    module/helpers/round-end.mjs.
 *  - `stackable` - whether a second application adds a second entry.
 *  - `mechanics` - the structured hooks the automation reads. Interpreted by
 *    module/helpers/debuff-effects.mjs (roll-time effects) and
 *    module/helpers/round-end.mjs (end-of-round/end-of-combat effects):
 *      penalty: N           "-N to all Checks" (per stack for a Stackable debuff).
 *      disadvantage: scope  "all" (every Check) | "sight" (sight-based Checks
 *                           only - surfaced as a dialog toggle) | "attack"
 *                           (Attacks only) | "nextAttack" (the next Attack,
 *                           then consumed) | "nextCheck" (the next Check of
 *                           any kind, then consumed) | "nextAction" (any roll
 *                           that is the creature's own Action, then consumed).
 *      endsAfterAction: true  Removed at the end of the creature's next
 *                           Action, whatever it is (Queasy, Staggered).
 *      noDexMod: true       Can't add DEX Mod to Attack or Evade.
 *      attackersGainAdvantage: true  Attacks against this creature have Advantage.
 *      dot: {formula, damageType}    Damage at the end of each round (p.96:
 *                           bypasses DR; Resistances/Immunities still apply).
 *      countdown: true      Dying's "CON Mod rounds until death" countdown;
 *                           each instance of damage also takes 1 off it.
 *      endsOnHealing: true  Removed when the creature regains >=1 HB slot.
 *      endsOnRest: kind     Removed by a rest of at least this length: "short" (2h),
 *                           "long" (8h) or "fullDay" (30h) - module/helpers/rest.mjs.
 *      endsWithCombat: true Removed when the Combat ends ("end of combat or
 *                           5 minutes").
 *      endsOnHbLoss: true   Removed when the creature loses >=1 HB slot.
 *      noHealing: true      Healing can't be applied.
 *      noSpells: true       Can't cast Spells.
 *      noActions: true      Can't take any Actions (rolls are blocked).
 *      alsoApplies: [key]   Applying this debuff also applies these.
 *
 * On a Mob, every d20-shaped penalty becomes a change to the Mob's static
 * Difficulty instead (p.60/p.96): Disadvantage is -5 (Advantage +5; they
 * cancel, and two of the same don't combine), a "-X" penalty is -X, and a
 * Disadvantaged Mob Attack gives the target a free Evade Check. See
 * module/helpers/debuff-effects.mjs for both halves.
 * @type {Object}
 */
CARLRPG.debuffs = {
  blinded: {
    label: "CARLRPG.Debuff.Blinded.Label",
    effect: "CARLRPG.Debuff.Blinded.Effect",
    mobEffect: "CARLRPG.Debuff.Blinded.MobEffect",
    durationType: "rounds",
    durationValue: 2,
    stackable: false,
    mechanics: { disadvantage: "sight" },
  },
  bloodTrail: {
    label: "CARLRPG.Debuff.BloodTrail.Label",
    effect: "CARLRPG.Debuff.BloodTrail.Effect",
    mobEffect: "CARLRPG.Debuff.BloodTrail.MobEffect",
    durationType: "until-condition",
    stackable: true,
    mechanics: { dot: { formula: "1d6 + @floor", damageType: "" } },
  },
  burned: {
    label: "CARLRPG.Debuff.Burned.Label",
    effect: "CARLRPG.Debuff.Burned.Effect",
    mobEffect: "CARLRPG.Debuff.Burned.MobEffect",
    durationType: "real-minutes",
    durationValue: 5,
    stackable: false,
    mechanics: { dot: { formula: "1d10 + @floor", damageType: "fire" }, endsWithCombat: true },
  },
  drowning: {
    label: "CARLRPG.Debuff.Drowning.Label",
    effect: "CARLRPG.Debuff.Drowning.Effect",
    mobEffect: "CARLRPG.Debuff.Drowning.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { dot: { formula: "1d6 + @floor", damageType: "" } },
  },
  dying: {
    label: "CARLRPG.Debuff.Dying.Label",
    effect: "CARLRPG.Debuff.Dying.Effect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { countdown: true, noActions: true, endsOnHealing: true },
  },
  enraged: {
    label: "CARLRPG.Debuff.Enraged.Label",
    effect: "CARLRPG.Debuff.Enraged.Effect",
    durationType: "rounds",
    durationValue: 2,
    stackable: false,
  },
  fatigued: {
    label: "CARLRPG.Debuff.Fatigued.Label",
    effect: "CARLRPG.Debuff.Fatigued.Effect",
    mobEffect: "CARLRPG.Debuff.Fatigued.MobEffect",
    durationType: "until-condition",
    stackable: true,
    mechanics: { penalty: 1, endsOnRest: 'long' },
  },
  held: {
    label: "CARLRPG.Debuff.Held.Label",
    effect: "CARLRPG.Debuff.Held.Effect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { attackersGainAdvantage: true },
  },
  longTermMajorInjury: {
    label: "CARLRPG.Debuff.LongTermMajorInjury.Label",
    effect: "CARLRPG.Debuff.LongTermMajorInjury.Effect",
    mobEffect: "CARLRPG.Debuff.LongTermMajorInjury.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { penalty: 5, endsOnRest: 'fullDay' },
  },
  longTermMinorInjury: {
    label: "CARLRPG.Debuff.LongTermMinorInjury.Label",
    effect: "CARLRPG.Debuff.LongTermMinorInjury.Effect",
    mobEffect: "CARLRPG.Debuff.LongTermMinorInjury.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { penalty: 2, endsOnRest: 'long' },
  },
  majorInjury: {
    label: "CARLRPG.Debuff.MajorInjury.Label",
    effect: "CARLRPG.Debuff.MajorInjury.Effect",
    mobEffect: "CARLRPG.Debuff.MajorInjury.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { penalty: 5, endsOnRest: 'long' },
  },
  minorInjury: {
    label: "CARLRPG.Debuff.MinorInjury.Label",
    effect: "CARLRPG.Debuff.MinorInjury.Effect",
    mobEffect: "CARLRPG.Debuff.MinorInjury.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { penalty: 2, endsOnRest: 'short' },
  },
  muted: {
    label: "CARLRPG.Debuff.Muted.Label",
    effect: "CARLRPG.Debuff.Muted.Effect",
    durationType: "real-minutes",
    durationValue: 5,
    stackable: false,
    mechanics: { noSpells: true, endsWithCombat: true },
  },
  poisoned: {
    label: "CARLRPG.Debuff.Poisoned.Label",
    effect: "CARLRPG.Debuff.Poisoned.Effect",
    mobEffect: "CARLRPG.Debuff.Poisoned.MobEffect",
    durationType: "until-condition",
    stackable: true,
    mechanics: { dot: { formula: "1d8 + @floor", damageType: "poison" } },
  },
  paralyzed: {
    label: "CARLRPG.Debuff.Paralyzed.Label",
    effect: "CARLRPG.Debuff.Paralyzed.Effect",
    durationType: "rounds",
    durationValue: 2,
    stackable: false,
    mechanics: { noActions: true },
  },
  queasy: {
    label: "CARLRPG.Debuff.Queasy.Label",
    effect: "CARLRPG.Debuff.Queasy.Effect",
    mobEffect: "CARLRPG.Debuff.Queasy.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { disadvantage: "nextAction", endsAfterAction: true },
  },
  sepsis: {
    label: "CARLRPG.Debuff.Sepsis.Label",
    effect: "CARLRPG.Debuff.Sepsis.Effect",
    mobEffect: "CARLRPG.Debuff.Sepsis.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: {
      dot: { formula: "1d10 + @floor", damageType: "poison" },
      alsoApplies: ["staggered"],
      endsOnHealing: true,
    },
  },
  shitFaced: {
    label: "CARLRPG.Debuff.ShitFaced.Label",
    effect: "CARLRPG.Debuff.ShitFaced.Effect",
    mobEffect: "CARLRPG.Debuff.ShitFaced.MobEffect",
    durationType: "real-minutes",
    durationValue: 10,
    stackable: false,
    mechanics: { disadvantage: "all" },
  },
  shocked: {
    label: "CARLRPG.Debuff.Shocked.Label",
    effect: "CARLRPG.Debuff.Shocked.Effect",
    durationType: "until-condition",
    stackable: false,
  },
  soreAsShit: {
    label: "CARLRPG.Debuff.SoreAsShit.Label",
    effect: "CARLRPG.Debuff.SoreAsShit.Effect",
    mobEffect: "CARLRPG.Debuff.SoreAsShit.MobEffect",
    durationType: "real-minutes",
    durationValue: 60,
    stackable: false,
    mechanics: { penalty: 1 },
  },
  staggered: {
    label: "CARLRPG.Debuff.Staggered.Label",
    effect: "CARLRPG.Debuff.Staggered.Effect",
    mobEffect: "CARLRPG.Debuff.Staggered.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { disadvantage: "nextAttack", endsAfterAction: true },
  },
  stiffLegs: {
    label: "CARLRPG.Debuff.StiffLegs.Label",
    effect: "CARLRPG.Debuff.StiffLegs.Effect",
    durationType: "real-minutes",
    durationValue: 5,
    stackable: false,
    mechanics: { endsWithCombat: true },
  },
  stunned: {
    label: "CARLRPG.Debuff.Stunned.Label",
    effect: "CARLRPG.Debuff.Stunned.Effect",
    mobEffect: "CARLRPG.Debuff.Stunned.MobEffect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { disadvantage: "nextCheck" },
  },
  takeDown: {
    label: "CARLRPG.Debuff.TakeDown.Label",
    effect: "CARLRPG.Debuff.TakeDown.Effect",
    durationType: "until-condition",
    stackable: false,
    mechanics: { attackersGainAdvantage: true },
  },
  terrified: {
    label: "CARLRPG.Debuff.Terrified.Label",
    effect: "CARLRPG.Debuff.Terrified.Effect",
    mobEffect: "CARLRPG.Debuff.Terrified.MobEffect",
    durationType: "rounds",
    durationValue: 2,
    stackable: false,
    mechanics: { disadvantage: "attack", endsOnHbLoss: true },
  },
  theTaint: {
    label: "CARLRPG.Debuff.TheTaint.Label",
    effect: "CARLRPG.Debuff.TheTaint.Effect",
    durationType: "real-minutes",
    durationValue: 5,
    stackable: false,
    mechanics: { noHealing: true, endsWithCombat: true },
  },
  woozy: {
    label: "CARLRPG.Debuff.Woozy.Label",
    effect: "CARLRPG.Debuff.Woozy.Effect",
    mobEffect: "CARLRPG.Debuff.Woozy.MobEffect",
    durationType: "rounds",
    durationValue: 2,
    stackable: false,
    mechanics: { noDexMod: true },
  },
};

/** Degrees of success/failure for a d20 Check (Playing the Game, p. 60-61, 79-80). */
CARLRPG.degreesOfSuccess = {
  criticalHit: "CARLRPG.Degree.CriticalHit",
  amazingSuccess: "CARLRPG.Degree.AmazingSuccess",
  standardSuccess: "CARLRPG.Degree.StandardSuccess",
  nearMissFail: "CARLRPG.Degree.NearMissFail",
  standardFail: "CARLRPG.Degree.StandardFail",
  majorFail: "CARLRPG.Degree.MajorFail",
  criticalFail: "CARLRPG.Degree.CriticalFail",
};
