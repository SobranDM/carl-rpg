import {
  collectDebuffRows,
  collectAdvantageAgainstRows,
  resolveRollerRows,
  resolveDifficultyRows,
  disadvantageScopeApplies,
  consumedConditionIds,
  endedConditionIds,
  isOneShotDebuff,
} from "../../helpers/debuff-effects.mjs";
import { resolveD20Formula, evaluateMobConstant } from "../../dice/dice.mjs";

/** A plain system-data stand-in: {conditions, stats.dex.mod}. */
function sysWith(conditions, { dexMod = 0 } = {}) {
  return {
    stats: { dex: { mod: dexMod } },
    conditions: conditions.map((c, i) => ({
      id: `c${i}`,
      label: "",
      stacks: 1,
      remaining: null,
      source: "",
      ...c,
    })),
  };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.debuff-effects-pure",
    (context) => {
      const { describe, it, assert } = context;

      describe("disadvantageScopeApplies (Table 11 wording)", function () {
        it("'all'/'sight'/'nextCheck' reach every kind of roll", function () {
          for (const scope of ["all", "sight", "nextCheck"]) {
            for (const kind of ["attack", "evade", "check"])
              assert.isTrue(disadvantageScopeApplies(scope, kind), `${scope}/${kind}`);
          }
        });
        it("'attack'/'nextAttack' only reach Attacks", function () {
          for (const scope of ["attack", "nextAttack"]) {
            assert.isTrue(disadvantageScopeApplies(scope, "attack"));
            assert.isFalse(disadvantageScopeApplies(scope, "evade"));
            assert.isFalse(disadvantageScopeApplies(scope, "check"));
          }
        });
        it("'nextAction' (Queasy) reaches any roll that is the creature's own Action, and nothing else", function () {
          for (const kind of ["attack", "evade", "check"]) {
            assert.isTrue(disadvantageScopeApplies("nextAction", kind), kind);
            assert.isFalse(
              disadvantageScopeApplies("nextAction", kind, { ownAction: false }),
              kind,
            );
          }
        });
        it("a Queasy Mob's Evade/Surprise aren't lowered (they aren't its Action)", function () {
          const sys = sysWith([{ key: "queasy" }]);
          assert.lengthOf(collectDebuffRows(sys, "evade", { ownAction: false }), 0);
          assert.lengthOf(collectDebuffRows(sys, "check", { ownAction: false }), 0);
        });
      });

      describe("collectDebuffRows", function () {
        it("flat penalties: Minor Injury -2, Fatigued -1 per stack", function () {
          const rows = collectDebuffRows(
            sysWith([{ key: "minorInjury" }, { key: "fatigued", stacks: 3 }]),
            "check",
          );
          assert.deepEqual(
            rows.map((r) => [r.kind, r.value]),
            [
              ["penalty", -2],
              ["penalty", -3],
            ],
          );
        });
        it("Terrified's Disadvantage applies to Attacks only", function () {
          const sys = sysWith([{ key: "terrified" }]);
          assert.lengthOf(collectDebuffRows(sys, "attack"), 1);
          assert.lengthOf(collectDebuffRows(sys, "evade"), 0);
        });
        it("Blinded is offered everywhere but only pre-ticked for Attacks/Evades", function () {
          const sys = sysWith([{ key: "blinded" }]);
          assert.isTrue(collectDebuffRows(sys, "attack")[0].defaultOn);
          assert.isTrue(collectDebuffRows(sys, "evade")[0].defaultOn);
          assert.isFalse(collectDebuffRows(sys, "check")[0].defaultOn);
        });
        it("Stunned/Queasy/Staggered are consumed; Shit-Faced isn't", function () {
          const sys = sysWith([
            { key: "stunned" },
            { key: "queasy" },
            { key: "staggered" },
            { key: "shitFaced" },
          ]);
          const rows = collectDebuffRows(sys, "attack");
          assert.deepEqual(
            rows.map((r) => [r.key, r.consume]),
            [
              ["stunned", true],
              ["queasy", true],
              ["staggered", true],
              ["shitFaced", false],
            ],
          );
        });
        it("Woozy removes the DEX Mod from an Evade, and from an Attack only when it uses DEX", function () {
          const sys = sysWith([{ key: "woozy" }], { dexMod: 3 });
          assert.deepEqual(
            collectDebuffRows(sys, "evade").map((r) => [r.kind, r.value]),
            [["noDex", -3]],
          );
          assert.lengthOf(collectDebuffRows(sys, "attack", { usesDex: false }), 0);
          assert.lengthOf(collectDebuffRows(sys, "attack", { usesDex: true }), 1);
          assert.lengthOf(collectDebuffRows(sys, "check"), 0);
        });
        it("ignores custom conditions and debuffs with no mechanics", function () {
          assert.lengthOf(
            collectDebuffRows(sysWith([{ key: "custom" }, { key: "enraged" }]), "attack"),
            0,
          );
        });
        it("row ids never contain a '.' (they're form-field name segments)", function () {
          const rows = collectDebuffRows(sysWith([{ key: "minorInjury", id: "abc" }]), "check", {
            idPrefix: "target",
          });
          assert.notInclude(rows[0].id, ".");
        });
      });

      describe("collectAdvantageAgainstRows", function () {
        it("Held and Take Down give attackers Advantage", function () {
          const rows = collectAdvantageAgainstRows(
            sysWith([{ key: "held" }, { key: "takeDown" }, { key: "minorInjury" }]),
          );
          assert.deepEqual(
            rows.map((r) => r.kind),
            ["advantage", "advantage"],
          );
        });
      });

      describe("resolveDifficultyRows (Mob Difficulty, p.60/p.96)", function () {
        const minor = { id: "a", kind: "penalty", value: -2, defaultOn: true };
        const dis1 = { id: "b", kind: "disadvantage", value: 0, defaultOn: true };
        const dis2 = { id: "c", kind: "disadvantage", value: 0, defaultOn: true };
        const adv = { id: "d", kind: "advantage", value: 0, defaultOn: true };

        it("'-X' lowers the Difficulty by X and Disadvantage by 5", function () {
          assert.equal(resolveDifficultyRows(15, [minor, dis1]).difficulty, 8);
        });
        it("two Disadvantages don't combine", function () {
          const result = resolveDifficultyRows(15, [dis1, dis2]);
          assert.equal(result.difficulty, 10);
          assert.equal(result.netAdvantage, -1);
        });
        it("Advantage and Disadvantage cancel", function () {
          assert.equal(resolveDifficultyRows(15, [dis1, adv]).difficulty, 15);
        });
        it("respects the dialog's checked set over defaultOn", function () {
          assert.equal(resolveDifficultyRows(15, [minor, dis1], new Set(["a"])).difficulty, 13);
        });
        it("no base Difficulty stays null", function () {
          assert.isNull(resolveDifficultyRows(null, [minor]).difficulty);
        });
      });

      describe("resolveRollerRows + resolveD20Formula", function () {
        it("counts Advantage/Disadvantage and folds Woozy into the penalties", function () {
          const result = resolveRollerRows([
            { id: "a", kind: "disadvantage", value: 0, defaultOn: true, label: "Shit-Faced" },
            { id: "b", kind: "noDex", value: -3, defaultOn: true, label: "Woozy" },
            { id: "c", kind: "advantage", value: 0, defaultOn: false, label: "Held" },
          ]);
          assert.equal(result.disadvantageCount, 1);
          assert.equal(result.advantageCount, 0);
          assert.deepEqual(result.penalties, [{ label: "Woozy", value: -3 }]);
        });
        it("debuff Disadvantage feeds the d20 formula", function () {
          assert.equal(resolveD20Formula(false, "normal", { disadvantageCount: 1 }), "2d20kl");
          assert.equal(resolveD20Formula(false, "advantage", { disadvantageCount: 1 }), "1d20");
        });
        it("two reasons for Advantage beat one for Disadvantage (p.60)", function () {
          assert.equal(
            resolveD20Formula(false, "normal", { advantageCount: 2, disadvantageCount: 1 }),
            "2d20kh",
          );
        });
      });

      describe("endedConditionIds / isOneShotDebuff", function () {
        it("an Action ends Queasy and Staggered even when they didn't shape the roll", function () {
          const sys = sysWith([
            { key: "queasy", id: "q" },
            { key: "staggered", id: "s" },
            { key: "poisoned", id: "p" },
          ]);
          assert.sameMembers(endedConditionIds(sys, []), ["q", "s"]);
        });
        it("a roll that isn't an Action (a free Evade) only ends consumed rows", function () {
          const sys = sysWith([
            { key: "queasy", id: "q" },
            { key: "stunned", id: "st" },
          ]);
          assert.deepEqual(
            endedConditionIds(sys, [{ conditionId: "st", consume: true }], { isAction: false }),
            ["st"],
          );
        });
        it("only Stunned/Queasy/Staggered count as one-shot", function () {
          for (const key of ["stunned", "queasy", "staggered"])
            assert.isTrue(isOneShotDebuff(key), key);
          for (const key of ["poisoned", "majorInjury", "dying", "custom"])
            assert.isFalse(isOneShotDebuff(key), key);
        });
      });

      describe("consumedConditionIds", function () {
        it("returns each consumed row's condition once", function () {
          assert.deepEqual(
            consumedConditionIds([
              { conditionId: "x", consume: true },
              { conditionId: "x", consume: true },
              { conditionId: "y", consume: false },
            ]),
            ["x"],
          );
        });
      });

      describe("evaluateMobConstant (p.267 '+F' values)", function () {
        it("adds the Floor to '+F'", function () {
          assert.equal(evaluateMobConstant("16+F", 3), 19);
          assert.equal(evaluateMobConstant("13 + F", 2), 15);
          assert.equal(evaluateMobConstant("12", 5), 12);
        });
        it("blank or non-arithmetic text is null", function () {
          assert.isNull(evaluateMobConstant("", 1));
          assert.isNull(evaluateMobConstant("lots", 1));
        });
      });
    },
    { displayName: "CarlRPG: debuff-effects.mjs (pure)" },
  );
}
