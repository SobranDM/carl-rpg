import { bakeItemGrants, cappedGrantRank, recheckLevelGatedGrants } from "../../helpers/race-class-grants.mjs";
import { createTestCharacter, createTestItem, deleteTestActor, settle, useQuenchTimeout, waitFor } from "../helpers.mjs";

/** The Race/Class's record of baked grant ids. */
const bakedIds = (item) => item.getFlag("carl-rpg", "bakedGrantIds") ?? [];
/** A unique Skill name no compendium has, so a grant makes a bare Skill. */
const uniqueSkill = () => `Quench Grant Skill ${foundry.utils.randomID()}`;

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.race-class-grants",
    (context) => {
      const { describe, it, assert } = context;

      describe("bakeItemGrants: a change with no persisted id (legacy/compendium-authored content)", function () {
        useQuenchTimeout(this);

        it("bakes correctly and the item ends up with a real, non-blank persisted id", async function () {
          // A literal id:"" would fail schema validation outright (the field
          // is `blank: false`) - omitting the key entirely is how this
          // actually reproduces on disk (compendium content authored before
          // ChangeEntry.id existed simply never had the key at all), and lets
          // the SchemaField's own `initial: () => randomID()` fill it in.
          // What matters for regression purposes either way: baking still
          // works, and the id is never left blank afterward.
          const actor = await createTestCharacter();
          try {
            const race = await createTestItem(actor, "race");
            race.updateSource({
              "system.changes": [{
                targetType: "stat", target: "str", mode: "add", value: "2",
                capMax: "", levelGate: 0, damageDiceKind: "", damageType: "", conditions: [],
              }],
            });
            await bakeItemGrants(race);
            await settle();
            assert.isNotEmpty(race.system.changes[0].id);
            assert.equal(actor.system.stats.str.value, 5, "the grant itself should still bake despite the missing id");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("bakeItemGrants: Rank-10 skillRank grant cap (p.127)", function () {
        useQuenchTimeout(this);

        it("caps at Rank 10 when the actor already has Ranks in the Skill", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "Alchemy", { name: "Alchemy", system: { rank: 6, category: "utility" } });
            await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "skillRank", target: "Alchemy", mode: "add", value: "8" }] } });
            // _onCreate's own bakeItemGrants call isn't awaited by createEmbeddedDocuments - poll instead of a fixed settle().
            await waitFor(() => actor.items.find((i) => i.name === "Alchemy")?.system.rank !== 6);
            const alchemy = actor.items.find((i) => i.name === "Alchemy");
            assert.equal(alchemy.system.rank, 10);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("is uncapped for a from-scratch grant (actor owns the Skill at Rank 0)", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "Alchemy", { name: "Alchemy", system: { rank: 0, category: "utility" } });
            await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "skillRank", target: "Alchemy", mode: "add", value: "8" }] } });
            await waitFor(() => actor.items.find((i) => i.name === "Alchemy")?.system.rank !== 0);
            const alchemy = actor.items.find((i) => i.name === "Alchemy");
            assert.equal(alchemy.system.rank, 8);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("creates a bare new Skill item at the granted Rank when nothing matches anywhere", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "race", "race", {
              system: { changes: [{ targetType: "skillRank", target: "Totally Not A Real Skill XYZ123", mode: "add", value: "8" }] },
            });
            await waitFor(() => !!actor.items.find((i) => i.name === "Totally Not A Real Skill XYZ123"));
            const created = actor.items.find((i) => i.name === "Totally Not A Real Skill XYZ123");
            assert.exists(created);
            assert.equal(created.type, "skill");
            assert.equal(created.system.rank, 8);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Rank-10 grant ceiling caps the gain, not the Rank (p.127)", function () {
        useQuenchTimeout(this);

        it("cappedGrantRank: never lowers, stops a gain at 10, leaves a new Skill and a reduction alone", function () {
          assert.equal(cappedGrantRank(12, 14), 12, "Rank 12 plus 2 stays 12");
          assert.equal(cappedGrantRank(8, 11), 10, "Rank 8 plus 3 stops at 10");
          assert.equal(cappedGrantRank(10, 12), 10);
          assert.equal(cappedGrantRank(0, 12), 12, "a new Skill is made at the granted Rank");
          assert.equal(cappedGrantRank(6, 4), 4, "a drawback still lowers it");
        });

        for (const [rank, grant, expected] of [[12, 2, 12], [8, 3, 10]]) {
          it(`a Skill at Rank ${rank} granted +${grant} ends at ${expected}`, async function () {
            const actor = await createTestCharacter();
            try {
              const name = uniqueSkill();
              await createTestItem(actor, "skill", name, { name, system: { rank, category: "utility" } });
              const race = await createTestItem(actor, "race", "race", {
                system: { changes: [{ targetType: "skillRank", target: name, mode: "add", value: String(grant) }] },
              });
              // Wait for the bake to finish (its record is written last), not for the Rank to move.
              await waitFor(() => bakedIds(race).length === 1, { message: "the grant never baked" });
              assert.equal(actor.items.find((i) => i.name === name).system.rank, expected);
            } finally {
              await deleteTestActor(actor);
            }
          });
        }

        it("a Skill the actor doesn't have, granted +12, is made at Rank 12", async function () {
          const actor = await createTestCharacter();
          try {
            const name = uniqueSkill();
            await createTestItem(actor, "race", "race", {
              system: { changes: [{ targetType: "skillRank", target: name, mode: "add", value: "12" }] },
            });
            await waitFor(() => !!actor.items.find((i) => i.name === name));
            assert.equal(actor.items.find((i) => i.name === name).system.rank, 12);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("baked grants belong to the actor they were baked on", function () {
        useQuenchTimeout(this);

        /** A Character with a Race (+2 STR, +3 to a new Skill) fully baked on it. */
        async function bakedOnA() {
          const actor = await createTestCharacter("grants A");
          const skill = uniqueSkill();
          const race = await createTestItem(actor, "race", "race", {
            system: { changes: [
              { targetType: "stat", target: "str", mode: "add", value: "2" },
              { targetType: "skillRank", target: skill, mode: "add", value: "3" },
            ] },
          });
          await waitFor(() => bakedIds(race).length === 2, { message: "the Race never baked on A" });
          assert.equal(actor.system.stats.str.value, 5);
          return { actor, race, skill };
        }

        /** B got the Race's bumps, and its copy records them. */
        async function assertBakedOnB(b, skill) {
          await waitFor(() => b.system.stats.str.value === 5 && !!b.items.find((i) => i.name === skill), {
            message: "the copied Race never baked on B",
          });
          assert.equal(b.items.find((i) => i.name === skill).system.rank, 3);
          const copy = b.items.find((i) => i.type === "race");
          await waitFor(() => bakedIds(copy).length === 2, { message: "B's copy has no record of baking" });
        }

        it("a Race baked on A, copied onto B, bakes on B", async function () {
          const { actor: a, race, skill } = await bakedOnA();
          const b = await createTestCharacter("grants B");
          try {
            // As a drop does (actor-sheet.mjs _onDropItem): the item's data, flags and all.
            await b.createEmbeddedDocuments("Item", [game.items.fromCompendium(race, { clearFolder: true })]);
            await assertBakedOnB(b, skill);
            assert.equal(a.system.stats.str.value, 5, "A is untouched");
          } finally {
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a Race from A dragged to the Items sidebar, then onto B, bakes on B", async function () {
          const { actor: a, race, skill } = await bakedOnA();
          const b = await createTestCharacter("grants B");
          let world = null;
          try {
            world = await Item.create(race.toObject());
            await b.createEmbeddedDocuments("Item", [game.items.fromCompendium(world, { clearFolder: true })]);
            await assertBakedOnB(b, skill);
          } finally {
            await world?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a duplicated actor keeps its Race's record and doesn't bake again", async function () {
          const { actor: a } = await bakedOnA();
          let dup = null;
          try {
            // As the sidebar's Duplicate does. Its items are embedded in the
            // new actor's own creation, so Item _preCreate never runs on them.
            dup = await a.clone({ name: `${a.name} (Copy)` }, { save: true });
            await settle(300);
            await recheckLevelGatedGrants(dup);
            await settle();
            assert.equal(dup.system.stats.str.value, 5, "the duplicate's Stats already include the grant");
            assert.lengthOf(bakedIds(dup.items.find((i) => i.type === "race")), 2);
          } finally {
            await deleteTestActor(a);
            await deleteTestActor(dup);
          }
        });
      });

      describe("bakeItemGrants: slugified name matching", function () {
        useQuenchTimeout(this);

        it("bumps an existing owned item despite case/whitespace differences in the grant target", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "Fire Fingers", { name: "Fire Fingers", system: { rank: 2, category: "attack" } });
            await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "skillRank", target: "Fire  Fingers", mode: "add", value: "1" }] } });
            await waitFor(() => actor.items.find((i) => i.name === "Fire Fingers")?.system.rank !== 2);
            const matches = actor.items.filter((i) => i.name === "Fire Fingers");
            assert.lengthOf(matches, 1, "should bump the existing item, not create a duplicate");
            assert.equal(matches[0].system.rank, 3);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("bakeItemGrants: idempotency", function () {
        useQuenchTimeout(this);

        it("baking the same item's grants twice does not double-apply", async function () {
          const actor = await createTestCharacter();
          try {
            const race = await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "stat", target: "str", mode: "add", value: "3" }] } });
            await waitFor(() => actor.system.stats.str.value !== 3);
            assert.equal(actor.system.stats.str.value, 6); // 3 base + 3 grant
            await bakeItemGrants(race);
            await settle();
            assert.equal(actor.system.stats.str.value, 6, "second bake must not double-apply");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("isEligibleNow: levelGate and conditions gating", function () {
        useQuenchTimeout(this);

        it("a levelGate'd stat change stays dormant until Level reaches it, then bakes on recheck", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "stat", target: "dex", mode: "add", value: "2", levelGate: 50 }] } });
            await settle();
            assert.equal(actor.system.stats.dex.value, 3, "not yet eligible below Level 50");

            await actor.update({ "system.attributes.level.value": 50 });
            await recheckLevelGatedGrants(actor);
            await settle();
            assert.equal(actor.system.stats.dex.value, 5, "eligible once Level 50 is reached");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a change carrying roll-time 'conditions' is never baked into base", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "race", "race", {
              system: { changes: [{ targetType: "stat", target: "cha", mode: "add", value: "2", conditions: [{ id: "c1", label: "Flanking" }] }] },
            });
            await settle();
            assert.equal(actor.system.stats.cha.value, 3, "conditional changes must stay live-only, never baked");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("actorBakeQueues: serialized concurrent bakes", function () {
        useQuenchTimeout(this);

        it("two near-simultaneous grants on the same actor both land (no lost update)", async function () {
          const actor = await createTestCharacter();
          try {
            const race = await createTestItem(actor, "race");
            const klass = await createTestItem(actor, "class");
            await settle();

            const p1 = race.update({ "system.changes": [{ targetType: "stat", target: "str", mode: "add", value: "2" }] });
            const p2 = klass.update({ "system.changes": [{ targetType: "stat", target: "str", mode: "add", value: "3" }] });
            await Promise.all([p1, p2]);
            await waitFor(() => actor.system.stats.str.value === 8);

            assert.equal(actor.system.stats.str.value, 8); // 3 base + 2 + 3
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: race-class-grants.mjs" },
  );
}
