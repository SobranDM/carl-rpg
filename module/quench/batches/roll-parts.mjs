import { RollParts, normalizeRollPart } from "../../dice/roll-parts.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.roll-parts",
    (context) => {
      const { describe, it, assert } = context;

      describe("normalizeRollPart", function () {
        it("coerces signed numeric strings to numbers", function () {
          assert.strictEqual(normalizeRollPart("+3"), 3);
          assert.strictEqual(normalizeRollPart("-2"), -2);
        });

        it("leaves a dice formula string unchanged", function () {
          assert.strictEqual(normalizeRollPart("1d6"), "1d6");
        });

        it("passes through non-string values unchanged", function () {
          assert.strictEqual(normalizeRollPart(5), 5);
        });
      });

      describe("RollParts.add / multiply / override (no-op dropping)", function () {
        it("drops a zero numeric value so labels never desync from values", function () {
          const parts = new RollParts();
          parts.add(0, "Zero Bonus");
          assert.isTrue(parts.isEmpty);
        });

        it("drops a blank string value", function () {
          const parts = new RollParts();
          parts.add("", "Blank");
          assert.isTrue(parts.isEmpty);
        });

        it("drops a multiply factor of 1 (a no-op)", function () {
          const parts = new RollParts();
          parts.multiply(1, "No-op Multiplier");
          assert.isTrue(parts.isEmpty);
        });

        it("drops a null/undefined/blank override", function () {
          const parts = new RollParts();
          parts.override(null, "x");
          parts.override("", "y");
          assert.isTrue(parts.isEmpty);
        });
      });

      describe("formula()", function () {
        it("assembles multiple additive parts with signs", function () {
          const parts = new RollParts();
          parts.add(5, "A").add(-2, "B");
          assert.equal(parts.formula(), "5 - 2");
        });

        it("handles a leading dice term", function () {
          const parts = new RollParts();
          parts.add("1d6", "Die").add(3, "Bonus");
          assert.equal(parts.formula(), "1d6 + 3");
        });

        it("falls back to '0' with no parts at all", function () {
          assert.equal(new RollParts().formula(), "0");
        });
      });

      describe("additiveBreakdown()", function () {
        it("renders a labeled +/- breakdown string", function () {
          const parts = new RollParts();
          parts.add(5, "A").add(-2, "B");
          assert.equal(parts.additiveBreakdown(), "5 (A) - 2 (B)");
        });

        it("omits the label wrapper for an unlabeled part", function () {
          const parts = new RollParts();
          parts.add(5, "");
          assert.equal(parts.additiveBreakdown(), "5");
        });
      });

      describe("evaluate() (real Roll, live-world only)", function () {
        it("applies a post-roll multiply against the additive total", async function () {
          const parts = new RollParts();
          parts.add(10, "Base");
          parts.multiply(2, "Double");
          const { total, breakdown } = await parts.evaluate();
          assert.equal(total, 20);
          assert.include(breakdown, "×2");
        });

        it("applies a post-roll override, replacing the additive total outright", async function () {
          const parts = new RollParts();
          parts.add(10, "Base");
          parts.override(99, "Set");
          const { total } = await parts.evaluate();
          assert.equal(total, 99);
        });
      });
    },
    { displayName: "CarlRPG: roll-parts.mjs (RollParts)" },
  );
}
