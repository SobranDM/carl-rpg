import { createTestCharacter, createTestItem, deleteTestActor, settle, useQuenchTimeout, waitFor } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.actor-document",
    (context) => {
      const { describe, it, assert } = context;

      describe("_preUpdate: +3 Stat points per Level (p.169)", function () {
        useQuenchTimeout(this);

        it("accrues 3 x levelDelta into bankedStatPoints on a Level increase", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.bankedStatPoints, 12); // 3 x (5 - 1)
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("does not claw back points on a Level decrease (GM correcting a mistake)", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.bankedStatPoints, 12);
            await actor.update({ "system.attributes.level.value": 3 });
            assert.equal(actor.system.bankedStatPoints, 12, "a Level decrease must not reduce banked points");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("does not fire on an update that never touches Level", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.biography": "Some text." });
            assert.equal(actor.system.bankedStatPoints, 0);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("accumulates correctly across multiple sequential Level-ups", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.attributes.level.value": 2 });
            assert.equal(actor.system.bankedStatPoints, 3);
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.bankedStatPoints, 12); // 3 + 3*3
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("_onUpdate: level-gated grant recheck", function () {
        useQuenchTimeout(this);

        it("bakes a levelGate'd grant automatically once Level crosses the gate via a real actor.update", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "race", "race", {
              system: { changes: [{ targetType: "stat", target: "dex", mode: "add", value: "2", levelGate: 50 }] },
            });
            await settle();
            assert.equal(actor.system.stats.dex.value, 3);

            await actor.update({ "system.attributes.level.value": 50 });
            // _onUpdate's recheckLevelGatedGrants->bakeItemGrants chain isn't awaited by actor.update() - poll instead of a fixed settle().
            await waitFor(() => actor.system.stats.dex.value !== 3);
            assert.equal(actor.system.stats.dex.value, 5, "the _onUpdate hook should auto-recheck level-gated grants");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("rollMarkedAdvancementChecks: rankFilter", function () {
        useQuenchTimeout(this);

        it("lte4 only rolls marked items at Rank <=4; gte5 only Rank >=5", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "Low Rank", { name: "Low Rank", system: { rank: 2, marked: true } });
            await createTestItem(actor, "skill", "High Rank", { name: "High Rank", system: { rank: 5, marked: true } });
            await createTestItem(actor, "skill", "Unmarked", { name: "Unmarked", system: { rank: 8, marked: false } });

            const low = await actor.rollMarkedAdvancementChecks({ rankFilter: "lte4" });
            assert.lengthOf(low, 1);
            assert.equal(low[0].item.name, "Low Rank");

            const high = await actor.rollMarkedAdvancementChecks({ rankFilter: "gte5" });
            assert.lengthOf(high, 1);
            assert.equal(high[0].item.name, "High Rank");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: documents/actor.mjs" },
  );
}
