import { getStatMod, getRankDamageDie, getDegreeOfSuccess, isHitDegree, degreeBadge } from "../../helpers/rules.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.rules",
    (context) => {
      const { describe, it, assert } = context;

      describe("getStatMod (Table 2 stepped lookup)", function () {
        it("returns the stepped band value, not a linear formula", function () {
          assert.equal(getStatMod(1), 1);
          assert.equal(getStatMod(2), 1);
          assert.equal(getStatMod(10), 4);
          assert.equal(getStatMod(19), 4);
          assert.equal(getStatMod(20), 5);
        });

        it("clamps below the table's floor and above its ceiling", function () {
          assert.equal(getStatMod(0), 1);
          assert.equal(getStatMod(-5), 1);
          assert.equal(getStatMod(500), 10);
        });
      });

      describe("getRankDamageDie (Table 37)", function () {
        it("looks up the band table, with no die below Rank 1", function () {
          assert.equal(getRankDamageDie(0), "");
          assert.equal(getRankDamageDie(1), "1");
          assert.equal(getRankDamageDie(13), "1d12");
          assert.equal(getRankDamageDie(20), "2d10");
        });

        it("has no ceiling clamp beyond Rank 20 (loop just keeps the last match)", function () {
          assert.equal(getRankDamageDie(999), "2d10");
        });
      });

      describe("getDegreeOfSuccess", function () {
        it("a natural 20 always wins, regardless of total/difficulty", function () {
          assert.equal(getDegreeOfSuccess(20, 5, 30), "criticalHit");
        });

        it("a natural 1 always wins, regardless of total/difficulty", function () {
          assert.equal(getDegreeOfSuccess(1, 25, 10), "criticalFail");
        });

        it("falls back to a total>=10 threshold with no Difficulty supplied", function () {
          assert.equal(getDegreeOfSuccess(10, 12, null), "standardSuccess");
          assert.equal(getDegreeOfSuccess(5, 9, undefined), "standardFail");
        });

        it("resolves margin bands against a Difficulty of 10", function () {
          assert.equal(getDegreeOfSuccess(15, 20, 10), "amazingSuccess"); // margin 10
          assert.equal(getDegreeOfSuccess(15, 19, 10), "standardSuccess"); // margin 9
          assert.equal(getDegreeOfSuccess(15, 10, 10), "standardSuccess"); // margin 0
          assert.equal(getDegreeOfSuccess(15, 9, 10), "nearMissFail"); // margin -1
          assert.equal(getDegreeOfSuccess(15, 8, 10), "nearMissFail"); // margin -2
          assert.equal(getDegreeOfSuccess(15, 7, 10), "standardFail"); // margin -3
          assert.equal(getDegreeOfSuccess(15, 1, 10), "standardFail"); // margin -9
          assert.equal(getDegreeOfSuccess(15, 0, 10), "majorFail"); // margin -10
        });
      });

      describe("isHitDegree", function () {
        it("only Critical Hit / Amazing Success / Standard Success count as a hit", function () {
          assert.isTrue(isHitDegree("criticalHit"));
          assert.isTrue(isHitDegree("amazingSuccess"));
          assert.isTrue(isHitDegree("standardSuccess"));
          assert.isFalse(isHitDegree("nearMissFail"));
          assert.isFalse(isHitDegree("standardFail"));
          assert.isFalse(isHitDegree("majorFail"));
          assert.isFalse(isHitDegree("criticalFail"));
        });
      });

      describe("degreeBadge", function () {
        it("classifies each degree into hit/miss/warn", function () {
          assert.equal(degreeBadge("criticalHit").type, "hit");
          assert.equal(degreeBadge("amazingSuccess").type, "hit");
          assert.equal(degreeBadge("standardSuccess").type, "hit");
          assert.equal(degreeBadge("majorFail").type, "miss");
          assert.equal(degreeBadge("criticalFail").type, "miss");
          assert.equal(degreeBadge("standardFail").type, "warn");
          assert.equal(degreeBadge("nearMissFail").type, "warn");
        });
      });
    },
    { displayName: "CarlRPG: rules.mjs (stat mods, degree of success)" },
  );
}
