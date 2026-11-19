import CarlDice from "../dice/dice.mjs";
import { recheckLevelGatedGrants } from "../helpers/race-class-grants.mjs";
import { buildConditionEntry, dyingRounds } from "../helpers/conditions.mjs";
import { syncDefeated } from "../helpers/defeat.mjs";
import { isCrawler, isPet, isVehicle } from "../helpers/actor-kinds.mjs";
import { explodeVehicle } from "../helpers/vehicle-ram.mjs";
import { grantPetSkills, levelBondedPets, syncPetCommandStatus, syncPetOwnership } from "../helpers/pets.mjs";

/**
 * Token defaults for a new actor, by type (ruled 2026-11-18): Characters and
 * Pets linked with vision; Mobs unlinked without (a Boss or Elite is linked
 * by the PDF importer); Vehicles and Loot Boxes linked without. Names show
 * on hover to anyone; bars on hover to the owner (a Mob's is the GM's);
 * Loot Boxes have none. Characters and Pets are Friendly, Mobs Hostile,
 * Vehicles and Loot Boxes Neutral. Applied only to what the creation data
 * leaves out (a copy, a compendium entry or an import keeps its own), and
 * only to new actors. Core's Prototype Token Overrides setting still
 * applies on top.
 * @param {string} type
 * @returns {object|null}  Prototype token fields.
 */
export function tokenDefaultsFor(type) {
  const { TOKEN_DISPLAY_MODES: MODES, TOKEN_DISPOSITIONS: DISPOSITIONS } = CONST;
  const shown = { displayName: MODES.HOVER, displayBars: MODES.OWNER_HOVER };
  switch (type) {
    case "character":
    case "pet":
      return { actorLink: true, sight: { enabled: true }, disposition: DISPOSITIONS.FRIENDLY, ...shown };
    case "mob":
      return { actorLink: false, sight: { enabled: false }, disposition: DISPOSITIONS.HOSTILE, ...shown };
    case "vehicle":
      return { actorLink: true, sight: { enabled: false }, disposition: DISPOSITIONS.NEUTRAL, ...shown };
    case "lootBox":
      return { actorLink: true, sight: { enabled: false }, disposition: DISPOSITIONS.NEUTRAL, ...shown, displayBars: MODES.NONE };
    default:
      return null;
  }
}

/**
 * Extend the base Actor document.
 * @extends {Actor}
 */
export class CarlRPGActor extends Actor {
  /**
   * A new actor's token defaults (tokenDefaultsFor), for each field the
   * creation data doesn't set.
   * @override
   */
  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    const defaults = tokenDefaultsFor(this.type);
    if (!defaults) return;
    const given = foundry.utils.flattenObject(data?.prototypeToken ?? {});
    const update = {};
    for (const [path, value] of Object.entries(foundry.utils.flattenObject(defaults))) {
      if (!(path in given)) update[`prototypeToken.${path}`] = value;
    }
    if (Object.keys(update).length) this.updateSource(update);
  }

  /**
   * The old Pet tab's blocks (system.pet / system.mount) are no longer in
   * the Character schema, and Foundry drops keys a schema doesn't know when
   * it cleans source data. This runs first, on the whole raw source (the
   * root DataModelSchemaField migrates before any field is cleaned), and
   * keeps a copy in a flag for the 0.7.0 migration (helpers/companion-
   * migration.mjs) to turn into Pet and Vehicle actors. Flags aren't pruned.
   * In place: the root ignores the return value. A Character already
   * converted (marked companionsMigrated) is left alone.
   * @override
   */
  static migrateData(source) {
    const system = source?.system;
    const hasOld = source?.type === "character" && system && typeof system === "object" && ("pet" in system || "mount" in system);
    if (hasOld && source.flags?.["carl-rpg"]?.companionsMigrated) {
      // Already converted (helpers/companion-migration.mjs), yet the database
      // still has the old keys: they're not brought back, only reported.
      console.warn(`carl-rpg | ${source.name}: old Pet tab data is still stored after its migration; ignored.`);
    } else if (hasOld) {
      source.flags ??= {};
      source.flags["carl-rpg"] ??= {};
      source.flags["carl-rpg"].legacyCompanions ??= foundry.utils.deepClone({
        pet: system.pet ?? null,
        mount: system.mount ?? null,
      });
    }
    return super.migrateData(source);
  }

  /** @override */
  prepareData() {
    super.prepareData();
  }

  /** @override */
  prepareBaseData() {
    super.prepareBaseData();
  }

  /** @override */
  prepareDerivedData() {
    super.prepareDerivedData();
  }

  /**
   * A token bar edit on a resource with bonus slots (hb) clamps to its
   * effective max (hb.effectiveMax), not the base max core uses, so gear's
   * extra HB slots can be filled from the bar. Otherwise core's behavior.
   * @override
   */
  async modifyTokenAttribute(attribute, value, isDelta = false, isBar = true) {
    const attr = foundry.utils.getProperty(this.system, attribute);
    if (!isBar || !Number.isFinite(attr?.effectiveMax)) {
      return super.modifyTokenAttribute(attribute, value, isDelta, isBar);
    }
    const current = attr.value;
    const update = isDelta ? current + value : value;
    if (update === current) return this;
    const updates = { [`system.${attribute}.value`]: Math.clamp(update, 0, attr.effectiveMax) };
    const allowed = Hooks.call("modifyTokenAttribute", { attribute, value, isDelta, isBar }, updates, this);
    return allowed !== false ? this.update(updates) : this;
  }

  /**
   * "When a crawler gains a Level, they also get 3 Stat points to assign"
   * (Crawler Advancement, p.169) - grant `3 x levelDelta` into the same
   * `bankedStatPoints` field module/apps/spend-stat-points-dialog.mjs
   * spends from, whenever this actor's Level actually increases (a GM
   * decrementing Level to correct a mistake doesn't claw points back,
   * consistent with this project's "once baked in, they stay" philosophy
   * for other permanent grants). Mutates `changed` directly so the points
   * land in the SAME update operation as the Level change, rather than a
   * second separate write - covers every path that can change Level (the
   * GM Toolbox's Party Level Up button, the sheet's own Level field, a
   * future Boss-kill/PvP Level-award action), not just one specific caller.
   * @override
   */
  async _preUpdate(changed, options, user) {
    const allowed = await super._preUpdate(changed, options, user);
    if (allowed === false) return false;
    // The 0.7.0 migration rewrites the whole system to drop old keys: nothing
    // really changed, so none of the reactions below apply.
    if (options.carlMigration) return;

    const newLevel = foundry.utils.getProperty(changed, "system.attributes.level.value");
    if (newLevel !== undefined) {
      const delta = Number(newLevel) - (this.system.attributes?.level?.value ?? 0);
      if (delta > 0) {
        const currentBanked = this.system.bankedStatPoints ?? 0;
        foundry.utils.setProperty(changed, "system.bankedStatPoints", currentBanked + 3 * delta);
        // "Keep a running total of all your grinding hours and erase it only
        // when you level up" (p.171) - any Level gain, whatever its source.
        if (this.type === "character") foundry.utils.setProperty(changed, "system.grindLevelHours", 0);
        // A crawler's bonded Pets level with it (_onUpdate, module/helpers/
        // pets.mjs) - _onUpdate can't see the old Level, so carry the gain,
        // keyed by actor (one options object serves a whole batched update).
        if (isCrawler(this)) options.carlLevelDelta = { ...(options.carlLevelDelta ?? {}), [this.id]: delta };
      }
    }

    // "If a crawler loses their last Health Bar slot, they gain the Dying
    // Debuff" (p.94) - added in this same update, with its "CON Mod rounds"
    // countdown (Table 11). Mobs instead die outright (see _onUpdate).
    // HB before this update, for _onUpdate's defeat sync (it only un-marks
    // "defeated" on a heal up from 0). Options travel with the update.
    if (foundry.utils.hasProperty(changed, "system.hb.value")) options.carlPreviousHb = this.system.hb?.value ?? 0;

    const droppedHb = foundry.utils.getProperty(changed, "system.hb.value");
    if (isCrawler(this) && droppedHb !== undefined && Number(droppedHb) <= 0 && (this.system.hb?.value ?? 0) > 0) {
      const conditions = foundry.utils.getProperty(changed, "system.conditions") ?? this.system.toObject().conditions ?? [];
      if (!conditions.some((c) => CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.countdown)) {
        const dying = buildConditionEntry("dying", { source: game.i18n.localize("CARLRPG.Actor.HealthBar") });
        dying.id = foundry.utils.randomID();
        dying.remaining = dyingRounds(this.system);
        foundry.utils.setProperty(changed, "system.conditions", [...conditions, dying]);
      }
    }

    // "Until you die or heal at least 1 HB slot" (Dying, Table 11): any HB
    // gain - Apply Healing, a rest, a hand edit on the sheet - ends every
    // `endsOnHealing` Debuff, in this same update.
    const newHb = foundry.utils.getProperty(changed, "system.hb.value");
    if (newHb !== undefined && Number(newHb) > (this.system.hb?.value ?? 0)) {
      const conditions = foundry.utils.getProperty(changed, "system.conditions") ?? this.system.toObject().conditions ?? [];
      const kept = conditions.filter((c) => !CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.endsOnHealing);
      if (kept.length !== conditions.length) foundry.utils.setProperty(changed, "system.conditions", kept);
    }
  }

  /**
   * Re-check every owned class/race item's level-gated grants (e.g. Bune's
   * "At Level 50, +2 Dexterity") whenever Level changes - a grant that
   * wasn't eligible when the Race/Class was added needs a second chance to
   * bake into base once the gate is crossed. See
   * module/helpers/race-class-grants.mjs.
   * @override
   */
  async _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if (options.carlMigration) return;
    // Defeat/death marking (module/helpers/defeat.mjs): a Mob at 0 HB, or a
    // crawler whose Dying countdown has run out. The active GM does it, so it
    // works whoever applied the damage.
    if (game.users.activeGM?.isSelf
      && (foundry.utils.hasProperty(changed, "system.hb.value") || foundry.utils.hasProperty(changed, "system.conditions"))) {
      syncDefeated(this, { previousHb: options.carlPreviousHb ?? null })
        .catch((err) => console.error("CarlRPG | defeat sync failed", err));
    }
    if (game.users.activeGM?.isSelf) {
      const levelDelta = options.carlLevelDelta?.[this.id];
      if (levelDelta > 0) {
        levelBondedPets(this, levelDelta)
          .catch((err) => console.error("CarlRPG | pet levelling failed", err));
      }
      if (isPet(this)) this.#onPetUpdate(changed);
      // A vehicle brought to 0% HB explodes (p.73) - once, as it gets there.
      if (isVehicle(this) && foundry.utils.hasProperty(changed, "system.hb.value")
        && (options.carlPreviousHb ?? 0) > 0 && this.system.hb.value <= 0) {
        explodeVehicle(this).catch((err) => console.error("CarlRPG | vehicle explosion failed", err));
      }
    }
    if (game.user.id !== userId) return;
    if (foundry.utils.hasProperty(changed, "system.attributes.level.value")) {
      await recheckLevelGatedGrants(this);
    }
  }

  /**
   * A new Pet learns its Slice Attack (module/helpers/pets.mjs). The active GM
   * does it, so it works whoever created the Pet.
   * @override
   */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    // The 0.7.0 migration grants a Pet it makes its Skills itself, awaited
    // (helpers/companion-migration.mjs).
    if (isPet(this) && game.users.activeGM?.isSelf && !options.carlMigration) {
      grantPetSkills(this).catch((err) => console.error("CarlRPG | pet skill grant failed", err));
    }
  }

  /**
   * Deleting the active Race or Class item, however it's done, clears
   * system.race / system.class, so the next one dropped becomes active
   * (actor-sheet.mjs _onDropItem). The deleting user does it.
   * @override
   */
  _onDeleteDescendantDocuments(parent, collection, documents, ids, options, userId) {
    super._onDeleteDescendantDocuments(parent, collection, documents, ids, options, userId);
    if (collection !== "items" || game.user.id !== userId || this.type !== "character") return;
    const cleared = {};
    for (const key of ["class", "race"]) {
      if (this.system[key] && ids.includes(this.system[key])) cleared[`system.${key}`] = "";
    }
    if (foundry.utils.isEmpty(cleared)) return;
    this.update(cleared).catch((err) => console.error("CarlRPG | clearing the active Race/Class failed", err));
  }

  /**
   * Active GM only: a changed Role or Taunt/Catcher pick grants its Skills,
   * a newly picked crawler's players can run the Pet, and a changed Command
   * Pet result updates the token's status icon.
   * @param {object} changed
   */
  #onPetUpdate(changed) {
    const sys = changed.system ?? {};
    if (sys.role !== undefined || sys.specialAbilities?.tauntOrCatcher !== undefined) {
      grantPetSkills(this).catch((err) => console.error("CarlRPG | pet skill grant failed", err));
    }
    if (sys.ownerId) {
      syncPetOwnership(this).catch((err) => console.error("CarlRPG | pet ownership sync failed", err));
    }
    if (sys.command !== undefined) {
      syncPetCommandStatus(this).catch((err) => console.error("CarlRPG | pet command status failed", err));
    }
  }

  /** @override */
  getRollData() {
    return { ...super.getRollData(), ...this.system.getRollData?.() ?? null };
  }

  /**
   * Roll an Evade Check (Interrupt) for this Actor. See module/dice/dice.mjs.
   * @param {{difficulty?: number|null, skipDialog?: boolean}} [options]
   */
  async rollEvadeCheck(options = {}) {
    return CarlDice.rollEvadeCheck(this, options);
  }

  /**
   * Roll a Skill Advancement Check for one owned Skill/Spell/Damage Effect.
   * @param {string} itemId
   * @param {{apply?: boolean, silent?: boolean}} [options]
   */
  async rollAdvancementCheck(itemId, options = {}) {
    const item = this.items.get(itemId);
    if (!item) return null;
    return CarlDice.rollAdvancementCheck(this, item, options);
  }

  /**
   * Roll Skill Advancement Checks for every currently-marked owned
   * Skill/Spell/Damage Effect, optionally restricted to Rank <=4 (the
   * two-hour real-world-timer cadence) vs Rank >=5 (the per-floor cadence).
   * See Crawler Advancement, p. 169. Intended for the GM Toolbox (Milestone 4)
   * but usable directly for testing.
   * @param {{rankFilter?: "lte4"|"gte5"|"all", floorBonus?: boolean}} [options]
   *   floorBonus: whether the Race/Class "at the end of each floor, add 1"
   *   bonus applies - only the End Floor checks (Rank 5+) get it, not the
   *   2-hour checks.
   * @returns {Promise<Array<{item: Item, success: boolean, newRank: number}>>}
   */
  async rollMarkedAdvancementChecks({ rankFilter = "all", floorBonus = true } = {}) {
    const results = [];
    const marked = this.items.filter((i) =>
      ["skill", "spell", "damageEffect"].includes(i.type) && i.system.marked
    );
    for (const item of marked) {
      const rank = item.system.rank ?? 0;
      if (rankFilter === "lte4" && rank > 4) continue;
      if (rankFilter === "gte5" && rank < 5) continue;
      const { success, newRank } = await CarlDice.rollAdvancementCheck(this, item, { silent: true, floorBonus });
      results.push({ item, success, newRank });
    }
    return results;
  }
}
