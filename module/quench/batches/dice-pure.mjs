import { resolveD20Formula, extractNaturalD20 } from "../../dice/dice.mjs";
import { mockD20Roll } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.dice-pure",
    (context) => {
      const { describe, it, assert } = context;

      describe("resolveD20Formula (net Advantage/Disadvantage, p.60)", function () {
        it("no inherent disadvantage: selection maps directly", function () {
          assert.equal(resolveD20Formula(false, "normal"), "1d20");
          assert.equal(resolveD20Formula(false, "advantage"), "2d20kh");
          assert.equal(resolveD20Formula(false, "disadvantage"), "2d20kl");
        });

        it("inherent disadvantage + selected Advantage cancel 1-for-1", function () {
          assert.equal(resolveD20Formula(true, "normal"), "2d20kl");
          assert.equal(resolveD20Formula(true, "advantage"), "1d20");
        });

        it("inherent disadvantage + selected Disadvantage both stack toward disadvantage", function () {
          assert.equal(resolveD20Formula(true, "disadvantage"), "2d20kl");
        });
      });

      describe("extractNaturalD20", function () {
        it("returns null with no d20 dice at all", function () {
          assert.isNull(extractNaturalD20({ dice: [] }));
        });

        it("returns the active result's face value among several inactive kept-die results", function () {
          const roll = mockD20Roll([{ result: 14, active: true }, { result: 3, active: false }]);
          assert.equal(extractNaturalD20(roll), 14);
        });

        it("returns null when no result is marked active", function () {
          const roll = mockD20Roll([{ result: 14, active: false }, { result: 3, active: false }]);
          assert.isNull(extractNaturalD20(roll));
        });
      });
    },
    { displayName: "CarlRPG: dice.mjs (pure helpers)" },
  );
}
