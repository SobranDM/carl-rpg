import {
  splitDamageEvenly,
  reduceDamagePortion,
  computeSlotsLost,
  reduceViaShield,
  computeDamageApplication,
} from "../../helpers/damage-pipeline.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.damage-pipeline",
    (context) => {
      const { describe, it, assert } = context;

      describe("splitDamageEvenly", function () {
        it("splits evenly with no remainder", function () {
          assert.deepEqual(splitDamageEvenly(10, ["fire", "force"]), { fire: 5, force: 5 });
        });

        it("distributes any remainder one point at a time to the first types in order", function () {
          assert.deepEqual(splitDamageEvenly(10, ["fire", "force", "ice"]), { fire: 4, force: 3, ice: 3 });
        });

        it("handles zero total and an empty type list", function () {
          assert.deepEqual(splitDamageEvenly(0, ["fire"]), { fire: 0 });
          assert.deepEqual(splitDamageEvenly(5, []), {});
        });

        it("clamps a negative total to 0", function () {
          assert.deepEqual(splitDamageEvenly(-5, ["fire"]), { fire: 0 });
        });
      });

      describe("reduceDamagePortion", function () {
        it("resists (half, floored), is vulnerable (double), is immune (zero), or passes through unchanged", function () {
          assert.equal(reduceDamagePortion(7, "resist").final, 3);
          assert.equal(reduceDamagePortion(7, "vulnerable").final, 14);
          assert.equal(reduceDamagePortion(7, "immune").final, 0);
          assert.equal(reduceDamagePortion(7, "none").final, 7);
        });

        it("clamps a negative amount to 0", function () {
          assert.equal(reduceDamagePortion(-5, "none").final, 0);
        });
      });

      describe("computeSlotsLost (the book's own worked example)", function () {
        it("consumes whole slots only, ignoring leftover damage under one slot's value", function () {
          assert.equal(computeSlotsLost(12, 5), 2);
          assert.equal(computeSlotsLost(15, 5), 3);
          assert.equal(computeSlotsLost(4, 5), 0);
        });

        it("returns 0 for a non-positive slotValue or damage", function () {
          assert.equal(computeSlotsLost(10, 0), 0);
          assert.equal(computeSlotsLost(0, 5), 0);
        });
      });

      describe("reduceViaShield", function () {
        it("absorbs whole slots up to the shield's own remaining value", function () {
          const result = reduceViaShield(12, { value: 3, slotValue: 5 });
          assert.deepEqual(result, { remaining: 2, slotsLost: 2, absorbed: 10 });
        });

        it("passes through unchanged with no shield capacity", function () {
          assert.deepEqual(reduceViaShield(12, { value: 0, slotValue: 5 }), { remaining: 12, slotsLost: 0, absorbed: 0 });
        });

        it("caps slots lost at the shield's remaining value, carrying overflow forward", function () {
          const result = reduceViaShield(100, { value: 2, slotValue: 5 });
          assert.equal(result.slotsLost, 2);
          assert.equal(result.absorbed, 10);
          assert.equal(result.remaining, 90);
        });
      });

      describe("computeDamageApplication (full pipeline)", function () {
        function target(overrides = {}) {
          return { system: { drEffective: 0, resistancesEffective: {}, hb: { slotValue: 5 }, shield: { value: 0, slotValue: 0 }, ...overrides } };
        }

        it("magic damage (the default) skips the Shield pool entirely", function () {
          const t = target({ shield: { value: 3, slotValue: 5 } });
          const result = computeDamageApplication({ fire: 12 }, t, true);
          assert.equal(result.shieldAbsorbed, 0);
        });

        it("non-magic damage is absorbed by an active Shield before DR", function () {
          const t = target({ shield: { value: 3, slotValue: 5 } });
          const result = computeDamageApplication({ fire: 12 }, t, false);
          assert.isAbove(result.shieldAbsorbed, 0);
        });

        it("applies DR once to the combined multi-type total, then re-splits evenly", function () {
          const t = target({ drEffective: 4, resistancesEffective: { fire: "resist" } });
          const result = computeDamageApplication({ fire: 10, force: 6 }, t, true);
          // Combined 16 - DR 4 = 12, split evenly (6/6), fire then halved -> 3, force -> 6.
          const fire = result.perType.find((p) => p.type === "fire");
          const force = result.perType.find((p) => p.type === "force");
          assert.equal(fire.afterDr, 6);
          assert.equal(fire.final, 3);
          assert.equal(force.afterDr, 6);
          assert.equal(force.final, 6);
          assert.equal(result.totalFinalDamage, 9);
        });

        it("an untyped ('') portion has no matching resistance and passes through", function () {
          const t = target();
          const result = computeDamageApplication({ "": 8 }, t, true);
          assert.equal(result.perType[0].state, "none");
          assert.equal(result.perType[0].final, 8);
        });

        it("falls back to raw dr/resistances when *Effective fields are absent", function () {
          const t = { system: { dr: 2, resistances: { fire: "vulnerable" }, hb: { slotValue: 5 } } };
          const result = computeDamageApplication({ fire: 10 }, t, true);
          assert.equal(result.perType[0].afterDr, 8);
          assert.equal(result.perType[0].final, 16);
        });
      });
    },
    { displayName: "CarlRPG: damage-pipeline.mjs" },
  );
}
