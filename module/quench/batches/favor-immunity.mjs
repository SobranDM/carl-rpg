import CarlDice from "../../dice/dice.mjs";
import { DAMAGE_TYPE_KEYS, findDamageType, findDamageTypes, normalizeDamageType } from "../../helpers/damage-types.mjs";
import { computeDamageApplication, isImmuneToAllDamage } from "../../helpers/damage-pipeline.mjs";
import { aiRerollFlags, keptD20, rerollFormula, rerollOpen } from "../../helpers/ai-favor.mjs";
import { canReroll, rerollMessage } from "../../chat/ai-favor-reroll.mjs";
import { applyRow } from "../../chat/attack-targets-card.mjs";
import {
  createTestCharacter, createTestMob, createTestItem, deleteTestActor,
  settle, withFakeTargets, withPinnedDice, PIN_D20_MID, withSetting, useQuenchTimeout,
} from "../helpers.mjs";

/** Chat messages created while `fn` runs (removed afterwards). */
async function capturingMessages(fn) {
  const before = new Set(game.messages.map((m) => m.id));
  const created = () => game.messages.filter((m) => !before.has(m.id));
  try {
    return await fn(created);
  } finally {
    const extra = created();
    if (extra.length) await ChatMessage.deleteDocuments(extra.map((m) => m.id));
  }
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.favor-immunity",
    (context) => {
      const { describe, it, assert } = context;

      describe("Damage types (Table 10, p.93)", function () {
        it("the system's types are exactly the book's 13", function () {
          assert.sameMembers(Object.keys(CONFIG.CARLRPG.damageTypes), DAMAGE_TYPE_KEYS);
          assert.lengthOf(DAMAGE_TYPE_KEYS, 13);
        });

        it("other spellings map onto the book's types; unknown words are untyped", function () {
          assert.equal(normalizeDamageType("Fire"), "fire");
          assert.equal(normalizeDamageType("cold"), "ice");
          assert.equal(normalizeDamageType("Radiant"), "holy");
          assert.equal(normalizeDamageType("Psionic"), "psychic");
          assert.equal(normalizeDamageType("lightning"), "electric");
          assert.equal(normalizeDamageType("emotional"), "");
          assert.equal(findDamageType("4d10+6 Psionic damage, 10ft range"), "psychic");
          assert.equal(findDamageType("3d10+5 Bludgeon-"), "bludgeoning");
          assert.deepEqual(findDamageTypes("Fire and Cold damage"), ["fire", "ice"]);
          assert.equal(findDamageType("No damage"), "");
        });

        it("a Resistance applies to another spelling of its type", function () {
          const target = { system: { dr: 0, resistances: { ice: "resist" }, hb: { slotValue: 1 } } };
          const result = computeDamageApplication({ cold: 10 }, target);
          assert.equal(result.totalFinalDamage, 5);
        });
      });

      describe("Immunity ignores the Debuffs that come with the damage (p.93)", function () {
        useQuenchTimeout(this);
        const immuneTo = (types) => ({ system: { resistancesEffective: Object.fromEntries(types.map((t) => [t, "immune"])) } });

        it("only when the target is Immune to every damage type the hit carries", function () {
          assert.isTrue(isImmuneToAllDamage({ fire: 8 }, immuneTo(["fire"])));
          assert.isTrue(isImmuneToAllDamage({ cold: 8 }, immuneTo(["ice"])), "another spelling");
          assert.isFalse(isImmuneToAllDamage({ fire: 8, force: 4 }, immuneTo(["fire"])), "Force still lands");
          assert.isTrue(isImmuneToAllDamage({ fire: 8, "": 2 }, immuneTo(["fire"])), "the untyped +Floor bonus doesn't count");
          assert.isFalse(isImmuneToAllDamage({ "": 6 }, immuneTo(["fire"])), "untyped damage alone isn't covered");
          assert.isFalse(isImmuneToAllDamage({}, immuneTo(["fire"])), "a hit with no damage isn't covered");
          assert.isFalse(isImmuneToAllDamage({ fire: 8 }, immuneTo([])));
        });

        it("an Attack row skips its Debuffs for an Immune target, and applies them otherwise", async function () {
          const immune = await createTestCharacter("immune", { system: { resistances: { fire: "immune" } } });
          const plain = await createTestCharacter("plain");
          let message;
          try {
            const rowFor = (id, actor) => ({
              id, uuid: actor.uuid, name: actor.name, isCharacter: true, zone: "full", difficulty: 13,
              hit: true, amazing: false, freeEvade: false, freeUsed: false, evade: null, applied: false, replaced: false,
            });
            message = await ChatMessage.create({
              content: '<div class="carl-chat-card"></div>',
              flags: { "carl-rpg": {
                isArea: false, floor: 1, damageIsMagic: true, damageByType: { fire: 1 },
                targetEffects: [{ id: "te1", debuffKey: "staggered", stacks: 1, label: "", sourceLabel: "Test" }],
                targetUuids: [immune.uuid, plain.uuid],
                targetRows: { t0: rowFor("t0", immune), t1: rowFor("t1", plain) },
              } },
            });
            const rows = () => message.getFlag("carl-rpg", "targetRows");
            const lines = await applyRow(message, rows().t0);
            await applyRow(message, rows().t1);
            await settle();
            const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);
            assert.notInclude(keys(immune), "staggered");
            assert.isTrue(lines.some((l) => l.includes(immune.name)), "the GM digest says why");
            assert.include(keys(plain), "staggered");
          } finally {
            await message?.delete();
            await deleteTestActor(immune);
            await deleteTestActor(plain);
          }
        });
      });

      describe("Opposed Spells cost Mana", function () {
        useQuenchTimeout(this);

        it("an opposed Spell Check spends the Spell's Mana", async function () {
          const actor = await createTestCharacter("caster", { system: { mana: { value: 10, max: 10 } } });
          try {
            const spell = await createTestItem(actor, "spell", "Charm", {
              name: "Charm", system: { rank: 2, manaCost: 3, governingStat: "cha" },
            });
            await capturingMessages(() => withPinnedDice(PIN_D20_MID, () =>
              CarlDice.rollOpposedSkillCheck(actor, spell, { difficulty: 12, skipDialog: true })));
            assert.equal(actor.system.mana.value, 7);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("AI Favor reroll (p.61)", function () {
        useQuenchTimeout(this);

        it("pure helpers: who gets one, the reroll formula, the kept die", function () {
          assert.deepEqual(aiRerollFlags({ type: "mob" }, { kind: "check", formula: "1d20", natural: 12, total: 15 }), {});
          const flags = aiRerollFlags({ type: "character", uuid: "Actor.x" }, { kind: "check", formula: "2d20kh", natural: 12, total: 15 });
          assert.equal(flags.aiReroll.formula, "2d20kh");
          assert.isFalse(flags.aiReroll.used);
          assert.equal(rerollFormula({ formula: "2d20kh", natural: 12, total: 15 }), "2d20kh + 3");
          assert.equal(rerollFormula({ formula: "1d20", natural: 12, total: 10 }), "1d20 - 2");
          assert.equal(rerollFormula({ formula: "1d20", natural: 12, total: 12 }), "1d20");
          assert.isFalse(rerollOpen({ natural: 1, used: false }), "never a Natural 1");
          assert.isFalse(rerollOpen({ natural: 12, used: true }), "once per Check");
          assert.isTrue(rerollOpen({ natural: 12, used: false }));
          assert.equal(keptD20("2d20kh", 4, 16), 16);
          assert.equal(keptD20("2d20kl", 4, 16), 4);
          assert.equal(keptD20("1d20", 4, 16), 4);
        });

        it("a Stat Check reroll spends 1 AI Favor, posts a new card and retires the old one", async function () {
          const actor = await createTestCharacter("favored", { system: { details: { aiFavor: 2 } } });
          try {
            await capturingMessages(async (created) => {
              const original = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollStatCheck(actor, "str", { skipDialog: true }));
              assert.exists(original.getFlag("carl-rpg", "aiReroll"));
              assert.isTrue(canReroll(original));

              assert.isTrue(await withPinnedDice(PIN_D20_MID, () => rerollMessage(original)));
              await settle();
              assert.equal(actor.system.details.aiFavor, 1);
              assert.isTrue(original.getFlag("carl-rpg", "aiRerolled"));
              assert.isFalse(canReroll(original));

              const reroll = created().find((m) => m.id !== original.id);
              assert.exists(reroll);
              assert.isTrue(reroll.getFlag("carl-rpg", "aiReroll").used);
              assert.isFalse(canReroll(reroll), "once per Check");
              assert.equal(reroll.rolls[0].total, original.rolls[0].total, "same d20 face, same modifiers");
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("no AI Favor, or a Mob, means no reroll", async function () {
          const broke = await createTestCharacter("broke");
          const mob = await createTestMob("mob");
          try {
            await capturingMessages(async () => {
              const message = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollStatCheck(broke, "str", { skipDialog: true }));
              assert.isFalse(canReroll(message), "0 AI Favor");
              assert.isFalse(await rerollMessage(message));
              const mobRoll = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollStatCheck(mob, "str", { skipDialog: true }));
              assert.notExists(mobRoll?.getFlag("carl-rpg", "aiReroll"));
            });
          } finally {
            await deleteTestActor(broke);
            await deleteTestActor(mob);
          }
        });

        it("an Attack reroll re-resolves its target rows; an acted-on Attack can't be rerolled", async function () {
          const actor = await createTestCharacter("attacker", { system: { details: { aiFavor: 2 } } });
          const target = await createTestMob("target", { system: { stats: { dex: { value: 3 } } } }); // Evade 13 at Floor 1
          try {
            const skill = await createTestItem(actor, "skill", "Punch", {
              name: "Punch", system: { category: "attack", rank: 3, governingStat: "", baseDamage: { dice: "1d6" } },
            });
            await capturingMessages(async (created) => {
              const roll = () => withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () =>
                withFakeTargets([{ actor: target }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }))));
              const original = await roll();
              assert.isTrue(canReroll(original));
              assert.isTrue(await withPinnedDice(PIN_D20_MID, () => rerollMessage(original)));
              await settle();
              const reroll = created().find((m) => m.id !== original.id && m.getFlag("carl-rpg", "aiReroll"));
              const rows = reroll.getFlag("carl-rpg", "targetRows");
              assert.isTrue(rows.t0.hit, "10 + 3 vs. 13");
              assert.equal(rows.t0.uuid, original.getFlag("carl-rpg", "targetRows").t0.uuid);
              assert.equal(actor.system.details.aiFavor, 1);

              // Once a row has been applied, the result is out - no reroll.
              const second = await roll();
              await second.update({ "flags.carl-rpg.targetRows.t0.applied": true });
              assert.isFalse(canReroll(second));
            });
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(target);
          }
        });
      });
    },
    { displayName: "CarlRPG: AI Favor, Immunity, damage types" },
  );
}
