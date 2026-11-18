import {
  announceWeaponSkill, backfillDeityTier, BASE_DR_MIGRATION_ID, COMPENDIUM_REFRESH_ID, DEITY_MIGRATION_ID,
  DEITY_TIER_MIGRATION_ID, inferDeityTier, MIGRATIONS, migrationPlan, needsHandToHand, persistDeityBlock,
  refreshedItemUpdate, tickHandToHandOn, WEAPON_SKILL_NOTICE_ID, zeroCharacterBaseDr,
  CHARGEN_DONE_MIGRATION_ID, madeBeforeChargen, markChargenDone, refreshSourceFor,
  RENAMED_MIGRATION_IDS, currentMigrationIds, MOB_ATTACKS_MIGRATION_ID,
  MOB_SIZE_MIGRATION_ID, saveMobSizes, GEAR_SLOTS_MIGRATION_ID, WEAPON_SKILL_GUESS_ID, loadWeaponSkillSources,
  guessWeaponSkill, guessActorWeaponSkills, guessItemWeaponSkills, looksLikeWeapon, postWeaponSkillNotice,
  gearSlotUpdate, inferActorGear, BASE_MULTIPLIER_MIGRATION_ID, baseMultiplierUpdate,
} from "../../helpers/migration.mjs";
import {
  blockEntered, legacyCompanionsOf, migrateCompanionsOf, parseSize, petDataFrom, vehicleDataFrom,
} from "../../helpers/companion-migration.mjs";
import { deityBenefitApplies } from "../../helpers/worship.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  useQuenchTimeout,
} from "../helpers.mjs";

/** An Attack Skill with this exact name. */
function attackSkill(actor, name, system = {}) {
  return createTestItem(actor, "skill", name, { name, system: { category: "attack", rank: 2, ...system } });
}

/** Migration ids, in order. */
const ids = (list) => list.map((m) => m.id);

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.migration",
    (context) => {
      const { describe, it, assert } = context;

      describe("World migrations", function () {
        useQuenchTimeout(this);

        it("runs each migration once per world, by id, whatever the version numbers", function () {
          const HAND = "0.7.0-hand-to-hand-box";
          assert.include(ids(MIGRATIONS), HAND);

          // A world from before migrations were tracked, with content in it.
          let p = migrationPlan({ done: [], hasContent: true });
          assert.include(ids(p.run), HAND);
          assert.include(p.record, HAND);

          // A new, empty world: nothing to fix, marked as having had them all.
          p = migrationPlan({ done: [], hasContent: false });
          assert.lengthOf(p.run, 0);
          assert.sameMembers(p.record, ids(MIGRATIONS));

          // Already had: nothing runs, nothing is written.
          p = migrationPlan({ done: ids(MIGRATIONS), hasContent: true });
          assert.lengthOf(p.run, 0);
          assert.isNull(p.record);

          // Ids it doesn't know (e.g. from a newer build) are kept, not lost.
          p = migrationPlan({ done: ["some-later-fix"], hasContent: true });
          assert.include(ids(p.run), HAND);
          assert.includeMembers(p.record, ["some-later-fix", HAND]);
        });

        it("are all 0.7.0 migrations, and a world that ran them under their old 0.6.0 ids reruns none", function () {
          for (const m of MIGRATIONS) {
            assert.equal(m.version, "0.7.0", m.id);
            assert.match(m.id, /^0\.7\.0-/, m.id);
          }
          const oldIds = Object.keys(RENAMED_MIGRATION_IDS);
          const renamed = Object.values(RENAMED_MIGRATION_IDS);
          assert.includeMembers(MIGRATIONS.map((m) => m.id), renamed, "every old id maps to a migration");
          // Migrations added after the renaming never had an old id.
          const added = MIGRATIONS.map((m) => m.id).filter((id) => !renamed.includes(id));
          assert.sameMembers(added, [BASE_MULTIPLIER_MIGRATION_ID, WEAPON_SKILL_GUESS_ID, MOB_ATTACKS_MIGRATION_ID, MOB_SIZE_MIGRATION_ID, GEAR_SLOTS_MIGRATION_ID]);
          const p = migrationPlan({ done: oldIds, hasContent: true });
          assert.sameMembers(ids(p.run), added, "nothing runs twice - only what's been added since");
          assert.sameMembers(currentMigrationIds([...oldIds, "0.7.0-deity-block", "some-later-fix"]),
            [...renamed, "some-later-fix"], "read as the new ids, without duplicates");
        });
      });

      describe("0.7.0: base-dice multipliers", function () {
        useQuenchTimeout(this);

        it("moves old Powerful Strike / Magic Missile multipliers to base, own and Upgrade; leaves others alone", async function () {
          const actor = await createTestCharacter("base-mult");
          try {
            const mult = (value, kind = "multiplier") => ({ targetType: "skillDamage", target: "", mode: "multiply", value, damageDiceKind: kind });
            const strike = await createTestItem(actor, "damageEffect", "Powerful Strike", {
              name: "Powerful Strike", system: { changes: [mult("@rank")] },
            });
            const missile = await createTestItem(actor, "spell", "Magic Missile", {
              name: "Magic Missile", system: { upgrades: [{ rankThreshold: 15, description: "", changes: [mult("3")] }] },
            });
            const smush = await createTestItem(actor, "damageEffect", "Smush", {
              name: "Smush", system: { changes: [mult("2")] },
            });
            const u1 = baseMultiplierUpdate(strike);
            assert.equal(u1?.["system.changes"][0].damageDiceKind, "base");
            const u2 = baseMultiplierUpdate(missile);
            assert.equal(u2?.["system.upgrades"][0].changes[0].damageDiceKind, "base", "an Upgrade tier's too");
            assert.isNull(baseMultiplierUpdate(smush), "x total effects keep \"multiplier\"");
            await strike.update({ "system.changes": u1["system.changes"] });
            assert.isNull(baseMultiplierUpdate(actor.items.get(strike.id)), "already base: nothing to do");
            assert.isTrue(MIGRATIONS.some((m) => m.id === BASE_MULTIPLIER_MIGRATION_ID));
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("0.7.0: the Hand-to-Hand box", function () {
        useQuenchTimeout(this);

        it("picks out unticked copies of the five, by name in any case - not homebrew, not ticked ones", async function () {
          const actor = await createTestCharacter("needs");
          try {
            assert.isTrue(needsHandToHand(await attackSkill(actor, "Pugilism")));
            assert.isTrue(needsHandToHand(await attackSkill(actor, "WRASSLIN'")));
            assert.isFalse(needsHandToHand(await attackSkill(actor, "Unarmed Combat", { isHandToHand: true })), "already ticked");
            assert.isFalse(needsHandToHand(await attackSkill(actor, "Flying Elbow")), "homebrew");
            assert.isFalse(needsHandToHand(await attackSkill(actor, "Longsword")));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("ticks a character's copies once, changing nothing else; a second run does nothing", async function () {
          const actor = await createTestCharacter("tick");
          try {
            const pugilism = await attackSkill(actor, "Pugilism", { rank: 4 });
            const unarmed = await attackSkill(actor, "Unarmed Combat");
            const elbow = await attackSkill(actor, "Flying Elbow");
            const before = actor.items.get(pugilism.id).toObject();

            assert.equal(await tickHandToHandOn(actor), 2);
            assert.isTrue(actor.items.get(pugilism.id).system.isHandToHand);
            assert.isTrue(actor.items.get(unarmed.id).system.isHandToHand);
            assert.isFalse(actor.items.get(elbow.id).system.isHandToHand, "homebrew left for its owner to tick");
            const after = actor.items.get(pugilism.id).toObject();
            assert.equal(after.system.rank, before.system.rank);
            assert.equal(after.name, before.name);

            assert.equal(await tickHandToHandOn(actor), 0, "idempotent");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("0.7.0: the structured Deity block", function () {
        useQuenchTimeout(this);

        it("is one of the 0.7.0 migrations", function () {
          const step = MIGRATIONS.find((m) => m.id === DEITY_MIGRATION_ID);
          assert.exists(step);
          assert.equal(step.version, "0.7.0");
        });

        it("saves a Character's whole Deity block (old notes included) as a forced replacement; skips other actors", async function () {
          const actor = await createTestCharacter("deity block", { system: { deity: "<p>Apito - a single tear</p>" } });
          const mob = await createTestMob("deity block");
          let sent;
          const hookId = Hooks.on("preUpdateActor", (doc, changes) => {
            if (doc === actor) sent = changes.system?.deity;
          });
          try {
            assert.equal(await persistDeityBlock(actor), 1);
            const { DataFieldOperator, ForcedReplacement } = foundry.data.operators;
            assert.instanceOf(sent, ForcedReplacement, "survives the client's diff whole");
            const whole = DataFieldOperator.get(sent);
            assert.equal(whole.notes, "<p>Apito - a single tear</p>");
            assert.equal(whole.tier, "");
            assert.equal(actor.system.deity.notes, "<p>Apito - a single tear</p>");

            // A later partial edit keeps the notes.
            await actor.update({ "system.deity.name": "Apito" });
            assert.equal(actor.system.deity.notes, "<p>Apito - a single tear</p>");

            assert.equal(await persistDeityBlock(actor), 1, "a second run writes the same value");
            assert.equal(actor.system.deity.name, "Apito");
            assert.equal(await persistDeityBlock(mob), 0);
          } finally {
            Hooks.off("preUpdateActor", hookId);
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });
      });

      describe("0.7.0: a Character imported after the Deity migration", function () {
        useQuenchTimeout(this);

        // The /code-review worry: an old Character imported once the 0.7.0
        // migration has run would be stored with its old Deity text, and a
        // later partial Deity edit would wipe it on the server. Import
        // builds the (migrated) document first and saves it whole, so what
        // the server gets is already the block.
        it("is saved with the block, not the old text, and keeps its notes through a partial edit", async function () {
          const actor = await createTestCharacter("deity import");
          let sent;
          const update = actor.update;
          actor.update = function (data, options) {
            sent = data?.system?.deity;
            return update.call(this, data, options);
          };
          try {
            for (const legacy of ["<p>Apito - a single tear</p>", ["Apito - a single tear"]]) {
              const json = actor.toObject();
              json.system.deity = legacy;
              sent = undefined;
              await actor.importFromJSON(JSON.stringify(json));
              assert.isObject(sent, `the import sends a block (${Array.isArray(legacy) ? "array" : "string"})`);
              assert.notInstanceOf(sent, Array);
              assert.include(sent.notes, "a single tear", "with the old text as its notes");

              await actor.update({ "system.deity.name": "Apito" });
              assert.include(actor.system.deity.notes, "a single tear", "a partial edit keeps the notes");
            }
          } finally {
            delete actor.update;
            await deleteTestActor(actor);
          }
        });
      });

      describe("0.7.0: the Deity Tier, from the Boons owned", function () {
        useQuenchTimeout(this);

        it("is a 0.7.0 migration of its own, after the Deity block's", function () {
          const index = MIGRATIONS.findIndex((m) => m.id === DEITY_TIER_MIGRATION_ID);
          assert.isAtLeast(index, 0);
          assert.equal(MIGRATIONS[index].version, "0.7.0");
          assert.isAbove(index, MIGRATIONS.findIndex((m) => m.id === DEITY_MIGRATION_ID));
          const p = migrationPlan({ done: MIGRATIONS.slice(0, index).map((m) => m.id), hasContent: true });
          assert.include(p.run.map((m) => m.id), DEITY_TIER_MIGRATION_ID, "a world that had the earlier ones still gets it");
        });

        it("sets a Character's blank Tier to its highest Boon's, so its Boons keep applying; once", async function () {
          const actor = await createTestCharacter("deity tier", { system: { deity: { name: "Apito", notes: "<p>kept</p>" } } });
          const set = await createTestCharacter("deity tier set", { system: { deity: { tier: "acolyte" } } });
          const none = await createTestCharacter("deity tier none");
          const mob = await createTestMob("deity tier");
          try {
            await createTestItem(actor, "feature", "acolyte boon", { system: { tier: "acolyte" } });
            const devotee = await createTestItem(actor, "feature", "devotee boon", { system: { tier: "devotee" } });
            await createTestItem(actor, "feature", "untiered");
            await createTestItem(set, "feature", "zealot boon", { system: { tier: "zealot" } });
            await createTestItem(none, "feature", "untiered");
            assert.isFalse(deityBenefitApplies(devotee, actor.system.deity), "off before the backfill");

            assert.equal(inferDeityTier(actor), "devotee");
            assert.equal(await backfillDeityTier(actor), "devotee");
            assert.equal(actor.system.deity.tier, "devotee");
            assert.equal(actor.system.deity.name, "Apito", "the rest of the block is kept");
            assert.equal(actor.system.deity.notes, "<p>kept</p>");
            assert.isTrue(deityBenefitApplies(devotee, actor.system.deity), "on after it");
            assert.equal(await backfillDeityTier(actor), "", "a second run does nothing");

            assert.equal(await backfillDeityTier(set), "", "a Tier the GM set is left alone");
            assert.equal(set.system.deity.tier, "acolyte");
            assert.equal(await backfillDeityTier(none), "", "no tiered Boons, no Tier");
            assert.equal(none.system.deity.tier, "");
            assert.equal(inferDeityTier(mob), "");
          } finally {
            for (const x of [actor, set, none, mob]) await deleteTestActor(x);
          }
        });
      });

      describe("0.7.0: owned copies of the changed compendium items", function () {
        useQuenchTimeout(this);

        /** A change entry as content authors it. */
        const change = (targetType, target, value, mode = "add", extra = {}) => ({
          id: foundry.utils.randomID(), targetType, target, mode, value: String(value), conditions: [], ...extra,
        });
        /** An Upgrade tier. */
        const tier = (rankThreshold, changes) => ({ rankThreshold, changes });

        it("both new 0.7.0 steps run in a world that had the earlier ones", function () {
          for (const id of [COMPENDIUM_REFRESH_ID, BASE_DR_MIGRATION_ID]) {
            const index = MIGRATIONS.findIndex((m) => m.id === id);
            assert.isAtLeast(index, 0, id);
            assert.equal(MIGRATIONS[index].version, "0.7.0");
            assert.isBelow(index, MIGRATIONS.findIndex((m) => m.id === WEAPON_SKILL_NOTICE_ID));
            const p = migrationPlan({ done: MIGRATIONS.slice(0, index).map((m) => m.id), hasContent: true });
            assert.include(p.run.map((m) => m.id), id);
          }
        });

        it("an old Dodge copy's overriding tiers become the compendium's adds; its Rank and other changes stay", function () {
          const copy = {
            type: "skill", name: "Dodge",
            system: {
              rank: 12, marked: true,
              changes: [change("rollMode", "evadeBonus", 1)],
              upgrades: [
                tier(5, [change("rollMode", "evadeBonus", 1, "override")]),
                tier(10, [change("rollMode", "evadeBonus", 2, "override"), change("custom", "houseRule", 1)]),
                tier(15, [change("rollMode", "evadeBonus", 2, "override")]),
              ],
            },
          };
          const source = {
            type: "skill", name: "Dodge",
            system: {
              changes: [change("rollMode", "evadeBonus", 1)],
              upgrades: [tier(5, []), tier(10, [change("rollMode", "evadeBonus", 1)]), tier(15, [])],
            },
          };
          const update = refreshedItemUpdate(copy, source);
          assert.notProperty(update, "system.changes", "the base already matched");
          assert.notProperty(update, "system.rank");
          const [r5, r10, r15] = update["system.upgrades"];
          assert.deepEqual(r5.changes, []);
          assert.deepEqual(r10.changes.map((c) => [c.target, c.mode, c.value]), [["houseRule", "add", "1"], ["evadeBonus", "add", "1"]],
            "the house rule is kept, the override becomes the add");
          assert.deepEqual(r15.changes, []);

          const refreshed = { ...copy, system: { ...copy.system, upgrades: update["system.upgrades"] } };
          assert.isNull(refreshedItemUpdate(refreshed, source), "a second run changes nothing");
        });

        it("a Race copy gains its Move without its Stat grants baking again", async function () {
          const actor = await createTestCharacter("refresh race");
          try {
            const race = await createTestItem(actor, "race", "Tigran", {
              name: "Tigran", system: { changes: [change("stat", "dex", 3), change("resource", "dr", 1, "add", { label: "DR Buff" })] },
            });
            await new Promise((r) => setTimeout(r, 200));
            const dex = actor.system.stats.dex.value;
            const source = {
              type: "race", name: "Tigran",
              system: { changes: [{ ...change("stat", "dex", 3), id: "" }, change("resource", "dr", 1, "add", { label: "DR Buff" }), change("resource", "move", 10)] },
            };
            const update = refreshedItemUpdate(race, source);
            const statEntry = update["system.changes"].find((c) => c.targetType === "stat");
            assert.equal(statEntry.id, race.system.changes.find((c) => c.targetType === "stat").id, "the Stat grant keeps its id");
            await actor.updateEmbeddedDocuments("Item", [{ _id: race.id, ...update }], { carlMigration: true });
            await new Promise((r) => setTimeout(r, 200));
            assert.equal(actor.system.stats.dex.value, dex, "DEX isn't raised a second time");
            assert.equal(actor.system.moveEffective, 30);
            assert.equal(actor.system.drEffective, 1);
            assert.isNull(refreshedItemUpdate(actor.items.get(race.id), source));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a copy is matched to the compendium item it came from; a homebrew one isn't touched", function () {
          const dodge = { type: "skill", name: "Dodge", id: "nce3YZYxqQKS22mU" };
          const sources = [dodge];
          assert.strictEqual(refreshSourceFor({ type: "skill", name: "Dodge" }, sources), dodge, "no source: by name");
          assert.strictEqual(refreshSourceFor({ type: "skill", name: "Dodge", _stats: { compendiumSource: "Compendium.carl-rpg.skills-and-spells.Item.nce3YZYxqQKS22mU" } }, sources), dodge);
          assert.strictEqual(refreshSourceFor({ type: "skill", name: "Dodge", flags: { core: { sourceId: "Compendium.carl-rpg.skills-and-spells.nce3YZYxqQKS22mU" } } }, sources), dodge, "an older source id");
          assert.isNull(refreshSourceFor({ type: "skill", name: "Dodge", _stats: { compendiumSource: "Compendium.world.homebrew.Item.abcdefghijklmnop" } }, sources),
            "a homebrew Dodge from a world compendium");
          assert.isNull(refreshSourceFor({ type: "spell", name: "Dodge" }, sources), "same name, other type");
        });

        it("a tier the compendium lacks is kept; a compendium tier the copy lacks is added", function () {
          const copy = {
            type: "skill", name: "Running",
            system: { changes: [], upgrades: [tier(7, [change("rollMode", "evadeBonus", 1)]), tier(10, [change("resource", "move", 10)])] },
          };
          const source = {
            type: "skill", name: "Running",
            system: { changes: [], upgrades: [tier(5, [change("resource", "move", 5)]), tier(10, [change("resource", "move", 10)])] },
          };
          const upgrades = refreshedItemUpdate(copy, source)["system.upgrades"];
          assert.deepEqual(upgrades.map((t) => t.rankThreshold), [5, 7, 10], "Rank 5 added, in order");
          assert.equal(upgrades.find((t) => t.rankThreshold === 7).changes[0].target, "evadeBonus", "the homebrew Rank 7 kept");
          assert.equal(upgrades.find((t) => t.rankThreshold === 5).changes[0].value, "5");
        });

        it("an Oakhide copy becomes a toggled Spell, and loses its 'apply by hand' note", function () {
          const note = "<p><em>Note: DR has no temporary/conditional-bonus mechanism in this system - apply this bonus by hand while the buff is active.</em></p>";
          const copy = { type: "spell", name: "Oakhide", system: { isToggled: false, active: false, description: `<p>Bark.</p>${note}`, changes: [] } };
          const source = { type: "spell", name: "Oakhide", system: { isToggled: true, changes: [change("resource", "dr", 2)] } };
          const update = refreshedItemUpdate(copy, source);
          assert.isTrue(update["system.isToggled"]);
          assert.notProperty(update, "system.active");
          assert.notInclude(update["system.description"], "apply this bonus by hand");
          assert.include(update["system.description"], "<p>Bark.</p>");
          assert.equal(update["system.changes"][0].target, "dr");
        });
      });

      describe("0.7.0: a Character's base DR is 0", function () {
        useQuenchTimeout(this);

        it("zeroes a Character's saved base DR, once; leaves a Mob's", async function () {
          const actor = await createTestCharacter("base dr", { system: { dr: 3 } });
          const mob = await createTestMob("base dr", { system: { dr: 4 } });
          try {
            assert.equal(await zeroCharacterBaseDr(actor), 3, "reports the old value");
            assert.equal(actor._source.system.dr, 0);
            assert.equal(await zeroCharacterBaseDr(actor), 0, "nothing left to do");
            assert.equal(await zeroCharacterBaseDr(mob), 0);
            assert.equal(mob.system.dr, 4);
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });
      });

      describe("0.7.0: Characters made before the Create Crawler wizard", function () {
        useQuenchTimeout(this);

        it("is a 0.7.0 step that runs in a world that had the earlier ones", function () {
          const index = MIGRATIONS.findIndex((m) => m.id === CHARGEN_DONE_MIGRATION_ID);
          assert.isAtLeast(index, 0);
          assert.equal(MIGRATIONS[index].version, "0.7.0");
          assert.isBelow(index, MIGRATIONS.findIndex((m) => m.id === WEAPON_SKILL_NOTICE_ID));
          const p = migrationPlan({ done: MIGRATIONS.slice(0, index).map((m) => m.id), hasContent: true });
          assert.include(p.run.map((m) => m.id), CHARGEN_DONE_MIGRATION_ID);
        });

        it("marks a Character with Skills as created, once; leaves a blank one, a done one and a Mob", async function () {
          const built = await createTestCharacter("old crawler");
          const caster = await createTestCharacter("old caster");
          const blank = await createTestCharacter("blank crawler");
          const gearOnly = await createTestCharacter("gear only");
          const done = await createTestCharacter("wizard crawler", { flags: { "carl-rpg": { chargen: { done: true, kind: "human" } } } });
          const mob = await createTestMob("old mob");
          try {
            await attackSkill(built, "Longsword");
            await createTestItem(caster, "spell", "Fireball", { name: "Fireball" });
            await createTestItem(gearOnly, "item", "rope");
            await createTestItem(done, "skill", "Running", { name: "Running" });
            await createTestItem(mob, "skill", "Bite", { name: "Bite" });

            assert.isTrue(await markChargenDone(built), "a Skill");
            assert.isTrue(built.getFlag("carl-rpg", "chargen").done);
            assert.isTrue(await markChargenDone(caster), "a Spell counts too");
            assert.isFalse(await markChargenDone(built), "once");
            assert.isFalse(await markChargenDone(blank), "no Skills: still to be made");
            assert.isFalse(await markChargenDone(gearOnly), "gear alone isn't a built crawler");
            assert.isUndefined(blank.getFlag("carl-rpg", "chargen"));
            assert.isFalse(madeBeforeChargen(done), "already through the wizard");
            assert.equal(done.getFlag("carl-rpg", "chargen").kind, "human", "its own record kept");
            assert.isFalse(await markChargenDone(mob));
          } finally {
            for (const a of [built, caster, blank, gearOnly, done, mob]) await deleteTestActor(a);
          }
        });
      });

      describe("0.7.0: Weapon Skills guessed from names", function () {
        useQuenchTimeout(this);

        const index = (id) => MIGRATIONS.findIndex((m) => m.id === id);
        /** Nothing to guess from but an owner's Skills. */
        const none = () => ({ gear: new Map(), notWeapons: new Set(), skills: new Map() });
        /** Gear with this exact name and a blank Weapon Skill, unless given. */
        const gear = (actor, name, system = {}) => createTestItem(actor, "item", name, { name, system: { weaponSkill: "", ...system } });
        /** A sidebar Item with this exact name. */
        const worldItem = (name, system = {}) =>
          Item.implementation.create({ name, type: "item", system: { weaponSkill: "", slots: [], ...system } });
        /** The system packs, which these need built (`npm run build:packs`). */
        const packSources = async () => {
          const sources = await loadWeaponSkillSources();
          assert.isAbove(sources.gear.size, 0, "the Gear compendium is built");
          assert.isAbove(sources.skills.size, 0, "the Skills and Spells compendium is built");
          return sources;
        };

        it("runs before the gear slots and the notice; a world that had every other one runs it alone", function () {
          const guess = index(WEAPON_SKILL_GUESS_ID);
          assert.isAtLeast(guess, 0);
          assert.equal(MIGRATIONS[guess].version, "0.7.0");
          assert.isBelow(guess, index(GEAR_SLOTS_MIGRATION_ID));
          assert.isBelow(guess, index(WEAPON_SKILL_NOTICE_ID));
          assert.isAbove(index(WEAPON_SKILL_NOTICE_ID), index(GEAR_SLOTS_MIGRATION_ID), "the notice sees where gear is worn");
          const p = migrationPlan({ done: ids(MIGRATIONS).filter((id) => id !== WEAPON_SKILL_GUESS_ID), hasContent: true });
          assert.deepEqual(ids(p.run), [WEAPON_SKILL_GUESS_ID]);
        });

        it("an owned weapon named for one of its owner's Attack Skills gets that Skill", async function () {
          const actor = await createTestCharacter("guess own");
          try {
            await attackSkill(actor, "Flying Spear");
            const spear = await gear(actor, "flying SPEAR!");
            assert.deepEqual(guessWeaponSkill(spear, none()), { weaponSkill: "Flying Spear", from: "owner" });
            assert.equal(await guessActorWeaponSkills(actor, none()), 1);
            assert.equal(actor.items.get(spear.id).system.weaponSkill, "Flying Spear");
            assert.equal(await guessActorWeaponSkills(actor, none()), 0, "once");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a sidebar Item named for a Gear compendium weapon gets its Skill: a Greatsword is a Longsword", async function () {
          const sources = await packSources();
          const greatsword = await worldItem("Greatsword");
          try {
            assert.deepEqual(guessWeaponSkill(greatsword, sources), { weaponSkill: "Longsword", from: "gear" });
            assert.equal(await guessItemWeaponSkills([greatsword], sources), 1);
            assert.equal(game.items.get(greatsword.id).system.weaponSkill, "Longsword");
          } finally {
            await greatsword.delete();
          }
        });

        it("a sidebar Item named for a compendium Attack Skill gets it", async function () {
          // Without the Gear compendium's weapons, which name the same Skills.
          const sources = { ...(await packSources()), gear: new Map() };
          const rapier = await worldItem("RAPIER");
          try {
            assert.deepEqual(guessWeaponSkill(rapier, sources), { weaponSkill: "Rapier", from: "skills" });
            assert.equal(await guessItemWeaponSkills([rapier], sources), 1);
            assert.equal(game.items.get(rapier.id).system.weaponSkill, "Rapier");
          } finally {
            await rapier.delete();
          }
        });

        it("leaves a set Weapon Skill, a name that matches nothing, and a consumable alone", async function () {
          const sources = await packSources();
          const actor = await createTestCharacter("guess leave");
          try {
            await attackSkill(actor, "Longsword");
            const set = await gear(actor, "Longsword", { weaponSkill: "Rapier" });
            const odd = await gear(actor, "Mystery Stick");
            const tonic = await gear(actor, "Longsword", { consumable: { kind: "other" } });
            // Names with no Latin letters or digits all slug alike: never a match.
            await attackSkill(actor, "斧");
            const unlatin = await gear(actor, "剣");
            for (const item of [set, odd, tonic, unlatin]) assert.isNull(guessWeaponSkill(item, sources), item.name);
            assert.equal(await guessActorWeaponSkills(actor, sources), 0);
            assert.equal(actor.items.get(set.id).system.weaponSkill, "Rapier");
            assert.equal(actor.items.get(odd.id).system.weaponSkill, "");
            assert.equal(actor.items.get(tonic.id).system.weaponSkill, "");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("never uses a hand-to-hand or weaponless Skill - nor the compendium's, for a name its owner's own Skill means", async function () {
          const sources = await packSources();
          const actor = await createTestCharacter("guess h2h");
          const bite = await worldItem("Bite");
          try {
            await attackSkill(actor, "Pugilism", { isHandToHand: true });
            await attackSkill(actor, "Improvised Weapons");
            // This crawler's own Rapier is hand-to-hand (homebrew).
            await attackSkill(actor, "Rapier", { isHandToHand: true });
            const noSources = { ...sources, gear: new Map() };
            assert.isNull(guessWeaponSkill(await gear(actor, "Pugilism"), sources), "hand-to-hand");
            assert.isNull(guessWeaponSkill(await gear(actor, "Improvised Weapons"), sources), "weaponless");
            assert.isNull(guessWeaponSkill(bite, sources), "a natural attack, unowned");
            assert.isNull(guessWeaponSkill(await gear(actor, "Rapier"), noSources), "its owner's Rapier is the one meant");
            assert.deepEqual(guessWeaponSkill(await gear(actor, "Rapier"), sources), { weaponSkill: "Rapier", from: "gear" },
              "the Gear compendium's Rapier still says what it is");
          } finally {
            await deleteTestActor(actor);
            await bite.delete();
          }
        });

        it("a weapon guessed here is then made Held by the gear slots migration", async function () {
          const actor = await createTestCharacter("guess then slots");
          try {
            await attackSkill(actor, "Flying Spear");
            const spear = await gear(actor, "Flying Spear", { slots: [] });
            assert.isNull(gearSlotUpdate(spear), "with no Weapon Skill, nothing tells where it goes");
            await guessActorWeaponSkills(actor, none());
            await inferActorGear(actor);
            assert.deepEqual(actor.items.get(spear.id).system.slots, ["held"]);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("0.7.0: the Weapon Skill notice", function () {
        useQuenchTimeout(this);

        /** A notice's text, tags out. */
        const text = (message) => message.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        /** A gear item with this exact name. */
        const gear = (actor, name, system = {}) => createTestItem(actor, "item", name, { name, system: { weaponSkill: "", ...system } });

        it("is the last 0.7.0 migration, after the gear slots'", function () {
          const index = MIGRATIONS.findIndex((m) => m.id === WEAPON_SKILL_NOTICE_ID);
          assert.isAtLeast(index, 0);
          assert.equal(MIGRATIONS[index].version, "0.7.0");
          assert.isAbove(index, MIGRATIONS.findIndex((m) => m.id === DEITY_MIGRATION_ID));
          assert.isAbove(index, MIGRATIONS.findIndex((m) => m.id === GEAR_SLOTS_MIGRATION_ID));
          // A world that already had the earlier ones still gets it.
          const earlier = MIGRATIONS.slice(0, index).map((m) => m.id);
          const p = migrationPlan({ done: earlier, hasContent: true });
          assert.deepEqual(ids(p.run), ids(MIGRATIONS.slice(index)));
          assert.equal(p.run[0].id, WEAPON_SKILL_NOTICE_ID);
        });

        it("lists only blank gear in a hand or held only - not a weapon, a shield, a torch, a consumable or a pack", async function () {
          const actor = await createTestCharacter("notice list");
          try {
            const sources = { notWeapons: new Set(["torch"]) };
            const inHand = await gear(actor, "Odd Stick", { slots: [] });
            const heldOnly = await gear(actor, "Odd Blade", { slots: ["held"] });
            const weapon = await gear(actor, "Longsword", { slots: ["held"], weaponSkill: "Longsword" });
            const buckler = await gear(actor, "Buckler", { slots: ["held"] });
            const shield = await gear(actor, "Round Thing", { slots: ["held"], shield: true });
            const torch = await gear(actor, "Torch", { slots: ["held"] });
            const pack = await gear(actor, "Backpack", { slots: ["torso"] });
            const rope = await gear(actor, "Rope", { slots: [] });
            await actor.update({ "system.gearSlots.mainHand": inHand.id });
            const listed = actor.items.filter((i) => looksLikeWeapon(i, sources)).map((i) => i.id);
            assert.sameMembers(listed, [inHand.id, heldOnly.id]);
            for (const item of [weapon, buckler, shield, torch, pack, rope]) assert.notInclude(listed, item.id, item.name);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("says how many were filled in, to everyone; the ones left go to the GM, by who has them", async function () {
          const { notice, list } = await postWeaponSkillNotice({
            filled: 7, remaining: new Map([["Carl", ["Odd Stick"]], ["Ghoul", ["Bone Thing", "Rusty Hook"]]]),
          });
          try {
            assert.lengthOf(notice.whisper, 0, "the notice isn't whispered");
            assert.include(text(notice), game.i18n.localize("CARLRPG.Migration.WeaponSkill.Title"));
            assert.include(text(notice), game.i18n.format("CARLRPG.Migration.WeaponSkill.Filled", { count: 7 }));
            assert.include(text(notice), game.i18n.localize("CARLRPG.Migration.WeaponSkill.Left"));
            for (const name of ["Carl", "Odd Stick", "Ghoul"]) assert.notInclude(text(notice), name, "names only in the GM's list");
            assert.exists(list);
            assert.isAbove(list.whisper.length, 0, "the list is the GM's");
            for (const name of ["Carl", "Odd Stick", "Ghoul", "Bone Thing", "Rusty Hook"]) assert.include(text(list), name);
          } finally {
            await notice.delete();
            await list?.delete();
          }
        });

        it("with none left, says so and sends no list", async function () {
          const { notice, list } = await postWeaponSkillNotice({ filled: 2, remaining: new Map() });
          try {
            assert.isNull(list);
            assert.include(text(notice), game.i18n.localize("CARLRPG.Migration.WeaponSkill.NoneLeft"));
          } finally {
            await notice.delete();
          }
        });

        it("run on the world, posts the notice to everyone and changes no documents", async function () {
          const posted = [];
          const hookId = Hooks.on("createChatMessage", (message) => {
            if (message.isAuthor) posted.push(message);
          });
          try {
            const result = await announceWeaponSkill();
            assert.equal(result.changed, 0);
            const notices = posted.filter((m) => !m.whisper.length);
            assert.lengthOf(notices, 1, "one notice everyone sees");
            assert.include(notices[0].content, game.i18n.localize("CARLRPG.Migration.WeaponSkill.Title"));
            for (const m of posted.filter((m) => m.whisper.length)) {
              assert.isTrue(m.whisper.every((id) => game.users.get(id)?.isGM), "anything else is the GM's");
            }
          } finally {
            Hooks.off("createChatMessage", hookId);
            for (const m of posted) await m.delete();
          }
        });
      });

      describe("0.7.0: the old Pet tab becomes Pet and Vehicle actors", function () {
        useQuenchTimeout(this);

        // The old blocks as a pre-0.7.0 Character stored them.
        const oldPet = () => ({
          name: "Rex", level: 300, str: 3, int: null, con: null, dex: 0, cha: null, dr: 2, evade: 14, move: 30,
          size: "Large (5)", attacks: ["Bite 1d6", ""], special: "Fetches", hb: { value: 6, max: 8 },
        });
        const oldMount = () => ({
          name: "Truck", size: "Huge", move: 60, occupants: 0, dr: 3, accessories: "Roof rack", hb: { value: 12, max: 12 },
        });
        const labels = (notes) => notes.map((n) => n.label);

        it("the safety net keeps the old blocks before Foundry drops them", function () {
          // Unsaved: built from raw data, as a world load builds each Actor.
          const doc = new Actor.implementation({
            name: "Quench legacy", type: "character",
            system: { pet: { name: "Rex", dex: 4 }, mount: { name: "Car" } },
          });
          assert.notProperty(doc._source.system, "pet", "pruned from the system");
          assert.notProperty(doc._source.system, "mount");
          const legacy = legacyCompanionsOf(doc);
          assert.equal(legacy?.pet?.name, "Rex", "but kept in the flag");
          assert.equal(legacy.pet.dex, 4);
          assert.equal(legacy.mount.name, "Car");

          // A Character already converted doesn't get it back.
          const done = new Actor.implementation({
            name: "Quench converted", type: "character",
            flags: { "carl-rpg": { companionsMigrated: true } },
            system: { pet: { name: "Rex" } },
          });
          assert.isNull(legacyCompanionsOf(done));
        });

        it("reads Size from a number, a size name, or both", function () {
          assert.equal(parseSize("Large"), 5);
          assert.equal(parseSize("5"), 5);
          assert.equal(parseSize("Large (5)"), 5);
          assert.equal(parseSize("huge-ish"), 6);
          assert.equal(parseSize("very large"), 5, "any word, not just the first");
          assert.equal(parseSize("A Huge truck"), 6);
          assert.isNull(parseSize("big"));
          assert.isNull(parseSize(""));
        });

        it("a block counts as entered for any value - but not the untouched 10/10 Health Bar", function () {
          assert.isFalse(blockEntered({ name: "", attacks: ["", ""], level: null, hb: { value: 10, max: 10 } }));
          assert.isTrue(blockEntered({ hb: { value: 6, max: 10 } }));
          assert.isTrue(blockEntered({ attacks: ["", "Bite"] }));
          assert.isTrue(blockEntered({ special: "Fetches" }));
        });

        it("maps a Pet block, and puts what has no field in its Biography", async function () {
          const character = await createTestCharacter("pet map");
          try {
            const { data, notes } = petDataFrom(character, oldPet());
            const s = data.system;
            assert.equal(data.type, "pet");
            assert.equal(data.name, "Rex");
            assert.equal(s.ownerId, character.id);
            assert.equal(s.attributes.level.value, 250, "clamped");
            assert.equal(s.stats.str.value, 3);
            assert.equal(s.stats.dex.value, 1, "clamped");
            assert.notProperty(s.stats, "int", "blank keeps the Pet's default");
            assert.equal(s.dr, 2);
            assert.equal(s.move, 30);
            assert.equal(s.size, 5);
            assert.equal(s.hbSlotsOverride, 8, "differs from the rule");
            assert.equal(s.hb.value, 6);
            assert.includeMembers(labels(notes), [
              game.i18n.localize("CARLRPG.Migration.Companions.Evade"),
              game.i18n.format("CARLRPG.Migration.Companions.Attack", { n: 1 }),
              game.i18n.localize("CARLRPG.Migration.Companions.Special"),
              game.i18n.localize("CARLRPG.Actor.HealthBar"),
            ]);
            assert.notInclude(labels(notes), game.i18n.format("CARLRPG.Migration.Companions.Attack", { n: 2 }), "a blank Attack isn't noted");
            assert.include(s.biography, game.i18n.localize("CARLRPG.Migration.Companions.Heading"));
            assert.include(s.biography, "Bite 1d6");

            // In a compendium: not bonded by id (bonds are to world actors) -
            // its crawler is named in its Biography instead.
            const packed = petDataFrom(character, oldPet(), { inPack: true });
            assert.notProperty(packed.data.system, "ownerId");
            assert.include(packed.data.system.biography, character.name);

            // An untouched 10/10: the rule's HB, no override.
            const plain = petDataFrom(character, { name: "Pip", hb: { value: 10, max: 10 } }).data.system;
            assert.notProperty(plain, "hbSlotsOverride");
            assert.notProperty(plain, "hb");
          } finally {
            await deleteTestActor(character);
          }
        });

        it("maps a Mount / Vehicle block to a Vehicle", async function () {
          const character = await createTestCharacter("vehicle map");
          try {
            const { data, notes } = vehicleDataFrom(character, oldMount());
            const s = data.system;
            assert.equal(data.type, "vehicle");
            assert.equal(data.name, "Truck");
            assert.equal(s.size, 6);
            assert.equal(s.move, 60);
            assert.equal(s.occupancy, 1, "clamped");
            assert.equal(s.dr, 3);
            assert.equal(s.hb.value, 10, "clamped to 10 slots");
            assert.includeMembers(labels(notes), [game.i18n.localize("CARLRPG.Migration.Companions.Accessories")]);
            assert.lengthOf(labels(notes).filter((l) => l === game.i18n.localize("CARLRPG.Actor.HealthBar")), 1, "one Health Bar note");
            assert.include(s.biography, "Roof rack");
          } finally {
            await deleteTestActor(character);
          }
        });

        it("creates the actors, checks them, clears the old data - and a second run makes nothing new", async function () {
          const legacy = { pet: oldPet(), mount: oldMount() };
          const character = await createTestCharacter("pet tab", { flags: { "carl-rpg": { legacyCompanions: legacy } } });
          const made = () => game.actors.filter((a) => a.flags?.["carl-rpg"]?.migratedFrom?.uuid === character.uuid);
          try {
            const result = await migrateCompanionsOf(character);
            assert.isTrue(result.ok, result.error);
            const pet = made().find((a) => a.type === "pet");
            const vehicle = made().find((a) => a.type === "vehicle");
            assert.exists(pet);
            assert.exists(vehicle);
            assert.equal(pet.system.ownerId, character.id);
            assert.equal(pet._source.system.hbSlotsOverride, 8);
            assert.equal(vehicle._source.system.move, 60);
            assert.include(pet.system.biography, "Fetches");
            assert.equal(pet.flags["carl-rpg"].migratedFrom.original.evade, 14, "the old block is kept verbatim");
            assert.isNull(legacyCompanionsOf(character), "the old data is cleared");
            assert.isTrue(character.flags["carl-rpg"].companionsMigrated);
            // Only the Character's own players (none here) own the Vehicle.
            const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
            for (const [id, level] of Object.entries(vehicle.ownership)) {
              if (id === "default" || id === game.user.id || level < OWNER) continue;
              assert.isAtLeast(character.ownership[id] ?? 0, OWNER, `${id} doesn't own the Character`);
            }

            // Run again (the flag back, as if interrupted before the clear),
            // after the Pet has changed - it's reused, not re-checked.
            await pet.update({ "system.dr": 9 });
            await character.setFlag("carl-rpg", "legacyCompanions", legacy);
            const again = await migrateCompanionsOf(character);
            assert.isTrue(again.ok, again.error);
            assert.lengthOf(made(), 2, "reused, not made twice");
          } finally {
            for (const actor of made()) await actor.delete();
            await deleteTestActor(character);
          }
        });
      });

      describe("0.7.0: a Mob's Size saved as Table 9's value", function () {
        useQuenchTimeout(this);

        it("is a 0.7.0 migration, after the Mob Attacks'", function () {
          const index = MIGRATIONS.findIndex((m) => m.id === MOB_SIZE_MIGRATION_ID);
          assert.isAtLeast(index, 0);
          assert.equal(MIGRATIONS[index].version, "0.7.0");
          assert.isAbove(index, MIGRATIONS.findIndex((m) => m.id === MOB_ATTACKS_MIGRATION_ID));
        });

        it("saves a Mob's Size as read, and only Mobs", async function () {
          const mob = await createTestMob("size save", { system: { size: "Large (5)" } });
          const pc = await createTestCharacter("size save pc");
          try {
            assert.equal(await saveMobSizes([mob, pc]), 1, "only the Mob");
            assert.equal(mob.system.size, 5);
            assert.equal(mob._source.system.size, 5, "the stored value is the number");
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });
      });
    },
    { displayName: "CarlRPG: Migration" },
  );
}
