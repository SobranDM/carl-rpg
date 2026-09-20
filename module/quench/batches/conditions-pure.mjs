import { buildConditionEntry, resolveTargetEffectLabel } from "../../helpers/conditions.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.conditions-pure",
    (context) => {
      const { describe, it, assert } = context;

      describe("buildConditionEntry", function () {
        it("resolves a timed-duration preset's initial remaining value", function () {
          // paralyzed: CONFIG.CARLRPG.debuffs durationType "rounds", durationValue 1.
          const entry = buildConditionEntry("paralyzed");
          assert.equal(entry.remaining, 1);
        });

        it("an until-condition preset has no countdown (remaining: null)", function () {
          const entry = buildConditionEntry("held");
          assert.isNull(entry.remaining);
        });

        it("an unknown key falls back to a blank label and no duration", function () {
          const entry = buildConditionEntry("totally-made-up");
          assert.equal(entry.label, "");
          assert.isNull(entry.remaining);
        });

        it("an explicit label override wins over the preset's own localized label", function () {
          const entry = buildConditionEntry("poisoned", { label: "Custom Poison" });
          assert.equal(entry.label, "Custom Poison");
        });
      });

      describe("resolveTargetEffectLabel", function () {
        it("an explicit label override wins", function () {
          assert.equal(resolveTargetEffectLabel({ label: "Custom Text", debuffKey: "poisoned" }), "Custom Text");
        });

        it("falls back to the localized CONFIG.CARLRPG.debuffs label", function () {
          const label = resolveTargetEffectLabel({ debuffKey: "poisoned" });
          assert.isString(label);
          assert.isNotEmpty(label);
        });

        it("falls back to the raw key for an unknown debuffKey", function () {
          assert.equal(resolveTargetEffectLabel({ debuffKey: "totally-made-up" }), "totally-made-up");
        });
      });
    },
    { displayName: "CarlRPG: conditions.mjs (pure builders)" },
  );
}
