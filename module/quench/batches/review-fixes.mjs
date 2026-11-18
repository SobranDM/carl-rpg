/**
 * Dice and rules engine fixes from the 2026-11-18 review:
 *  - damage multipliers: Powerful Strike scales only the base damage dice
 *    (p.180); a "x2 the total damage" one (Choke Out, Smush) scales every
 *    type and the Amazing Success +Floor;
 *  - a ticked conditional damage term keeps its kind: a Rank damage die
 *    (Skullcracker Rank 10, p.180) and Critical Hit doubling of base dice
 *    (p.79);
 *  - an untrained (Rank 0) use marks for Advancement only on the Tutorial
 *    Floors (p.58);
 *  - a Check that isn't an Action leaves Queasy alone (Table 11, p.96);
 *  - a "+N Skill" gear bonus unlocks Upgrade tiers only while worn.
 */
import CarlDice from "../../dice/dice.mjs";
import { rowOutcome } from "../../helpers/attack-targets.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { assignItemToSlot, clearSlot } from "../../helpers/equip-slots.mjs";
import { attackIsArmorPiercing, effectiveRank, slugifySkillName } from "../../helpers/modifiers.mjs";
import { getRankDamageDie } from "../../helpers/rules.mjs";
import {
  createTestCharacter, createTestItem, createTestMob, deleteTestActor, deleteTestCombat, settle,
  PIN_D20_MID, useQuenchTimeout, withFakeTargets, withPinnedDice, withSetting,
} from "../helpers.mjs";

/** STR 10: Mod 4 (statModTable). */
const STR_MOD_4 = { system: { stats: { str: { value: 10 } } } };

/** A Pugilism-like Attack Skill: 1d6 + STR Bludgeoning, no weapon needed. */
function fists(actor, name) {
  return createTestItem(actor, "skill", name, {
    name,
    system: {
      category: "attack", isHandToHand: true, rank: 1, governingStat: "str",
      baseDamage: { dice: "1d6", stat: "str", damageType: "bludgeoning" },
    },
  });
}

/** The randomUniform value that rolls every die at its highest face (a natural 20). */
async function unitForMax() {
  for (const unit of [0.0001, 0.9999]) {
    const roll = await withPinnedDice(unit, () => new Roll("1d20").evaluate());
    if (roll.total === 20) return unit;
  }
  throw new Error("couldn't pin a d20 to 20");
}

/** The Attack card's damage, by type. */
const damageOf = (message) => message.getFlag("carl-rpg", "damageByType") ?? {};

/** The ids of the actor's conditional modifiers from one item. */
const conditionalIdsFrom = (actor, item) => (actor.system.conditionalModifiers ?? [])
  .filter((cm) => cm.sourceItemId === item.id).map((cm) => cm.id);

/** Roll options as the dialog would return them. */
const preset = (overrides = {}) => ({
  advantage: "normal", difficulty: null, modifier: 0, checked: new Set(), manaCostChoice: 0, checkedDebuffs: null, ...overrides,
});

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.review-fixes",
    (context) => {
      const { describe, it, assert } = context;

      describe("damage multipliers", function () {
        useQuenchTimeout(this);

        it("Powerful Strike multiplies the base damage dice only: d6 3 x Rank 5 + STR 4 = 19, not 35 (p.180)", async function () {
          const actor = await createTestCharacter("powerful strike", STR_MOD_4);
          let message;
          try {
            const skill = await fists(actor, "Pugilism QA");
            const name = "Powerful Strike QA";
            const de = await createTestItem(actor, "damageEffect", name, {
              name,
              system: {
                rank: 5, parentSkills: [skill.name],
                // As packs-source/skills-and-spells/powerful-strike.json.
                changes: [{ targetType: "skillDamage", target: name, mode: "multiply", value: "@rank", damageDiceKind: "base" }],
              },
            });
            await settle();
            assert.equal(actor.system.stats.str.mod, 4, "sanity: STR Mod 4");
            message = await withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([], () => CarlDice.rollAttack(actor, skill, { skipDialog: true, damageEffectItem: de })));
            assert.equal(damageOf(message).bludgeoning, 19);
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });

        it("a 'x2 the total damage' box doubles every damage type and the Amazing Success +Floor", async function () {
          const actor = await createTestCharacter("total x2", STR_MOD_4);
          let message;
          try {
            const skill = await fists(actor, "Wrasslin QA");
            const name = "Choke Out QA";
            const de = await createTestItem(actor, "damageEffect", name, {
              name,
              system: {
                rank: 1, parentSkills: [skill.name],
                changes: [
                  { targetType: "skillDamage", target: name, mode: "add", value: "1d4", damageDiceKind: "base", damageType: "fire" },
                  { targetType: "skillDamage", target: name, mode: "multiply", value: "2", damageDiceKind: "multiplier",
                    conditions: [{ label: "Target at 10% Health Bar or less?" }] },
                ],
              },
            });
            await settle();
            const checked = new Set(conditionalIdsFrom(actor, de));
            assert.lengthOf([...checked], 1, "sanity: the box");
            // d20 10 + Rank 1 + STR 4 = 15 vs. 1: an Amazing Success, at no one.
            message = await withSetting("currentFloor", 2, () => withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([], () => CarlDice.rollAttack(actor, skill, {
                presetOptions: preset({ difficulty: 1, checked, damageEffectId: de.id }),
              }))));
            const damage = damageOf(message);
            assert.equal(damage.bludgeoning, (3 + 4) * 2, "d6 3 + STR 4, x2");
            assert.equal(damage.fire, 2 * 2, "the Damage Effect's own d4 2 (Fire), x2");
            assert.equal(damage[""], 2 * 2, "Floor 2, x2");
            assert.equal(message.getFlag("carl-rpg", "attackDice").damageFactor, 2);
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });

        it("a target row's Amazing Success +Floor takes the Attack's total multiplier", function () {
          const row = { hit: true, amazing: true, zone: "full", damageFactor: 2 };
          assert.equal(rowOutcome(row, { damageByType: { fire: 4 }, isArea: false, floor: 3 }).damage[""], 6);
          assert.equal(rowOutcome({ ...row, damageFactor: undefined }, { damageByType: {}, isArea: false, floor: 3 }).damage[""], 3);
        });
      });

      describe("ticked conditional damage terms", function () {
        useQuenchTimeout(this);

        /** A Skullcracker-like Damage Effect at Rank 10, both boxes ticked. */
        async function skullcracker(actor, unit) {
          const skill = createTestItem(actor, "skill", "Noggin QA", {
            name: "Noggin QA",
            system: { category: "attack", isHandToHand: true, rank: 1, governingStat: "", baseDamage: { dice: "1d6", damageType: "bludgeoning" } },
          });
          const skillItem = await skill;
          const name = "Skullcracker QA";
          const sameSize = () => [{ label: "Target the same size as you?" }];
          const de = await createTestItem(actor, "damageEffect", name, {
            name,
            system: {
              rank: 10, parentSkills: [skillItem.name],
              changes: [{ targetType: "skillDamage", target: name, mode: "add", value: "1d4", damageDiceKind: "base", conditions: sameSize() }],
              upgrades: [{ rankThreshold: 10, changes: [
                { targetType: "skillDamage", target: name, mode: "add", value: "", damageDiceKind: "rankDie", conditions: sameSize() },
              ] }],
            },
          });
          await settle();
          const checked = new Set(conditionalIdsFrom(actor, de));
          assert.lengthOf([...checked], 2, "sanity: both boxes");
          return withPinnedDice(unit, () => withFakeTargets([], () => CarlDice.rollAttack(actor, skillItem, {
            presetOptions: preset({ checked, damageEffectId: de.id }),
          })));
        }

        it("Skullcracker Rank 10's 'add 1 Rank damage die' box adds its die (p.180)", async function () {
          const actor = await createTestCharacter("skullcracker");
          let message;
          try {
            message = await skullcracker(actor, PIN_D20_MID);
            const die = getRankDamageDie(10);
            assert.equal(die, "1d10", "sanity: Table 37");
            // d6 3 + the box's d4 2 + the Rank die's d10 5.
            assert.equal(damageOf(message).bludgeoning, 3 + 2 + 5);
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });

        it("a Critical Hit doubles a ticked base die, not the Rank die (p.79)", async function () {
          const actor = await createTestCharacter("skullcracker crit");
          let message;
          try {
            message = await skullcracker(actor, await unitForMax());
            assert.equal(message.getFlag("carl-rpg", "aiReroll")?.natural ?? 20, 20, "sanity: a natural 20");
            const formula = message.rolls.slice(1).map((r) => r.formula).join(" ");
            assert.include(formula, "2d4", "the ticked base d4 doubled");
            assert.include(formula, "1d10", "the Rank die not doubled");
            // 2d6 12 + 2d4 8 + 1d10 10.
            assert.equal(damageOf(message).bludgeoning, 12 + 8 + 10);
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });
      });

      describe("untrained use and Advancement (p.58)", function () {
        useQuenchTimeout(this);

        it("a Rank 0 Skill used on Floor 3 isn't marked; on Floor 1 it is", async function () {
          const actor = await createTestCharacter("untrained");
          const made = [];
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", { system: { category: "utility", rank: 0 } });
            made.push(await withSetting("currentFloor", 3, () => CarlDice.rollSkillCheck(actor, skill, { skipDialog: true })));
            assert.isFalse(actor.items.get(skill.id).system.marked, "Floor 3: no new Skill this way");
            made.push(await withSetting("currentFloor", 1, () => CarlDice.rollSkillCheck(actor, skill, { skipDialog: true })));
            assert.isTrue(actor.items.get(skill.id).system.marked, "a Tutorial Floor");
          } finally {
            for (const m of made) await m?.delete();
            await deleteTestActor(actor);
          }
        });
      });

      describe("a Check that isn't an Action (Table 11, p.96)", function () {
        useQuenchTimeout(this);

        it("leaves Queasy in place and isn't made with its Disadvantage; a Check that is an Action ends it", async function () {
          const mob = await createTestMob("queasy-mob");
          const pc = await createTestCharacter("queasy-pc");
          const made = [];
          let combat;
          try {
            combat = await Combat.create({});
            await combat.createEmbeddedDocuments("Combatant", [mob, pc].map((a) => ({ actorId: a.id })));
            await combat.startCombat();
            const skill = await createTestItem(pc, "skill", "Climbing", { system: { category: "utility", rank: 1 } });
            await addConditionToActor(pc, "queasy");
            const queasy = () => pc.system.conditions.some((c) => c.key === "queasy");

            // In a fight, a Stat Check's "Uses an Action" box starts unticked.
            const stat = await CarlDice.rollStatCheck(pc, "str", { skipDialog: true });
            made.push(stat);
            assert.isTrue(queasy(), "not an Action: Queasy stays");
            assert.match(stat.rolls[0].formula, /^1d20/, "no Disadvantage");

            const check = await CarlDice.rollSkillCheck(pc, skill, { skipDialog: true });
            made.push(check);
            assert.match(check.rolls[0].formula, /^2d20kl/, "an Action: Queasy's Disadvantage");
            assert.isFalse(queasy(), "and ended");
          } finally {
            for (const m of made) await m?.delete();
            await deleteTestCombat(combat);
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });
      });

      describe("a '+N Skill' gear bonus and Upgrade tiers", function () {
        useQuenchTimeout(this);

        it("Dagger Rank 4 + '+1 Dagger' gear unlocks Rank 5 (Armor-Piercing, +1d4) while worn, not after", async function () {
          const actor = await createTestCharacter("gear rank");
          try {
            const name = "Dagger QA";
            const dagger = await createTestItem(actor, "skill", name, {
              name,
              system: {
                category: "attack", rank: 4,
                baseDamage: { dice: "1d4", damageType: "piercing" },
                upgrades: [{ rankThreshold: 5, armorPiercing: true, changes: [
                  { targetType: "skillDamage", target: name, mode: "add", value: "1d4", damageDiceKind: "base" },
                ] }],
              },
            });
            const charm = await createTestItem(actor, "item", "Dagger charm", {
              system: { slots: ["head"], changes: [{ targetType: "skillRank", target: name, mode: "add", value: "1" }] },
            });
            const entry = () => actor.system.skills[slugifySkillName(name)];
            assert.isFalse(attackIsArmorPiercing(actor, dagger), "Rank 4");

            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, charm);
            assert.equal(entry().rank, 5);
            assert.equal(effectiveRank(dagger), 5);
            assert.isTrue(attackIsArmorPiercing(actor, dagger), "Rank 5 with the charm worn");
            assert.lengthOf(entry().damage.baseDice, 2, "the Rank 5 tier's +1d4 too");
            assert.equal(dagger.system.rank, 4, "the Skill's own Rank - what Advancement reads - is unchanged");

            await clearSlot(actor, { slotType: "gear", slotKey: "head" });
            assert.equal(entry().rank, 4);
            assert.isFalse(attackIsArmorPiercing(actor, dagger), "taken off: Rank 4 again");
            assert.lengthOf(entry().damage.baseDice, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: Review fixes (damage multipliers, conditional dice, untrained use, non-Action Checks, gear Rank)" },
  );
}
