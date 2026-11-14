import CarlRPGActorBase from "./actor-base.mjs";
import { staticEvade } from "../helpers/rules.mjs";
import { aggregateActorBonuses } from "../helpers/modifiers.mjs";
import { defineConditionsField } from "./shared/condition-entry.mjs";
import {
  defineStatsField, deriveStats, deriveDefenses, deriveResourceCaps, creatureRollData,
} from "./shared/derive-creature.mjs";

/**
 * Pet actor (Pets, p.228-232) - a crawler's animal companion, and living
 * mounts too (`isMount`, Mounts p.232-233). See docs/companions-and-vehicles.md.
 *  - Its own crawler (`ownerId`) rolls its Attacks and Evades, as the owner
 *    rolls a crawler's (module/helpers/actor-kinds.mjs rollsLikeCrawler), and
 *    it acts in the Crawler phase - but it dies at 0% HB like a Mob.
 *  - It levels with its crawler: 2 Levels per crawler Level until 15, then 1
 *    (module/helpers/pets.mjs), banking 3 Stat Points per Level through the
 *    same system.attributes.level.value path a Character uses (documents/
 *    actor.mjs). Mounts never level.
 *  - It has no Skill Ranks of its own: every owned Skill/Spell's Rank is the
 *    current Floor (data/ranked-item-base.mjs).
 *  - `command` records the Command Pet result for one combat (module/helpers/
 *    pet-command.mjs).
 */
export default class CarlRPGPet extends CarlRPGActorBase {
  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    // A choice of a CONFIG map's keys; "" (none) is allowed unless the
    // initial value is a real key that must always be set.
    const choice = (map, initial) => new fields.StringField({
      required: true, blank: initial === "", initial,
      choices: [...(initial === "" ? [""] : []), ...Object.keys(map)],
    });
    const schema = super.defineSchema();

    // Same path as a Character's, so the +3 banked Stat Points per Level in
    // CarlRPGActor#_preUpdate and @lvl in roll data work unchanged.
    schema.attributes = new fields.SchemaField({
      level: new fields.SchemaField({
        value: new fields.NumberField({ ...requiredInteger, initial: 1, min: 1, max: 250 }),
      }),
    });
    schema.bankedStatPoints = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });

    // "Pet, Level 1": STR 2, INT 1, CON 2, DEX 2, CHA 1 (p.231).
    schema.stats = defineStatsField(CONFIG.CARLRPG.petBaseStats);
    schema.conditions = defineConditionsField();

    // A dedicated mount: "Health Bar slots equal to their size, and that's
    // all they're going to get, as mounts don't level up as pets do" (p.232).
    schema.isMount = new fields.BooleanField({ initial: false });
    // The bonded crawler - a world Actor id, like a Character's class/race.
    schema.ownerId = new fields.StringField({ required: true, blank: true, initial: "" });
    // "If a Class grants you a pet ... That pet starts as Calm" (p.229).
    schema.attitude = choice(CONFIG.CARLRPG.petAttitudes, "calm");
    schema.role = choice(CONFIG.CARLRPG.petRoles, "");
    schema.specialAbilities = new fields.SchemaField({
      move60: new fields.BooleanField({ initial: false }),
      tauntOrCatcher: choice({ taunt: "Taunt", catcher: "Catcher" }, ""),
      altMove: choice(CONFIG.CARLRPG.petAltMoves, ""),
      heightenedSenses: new fields.BooleanField({ initial: false }),
      resistance: choice(CONFIG.CARLRPG.damageTypes, ""),
    });
    schema.matureBenefit = new fields.StringField({ required: true, blank: true, initial: "" });
    // Brought from Earth: INT 2+ (an Enhanced Pet Biscuit) makes it a crawler.
    schema.earthBorn = new fields.BooleanField({ initial: false });

    schema.size = new fields.NumberField({
      ...requiredInteger, initial: 3, min: 1, max: 8,
      choices: Object.keys(CONFIG.CARLRPG.sizes).map(Number),
    });
    schema.creatureType = new fields.StringField({ required: true, blank: true, initial: "" });
    // "Speed 20+S" (p.231) - Move plus Step, as a crawler's.
    schema.move = new fields.NumberField({ ...requiredInteger, initial: 20, min: 0 });
    schema.step = new fields.NumberField({ ...requiredInteger, initial: 10, min: 0 });
    schema.hbSlotsOverride = new fields.NumberField({ required: false, nullable: true, integer: true, min: 1, initial: null });

    schema.command = new fields.SchemaField({
      state: choice(CONFIG.CARLRPG.petCommandStates, ""),
      combatId: new fields.StringField({ required: true, blank: true, initial: "" }),
      round: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
    });

    return schema;
  }

  /**
   * HB slots from the rules: Size to start, +1 per Level gained, max 10
   * (p.231); a mount's never grow past its Size (p.232).
   * @param {{size: number, level: number, isMount: boolean}} args
   * @returns {number}
   */
  static hbSlotsFor({ size, level, isMount }) {
    return Math.min(isMount ? size : size + level - 1, 10);
  }

  /**
   * Every new Pet keeps its own contents and HB (a linked token - the owner
   * link, auto-levelling and command reset all go through game.actors). It
   * starts with full HB and Mana, belongs to its creator's crawler when one
   * isn't given, and whoever plays that crawler can run it.
   * @override
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;
    const sys = data.system ?? {};
    const updates = { prototypeToken: { actorLink: true }, system: {} };
    if (!data.img) updates.img = "icons/svg/pawprint.svg";

    const hbMax = CarlRPGPet.hbSlotsFor({
      size: sys.size ?? 3,
      level: sys.attributes?.level?.value ?? 1,
      isMount: !!sys.isMount,
    });
    if (sys.hb?.value === undefined) updates.system.hb = { value: hbMax };
    if (sys.mana?.value === undefined) {
      updates.system.mana = { value: sys.stats?.int?.value ?? CONFIG.CARLRPG.petBaseStats.int };
    }

    let ownerId = sys.ownerId;
    if (!ownerId && user?.character?.type === "character") {
      ownerId = user.character.id;
      updates.system.ownerId = ownerId;
    }
    const owner = ownerId ? game.actors?.get(ownerId) : null;
    if (owner) {
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const owners = Object.entries(owner.ownership ?? {})
        .filter(([id, level]) => id !== "default" && level >= OWNER);
      if (owners.length) {
        updates.ownership = { ...(data.ownership ?? {}), ...Object.fromEntries(owners.map(([id]) => [id, OWNER])) };
      }
    }
    this.parent.updateSource(updates);
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (!this.stats) return;

    aggregateActorBonuses(this);
    const floor = game.settings.get("carl-rpg", "currentFloor");
    this.applyRoleBonuses(floor);

    deriveStats(this);
    deriveDefenses(this);

    const level = this.attributes.level.value;
    this.hbSlotsRule = CarlRPGPet.hbSlotsFor({ size: this.size, level, isMount: this.isMount });
    this.hb.max = this.hbSlotsOverride ?? this.hbSlotsRule;
    if (this.hb.value > this.hb.max) this.hb.value = this.hb.max;

    // Move 60ft (a Special Ability, p.231) replaces the base Move.
    this.moveEffective = this.specialAbilities.move60 ? Math.max(60, this.move) : this.move;
    this.altMoveValue = CONFIG.CARLRPG.petAltMoveFeet[this.specialAbilities.altMove] ?? 0;
    // Reference values shown "+F" on the sheet, like a Mob's. A Pet still
    // rolls its own Evade when attacked; this is what an attacker sees.
    this.evadeBase = staticEvade(this);
    // "INT-Opposed Animal Handling Skill Checks vs. the INT of the pet ...
    // base 10, +1 for their INT Mod, and + Floor" (p.230).
    this.commandBase = 10 + (this.stats.int?.mod ?? 0);
    this.rankFloor = Math.min(Math.max(1, floor), 20);

    const abilities = this.specialAbilities;
    this.specialAbilityCount = [
      abilities.move60, abilities.tauntOrCatcher, abilities.altMove,
      abilities.heightenedSenses, abilities.resistance,
    ].filter(Boolean).length;
    this.specialAbilityAllowed = CONFIG.CARLRPG.petSpecialAbilityAllowance[this.role] ?? 0;
    this.intWarning = this.earthBorn && this.stats.int.value >= 2;

    deriveResourceCaps(this);
  }

  /**
   * The Pet Roles (p.231), on top of whatever its gear grants:
   *  - Tank: "Has DR equal to Floor Number" - added to DR.
   *  - Aggressive: "add + Floor damage to all Animal Attacks" - every owned
   *    Attack Skill gets a +F damage term (a Pet's Attacks are all animal).
   *  - The Resistance Special Ability: Resistance to the chosen type, unless
   *    something already grants it a better state.
   * @param {number} floor
   */
  applyRoleBonuses(floor) {
    this.bonuses ??= {};
    if (this.role === "tank") this.bonuses.dr = (this.bonuses.dr ?? 0) + floor;
    if (this.role === "aggressive") {
      const label = game.i18n.localize("CARLRPG.Pet.Roles.aggressive");
      for (const entry of Object.values(this.skills ?? {})) {
        if (entry.itemType !== "skill" || entry.category !== "attack") continue;
        entry.damage.flatBonuses.push({ formula: String(floor), label, mode: "add", damageType: "" });
      }
    }
    const resisted = this.specialAbilities.resistance;
    if (resisted) {
      this.grantedResistances ??= {};
      this.grantedResistances[resisted] ??= "resist";
    }
  }

  getRollData() {
    return creatureRollData(this, this.attributes.level.value);
  }
}
