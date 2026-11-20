import CarlRPGActorBase from "./actor-base.mjs";
import { ownerIds, withOwners } from "../helpers/ownership.mjs";
import { deriveDefenses } from "./shared/derive-creature.mjs";
import { currentFloor } from "../helpers/floor.mjs";

/** The driving Skill keys a vehicle stored before 0.7.0, and the Skills they named. */
export const LEGACY_DRIVE_SKILLS = Object.freeze({
  driving: "Driving",
  chopperPilot: "Chopper Pilot",
});

/**
 * Vehicle actor (Vehicles, p.72-73; docs/companions-and-vehicles.md). An
 * object, not a creature: "They do not have Actions but simply move
 * according to the driver's wishes" - no Stats, Skills, Level, Evade or
 * Debuffs. What it has:
 *  - 10 Health Bar slots, each worth its Size ("Instead of a CON Mod in
 *    each slot, the vehicle's size value (1-8) is used"), and DR.
 *  - Move (roughly its mph), Occupancy (the driver included) and cargo.
 *  - Occupants (`occupants`): who is aboard and who drives. The occupants are
 *    the combatants; a vehicle never is (documents/combat.mjs).
 *  - This round's Driving Check result (`round`, Table 6) and its upgrades.
 * What depends on other documents - the driver's Driving Rank, the combat
 * round, a running Nitrous boost - is worked out when read, by
 * module/helpers/vehicle-state.mjs vehicleStatus(), not here: those don't
 * re-prepare this actor when they change.
 */
export default class CarlRPGVehicle extends CarlRPGActorBase {
  /** @override */
  static migrateData(source) {
    // Before 0.7.0 the driving Skill was a key: read it as the Skill's name,
    // in memory on every load (world vehicles, tokens, compendiums). The
    // 0.7.0 migration saves it (migration.mjs migrateVehicleSkillSettings).
    if (
      typeof source.driveSkill === "string" &&
      Object.hasOwn(LEGACY_DRIVE_SKILLS, source.driveSkill)
    ) {
      source.driveSkill = LEGACY_DRIVE_SKILLS[source.driveSkill];
    }
    return super.migrateData(source);
  }

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const nullableInteger = { required: false, nullable: true, integer: true, initial: null };
    const choice = (keys, initial) =>
      new fields.StringField({ required: true, blank: initial === "", initial, choices: keys });
    const schema = super.defineSchema();

    schema.model = new fields.StringField({ required: true, blank: true, initial: "" });
    schema.size = new fields.NumberField({
      ...requiredInteger,
      initial: 5,
      min: 1,
      max: 8,
      choices: Object.keys(CONFIG.CARLRPG.sizes).map(Number),
    });
    // Base Move (Table 7). This round's Move: vehicleStatus().
    schema.move = new fields.NumberField({ ...requiredInteger, initial: 80, min: 0 });
    // "The total number of entities (including the driver) that can fit."
    schema.occupancy = new fields.NumberField({ ...requiredInteger, initial: 5, min: 1 });
    // Extra entities in a cargo area - Table 7's "(+50 in cargo)".
    schema.cargo = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });
    // The name of the Skill that drives it (Driving, Chopper Pilot, or a
    // homebrew one), matched by slug against the driver's own Skills. What
    // the driver's Ranks give are that Skill's Upgrade tiers' vehicle fields
    // (module/helpers/vehicle-state.mjs driverPerks).
    schema.driveSkill = new fields.StringField({ required: true, blank: true, initial: "Driving" });
    // An odd vehicle whose slots don't hold its Size (the book's Ship shows 6s).
    schema.hbSlotValueOverride = new fields.NumberField({ ...nullableInteger, min: 1 });

    // Aboard: each occupant's Actor uuid (a token's synthetic actor for an
    // unlinked Mob), its seat, and its name (shown if the token is gone).
    schema.occupants = new fields.ArrayField(
      new fields.SchemaField({
        uuid: new fields.StringField({ required: true, blank: false }),
        role: choice(Object.keys(CONFIG.CARLRPG.vehicleRoles), "passenger"),
        name: new fields.StringField({ required: true, blank: true, initial: "" }),
      }),
      { required: true, initial: [] },
    );
    // Standing still: Move 0, and attacks against it are at Difficulty 10.
    schema.parked = new fields.BooleanField({ initial: true });

    // This round's Driving Check (Table 6), stamped with the fight and round
    // it was rolled in - a new round means full Move again. ramFactor:
    // ramming halves Move (0 if it hit something larger), p.73. checkId:
    // the Check whose card set it (flags.carl-rpg.driving.checkId) - only
    // that card's buttons may change it (module/chat/vehicle-card.mjs);
    // blank when set by hand on the sheet.
    schema.round = new fields.SchemaField({
      combatId: new fields.StringField({ required: true, blank: true, initial: "" }),
      checkId: new fields.StringField({ required: true, blank: true, initial: "" }),
      round: new fields.NumberField(nullableInteger),
      degree: choice(["", ...CONFIG.CARLRPG.degreeOrder], ""),
      critChoice: choice(["", "move", "favor"], ""),
      ramFactor: new fields.NumberField({
        required: true,
        nullable: false,
        initial: 1,
        min: 0,
        max: 1,
      }),
    });
    // Amazing Success: "Advantage on your next Skill Check to operate this vehicle."
    schema.nextCheckAdvantage = new fields.BooleanField({ initial: false });

    // The book's sample upgrades (p.73). "Once per Floor" ones remember the
    // Floor they were last used on.
    schema.upgrades = new fields.SchemaField({
      rollCage: new fields.BooleanField({ initial: false }),
      ramPlate: new fields.BooleanField({ initial: false }),
      nitrous: new fields.SchemaField({
        installed: new fields.BooleanField({ initial: false }),
        endsAt: new fields.NumberField({ required: false, nullable: true, initial: null }),
      }),
      shockAbsorbers: new fields.SchemaField({
        installed: new fields.BooleanField({ initial: false }),
        usedFloor: new fields.NumberField(nullableInteger),
      }),
      fuzzyDice: new fields.SchemaField({
        installed: new fields.BooleanField({ initial: false }),
        usedFloor: new fields.NumberField(nullableInteger),
      }),
    });

    // Built-in weapons - a Mob's Attack shape (so a GM-crewed vehicle fires
    // through CarlDice.rollMobAttack), plus the Attack Skill and Stat a
    // crawler occupant fires it with (module/helpers/vehicle-weapons.mjs).
    schema.attacks = new fields.ArrayField(
      new fields.SchemaField({
        name: new fields.StringField({ required: true, blank: true, initial: "" }),
        toHit: new fields.StringField({ required: true, blank: true, initial: "" }),
        damage: new fields.StringField({ required: true, blank: true, initial: "" }),
        damageType: new fields.StringField({
          required: true,
          blank: true,
          initial: "",
          choices: ["", ...Object.keys(CONFIG.CARLRPG.damageTypes)],
        }),
        range: new fields.StringField({ required: true, blank: true, initial: "" }),
        effect: new fields.StringField({ required: true, blank: true, initial: "" }),
        skill: new fields.StringField({ required: true, blank: true, initial: "" }),
        stat: choice(Object.keys(CONFIG.CARLRPG.stats), "dex"),
      }),
      { required: false, initial: [] },
    );

    return schema;
  }

  /**
   * A linked token (its occupants and damage are its own), full HB, and the
   * Object Immunities a ship's block spells out - Psychic damage can't hurt
   * a machine. Whoever plays its creator's crawler can drive it.
   * @override
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;
    const sys = data.system ?? {};
    const updates = { prototypeToken: { actorLink: true }, system: {} };
    if (!data.img) updates.img = "icons/environment/vehicles/car-automobile-classic.webp";
    if (sys.hb?.value === undefined) updates.system.hb = { value: 10, max: 10 };
    if (sys.resistances?.psychic === undefined) updates.system.resistances = { psychic: "immune" };
    // Not for one the 0.7.0 migration makes: it sets the Character's owners
    // itself, and the migrating GM's own crawler has nothing to do with it.
    const crawler =
      !options?.carlMigration && user?.character?.type === "character" ? user.character : null;
    const owners = ownerIds(crawler);
    if (owners.length) updates.ownership = withOwners(data.ownership, owners);
    this.parent.updateSource(updates);
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    // No Stats, Skills or conditions: none of a creature's derivation applies
    // (and data/shared/derive-creature.mjs deriveResourceCaps needs Stats).
    this.bonuses = { dr: this.upgrades.rollCage ? 1 : 0 };
    this.grantedResistances = {};
    deriveDefenses(this);

    // Each slot holds the Size - damage-pipeline.mjs reads hb.slotValue, and
    // a slot value of 0 would lose no slots at all.
    this.hb.max = 10;
    this.hb.slotValue = this.hbSlotValueOverride ?? this.size;
    this.hb.bonusMax = 0;
    this.hb.effectiveMax = this.hb.max;
    if (this.hb.value > this.hb.effectiveMax) this.hb.value = this.hb.effectiveMax;
    this.mana.max = 0;
    this.shield.slotValue = 0;
    this.shield.effectiveMax = 0;
    this.shield.value = 0;

    this.capacity = this.occupancy + this.cargo;
  }

  getRollData() {
    return { floor: currentFloor(), size: this.size, move: this.move };
  }
}
