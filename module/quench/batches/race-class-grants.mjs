import { bakeItemGrants, recheckLevelGatedGrants } from "../../helpers/race-class-grants.mjs";
import { createTestCharacter, createTestItem, deleteTestActor, settle, useQuenchTimeout, waitFor } from "../helpers.mjs";

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
