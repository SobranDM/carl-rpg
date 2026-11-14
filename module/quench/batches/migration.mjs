import { MIGRATIONS, migrationPlan, needsHandToHand, tickHandToHandOn } from "../../helpers/migration.mjs";
import {
  createTestCharacter,
  createTestItem,
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
    },
    { displayName: "CarlRPG: Migration" },
  );
}
