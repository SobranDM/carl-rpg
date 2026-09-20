import { createTestCharacter, createTestMob, createTestItem, deleteTestActor, useQuenchTimeout } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.data-models",
    (context) => {
      const { describe, it, assert } = context;

      describe("actor-base.mjs defaults (shared by Character and Mob)", function () {
        useQuenchTimeout(this);

        it("Character: hb/shield/mana/dr defaults", async function () {
          const actor = await createTestCharacter();
          try {
            assert.equal(actor.system.hb.max, 10);
            assert.equal(actor.system.hb.value, 10);
            assert.equal(actor.system.shield.value, 0);
            assert.equal(actor.system.shield.effectiveMax, 0);
            assert.equal(actor.system.mana.value, 0);
            // mana.max is derived every pass as stats.int.effective + bonus
            // (character.mjs), not the schema's own raw initial - default INT
            // is 3, so a freshly-created actor's mana.max is 3, not 0.
            assert.equal(actor.system.mana.max, actor.system.stats.int.effective);
            assert.equal(actor.system.dr, 0);
            for (const type of Object.keys(CONFIG.CARLRPG.damageTypes)) {
              assert.equal(actor.system.resistances[type], "none");
            }
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("character.mjs schema", function () {
        useQuenchTimeout(this);

        it("Level defaults to 1 with min 1 / max 250", async function () {
          const actor = await createTestCharacter();
          try {
            assert.equal(actor.system.attributes.level.value, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("bankedStatPoints defaults to 0, Stats default to 3, conditions default to []", async function () {
          const actor = await createTestCharacter();
          try {
            assert.equal(actor.system.bankedStatPoints, 0);
            assert.equal(actor.system.stats.str.value, 3);
            assert.deepEqual(actor.system.conditions, []);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("mob.mjs schema", function () {
        useQuenchTimeout(this);

        it("mobTier defaults to blank, with the 6 named tiers as valid choices", async function () {
          const actor = await createTestMob();
          try {
            assert.equal(actor.system.mobTier, "");
            await actor.update({ "system.mobTier": "borough" });
            assert.equal(actor.system.mobTier, "borough");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("shares the same conditions shape as Character, but Stats default to 1 (not Character's 3) - p.270's 'Mobs have a base of 1 in each stat'", async function () {
          const actor = await createTestMob();
          try {
            assert.equal(actor.system.stats.str.value, 1);
            assert.deepEqual(actor.system.conditions, []);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("level defaults to 1, attacks to [], hbSlotsOverride to null", async function () {
          const actor = await createTestMob();
          try {
            assert.equal(actor.system.level, 1);
            assert.deepEqual(actor.system.attacks, []);
            assert.isNull(actor.system.hbSlotsOverride);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("hbSlotsRule/hb.max: a plain Mob (blank Tier) is min(Level, 10)", async function () {
          const actor = await createTestMob("mob", { system: { level: 6 } });
          try {
            assert.equal(actor.system.hbSlotsRule, 6);
            assert.equal(actor.system.hb.max, 6);
            await actor.update({ "system.level": 15 });
            assert.equal(actor.system.hbSlotsRule, 10, "capped at 10 past Level 10");
            assert.equal(actor.system.hb.max, 10);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("hbSlotsRule/hb.max: a Boss Tier is Table 50's hbSlotsBase + current Floor", async function () {
          const priorFloor = game.settings.get("carl-rpg", "currentFloor");
          await game.settings.set("carl-rpg", "currentFloor", 3);
          const actor = await createTestMob("boss", { system: { level: 27, mobTier: "neighborhood" } });
          try {
            // Table 50: Neighborhood Boss hbSlotsBase is 10.
            assert.equal(actor.system.hbSlotsRule, 13);
            assert.equal(actor.system.hb.max, 13);
          } finally {
            await deleteTestActor(actor);
            await game.settings.set("carl-rpg", "currentFloor", priorFloor);
          }
        });

        it("hbSlotsOverride, once set, wins over hbSlotsRule", async function () {
          const actor = await createTestMob("mob", { system: { level: 6 } });
          try {
            assert.equal(actor.system.hb.max, 6);
            await actor.update({ "system.hbSlotsOverride": 20 });
            assert.equal(actor.system.hb.max, 20);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("surpriseBase/evadeBase are 10 + the relevant Stat Mod (p.271), never baked-in Floor", async function () {
          const actor = await createTestMob("mob", { system: { stats: { int: { value: 20 }, dex: { value: 50 } } } });
          try {
            // INT 20 -> mod +5, DEX 50 -> mod +6 (Table 2: Stat Mods).
            assert.equal(actor.system.surpriseBase, 15);
            assert.equal(actor.system.evadeBase, 16);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("statPointsBase/statPointsPerLevel/statPointsAvailable/statPointsSpent: plain Mob uses base 1 / 3 per Level, never the Boss numbers", async function () {
          const actor = await createTestMob("mob", { system: { level: 6 } });
          try {
            assert.equal(actor.system.statPointsBase, 1);
            assert.equal(actor.system.statPointsPerLevel, 3);
            // "a Level 6 Mob has 18 stat points to distribute" (p.270).
            assert.equal(actor.system.statPointsAvailable, 18);
            assert.equal(actor.system.statPointsSpent, 0, "all 5 Stats still at the base of 1 - nothing spent yet");
            await actor.update({ "system.stats.str.value": 4 });
            assert.equal(actor.system.statPointsSpent, 3, "3 points sunk into STR above its base of 1");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("statPointsBase/statPointsPerLevel: a Boss Tier uses its own base of 5 and Table 50's per-Tier rate, not the plain-Mob numbers", async function () {
          const actor = await createTestMob("boss", { system: { level: 10, mobTier: "city" } });
          try {
            // Table 50: City Boss is statBase 5, statsPerLevel 5.
            assert.equal(actor.system.statPointsBase, 5);
            assert.equal(actor.system.statPointsPerLevel, 5);
            assert.equal(actor.system.statPointsAvailable, 50);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("item schemas (embedded on a Character)", function () {
        useQuenchTimeout(this);

        it("item-base.mjs: changes defaults to []", async function () {
          const actor = await createTestCharacter();
          try {
            const gear = await createTestItem(actor, "item");
            assert.deepEqual(gear.system.changes, []);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("ranked-item-base.mjs: rank defaults to 0 (min 0, max 20), advancementGate defaults to 'normal'", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill");
            assert.equal(skill.system.rank, 0);
            assert.equal(skill.system.advancementGate, "normal");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("isMagicDamage defaults false for Skill, true for Spell (spell.mjs's override)", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill");
            const spell = await createTestItem(actor, "spell");
            assert.isFalse(skill.system.isMagicDamage);
            assert.isTrue(spell.system.isMagicDamage);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("skill.mjs: category defaults to 'utility'", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill");
            assert.equal(skill.system.category, "utility");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("spell.mjs: castingKeywords/manaCostVariants default to []", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell");
            assert.deepEqual(spell.system.castingKeywords, []);
            assert.deepEqual(spell.system.manaCostVariants, []);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("damage-effect.mjs: parentSkills defaults to []", async function () {
          const actor = await createTestCharacter();
          try {
            const de = await createTestItem(actor, "damageEffect");
            assert.deepEqual(de.system.parentSkills, []);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("class.mjs/race.mjs: skillChoiceGrants defaults to []", async function () {
          const actor = await createTestCharacter();
          try {
            const klass = await createTestItem(actor, "class");
            const race = await createTestItem(actor, "race");
            assert.deepEqual(klass.system.skillChoiceGrants, []);
            assert.deepEqual(race.system.skillChoiceGrants, []);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("item.mjs (gear): quantity defaults to 1, weight to 0, equipped to false", async function () {
          const actor = await createTestCharacter();
          try {
            const gear = await createTestItem(actor, "item");
            assert.equal(gear.system.quantity, 1);
            assert.equal(gear.system.weight, 0);
            assert.isFalse(gear.system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("shared/change-entry.mjs (ChangeEntry)", function () {
        useQuenchTimeout(this);

        it("two fresh ChangeEntries auto-generate distinct ids", async function () {
          const actor = await createTestCharacter();
          try {
            const gear = await createTestItem(actor, "item", "item", {
              system: { changes: [{ targetType: "stat", target: "str", mode: "add", value: "1" }, { targetType: "stat", target: "dex", mode: "add", value: "1" }] },
            });
            assert.notEqual(gear.system.changes[0].id, gear.system.changes[1].id);
            assert.isNotEmpty(gear.system.changes[0].id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("targetType/mode reject values outside their closed enum", async function () {
          // Foundry does NOT reject createEmbeddedDocuments' own returned
          // Promise for a per-document validation failure - it catches the
          // DataModelValidationError internally (logged via its own onError,
          // visible as a console error/notification), drops that document
          // from the batch, and still resolves normally. With only one
          // (invalid) document requested, the resolved array is empty, so
          // createTestItem's `[item] = []` destructure yields undefined -
          // that's the actual signal to check for, not a caught exception.
          const actor = await createTestCharacter();
          try {
            const before = actor.items.size;
            const gear = await createTestItem(actor, "item", "item", {
              system: { changes: [{ targetType: "not-a-real-type", target: "x", mode: "add", value: "1" }] },
            });
            assert.isUndefined(gear, "a StringField with a closed 'choices' list should reject an out-of-enum value, so no Item gets created");
            assert.equal(actor.items.size, before, "no new item should have been created");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("shared/upgrade-tier.mjs (rankThreshold NumberField 'choices')", function () {
        useQuenchTimeout(this);

        it("rejects an out-of-enum rankThreshold (e.g. 7), resolving the once-open question the inventory flagged", async function () {
          // Confirmed against the live schema (not assumed): NumberField's
          // `choices` DOES enforce membership, exactly like StringField's -
          // there was no schema-authoring trap here after all. As with the
          // ChangeEntry test above, the rejection surfaces as the invalid
          // document being silently dropped from the create batch (a console
          // error via Foundry's own onError), not a rejected Promise.
          const actor = await createTestCharacter();
          try {
            const before = actor.items.size;
            const skill = await createTestItem(actor, "skill", "skill", {
              system: { upgrades: [{ rankThreshold: 7, description: "off-enum test" }] },
            });
            assert.isUndefined(skill, "rankThreshold's NumberField 'choices' should reject an out-of-enum value, so no Item gets created");
            assert.equal(actor.items.size, before, "no new item should have been created");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("shared/skill-choice-grant.mjs", function () {
        useQuenchTimeout(this);

        it("amount defaults to 1 (min 1)", async function () {
          const actor = await createTestCharacter();
          try {
            const race = await createTestItem(actor, "race", "race", {
              system: { skillChoiceGrants: [{ category: "crafting" }] },
            });
            assert.equal(race.system.skillChoiceGrants[0].amount, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: data models (schema defaults/choices)" },
  );
}
