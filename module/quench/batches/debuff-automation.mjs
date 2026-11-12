import CarlDice from "../../dice/dice.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { processActorRoundEnd, processCombatEnd } from "../../helpers/round-end.mjs";
import {
  createTestCharacter, createTestMob, createTestItem, createTestCombat, deleteTestActor, deleteTestCombat,
  settle, waitFor, withFakeTargets, withPinnedDice, PIN_D20_MID, withSetting, useQuenchTimeout,
} from "../helpers.mjs";

const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);
const condition = (actor, key) => actor.system.conditions.find((c) => c.key === key);

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.debuff-automation",
    (context) => {
      const { describe, it, assert } = context;

      describe("Mob Difficulties (p.96)", function () {
        useQuenchTimeout(this);

        it("a Mob's Minor Injury lowers its sheet Evade by 2", async function () {
          const mob = await createTestMob("mob", { system: { stats: { dex: { value: 3 } } } }); // dex mod 2
          try {
            assert.equal(mob.system.evadeBase, 12);
            await addConditionToActor(mob, "minorInjury");
            assert.equal(mob.system.evadeBase, 10);
            assert.equal(mob.system.evadeDebuffDelta, -2);
          } finally {
            await deleteTestActor(mob);
          }
        });

        it("rollAttack vs. a Shit-Faced Mob rolls against Evade - 5", async function () {
          const actor = await createTestCharacter();
          const mob = await createTestMob("target", { system: { stats: { dex: { value: 3 } } } });
          try {
            const skill = await createTestItem(actor, "skill", "Attack Skill", {
              name: "Attack Skill", system: { category: "attack", rank: 1, governingStat: "" },
            });
            await addConditionToActor(mob, "shitFaced");
            await settle();
            // base = 10 + dexMod(2) + floor(1) = 13; Shit-Faced -> 8.
            const message = await withSetting("currentFloor", 1, () =>
              withPinnedDice(PIN_D20_MID, () =>
                withFakeTargets([{ actor: mob }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }))));
            assert.equal(message.getFlag("carl-rpg", "targetDifficulty"), 8);
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });

        it("rollAttack consumes a target Mob's Stunned", async function () {
          const actor = await createTestCharacter();
          const mob = await createTestMob("target");
          try {
            const skill = await createTestItem(actor, "skill", "Attack Skill", {
              name: "Attack Skill", system: { category: "attack", rank: 1, governingStat: "" },
            });
            await addConditionToActor(mob, "stunned");
            await settle();
            await withFakeTargets([{ actor: mob }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }));
            assert.notInclude(keys(mob), "stunned");
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });
      });

      describe("Crawler rolls", function () {
        useQuenchTimeout(this);

        it("Minor Injury takes 2 off a crawler's Evade total", async function () {
          const actor = await createTestCharacter();
          try {
            const clean = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollEvadeCheck(actor, { difficulty: 10, skipDialog: true, post: false }));
            await addConditionToActor(actor, "minorInjury");
            const hurt = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollEvadeCheck(actor, { difficulty: 10, skipDialog: true, post: false }));
            assert.equal(hurt.total, clean.total - 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Stat Checks apply Debuffs too (Minor Injury -2)", async function () {
          const actor = await createTestCharacter();
          try {
            const clean = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollStatCheck(actor, "str", { skipDialog: true }));
            await addConditionToActor(actor, "minorInjury");
            const hurt = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollStatCheck(actor, "str", { skipDialog: true }));
            assert.equal(hurt.rolls[0].total, clean.rolls[0].total - 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("any Action ends Staggered, not just an Attack", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "staggered");
            await CarlDice.rollStatCheck(actor, "str", { skipDialog: true });
            assert.notInclude(keys(actor), "staggered");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a free Evade neither applies nor ends Queasy; a real Evade does both", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "queasy");
            const free = await CarlDice.rollEvadeCheck(actor, { difficulty: 10, skipDialog: true, post: false, isAction: false });
            assert.equal(free.debuffNote, "");
            assert.include(keys(actor), "queasy");
            const real = await CarlDice.rollEvadeCheck(actor, { difficulty: 10, skipDialog: true, post: false });
            assert.isNotEmpty(real.debuffNote);
            assert.notInclude(keys(actor), "queasy");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Paralyzed blocks the roll outright", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "paralyzed");
            assert.isNull(await CarlDice.rollEvadeCheck(actor, { difficulty: 10, skipDialog: true, post: false }));
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Mob Attacks (CarlDice.rollMobAttack)", function () {
        useQuenchTimeout(this);

        const bite = { name: "Bite", toHit: "16+F", damage: "1d4", damageType: "piercing", range: "", effect: "" };

        it("a Terrified Mob's Attack is 5 easier to Evade and grants a free Evade", async function () {
          const mob = await createTestMob("attacker", { system: { attacks: [bite] } });
          const pc = await createTestCharacter("defender");
          try {
            await addConditionToActor(mob, "terrified");
            const message = await withSetting("currentFloor", 1, () =>
              withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true })));
            assert.equal(message.getFlag("carl-rpg", "targetDifficulty"), 12);
            assert.isTrue(message.getFlag("carl-rpg", "freeEvade"));
            assert.isNotEmpty(message.getFlag("carl-rpg", "damageByType"));
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });

        it("a blank damage type counts as physical, so a Shield can absorb it", async function () {
          const claw = { ...bite, name: "Claw", damageType: "" };
          const mob = await createTestMob("attacker", { system: { attacks: [claw] } });
          const pc = await createTestCharacter("defender");
          try {
            const message = await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            assert.isFalse(message.getFlag("carl-rpg", "damageIsMagic"));
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });

        it("with nothing targeted, the Mob's one-shot Debuffs aren't spent", async function () {
          const mob = await createTestMob("attacker", { system: { attacks: [bite] } });
          try {
            await addConditionToActor(mob, "stunned");
            await withFakeTargets([], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            assert.include(keys(mob), "stunned");
          } finally {
            await deleteTestActor(mob);
          }
        });

        it("each defender's row gets its own Difficulty and free Evade", async function () {
          const mob = await createTestMob("attacker", { system: { attacks: [bite] } });
          const pcA = await createTestCharacter("defenderA");
          const pcB = await createTestCharacter("defenderB");
          try {
            await addConditionToActor(mob, "terrified");
            await addConditionToActor(pcB, "held");
            const message = await withSetting("currentFloor", 1, () =>
              withFakeTargets([{ actor: pcA }, { actor: pcB }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true })));
            const rows = message.getFlag("carl-rpg", "targetRows");
            assert.equal(rows.t0.difficulty, 12, "Terrified: 17 - 5");
            assert.isTrue(rows.t0.freeEvade);
            assert.equal(rows.t1.difficulty, 17, "Held cancels the Disadvantage for B only");
            assert.isFalse(rows.t1.freeEvade);
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(pcA);
            await deleteTestActor(pcB);
          }
        });

        it("a Held defender's Advantage cancels the Mob's Disadvantage", async function () {
          const mob = await createTestMob("attacker", { system: { attacks: [bite] } });
          const pc = await createTestCharacter("defender");
          try {
            await addConditionToActor(mob, "terrified");
            await addConditionToActor(pc, "held");
            const message = await withSetting("currentFloor", 1, () =>
              withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true })));
            assert.equal(message.getFlag("carl-rpg", "targetDifficulty"), 17);
            assert.notExists(message.getFlag("carl-rpg", "freeEvade"));
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });
      });

      describe("conditions.mjs additions", function () {
        useQuenchTimeout(this);

        it("Sepsis also applies Staggered", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "sepsis");
            assert.includeMembers(keys(actor), ["sepsis", "staggered"]);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("healing at least 1 HB slot ends Dying", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.hb.value": 1 });
            await addConditionToActor(actor, "dying");
            await actor.update({ "system.hb.value": 2 });
            assert.notInclude(keys(actor), "dying");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Dying starts its countdown at the CON Mod", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "dying");
            const dying = actor.system.conditions.find((c) => c.key === "dying");
            assert.equal(dying.remaining, Math.max(0, actor.system.stats.con.mod));
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("End of round / end of combat (round-end.mjs)", function () {
        useQuenchTimeout(this);

        it("'until the end of the next round' lasts two round ends", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "blinded");
            await processActorRoundEnd(actor);
            assert.include(keys(actor), "blinded");
            await processActorRoundEnd(actor);
            assert.notInclude(keys(actor), "blinded");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Dying countdown at 0 announces death exactly once", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "dying");
            const conditions = foundry.utils.deepClone(actor.system.conditions);
            conditions.find((c) => c.key === "dying").remaining = 0;
            await actor.update({ "system.conditions": conditions });
            const dead = game.i18n.format("CARLRPG.RoundEnd.DyingDead", { name: foundry.utils.escapeHTML(actor.name) });
            assert.include((await processActorRoundEnd(actor)).lines, dead);
            assert.notInclude((await processActorRoundEnd(actor)).lines, dead);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Dying creature's damage Debuff ticks the countdown without rolling damage", async function () {
          const actor = await createTestCharacter();
          try {
            await addConditionToActor(actor, "dying");
            const conditions = foundry.utils.deepClone(actor.system.conditions);
            conditions.find((c) => c.key === "dying").remaining = 3;
            await actor.update({ "system.conditions": conditions });
            await addConditionToActor(actor, "poisoned");
            const result = await processActorRoundEnd(actor);
            assert.lengthOf(result.rolls, 0);
            assert.equal(condition(actor, "dying").remaining, 1, "1 for the Poison, 1 for the round");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Poisoned damage bypasses DR, and the slot it costs ends Terrified", async function () {
          // CON 10 -> mod 4 per HB slot; Poisoned (1d8 + Floor) pinned to >= 5.
          const mob = await createTestMob("poisoned", {
            system: { level: 3, dr: 100, hb: { value: 3 }, stats: { con: { value: 10 } } },
          });
          try {
            await addConditionToActor(mob, "poisoned");
            await addConditionToActor(mob, "terrified");
            await withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () => processActorRoundEnd(mob)));
            assert.isBelow(mob.system.hb.value, 3);
            assert.notInclude(keys(mob), "terrified");
            assert.include(keys(mob), "poisoned");
          } finally {
            await deleteTestActor(mob);
          }
        });

        it("CarlRPGCombat ticks durations when a real round ends (Combat#_onEndRound)", async function () {
          const actor = await createTestCharacter();
          let combat;
          try {
            await addConditionToActor(actor, "blinded");
            ({ combat } = await createTestCombat(actor));
            await combat.startCombat();
            assert.equal(actor.system.conditions.find((c) => c.key === "blinded").remaining, 2, "starting combat ends no round");
            await combat.nextRound();
            await waitFor(() => actor.system.conditions.find((c) => c.key === "blinded")?.remaining === 1, {
              message: "Blinded never ticked down after nextRound()",
            });
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("ending a combat clears 'until the end of combat' Debuffs", async function () {
          const actor = await createTestCharacter();
          let combat;
          try {
            await addConditionToActor(actor, "burned");
            await addConditionToActor(actor, "minorInjury");
            ({ combat } = await createTestCombat(actor));
            await processCombatEnd(combat);
            assert.notInclude(keys(actor), "burned");
            assert.include(keys(actor), "minorInjury");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: Debuff automation (rolls, Mob Attacks, round end)" },
  );
}
