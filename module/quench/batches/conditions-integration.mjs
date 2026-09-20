import { addConditionToActor, removeConditionFromActor } from "../../helpers/conditions.mjs";
import { createTestCharacter, deleteTestActor, useQuenchTimeout } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.conditions-integration",
    (context) => {
      const { describe, it, assert } = context;

      describe("addConditionToActor: stacking enforcement (Table 11)", function () {
        useQuenchTimeout(this);

        it("a 2nd Minor Injury upgrades to Long-Term Minor Injury instead of stacking", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "minorInjury");
            await addConditionToActor(actor, "minorInjury");
            assert.lengthOf(actor.system.conditions, 1);
            assert.equal(actor.system.conditions[0].key, "longTermMinorInjury");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a 2nd Major Injury upgrades to Long-Term Major Injury", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "majorInjury");
            await addConditionToActor(actor, "majorInjury");
            assert.lengthOf(actor.system.conditions, 1);
            assert.equal(actor.system.conditions[0].key, "longTermMajorInjury");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a stackable Debuff (e.g. Poisoned) pushes a genuine second entry", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "poisoned");
            await addConditionToActor(actor, "poisoned");
            assert.lengthOf(actor.system.conditions, 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a non-stackable Debuff with no Injury-upgrade mapping refreshes in place, not a duplicate", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "blinded");
            await addConditionToActor(actor, "blinded");
            assert.lengthOf(actor.system.conditions, 1);
            assert.equal(actor.system.conditions[0].key, "blinded");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("removeConditionFromActor", function () {
        useQuenchTimeout(this);

        it("removes exactly the entry at the given index, leaving the rest intact", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "poisoned");
            await addConditionToActor(actor, "fatigued");
            await addConditionToActor(actor, "poisoned");
            assert.lengthOf(actor.system.conditions, 3);
            const middleKey = actor.system.conditions[1].key;
            assert.equal(middleKey, "fatigued");
            await removeConditionFromActor(actor, 1);
            assert.lengthOf(actor.system.conditions, 2);
            assert.notInclude(actor.system.conditions.map((c) => c.key), "fatigued");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: conditions.mjs (actor-writing halves)" },
  );
}
