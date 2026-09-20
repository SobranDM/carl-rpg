import {
  slugifySkillName,
  applyScalarChange,
  collectItemTargetEffects,
  computeActiveShieldSlots,
  applyOneChange,
  accumulateBonus,
  accumulateCap,
} from "../../helpers/modifiers.mjs";

/** Minimal ChangeEntry-shaped object - only the fields applyOneChange reads. */
function change(overrides = {}) {
  return {
    id: foundry.utils.randomID(),
    targetType: "custom",
    target: "someKey",
    mode: "add",
    value: "1",
    capMax: "",
    levelGate: 0,
    conditions: [],
    damageType: "",
    damageDiceKind: "",
    ...overrides,
  };
}

function emptyCtx(overrides = {}) {
  return {
    skills: {},
    bonuses: {},
    rollData: { stats: {}, lvl: 1, floor: 1 },
    conditionalModifiers: [],
    caps: {},
    resistances: {},
    advancementBonuses: {},
    rankCaps: {},
    ...overrides,
  };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.modifiers",
    (context) => {
      const { describe, it, assert } = context;

      describe("slugifySkillName", function () {
        it("normalizes whitespace/case into a dash-joined slug", function () {
          assert.equal(slugifySkillName("Fire Fingers"), "fire-fingers");
          assert.equal(slugifySkillName("  Multi   Space  "), "multi-space");
        });

        it("falls back to 'unknown' for blank/null input", function () {
          assert.equal(slugifySkillName(""), "unknown");
          assert.equal(slugifySkillName(null), "unknown");
        });

        it("strips non a-z0-9 characters (accents included)", function () {
          assert.equal(slugifySkillName("Über!!"), "ber");
        });
      });

      describe("applyScalarChange (the six modifier modes)", function () {
        it("implements add/subtract/multiply/override/upgrade/downgrade", function () {
          assert.equal(applyScalarChange(5, "add", 3), 8);
          assert.equal(applyScalarChange(5, "subtract", 3), 2);
          assert.equal(applyScalarChange(5, "multiply", 3), 15);
          assert.equal(applyScalarChange(5, "override", 3), 3);
          assert.equal(applyScalarChange(5, "upgrade", 3), 5);
          assert.equal(applyScalarChange(2, "upgrade", 3), 3);
          assert.equal(applyScalarChange(5, "downgrade", 3), 3);
        });

        it("passes through unchanged for an unrecognized mode", function () {
          assert.equal(applyScalarChange(5, "bogus", 3), 5);
        });
      });

      describe("collectItemTargetEffects", function () {
        it("only surfaces effects whose Upgrade tier rankThreshold is met", function () {
          const item = {
            name: "Iron Punch",
            system: {
              rank: 10,
              upgrades: [{
                rankThreshold: 5,
                targetEffects: [{ id: "a", debuffKey: "poisoned", critOnly: false, amazingSuccessOnly: false }],
              }],
            },
          };
          assert.lengthOf(collectItemTargetEffects(item), 1);

          const untrained = { ...item, system: { ...item.system, rank: 3 } };
          assert.lengthOf(collectItemTargetEffects(untrained), 0);
        });

        it("gates critOnly/amazingSuccessOnly entries on the caller's flags", function () {
          const item = {
            name: "Enchanted Blade",
            system: {
              rank: 10,
              upgrades: [{
                rankThreshold: 5,
                targetEffects: [
                  { id: "crit", debuffKey: "stunned", critOnly: true, amazingSuccessOnly: false },
                  { id: "as", debuffKey: "staggered", critOnly: false, amazingSuccessOnly: true },
                ],
              }],
            },
          };
          assert.lengthOf(collectItemTargetEffects(item, { isCrit: false, isAmazingSuccess: false }), 0);
          assert.lengthOf(collectItemTargetEffects(item, { isCrit: true, isAmazingSuccess: false }), 1);
          assert.lengthOf(collectItemTargetEffects(item, { isCrit: false, isAmazingSuccess: true }), 1);
        });

        it("filters out entries with a blank debuffKey", function () {
          const item = {
            name: "Blank Effect",
            system: { rank: 5, upgrades: [{ rankThreshold: 5, targetEffects: [{ id: "x", debuffKey: "" }] }] },
          };
          assert.lengthOf(collectItemTargetEffects(item), 0);
        });
      });

      describe("computeActiveShieldSlots", function () {
        it("returns 0 with no toggled-active shield spell", function () {
          assert.equal(computeActiveShieldSlots([]), 0);
          const off = [{ type: "spell", system: { isToggled: true, active: false, shieldSlots: 4 } }];
          assert.equal(computeActiveShieldSlots(off), 0);
        });

        it("uses the highest-rankThreshold unlocked tier that overrides shieldSlots", function () {
          const items = [{
            type: "spell",
            system: {
              isToggled: true, active: true, shieldSlots: 4, rank: 10,
              upgrades: [{ rankThreshold: 5, shieldSlots: 6 }, { rankThreshold: 15, shieldSlots: 8 }],
            },
          }];
          assert.equal(computeActiveShieldSlots(items), 6);
        });

        it("only ever considers the first active shield spell found", function () {
          const items = [
            { type: "spell", system: { isToggled: true, active: true, shieldSlots: 4, rank: 1, upgrades: [] } },
            { type: "spell", system: { isToggled: true, active: true, shieldSlots: 99, rank: 1, upgrades: [] } },
          ];
          assert.equal(computeActiveShieldSlots(items), 4);
        });
      });

      describe("applyOneChange (per-targetType branches)", function () {
        it("stat: accumulates into bonuses['stats.<key>'] and applies capMax", function () {
          const ctx = emptyCtx();
          applyOneChange(change({ targetType: "stat", target: "str", value: "3", capMax: "10" }), "src", "id1", 0, ctx);
          assert.equal(ctx.bonuses["stats.str"], 3);
          assert.equal(ctx.caps["stats.str"], 10);
        });

        it("resource: accumulates into bonuses[target] directly (e.g. hb.max)", function () {
          const ctx = emptyCtx();
          applyOneChange(change({ targetType: "resource", target: "hb.max", value: "5" }), "src", "id1", 0, ctx);
          assert.equal(ctx.bonuses["hb.max"], 5);
        });

        it("resistance: SET semantics, not accumulate", function () {
          const ctx = emptyCtx();
          applyOneChange(change({ targetType: "resistance", target: "fire", value: "immune" }), "src", "id1", 0, ctx);
          assert.equal(ctx.resistances.fire, "immune");
        });

        it("advancementBonus: accumulates by slugified skill name", function () {
          const ctx = emptyCtx();
          applyOneChange(change({ targetType: "advancementBonus", target: "Alchemy", value: "1" }), "src", "id1", 0, ctx);
          assert.equal(ctx.advancementBonuses["alchemy"], 1);
        });

        it("skillRank: bumps the skills bag, unless it's a baked Race/Class grant", function () {
          const ctx = emptyCtx({ skills: { alchemy: { key: "alchemy", name: "Alchemy", rank: 2 } } });
          applyOneChange(change({ targetType: "skillRank", target: "Alchemy", value: "2" }), "src", "id1", 0, ctx, "skill");
          assert.equal(ctx.skills.alchemy.rank, 4);

          const bakedCtx = emptyCtx({ skills: { alchemy: { key: "alchemy", name: "Alchemy", rank: 2 } } });
          applyOneChange(change({ targetType: "skillRank", target: "Alchemy", value: "2" }), "src", "id1", 0, bakedCtx, "race");
          assert.equal(bakedCtx.skills.alchemy.rank, 2, "a baked Race/Class grant must not double-apply live");
        });

        it("stat: multiply scales the real base Stat value (rollData.stats), not the zeroed bonus accumulator", function () {
          // Regression guard for the reported bug: multiply used to always
          // produce 0 for a single contributing item, because it multiplied
          // against the running bonuses-bag accumulator (which starts at 0
          // every pass), not the actor's real base value.
          const ctx = emptyCtx({ rollData: { stats: { str: { value: 10 } }, lvl: 1, floor: 1 } });
          applyOneChange(change({ targetType: "stat", target: "str", mode: "multiply", value: "2" }), "src", "id1", 0, ctx);
          // base 10, factor 2 -> bonus contribution = 10*(2-1) = 10, so
          // effective (base + bonus) = 20 = base*factor, as intended.
          assert.equal(ctx.bonuses["stats.str"], 10);
        });

        it("stat: two independent multiply ChangeEntries on the same Stat combine additively against the same base (design choice), not by compounding", function () {
          const ctx = emptyCtx({ rollData: { stats: { str: { value: 10 } }, lvl: 1, floor: 1 } });
          applyOneChange(change({ targetType: "stat", target: "str", mode: "multiply", value: "2" }), "item1", "id1", 0, ctx);
          applyOneChange(change({ targetType: "stat", target: "str", mode: "multiply", value: "2" }), "item2", "id2", 0, ctx);
          // Each x2 item independently contributes base*(2-1)=10 against the
          // SAME original base (10), not against each other's result - so
          // total bonus is 20 (effective 30 = 3x base), NOT 30 bonus/40
          // effective (4x base), which is what compounding would produce.
          assert.equal(ctx.bonuses["stats.str"], 20);
        });

        it("stat: multiply falls back to a no-op contribution when rollData has no real base for the target (unchanged pre-fix behavior)", function () {
          const ctx = emptyCtx({ rollData: { stats: {}, lvl: 1, floor: 1 } });
          applyOneChange(change({ targetType: "stat", target: "dex", mode: "multiply", value: "2" }), "src", "id1", 0, ctx);
          assert.equal(ctx.bonuses["stats.dex"], 0);
        });

        it("resource: multiply on 'dr' scales actorSystem.dr's real persisted base", function () {
          const ctx = emptyCtx({ actorSystem: { dr: 5 } });
          applyOneChange(change({ targetType: "resource", target: "dr", mode: "multiply", value: "3" }), "src", "id1", 0, ctx);
          // base 5, factor 3 -> bonus contribution = 5*(3-1) = 10.
          assert.equal(ctx.bonuses.dr, 10);
        });

        it("resource: multiply on 'hb.max'/'mana.max' still falls back to the old no-real-base behavior (documented limitation, not fixed by this change)", function () {
          // hb.max is fully re-derived from level/tier every pass for a Mob,
          // and mana.max is fully derived (stats.int.effective + bonus) for
          // BOTH actor types - neither has a stable persisted base this
          // aggregation pass can safely read, so multiply here is
          // deliberately left as the pre-existing (documented) no-op rather
          // than scaling a possibly-stale/wrong number.
          const ctx = emptyCtx({ actorSystem: { dr: 5 } });
          applyOneChange(change({ targetType: "resource", target: "hb.max", mode: "multiply", value: "2" }), "src", "id1", 0, ctx);
          assert.equal(ctx.bonuses["hb.max"], 0);

          const manaCtx = emptyCtx({ actorSystem: { dr: 5 } });
          applyOneChange(change({ targetType: "resource", target: "mana.max", mode: "multiply", value: "2" }), "src", "id1", 0, manaCtx);
          assert.equal(manaCtx.bonuses["mana.max"], 0);
        });

        it("skillRank: Override/Upgrade/Downgrade still work exactly as before (regression - these remain correct for skillRank)", function () {
          const overrideCtx = emptyCtx({ skills: { alchemy: { key: "alchemy", name: "Alchemy", rank: 2 } } });
          applyOneChange(change({ targetType: "skillRank", target: "Alchemy", mode: "override", value: "7" }), "src", "id1", 0, overrideCtx);
          assert.equal(overrideCtx.skills.alchemy.rank, 7);

          const upgradeCtx = emptyCtx({ skills: { alchemy: { key: "alchemy", name: "Alchemy", rank: 2 } } });
          applyOneChange(change({ targetType: "skillRank", target: "Alchemy", mode: "upgrade", value: "5" }), "src", "id1", 0, upgradeCtx);
          assert.equal(upgradeCtx.skills.alchemy.rank, 5, "upgrade should raise rank 2 up to at least 5");
          applyOneChange(change({ targetType: "skillRank", target: "Alchemy", mode: "upgrade", value: "3" }), "src", "id2", 0, upgradeCtx);
          assert.equal(upgradeCtx.skills.alchemy.rank, 5, "a lower upgrade value should not lower an already-higher rank");

          const downgradeCtx = emptyCtx({ skills: { alchemy: { key: "alchemy", name: "Alchemy", rank: 8 } } });
          applyOneChange(change({ targetType: "skillRank", target: "Alchemy", mode: "downgrade", value: "5" }), "src", "id1", 0, downgradeCtx);
          assert.equal(downgradeCtx.skills.alchemy.rank, 5, "downgrade should cap rank 8 down to at most 5");
        });

        it("skips a change entirely when levelGate exceeds the actor's current level", function () {
          const ctx = emptyCtx({ rollData: { stats: {}, lvl: 10, floor: 1 } });
          applyOneChange(change({ targetType: "stat", target: "dex", value: "2", levelGate: 50 }), "src", "id1", 0, ctx);
          assert.notProperty(ctx.bonuses, "stats.dex");
        });

        it("routes a change with conditions into conditionalModifiers instead of applying it", function () {
          const ctx = emptyCtx();
          applyOneChange(change({ targetType: "stat", target: "str", value: "2", conditions: [{ id: "c1", label: "Flanking" }] }), "src", "id1", 0, ctx);
          assert.notProperty(ctx.bonuses, "stats.str");
          assert.lengthOf(ctx.conditionalModifiers, 1);
        });
      });

      describe("accumulateBonus / accumulateCap", function () {
        it("accumulateBonus applies the mode-based scalar change onto the bag", function () {
          const bonuses = { x: 2 };
          accumulateBonus(bonuses, "x", change({ mode: "add", value: "3" }), {});
          assert.equal(bonuses.x, 5);
        });

        it("accumulateCap keeps the most restrictive (lowest) cap per key", function () {
          const caps = {};
          accumulateCap(caps, "dr", change({ capMax: "10" }), {});
          accumulateCap(caps, "dr", change({ capMax: "5" }), {});
          accumulateCap(caps, "dr", change({ capMax: "20" }), {});
          assert.equal(caps.dr, 5);
        });

        it("accumulateCap no-ops when capMax is blank", function () {
          const caps = {};
          accumulateCap(caps, "dr", change({ capMax: "" }), {});
          assert.notProperty(caps, "dr");
        });

        it("accumulateBonus 'multiply' with a numeric baseValue contributes base*(factor-1), not current*factor", function () {
          const bonuses = {};
          accumulateBonus(bonuses, "x", change({ mode: "multiply", value: "4" }), {}, 10);
          assert.equal(bonuses.x, 30, "base 10, factor 4 -> bonus 10*(4-1) = 30 (effective 10+30=40=10*4)");
        });

        it("accumulateBonus 'multiply' with no baseValue falls back to the old current*factor arithmetic (always 0 for a first contributor)", function () {
          const bonuses = {};
          accumulateBonus(bonuses, "x", change({ mode: "multiply", value: "4" }), {});
          assert.equal(bonuses.x, 0);
        });

        it("accumulateBonus non-multiply modes ignore baseValue entirely (add/subtract regression)", function () {
          const bonuses = { x: 2 };
          accumulateBonus(bonuses, "x", change({ mode: "add", value: "3" }), {}, 999);
          assert.equal(bonuses.x, 5);
          accumulateBonus(bonuses, "x", change({ mode: "subtract", value: "1" }), {}, 999);
          assert.equal(bonuses.x, 4);
        });
      });

      describe("CARLRPG.changeModesByTarget (Change Entry editor's Mode dropdown filtering)", function () {
        it("excludes override/upgrade/downgrade for stat/resource/rollMode/custom (broken zeroed-accumulator path)", function () {
          for (const targetType of ["stat", "resource", "rollMode", "custom"]) {
            const allowed = CONFIG.CARLRPG.changeModesByTarget[targetType];
            assert.isArray(allowed, `expected a Mode allow-list for targetType "${targetType}"`);
            assert.sameMembers(allowed, ["add", "subtract", "multiply"], `targetType "${targetType}"`);
          }
        });

        it("only offers Add for advancementBonus (its own applyOneChange case ignores mode entirely - Subtract/Multiply are no-ops there too, a separate pre-existing gap)", function () {
          assert.sameMembers(CONFIG.CARLRPG.changeModesByTarget.advancementBonus, ["add"]);
        });

        it("keeps all six modes for skillRank (its 'current' is the real live rank, not a zeroed accumulator)", function () {
          assert.sameMembers(
            CONFIG.CARLRPG.changeModesByTarget.skillRank,
            ["add", "subtract", "multiply", "override", "upgrade", "downgrade"],
          );
        });

        it("has no entry for skillDamage or resistance, so their dropdown stays the full unfiltered list", function () {
          assert.notProperty(CONFIG.CARLRPG.changeModesByTarget, "skillDamage");
          assert.notProperty(CONFIG.CARLRPG.changeModesByTarget, "resistance");
        });
      });

      describe("changeModeChoices Handlebars helper (module/carl-rpg.mjs)", function () {
        const allModes = CONFIG.CARLRPG.changeModes;
        const byTarget = CONFIG.CARLRPG.changeModesByTarget;
        const helper = Handlebars.helpers.changeModeChoices;

        it("narrows a gear/feature/skill/spell item's 'stat' change to add/subtract/multiply", function () {
          const result = helper(allModes, byTarget, "stat", "item");
          assert.sameMembers(Object.keys(result), ["add", "subtract", "multiply"]);
        });

        it("keeps the full six-option list for a Class or Race item's own 'stat' change (bakes into the real base - see race-class-grants.mjs)", function () {
          assert.sameMembers(Object.keys(helper(allModes, byTarget, "stat", "class")), Object.keys(allModes));
          assert.sameMembers(Object.keys(helper(allModes, byTarget, "stat", "race")), Object.keys(allModes));
        });

        it("does NOT extend that Class/Race exception to 'resource' changes (only 'stat'/'skillRank' are ever baked)", function () {
          const result = helper(allModes, byTarget, "resource", "race");
          assert.sameMembers(Object.keys(result), ["add", "subtract", "multiply"]);
        });
      });
    },
    { displayName: "CarlRPG: modifiers.mjs (aggregation engine)" },
  );
}
