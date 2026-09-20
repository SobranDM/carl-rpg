import { createTestCharacter, createTestMob, createTestItem, deleteTestActor, settle, useQuenchTimeout } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.derived-data",
    (context) => {
      const { describe, it, assert } = context;

      describe("prepareDerivedData: Stat mod / HB / Shield / Resistance wiring", function () {
        useQuenchTimeout(this);

        it("derives stats.<key>.mod from the effective (base+bonus) value via getStatMod", async function () {
          const actor = await createTestCharacter("character", { system: { stats: { con: { value: 8 } } } });
          try {
            assert.equal(actor.system.stats.con.mod, 3); // getStatMod(8) -> [6,9,3] band
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("hb.slotValue mirrors CON Mod on both Character and Mob", async function () {
          const actor = await createTestCharacter("character", { system: { stats: { con: { value: 8 } } } });
          const mob = await createTestMob("mob", { system: { stats: { con: { value: 8 } } } });
          try {
            assert.equal(actor.system.hb.slotValue, 3);
            assert.equal(mob.system.hb.slotValue, 3);
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });

        it("hb.effectiveMax includes a 'resource' ChangeEntry bonus targeting hb.max", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "item", "gear", { system: { changes: [{ targetType: "resource", target: "hb.max", mode: "add", value: "5" }] } });
            await settle();
            assert.equal(actor.system.hb.effectiveMax, 15); // 10 base + 5 bonus
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Mana Max uses the effective (bonused) INT on both Character and Mob (p.110's 'Enhanced' Stat)", async function () {
          const actor = await createTestCharacter("character", { system: { stats: { int: { value: 10 } } } });
          const mob = await createTestMob("mob", { system: { stats: { int: { value: 10 } } } });
          try {
            await createTestItem(actor, "item", "gear", { system: { changes: [{ targetType: "stat", target: "int", mode: "add", value: "5" }] } });
            await settle();
            assert.equal(actor.system.mana.max, 15, "Character: Mana Max should track the live INT bonus");

            await mob.createEmbeddedDocuments("Item", [{ name: "gear", type: "item", system: { changes: [{ targetType: "stat", target: "int", mode: "add", value: "5" }] } }]);
            await settle();
            assert.equal(mob.system.mana.max, 15, "Mob: Mana Max should track the live INT bonus too (mob.mjs matches character.mjs)");
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });

        it("toggling a shield spell on/off recomputes shield.effectiveMax and clamps shield.value down", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Shield", { system: { isToggled: true, active: true, rank: 5, shieldSlots: 4 } });
            await settle();
            assert.equal(actor.system.shield.effectiveMax, 4);

            await actor.update({ "system.shield.value": 4 });
            await spell.update({ "system.active": false });
            await settle();
            assert.equal(actor.system.shield.effectiveMax, 0);
            assert.equal(actor.system.shield.value, 0, "value must clamp down to the new (lower) effectiveMax");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a granted 'resistance' ChangeEntry overrides the base value for its damage type only", async function () {
          const actor = await createTestCharacter("character", { system: { resistances: { fire: "resist" } } });
          try {
            await createTestItem(actor, "race", "race", { system: { changes: [{ targetType: "resistance", target: "fire", mode: "override", value: "immune" }] } });
            await settle();
            assert.equal(actor.system.resistancesEffective.fire, "immune", "the granted override should win over the base 'resist'");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("getRollData() returns a deep-cloned stats bag - mutating it must not affect the actor's own data", async function () {
          const actor = await createTestCharacter();
          try {
            const rollData = actor.getRollData();
            rollData.stats.str.value = 999;
            assert.notEqual(actor.system.stats.str.value, 999);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: character.mjs/mob.mjs (derived data)" },
  );
}
