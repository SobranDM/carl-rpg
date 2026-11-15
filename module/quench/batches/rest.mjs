import { restorePerRound, shortRestUpdates } from "../../helpers/rest.mjs";
import { ownerIds, withOwners } from "../../helpers/ownership.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { createTestCharacter, deleteTestActor } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.rest",
    (context) => {
      const { describe, it, assert } = context;

      describe("shortRestUpdates (p.94: +5 HB, +half Mana, both clamped to max)", function () {
        it("adds 5 HB slots, clamped at effectiveMax", async function () {
          const actor = await createTestCharacter("character", { system: { hb: { value: 3, max: 10 } } });
          try {
            assert.equal(shortRestUpdates(actor)["system.hb.value"], 8);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("clamps at effectiveMax rather than overshooting", async function () {
          const actor = await createTestCharacter("character", { system: { hb: { value: 8, max: 10 } } });
          try {
            assert.equal(shortRestUpdates(actor)["system.hb.value"], 10);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("restores half of max Mana (floored), clamped at max", async function () {
          const actor = await createTestCharacter("character", { system: { stats: { int: { value: 10 } }, mana: { value: 2 } } });
          try {
            // mana.max derives from effective INT (10) -> restore floor(10/2)=5 -> 2+5=7.
            assert.equal(shortRestUpdates(actor)["system.mana.value"], 7);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      // The one rule for a round's end, a fight's end and a restore used
      // outside a fight (round-end.mjs, consumables.mjs).
      describe("restorePerRound", function () {
        it("restores per round x rounds, each up to its max; The Taint blocks only the Health Bar", async function () {
          const actor = await createTestCharacter("restore", { system: { hb: { value: 2, max: 10 }, stats: { int: { value: 10 } } } });
          try {
            const sys = actor.system;
            const maxMana = sys.mana.max;
            let r = restorePerRound(sys, { hb: 2, mana: 0 }, { hb: 1, mana: 2 }, 3);
            assert.deepEqual(r, { hb: 5, mana: Math.min(6, maxMana), taint: null });
            r = restorePerRound(sys, { hb: 9, mana: maxMana }, { hb: 5, mana: 5 });
            assert.equal(r.hb, 10, "capped at max");
            assert.equal(r.mana, maxMana, "never past max");
            assert.equal(restorePerRound(sys, { hb: 12, mana: 0 }, { hb: 1 }).hb, 12, "never lowered");

            const taintKey = Object.entries(CONFIG.CARLRPG.debuffs).find(([, d]) => d.mechanics?.noHealing)?.[0];
            await addConditionToActor(actor, taintKey);
            r = restorePerRound(actor.system, { hb: 2, mana: 0 }, { hb: 1, mana: 2 }, 3);
            assert.equal(r.hb, 2, "no Health Bar under The Taint");
            assert.equal(r.taint?.key, taintKey);
            assert.equal(r.mana, Math.min(6, maxMana), "Mana still restores");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      // A crawler's players own its Pet and Vehicle (ownership.mjs).
      describe("ownerIds / withOwners", function () {
        it("lists OWNER-level users, not default or lesser ones; adds them without lowering anyone", function () {
          const { NONE, OBSERVER, OWNER } = CONST.DOCUMENT_OWNERSHIP_LEVELS;
          const crawler = { ownership: { default: OWNER, a: OWNER, b: OBSERVER, c: OWNER } };
          assert.sameMembers(ownerIds(crawler), ["a", "c"]);
          assert.deepEqual(ownerIds(null), []);
          const given = { default: NONE, b: OWNER };
          assert.deepEqual(withOwners(given, ["a"]), { default: NONE, b: OWNER, a: OWNER });
          assert.deepEqual(given, { default: NONE, b: OWNER }, "the original is left alone");
          assert.deepEqual(withOwners(undefined, ["a"]), { a: OWNER });
        });
      });
    },
    { displayName: "CarlRPG: rest.mjs" },
  );
}
