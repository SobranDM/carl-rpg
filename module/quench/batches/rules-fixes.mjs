import CarlDice, { applyFavoredClassSurcharge, doubleDiceCount } from "../../dice/dice.mjs";
import { conditionsAfterRest } from "../../helpers/rest.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { applyGrindHours, isGrindTarget } from "../../helpers/grinding.mjs";
import { grindSurplusTargets, postGrindSurplusCard } from "../../chat/grind-surplus-card.mjs";
import {
  createTestCharacter, createTestMob, createTestItem, deleteTestActor, settle, withSetting, withPinnedDice, useQuenchTimeout,
} from "../helpers.mjs";

const keys = (conditions) => conditions.map((c) => c.key);

/** The randomUniform value that lands a d20 on a natural 1 (Foundry's face mapping isn't assumed). */
async function unitForNatOne() {
  for (const unit of [0.0001, 0.9999]) {
    const roll = await withPinnedDice(unit, () => new Roll("1d20").evaluate());
    if (roll.total === 1) return unit;
  }
  throw new Error("couldn't pin a d20 to 1");
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.rules-fixes",
    (context) => {
      const { describe, it, assert } = context;

      describe("Rests end injuries by length (p.94/96)", function () {
        const all = ["minorInjury", "majorInjury", "longTermMinorInjury", "longTermMajorInjury", "fatigued", "poisoned"]
          .map((key, i) => ({ id: `c${i}`, key }));

        it("a short rest ends Minor Injury only", function () {
          assert.sameMembers(keys(conditionsAfterRest(all, "short")),
            ["majorInjury", "longTermMinorInjury", "longTermMajorInjury", "fatigued", "poisoned"]);
        });
        it("a long rest also ends Major, Long-Term Minor and Fatigued", function () {
          assert.sameMembers(keys(conditionsAfterRest(all, "long")), ["longTermMajorInjury", "poisoned"]);
        });
        it("a full day's rest also ends Long-Term Major", function () {
          assert.sameMembers(keys(conditionsAfterRest(all, "fullDay")), ["poisoned"]);
        });
      });

      describe("Favored-Class Mana surcharge (p.201)", function () {
        const spell = { system: { favoredClasses: ["Mage"] } };
        const caster = (classItem) => ({ system: { classItem } });

        it("a Class whose category is favored pays the base cost", function () {
          const mage = { name: "Boring Ol' Mage", system: { classTypes: ["Mage"] } };
          assert.equal(applyFavoredClassSurcharge(spell, caster(mage), 3), 3);
        });
        it("any other Class pays +1", function () {
          const fighter = { name: "Brawler", system: { classTypes: ["Fighter"] } };
          assert.equal(applyFavoredClassSurcharge(spell, caster(fighter), 3), 4);
        });
        it("a caster with no Class yet pays no surcharge", function () {
          assert.equal(applyFavoredClassSurcharge(spell, caster(null), 3), 3);
        });
      });

      describe("Critical Hit dice (p.79/p.92)", function () {
        it("doubles the dice count, not the result", function () {
          assert.equal(doubleDiceCount("1d10"), "2d10");
          assert.equal(doubleDiceCount("3d6 + 2"), "6d6 + 2");
          assert.equal(doubleDiceCount("d8"), "2d8");
          assert.equal(doubleDiceCount("1d4 + @floor"), "2d4 + @floor");
          assert.equal(doubleDiceCount("(@rank)d6"), "(2*(@rank))d6");
          assert.equal(doubleDiceCount("(1+1)d8 + 2d6"), "(2*(1+1))d8 + 4d6");
        });
      });

      describe("Spells", function () {
        useQuenchTimeout(this);

        it("a Rank 0 Attack Spell can't be cast", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Zap", { system: { rank: 0, castingKeywords: ["attack"] } });
            assert.isNull(await CarlDice.rollAttack(actor, spell, { skipDialog: true }));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Rank 0 Spell can't be used for an Opposed Check either", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Mind Spike", { system: { rank: 0 } });
            assert.isNull(await CarlDice.rollOpposedSkillCheck(actor, spell, { difficulty: 10, skipDialog: true, post: false }));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Rank 0 Heal Spell can't be cast", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Heal", { system: { rank: 0, castingKeywords: ["heal", "passive"] } });
            assert.isNull(await CarlDice.rollHeal(actor, spell));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("casting a Passive Spell doesn't mark it for Advancement (p.202)", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Heal", {
              system: { rank: 1, healDice: "1d4", castingKeywords: ["heal", "passive"] },
            });
            await CarlDice.rollHeal(actor, spell);
            assert.isFalse(spell.system.marked);
            assert.isFalse(CarlDice.isAdvancedByUse(spell));
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Combat details", function () {
        useQuenchTimeout(this);

        it("a natural 1 misses even with no Difficulty set (p.92)", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Attack Skill", {
              name: "Attack Skill", system: { category: "attack", rank: 5, governingStat: "", baseDamage: { dice: "1d6" } },
            });
            const unit = await unitForNatOne();
            const message = await withPinnedDice(unit, () => CarlDice.rollAttack(actor, skill, { skipDialog: true }));
            assert.notExists(message.getFlag("carl-rpg", "damageByType"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an Evade bonus raises the static Evade a Mob is attacked against", async function () {
          const mob = await createTestMob("dodger", { system: { stats: { dex: { value: 3 } } } }); // dex mod 2
          try {
            assert.equal(mob.system.evadeBase, 12);
            await mob.createEmbeddedDocuments("Item", [{
              name: "Dodgy Boots", type: "item",
              system: { equipped: true, changes: [{ targetType: "rollMode", target: "evadeBonus", mode: "add", value: "2" }] },
            }]);
            await settle();
            assert.equal(mob.system.evadeBase, 14);
          } finally {
            await deleteTestActor(mob);
          }
        });

        it("healing ends Sepsis (its damage 'continues until you're healed')", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.hb.value": 3 });
            await addConditionToActor(actor, "sepsis");
            await actor.update({ "system.hb.value": 4 });
            assert.notInclude(keys(actor.system.conditions), "sepsis");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Grinding (p.170)", function () {
        useQuenchTimeout(this);

        it("hours below the Rank are stored, and the Skill can take more", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", { system: { category: "utility", rank: 5 } });
            assert.isTrue(isGrindTarget(actor, skill));
            const result = await applyGrindHours(actor, skill, 3);
            assert.isFalse(result.rolled);
            assert.equal(skill.getFlag("carl-rpg", "grindHours"), 3);
            assert.isTrue(isGrindTarget(actor, skill));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("reaching the Rank rolls the check, resets the hours, and returns the surplus", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", { system: { category: "utility", rank: 3 } });
            const result = await applyGrindHours(actor, skill, 5);
            assert.isTrue(result.rolled);
            assert.equal(result.surplus, 2);
            assert.equal(skill.getFlag("carl-rpg", "grindHours"), 0);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Rank 0, capped and Passive-Spell Skills aren't grind targets", async function () {
          const actor = await createTestCharacter();
          try {
            const untrained = await createTestItem(actor, "skill", "Juggling", { system: { rank: 0 } });
            const capped = await createTestItem(actor, "skill", "Dancing", { system: { rank: 15 } });
            const passive = await createTestItem(actor, "spell", "Torch", { system: { rank: 2, castingKeywords: ["passive"] } });
            const fresh = await createTestItem(actor, "skill", "Cooking", { system: { rank: 2 } });
            assert.isFalse(isGrindTarget(actor, untrained));
            assert.isFalse(isGrindTarget(actor, capped));
            assert.isFalse(isGrindTarget(actor, passive));
            assert.isTrue(isGrindTarget(actor, fresh));
            assert.deepEqual(grindSurplusTargets(actor, fresh.id).map((i) => i.id), []);
            assert.deepEqual(grindSurplusTargets(actor, "someOtherSkill").map((i) => i.id), [fresh.id]);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the surplus card carries the actor's UUID and the hours", async function () {
          const actor = await createTestCharacter();
          let message;
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", { system: { rank: 3 } });
            message = await postGrindSurplusCard(actor, skill, 2);
            const flag = message.getFlag("carl-rpg", "grindSurplus");
            assert.equal(flag.actorUuid, actor.uuid);
            assert.equal(flag.hours, 2);
            assert.equal(flag.sourceItemId, skill.id);
            assert.include(message.content, `data-actor-uuid="${actor.uuid}"`);
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });

        it("the grinding check gets no end-of-floor bonus and keeps the Skill's use-mark", async function () {
          const actor = await createTestCharacter();
          try {
            // An exact name: the feature's advancementBonus targets the Skill by name.
            const skill = await createTestItem(actor, "skill", "Lockpicking", { name: "Lockpicking", system: { rank: 3, marked: true } });
            await createTestItem(actor, "feature", "Nimble Fingers", {
              system: { changes: [{ targetType: "advancementBonus", target: "Lockpicking", mode: "add", value: "1" }] },
            });
            await settle();
            const floorCheck = await CarlDice.rollAdvancementCheck(actor, skill, { apply: false, silent: true });
            assert.notEqual(floorCheck.roll.formula, "1d20", "sanity: the end-of-floor check carries the +1");
            const grindCheck = await CarlDice.rollAdvancementCheck(actor, skill, { silent: true, floorBonus: false, clearMark: false });
            assert.equal(grindCheck.roll.formula, "1d20");
            assert.isTrue(skill.system.marked);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the grinding Advancement Check applies Debuff penalties", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", { system: { rank: 3 } });
            await addConditionToActor(actor, "fatigued");
            const result = await withSetting("currentFloor", 1, () =>
              CarlDice.rollAdvancementCheck(actor, skill, { apply: false, silent: true, debuffs: true }));
            assert.include(result.roll.formula, "-1");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: rules fixes (rests, damage split, spells, grinding)" },
  );
}
