/**
 * Armor-Piercing and Anti-Piercing (docs/rules-fixes.md C; p.95, p.225):
 * where an Attack's Armor-Piercing comes from (modifiers.mjs
 * attackIsArmorPiercing), the DR such a hit still meets (drAntiPiercing -
 * Anti-Piercing gear's), the damage pipeline, and the flag on the cards.
 */
import CarlDice from "../../dice/dice.mjs";
import { attackIsArmorPiercing, itemIsArmorPiercing } from "../../helpers/modifiers.mjs";
import { computeDamageApplication } from "../../helpers/damage-pipeline.mjs";
import { applyDamageToActor } from "../../chat/damage-card.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { mobAttackData } from "../../helpers/mob-attacks.mjs";
import {
  createTestCharacter, createTestItem, createTestMob, deleteTestActor, PIN_D20_MID, useQuenchTimeout, withFakeTargets, withPinnedDice,
} from "../helpers.mjs";

const drChange = (value) => ({ targetType: "resource", target: "dr", mode: "add", value: String(value) });

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.armor-piercing",
    (context) => {
      const { describe, it, assert } = context;

      describe("the damage pipeline", function () {
        const target = { system: { drEffective: 5, drAntiPiercing: 2, resistancesEffective: {}, hb: { slotValue: 1 } } };

        it("an Armor-Piercing hit meets only the Anti-Piercing DR", function () {
          assert.equal(computeDamageApplication({ "": 10 }, target, true).totalFinalDamage, 5, "all DR");
          assert.equal(computeDamageApplication({ "": 10 }, target, true, { armorPiercing: true }).totalFinalDamage, 8);
        });

        it("no Anti-Piercing gear: no DR at all; a hit-only extra DR doesn't count either", function () {
          const bare = { system: { drEffective: 5, resistancesEffective: {}, hb: { slotValue: 1 } } };
          assert.equal(computeDamageApplication({ "": 10 }, bare, true, { armorPiercing: true, extraDr: 3 }).totalFinalDamage, 10);
        });

        it("Debuff damage still skips every DR", function () {
          assert.equal(computeDamageApplication({ "": 10 }, target, true, { ignoreDr: true, armorPiercing: true }).totalFinalDamage, 10);
        });
      });

      describe("where it comes from", function () {
        useQuenchTimeout(this);

        it("a Skill's own box, or an Upgrade tier once its Rank is reached", function () {
          assert.isTrue(itemIsArmorPiercing({ system: { armorPiercing: true, upgrades: [] } }));
          const dagger = (rank) => ({ system: { rank, upgrades: [{ rankThreshold: 5, armorPiercing: true }] } });
          assert.isFalse(itemIsArmorPiercing(dagger(4)), "Dagger below Rank 5");
          assert.isTrue(itemIsArmorPiercing(dagger(5)), "Dagger at Rank 5");
        });

        it("an equipped Armor-Piercing weapon for this Attack's Skill - not other gear, not when unequipped", async function () {
          const actor = await createTestCharacter("ap weapon");
          try {
            const skill = await createTestItem(actor, "skill", "Spear", { system: { category: "attack", rank: 2 } });
            const other = await createTestItem(actor, "skill", "Club", { system: { category: "attack", rank: 2 } });
            const spear = await createTestItem(actor, "item", "AP spear", {
              system: { weaponSkill: skill.name, armorPiercing: true, slots: ["held"] },
            });
            assert.isFalse(attackIsArmorPiercing(actor, skill), "carried, not equipped");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, spear);
            assert.isTrue(attackIsArmorPiercing(actor, skill));
            assert.isFalse(attackIsArmorPiercing(actor, other), "another Skill's Attack");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Damage Effect's box", async function () {
          const actor = await createTestCharacter("ap de");
          try {
            const skill = await createTestItem(actor, "skill", "Fists", { system: { category: "attack", rank: 2 } });
            const de = await createTestItem(actor, "damageEffect", "Pierce", { system: { rank: 2, armorPiercing: true } });
            assert.isFalse(attackIsArmorPiercing(actor, skill));
            assert.isTrue(attackIsArmorPiercing(actor, skill, { damageEffectItem: de }));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Mob Attack's box reaches what a roll reads", async function () {
          const mob = await createTestMob("ap mob");
          try {
            const [attack] = await mob.createEmbeddedDocuments("Item", [{
              name: "Spine", type: "mobAttack", system: { toHit: "15", damage: "3d6+5", damageType: "piercing", armorPiercing: true },
            }]);
            assert.isTrue(mobAttackData(attack).armorPiercing);
          } finally {
            await deleteTestActor(mob);
          }
        });
      });

      describe("the DR an Armor-Piercing hit meets", function () {
        useQuenchTimeout(this);

        it("only Anti-Piercing gear's, scaled like the rest of DR", async function () {
          const actor = await createTestCharacter("anti");
          try {
            const helm = await createTestItem(actor, "item", "AP helm", { system: { slots: ["head"], antiPiercing: true, changes: [drChange(3)] } });
            const boots = await createTestItem(actor, "item", "boots", { system: { slots: ["feet"], changes: [drChange(2)] } });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "feet" }, boots);
            assert.equal(actor.system.drEffective, 5);
            assert.equal(actor.system.drAntiPiercing, 3);

            // An Iron Skin Potion's DR x2 doubles both.
            await actor.update({ "system.conditions": [{ id: foundry.utils.randomID(), key: "custom", label: "Iron Skin",
              changes: [{ targetType: "resource", target: "dr", mode: "multiply", value: "2" }] }] });
            assert.equal(actor.system.drEffective, 10);
            assert.equal(actor.system.drAntiPiercing, 6);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an outclassed Anti-Piercing piece in the same slot type counts for nothing", async function () {
          // A Mob wears gear by its Equipped box: two head pieces compete (p.225).
          const mob = await createTestMob("outclassed");
          try {
            const weak = await createTestItem(mob, "item", "AP cap", { system: { slots: ["head"], antiPiercing: true, changes: [drChange(1)] } });
            await weak.update({ "system.equipped": true });
            assert.equal(mob.system.drAntiPiercing, 1, "worn alone, it counts");
            const strong = await createTestItem(mob, "item", "helm", { system: { slots: ["head"], changes: [drChange(4)] } });
            await strong.update({ "system.equipped": true });
            assert.equal(mob.system.drAntiPiercing, 0, "the better helm outclasses it");
          } finally {
            await deleteTestActor(mob);
          }
        });

        it("applyDamageToActor takes the flag", async function () {
          const actor = await createTestCharacter("applied", { system: { hb: { value: 10, max: 10 } } });
          try {
            const helm = await createTestItem(actor, "item", "AP helm", { system: { slots: ["head"], changes: [drChange(50)] } });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            const slotValue = actor.system.hb.slotValue || 1;
            await applyDamageToActor(actor, { "": slotValue * 2 }, true);
            assert.equal(actor.system.hb.value, 10, "DR 50 stops it");
            await applyDamageToActor(actor, { "": slotValue * 2 }, true, { armorPiercing: true });
            assert.equal(actor.system.hb.value, 8, "Armor-Piercing goes through");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("on the Attack card", function () {
        useQuenchTimeout(this);

        it("a crawler's Attack with an Armor-Piercing weapon flags its card and says so", async function () {
          const actor = await createTestCharacter("attacker");
          const mob = await createTestMob("victim");
          let message;
          try {
            const skill = await createTestItem(actor, "skill", "Spear", {
              system: { category: "attack", rank: 2, baseDamage: { dice: "1d4" } },
            });
            const spear = await createTestItem(actor, "item", "AP spear", {
              system: { weaponSkill: skill.name, armorPiercing: true, slots: ["held"] },
            });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, spear);
            message = await withPinnedDice(PIN_D20_MID, () => withFakeTargets([{ actor: mob }],
              () => CarlDice.rollAttack(actor, skill, { skipDialog: true })));
            assert.exists(message);
            assert.isTrue(message.getFlag("carl-rpg", "armorPiercing"));
            if (message.getFlag("carl-rpg", "damageByType")) {
              assert.include(message.content, game.i18n.localize("CARLRPG.ArmorPiercing.Label"));
            }
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });
      });

      describe("the compendium (needs `npm run build:packs`)", function () {
        useQuenchTimeout(this);

        it("Dagger Rank 5 and Javelin Rank 10 are Armor-Piercing", async function () {
          const pack = game.packs.get("carl-rpg.skills-and-spells");
          assert.exists(pack);
          for (const [name, rank] of [["Dagger", 5], ["Javelin", 10], ["Icicles", 15], ["Thunderlash", 10]]) {
            const entry = pack.index.find((e) => e.name === name);
            const doc = entry ? await pack.getDocument(entry._id) : null;
            assert.isTrue(!!doc?.system.upgrades.find((u) => u.rankThreshold === rank)?.armorPiercing, `${name} Rank ${rank}`);
          }
        });
      });
    },
    { displayName: "CarlRPG: Armor-Piercing" },
  );
}
