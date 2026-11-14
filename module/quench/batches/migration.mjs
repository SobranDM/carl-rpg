import {
  DEITY_MIGRATION_ID, MIGRATIONS, migrationPlan, needsHandToHand, persistDeityBlock, tickHandToHandOn,
} from "../../helpers/migration.mjs";
import {
  blockEntered, legacyCompanionsOf, migrateCompanionsOf, parseSize, petDataFrom, vehicleDataFrom,
} from "../../helpers/companion-migration.mjs";
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

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.migration",
    (context) => {
      const { describe, it, assert } = context;

      describe("World migrations", function () {
        useQuenchTimeout(this);

        it("runs each migration once per world, by id, whatever the version numbers", function () {
          const HAND = "0.6.0-hand-to-hand-box";
          const ids = (list) => list.map((m) => m.id);
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
      });

      describe("0.6.0: the Hand-to-Hand box", function () {
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

      describe("0.6.0: the structured Deity block", function () {
        useQuenchTimeout(this);

        it("is one of the 0.6.0 migrations", function () {
          const step = MIGRATIONS.find((m) => m.id === DEITY_MIGRATION_ID);
          assert.exists(step);
          assert.equal(step.version, "0.6.0");
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

      describe("0.6.0: the old Pet tab becomes Pet and Vehicle actors", function () {
        useQuenchTimeout(this);

        // The old blocks as a pre-0.6.0 Character stored them.
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
    },
    { displayName: "CarlRPG: Migration" },
  );
}
