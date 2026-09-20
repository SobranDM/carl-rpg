import { createTestCharacter, createTestItem, deleteTestActor, settle, useQuenchTimeout, waitFor } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.item-document",
    (context) => {
      const { describe, it, assert } = context;

      describe("_onCreate: automatic Race/Class grant baking", function () {
        useQuenchTimeout(this);

        it("bakes a newly-created Race item's grants with no explicit bakeItemGrants call", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "stat", target: "str", mode: "add", value: "2" }] } });
            // _onCreate's own bakeItemGrants call isn't awaited by createEmbeddedDocuments - poll instead of a fixed settle().
            await waitFor(() => actor.system.stats.str.value !== 3);
            assert.equal(actor.system.stats.str.value, 5); // 3 base + 2 grant
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("does not bake anything for a newly-created Skill item", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "skill", { system: { changes: [{ targetType: "stat", target: "str", mode: "add", value: "2" }] } });
            await settle();
            assert.equal(actor.system.stats.str.value, 3, "a Skill's own 'changes' are a live bonus, never baked into base");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("_onUpdate: baking newly-appended grants", function () {
        useQuenchTimeout(this);

        it("bakes a change appended after creation, without re-baking the already-baked one", async function () {
          const actor = await createTestCharacter();
          try {
            const race = await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "stat", target: "str", mode: "add", value: "2" }] } });
            await waitFor(() => actor.system.stats.str.value !== 3);
            assert.equal(actor.system.stats.str.value, 5);

            const appended = [...race.system.changes, { targetType: "stat", target: "dex", mode: "add", value: "3" }];
            await race.update({ "system.changes": appended });
            await waitFor(() => actor.system.stats.dex.value !== 3);
            assert.equal(actor.system.stats.str.value, 5, "the already-baked str grant must not re-apply");
            assert.equal(actor.system.stats.dex.value, 6, "the newly-appended dex grant should bake");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an unrelated field update does not trigger baking at all", async function () {
          const actor = await createTestCharacter();
          try {
            const race = await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "stat", target: "str", mode: "add", value: "2" }] } });
            await waitFor(() => actor.system.stats.str.value !== 3);
            await race.update({ "system.description": "flavor text" });
            await settle();
            assert.equal(actor.system.stats.str.value, 5);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("roll(): type-based routing", function () {
        useQuenchTimeout(this);

        // Not covered here: routing an Attack Skill/Spell to rollAttack.
        // Item#roll() calls CarlDice.rollAttack(this.actor, this) with no
        // options at all, so skipDialog defaults to false and a real
        // promptRollOptions dialog opens and awaits a click that never comes
        // in Quench - the same dialog-simulation gap as the A3 GM-override
        // test in dice-integration.mjs. Left as a manual-QA gap.

        it("routes a heal-keyword Spell to rollHeal even when isPassive is true", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Heal Self", {
              system: { isPassive: true, castingKeywords: ["heal"], rank: 5, upgrades: [{ rankThreshold: 5, healDice: "1d6" }] },
            });
            const message = await spell.roll();
            assert.isNumber(message.getFlag("carl-rpg", "healAmount"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("routes a toggled Spell to rollToggleSpell (activates/deactivates instead of rolling a Check)", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Toggle Spell", { system: { isToggled: true, active: false, rank: 5 } });
            await spell.roll();
            await settle();
            assert.isTrue(spell.system.active);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("routes a Damage Effect to a description card, never a roll", async function () {
          const actor = await createTestCharacter();
          try {
            const de = await createTestItem(actor, "damageEffect", "Powerful Strike", { system: { description: "Extra oomph." } });
            const message = await de.roll();
            assert.include(message.content, "Extra oomph.");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: documents/item.mjs" },
  );
}
