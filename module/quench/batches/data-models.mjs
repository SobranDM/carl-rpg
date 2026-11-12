import {
  createTestCharacter,
  createTestMob,
  createTestItem,
  deleteTestActor,
  useQuenchTimeout,
} from "../helpers.mjs";
import {
  assignItemToSlot,
  clearSlot,
  resolveSlotValue,
  unwearItem,
} from "../../helpers/equip-slots.mjs";

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

        it("Roll20-sheet parity fields default to blank / book defaults", async function () {
          const actor = await createTestCharacter();
          try {
            const s = actor.system;
            assert.equal(s.details.pronouns, "");
            assert.equal(s.details.crawlerNumber, "");
            assert.equal(s.details.popularity, 0);
            assert.equal(s.details.aiFavor, 0);
            assert.equal(s.details.move, 20);
            assert.equal(s.details.step, 10);
            assert.equal(s.details.size, 4);
            for (const key of [
              "externalBuffs",
              "hotlist",
              "accessories",
              "importantKills",
              "clubs",
              "deity",
              "sponsors",
            ]) {
              assert.deepEqual(s[key], [], key);
            }
            assert.deepEqual(s.personalSpace.notes, []);
            assert.equal(s.gearSlots.mainHand, "");
            assert.equal(s.story.regrets, "");
            assert.equal(s.pet.hb.max, 10);
            assert.isNull(s.pet.str);
            assert.deepEqual(s.pet.attacks, []);
            assert.equal(s.mount.hb.value, 10);
            assert.isNull(s.mount.occupants);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Fixed-slot text lists accept the sheet's index-keyed form data", async function () {
          // The sheet binds one input per slot as `system.<list>.<i>`, so a
          // form submit arrives as an index-keyed object, not an array.
          const actor = await createTestCharacter();
          try {
            await actor.update({
              "system.hotlist": { 0: "Healing Potion", 1: "", 2: "Goblin Dynamite" },
              "system.pet.attacks": { 0: "Bite 1d6" },
              "system.details.size": "5",
            });
            assert.deepEqual(actor.system.hotlist, ["Healing Potion", "", "Goblin Dynamite"]);
            assert.deepEqual(actor.system.pet.attacks, ["Bite 1d6"]);
            assert.equal(actor.system.details.size, 5);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Size rejects values outside the 1-8 scale", async function () {
          const actor = await createTestCharacter();
          try {
            // Like the ChangeEntry case below, Foundry v14 reports the
            // validation failure (console error + notification) and drops
            // the update rather than throwing - so the signal is that the
            // stored value didn't change.
            try {
              await actor.update({ "system.details.size": 9 });
            } catch (e) {
              // Older cores threw instead; either way the value must not change.
            }
            assert.equal(actor.system.details.size, 4);
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
          const actor = await createTestMob("boss", {
            system: { level: 27, mobTier: "neighborhood" },
          });
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
          const actor = await createTestMob("mob", {
            system: { stats: { int: { value: 20 }, dex: { value: 50 } } },
          });
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
            assert.equal(
              actor.system.statPointsSpent,
              0,
              "all 5 Stats still at the base of 1 - nothing spent yet",
            );
            await actor.update({ "system.stats.str.value": 4 });
            assert.equal(
              actor.system.statPointsSpent,
              3,
              "3 points sunk into STR above its base of 1",
            );
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
              system: {
                changes: [
                  { targetType: "stat", target: "str", mode: "add", value: "1" },
                  { targetType: "stat", target: "dex", mode: "add", value: "1" },
                ],
              },
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
              system: {
                changes: [{ targetType: "not-a-real-type", target: "x", mode: "add", value: "1" }],
              },
            });
            assert.isUndefined(
              gear,
              "a StringField with a closed 'choices' list should reject an out-of-enum value, so no Item gets created",
            );
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
            assert.isUndefined(
              skill,
              "rankThreshold's NumberField 'choices' should reject an out-of-enum value, so no Item gets created",
            );
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

      describe("helpers/equip-slots.mjs (Inventory Hotlist/Equipped slots)", function () {
        useQuenchTimeout(this);

        it("a gear slot equips its item and unequips the one it replaced", async function () {
          const actor = await createTestCharacter();
          try {
            const club = await createTestItem(actor, "item", "club");
            const pipe = await createTestItem(actor, "item", "pipe");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            assert.equal(actor.system.gearSlots.mainHand, club.id);
            assert.isTrue(club.system.equipped);

            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, pipe);
            assert.equal(actor.system.gearSlots.mainHand, pipe.id);
            assert.isTrue(pipe.system.equipped);
            assert.isFalse(club.system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("moving a worn item clears its old slot; unwearing clears all", async function () {
          const actor = await createTestCharacter();
          try {
            const ring = await createTestItem(actor, "item", "ring");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "gloves" }, ring);
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "0" }, ring);
            assert.equal(actor.system.gearSlots.gloves, "");
            assert.deepEqual(actor.system.accessories, [ring.id]);
            assert.isTrue(ring.system.equipped);

            await unwearItem(actor, ring);
            assert.deepEqual(actor.system.accessories, []);
            assert.isFalse(ring.system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("only gear goes in a worn slot; an over-full accessory list doesn't block gear", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "punch");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, skill);
            assert.equal(actor.system.gearSlots.head, "");

            // Old data holding more accessories than the cap.
            const rings = [];
            for (let i = 0; i <= CONFIG.CARLRPG.characterListSlots.accessories; i++) {
              rings.push(await createTestItem(actor, "item", `ring ${i}`));
            }
            await actor.update({ "system.accessories": rings.map((r) => r.id) });
            const helm = await createTestItem(actor, "item", "helm");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            assert.equal(actor.system.gearSlots.head, helm.id);
            assert.isTrue(helm.system.equipped);

            const extra = await createTestItem(actor, "item", "extra ring");
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "99" }, extra);
            assert.notInclude(actor.system.accessories, extra.id, "can't add past the cap");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("(x) on a gear or accessory slot clears it and unequips", async function () {
          const actor = await createTestCharacter();
          try {
            const helm = await createTestItem(actor, "item", "helm");
            const ring = await createTestItem(actor, "item", "ring");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "0" }, ring);

            await clearSlot(actor, { slotType: "gear", slotKey: "head" });
            assert.equal(actor.system.gearSlots.head, "");
            assert.isFalse(helm.system.equipped);

            await clearSlot(actor, { slotType: "accessory", slotKey: "0" });
            assert.deepEqual(actor.system.accessories, []);
            assert.isFalse(ring.system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("blank and deleted accessory entries don't use up the 10", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({
              "system.accessories": ["", foundry.utils.randomID(), "Gutter Ring"],
            });
            const ring = await createTestItem(actor, "item", "ring");
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "3" }, ring);
            assert.deepEqual(actor.system.accessories, ["Gutter Ring", ring.id]);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("hotlist slots hold item ids without equipping, and clear", async function () {
          const actor = await createTestCharacter();
          try {
            const potion = await createTestItem(actor, "item", "potion");
            await assignItemToSlot(actor, { slotType: "hotlist", slotKey: "3" }, potion);
            assert.equal(actor.system.hotlist[3], potion.id);
            assert.lengthOf(actor.system.hotlist, 10);
            assert.isFalse(potion.system.equipped);
            assert.equal(resolveSlotValue(actor, actor.system.hotlist[3]).name, potion.name);

            await clearSlot(actor, { slotType: "hotlist", slotKey: "3" });
            assert.equal(actor.system.hotlist[3], "");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("shows legacy free text, hides a deleted item's id", async function () {
          const actor = await createTestCharacter();
          try {
            assert.equal(resolveSlotValue(actor, "Goblin Dynamite").name, "Goblin Dynamite");
            assert.equal(resolveSlotValue(actor, foundry.utils.randomID()).name, "");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("migrates the old Hands gear slot into Main Hand", async function () {
          const actor = await createTestCharacter("legacy hands", {
            system: { gearSlots: { hands: "Rebar Club" } },
          });
          try {
            assert.equal(actor.system.gearSlots.mainHand, "Rebar Club");
            assert.notProperty(actor.system.gearSlots, "hands");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: data models (schema defaults/choices)" },
  );
}
