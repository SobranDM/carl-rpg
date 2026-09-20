import CarlDice from "../../dice/dice.mjs";
import { createTestCharacter, createTestMob, createTestItem, deleteTestActor, settle, withFakeTargets, withPinnedDice, PIN_D20_MID, withSetting, useQuenchTimeout } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.dice-integration",
    (context) => {
      const { describe, it, assert } = context;

      describe("rollAttack: Amazing Success (p.79)", function () {
        useQuenchTimeout(this);

        it("adds untyped damage equal to the current Floor Number on an Amazing Success", async function () {
          const actor = await createTestCharacter();
          const target = await createTestMob("target", { system: { stats: { dex: { value: 3 } } } }); // dex mod 2
          try {
            const skill = await createTestItem(actor, "skill", "Attack Skill", {
              name: "Attack Skill",
              system: { category: "attack", rank: 15, governingStat: "" },
            });
            await settle();
            // Pinned to floor 1 regardless of the GM's real world state, so the
            // margin math below (and the asserted +1 bonus) stays deterministic.
            // total = pinned d20 (10) + rank (15) = 25; difficulty = 10 + dexMod(2) + floor(1) = 13; margin 12 -> amazingSuccess.
            const message = await withSetting("currentFloor", 1, () =>
              withPinnedDice(PIN_D20_MID, () =>
                withFakeTargets([{ actor: target }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true })),
              ),
            );
            assert.exists(message);
            const damageByType = message.getFlag("carl-rpg", "damageByType");
            assert.equal(damageByType[""], 1, "the skill has no base damage of its own, so only the +Floor bonus should appear");
            // Not covered here: a GM's dialog-entered Difficulty override
            // surviving onto this same flag (the A3 regression fix) - that
            // needs simulating promptRollOptions' own dialog resolution, which
            // isn't practical to script through Quench; left as a manual-QA
            // gap (see the plan's Category-A verification notes).
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(target);
          }
        });
      });

      describe("rollAdvancementCheck: at-cap short-circuit", function () {
        useQuenchTimeout(this);

        it("does not roll, does not change Rank, and reports 'at cap' once Rank meets its cap", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Capped Skill", { name: "Capped Skill", system: { rank: 15 } }); // default rankCap 15
            const result = await actor.rollAdvancementCheck(skill.id, { silent: true });
            assert.isFalse(result.success);
            assert.isNull(result.roll);
            assert.equal(result.newRank, 15);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an advancementBonus grant participates in the roll and can turn a failure into a success", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Almost Capped", { name: "Almost Capped", system: { rank: 14 } });
            await createTestItem(actor, "race", "race", {
              system: { changes: [{ targetType: "advancementBonus", target: "Almost Capped", mode: "add", value: "10" }] },
            });
            await settle();
            // Pinned d20 (10) alone is below currentRank (14) - would fail
            // without the +10 bonus; 10+10=20 >= 14 succeeds. newRank lands
            // exactly at the cap (14+1=15), the boundary the clamp exists for.
            const result = await withPinnedDice(PIN_D20_MID, () => actor.rollAdvancementCheck(skill.id, { silent: true }));
            assert.isTrue(result.success);
            assert.equal(result.newRank, 15);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("rollSkillCheck: untrained gating", function () {
        useQuenchTimeout(this);

        it("blocks an untrained (Rank 0) Spell from being Checked at all", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "spell", { system: { rank: 0 } });
            const result = await CarlDice.rollSkillCheck(actor, spell, { skipDialog: true });
            assert.isNull(result);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("still allows an untrained (Rank 0) non-Spell Skill to roll", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "skill", { system: { rank: 0 } });
            const result = await CarlDice.rollSkillCheck(actor, skill, { skipDialog: true });
            assert.exists(result);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("blocks a Passive Skill from being Checked regardless of Rank", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "skill", { system: { isPassive: true, rank: 5 } });
            const result = await CarlDice.rollSkillCheck(actor, skill, { skipDialog: true });
            assert.isNull(result);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("rollHeal", function () {
        useQuenchTimeout(this);

        it("a healToFull tier skips dice and sets flags.healFull", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Heal Self", {
              system: { rank: 15, castingKeywords: ["heal"], upgrades: [{ rankThreshold: 15, healToFull: true }] },
            });
            const message = await CarlDice.rollHeal(actor, spell);
            assert.isTrue(message.getFlag("carl-rpg", "healFull"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a dice tier rolls healDice and sets flags.healAmount", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Heal Self", {
              system: { rank: 5, castingKeywords: ["heal"], upgrades: [{ rankThreshold: 5, healDice: "1d6" }] },
            });
            const message = await CarlDice.rollHeal(actor, spell);
            assert.isNumber(message.getFlag("carl-rpg", "healAmount"));
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("rollToggleSpell", function () {
        useQuenchTimeout(this);

        it("blocks turning on an untrained (Rank 0) toggle Spell", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "spell", { system: { isToggled: true, active: false, rank: 0 } });
            const result = await CarlDice.rollToggleSpell(actor, spell);
            assert.isNull(result);
            assert.isFalse(spell.system.active);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("turning on a shield-granting toggle Spell fills shield.value to its effective max", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Shield", { system: { isToggled: true, active: false, rank: 5, shieldSlots: 4 } });
            await CarlDice.rollToggleSpell(actor, spell);
            await settle();
            assert.equal(actor.system.shield.value, 4);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("rollEvadeCheck / rollOpposedSkillCheck: post:false raw shape", function () {
        useQuenchTimeout(this);

        it("rollEvadeCheck returns raw roll data instead of posting a ChatMessage", async function () {
          const actor = await createTestCharacter();
          try {
            const result = await CarlDice.rollEvadeCheck(actor, { difficulty: 10, skipDialog: true, post: false });
            assert.containsAllKeys(result, ["roll", "total", "breakdown", "naturalRoll", "degree"]);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("rollOpposedSkillCheck returns raw roll data instead of posting a ChatMessage", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Taunt", { system: { rank: 5 } });
            const result = await CarlDice.rollOpposedSkillCheck(actor, skill, { difficulty: 10, skipDialog: true, post: false });
            assert.containsAllKeys(result, ["roll", "total", "breakdown", "naturalRoll", "degree"]);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: dice.mjs (full roll flows)" },
  );
}
