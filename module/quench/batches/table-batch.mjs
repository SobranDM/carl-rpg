import CarlDice from "../../dice/dice.mjs";
import { isAreaItem, isAreaMobAttack, textDescribesArea } from "../../helpers/area.mjs";
import { scaleDamageByType } from "../../helpers/damage-pipeline.mjs";
import { rowOutcome, rowEvadeDifficulty } from "../../helpers/attack-targets.mjs";
import { buildDifficultyPresets, selectedPresetValue } from "../../helpers/rules.mjs";
import { mendingUpdates } from "../../helpers/rest.mjs";
import { endOfFloorPopularityDelta, collapseDays } from "../../helpers/floor.mjs";
import { addGrindLevelHours } from "../../helpers/grinding.mjs";
import { PVE_INITIATIVE } from "../../documents/combat.mjs";
import { applyRow } from "../../chat/attack-targets-card.mjs";
import { setDefeated } from "../../helpers/defeat.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import {
  createTestCharacter, createTestMob, createTestItem, createTestCombat, deleteTestActor, deleteTestCombat,
  settle, waitFor, withFakeTargets, withPinnedDice, PIN_D20_MID, withSetting, useQuenchTimeout,
} from "../helpers.mjs";

const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);
const row = (extra = {}) => ({ id: "t0", hit: true, zone: "full", amazing: false, evade: null, ...extra });
/** A conditions write, the kind round-end makes every round. */
const addConditionToActorSafe = (actor) => actor.update({ "system.conditions": [...(actor.system.toObject().conditions ?? []), { key: "custom", label: "Test", stacks: 1 }] });

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.table-batch",
    (context) => {
      const { describe, it, assert } = context;

      describe("Area detection (p.83)", function () {
        it("reads Blast/Burst/Cone/Line and +Splash wording", function () {
          assert.isTrue(textDescribesArea("Range: 20ft Cone"));
          assert.isTrue(textDescribesArea("1d12 + INT Fire, 10ft Blast radius"));
          assert.isTrue(textDescribesArea("Rank 15: +40ft Splash (on the Blast)"));
          assert.isTrue(textDescribesArea("becomes an 80ft Line attack"));
          assert.isFalse(textDescribesArea("Range: 80 feet"));
          assert.isFalse(textDescribesArea("Your allies within 10 feet gain +1"));
        });
        it("uses the Area of Effect keyword, and only unlocked Upgrade tiers", function () {
          assert.isTrue(isAreaItem({ system: { castingKeywords: ["attack", "areaOfEffect"] } }));
          const fear = { system: { rank: 3, range: "50 feet", upgrades: [{ rankThreshold: 5, description: "+5ft Blast radius" }] } };
          assert.isFalse(isAreaItem(fear));
          assert.isTrue(isAreaItem(fear, 5));
        });
        it("reads a Mob Attack's stat line", function () {
          assert.isTrue(isAreaMobAttack({ name: "Sonic Screech", damage: "2d10+4", range: "30ft Cone" }));
          assert.isFalse(isAreaMobAttack({ name: "Bite", damage: "1d4", range: "5ft" }));
        });
      });

      describe("Per-target damage (p.79-83)", function () {
        const dmg = { fire: 20, "": 3 };
        const card = { damageByType: dmg, isArea: true, floor: 2 };
        it("scaleDamageByType floors each type and adds a flat extra", function () {
          assert.deepEqual(scaleDamageByType({ fire: 7, "": 3 }, 0.5), { fire: 3, "": 1 });
          assert.deepEqual(scaleDamageByType({ fire: 7 }, 1, 2), { fire: 7, "": 2 });
        });
        it("full / Splash / Evaded area / Splash + Evaded", function () {
          assert.deepEqual(rowOutcome(row(), card).damage, { fire: 20, "": 3 });
          assert.deepEqual(rowOutcome(row({ zone: "splash" }), card).damage, { fire: 10, "": 1 });
          assert.deepEqual(rowOutcome(row({ evade: { degree: "standardSuccess", success: true } }), card).damage, { fire: 10, "": 1 });
          assert.deepEqual(rowOutcome(row({ zone: "splash", evade: { degree: "standardSuccess", success: true } }), card).damage, { fire: 5 });
        });
        it("an Evaded non-area Attack deals nothing and applies no effects", function () {
          const out = rowOutcome(row({ evade: { degree: "amazingSuccess", success: true } }), { ...card, isArea: false });
          assert.deepEqual(out.damage, {});
          assert.isFalse(out.effects);
        });
        it("Evade Major Fail adds the Floor; Critical Fail doubles", function () {
          const flat = { damageByType: { fire: 10 }, isArea: false, floor: 3 };
          assert.deepEqual(rowOutcome(row({ evade: { degree: "majorFail", success: false } }), flat).damage, { fire: 10, "": 3 });
          assert.deepEqual(rowOutcome(row({ evade: { degree: "criticalFail", success: false } }), flat).damage, { fire: 20 });
        });
        it("a missed row takes nothing; an Amazing row adds the Floor", function () {
          assert.deepEqual(rowOutcome(row({ hit: false }), card).damage, {});
          assert.deepEqual(rowOutcome(row({ amazing: true }), { damageByType: { fire: 4 }, isArea: false, floor: 2 }).damage, { fire: 4, "": 2 });
        });
        it("PvP: a crawler's Evade rolls against the attacker's total (p.87)", function () {
          assert.equal(rowEvadeDifficulty(row({ isCharacter: true, difficulty: 13 }), { attackerType: "character", attackTotal: 21 }), 21);
          assert.equal(rowEvadeDifficulty(row({ isCharacter: true, difficulty: 13 }), { attackerType: "mob", attackTotal: 13 }), 13);
        });
      });

      describe("rollAttack with several targets", function () {
        useQuenchTimeout(this);

        it("a single-target Attack is checked against each target's own Evade", async function () {
          const actor = await createTestCharacter();
          const nimble = await createTestMob("nimble", { system: { stats: { dex: { value: 10 } } } }); // mod 4 -> 15
          const clumsy = await createTestMob("clumsy", { system: { stats: { dex: { value: 3 } } } }); // mod 2 -> 13
          try {
            const skill = await createTestItem(actor, "skill", "Punch", {
              name: "Punch", system: { category: "attack", rank: 3, governingStat: "", baseDamage: { dice: "1d6" } },
            });
            // d20 pinned to 10 + Rank 3 = 13.
            const message = await withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: clumsy }, { actor: nimble }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }))));
            const rows = message.getFlag("carl-rpg", "targetRows");
            assert.isTrue(rows.t0.hit, "13 vs. 13");
            assert.isFalse(rows.t1.hit, "13 vs. 15");
            assert.isFalse(message.getFlag("carl-rpg", "isArea"));
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(nimble);
            await deleteTestActor(clumsy);
          }
        });

        it("a target with different Advantage gets an extra d20 (p.60)", async function () {
          const actor = await createTestCharacter();
          const free = await createTestMob("free");
          const held = await createTestMob("held");
          try {
            await addConditionToActor(held, "held");
            const skill = await createTestItem(actor, "skill", "Punch", {
              name: "Punch", system: { category: "attack", rank: 3, governingStat: "", baseDamage: { dice: "1d6" } },
            });
            const message = await withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: free }, { actor: held }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }))));
            assert.equal(message.rolls[1]?.formula, "1d20", "the extra die for the Held target");
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(free);
            await deleteTestActor(held);
          }
        });

        it("a targeted Attack that misses everyone still rolls damage, for a Taunt to redirect", async function () {
          const actor = await createTestCharacter();
          const nimble = await createTestMob("nimble", { system: { stats: { dex: { value: 10 } } } }); // Evade 15
          try {
            const skill = await createTestItem(actor, "skill", "Punch", {
              name: "Punch", system: { category: "attack", rank: 3, governingStat: "", baseDamage: { dice: "1d6" } },
            });
            const message = await withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: nimble }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }))));
            assert.isFalse(message.getFlag("carl-rpg", "targetRows").t0.hit);
            assert.isNotEmpty(message.getFlag("carl-rpg", "damageByType"));
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(nimble);
          }
        });

        it("an Area Attack lands on everyone when it hits the chosen foe", async function () {
          const actor = await createTestCharacter();
          const nimble = await createTestMob("nimble", { system: { stats: { dex: { value: 10 } } } });
          const clumsy = await createTestMob("clumsy", { system: { stats: { dex: { value: 3 } } } });
          try {
            const skill = await createTestItem(actor, "skill", "Breath", {
              name: "Breath", system: { category: "attack", rank: 3, governingStat: "", range: "15ft Cone", baseDamage: { dice: "1d6" } },
            });
            const message = await withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: clumsy }, { actor: nimble }], () => CarlDice.rollAttack(actor, skill, { skipDialog: true }))));
            const rows = message.getFlag("carl-rpg", "targetRows");
            assert.isTrue(message.getFlag("carl-rpg", "isArea"));
            assert.isTrue(rows.t0.hit);
            assert.isTrue(rows.t1.hit, "the area hits the nimble Mob too");
            assert.isNotEmpty(message.getFlag("carl-rpg", "damageByType"));
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(nimble);
            await deleteTestActor(clumsy);
          }
        });
      });

      describe("Applying target rows (module/chat/attack-targets-card.mjs)", function () {
        useQuenchTimeout(this);

        it("each row applies its own share: full vs. an Evaded Area Attack's half", async function () {
          const a = await createTestCharacter("full");
          const b = await createTestCharacter("evaded");
          let message;
          try {
            const slot = a.system.hb.slotValue;
            const rowFor = (id, actor, extra = {}) => ({
              id, uuid: actor.uuid, name: actor.name, isCharacter: true, zone: "full", difficulty: 13,
              hit: true, amazing: false, freeEvade: false, freeUsed: false, evade: null, applied: false, replaced: false, ...extra,
            });
            message = await ChatMessage.create({
              content: '<div class="carl-chat-card"></div>',
              flags: { "carl-rpg": {
                isArea: true, floor: 1, damageIsMagic: true, damageByType: { "": slot * 4 },
                targetUuids: [a.uuid, b.uuid],
                targetRows: { t0: rowFor("t0", a), t1: rowFor("t1", b, { evade: { degree: "standardSuccess", success: true } }) },
              } },
            });
            const rows = () => message.getFlag("carl-rpg", "targetRows");
            await applyRow(message, rows().t0);
            await settle();
            assert.isTrue(rows().t0.applied);
            assert.isFalse(rows().t1.applied, "the other row is untouched");
            assert.equal(rows().t1.evade.degree, "standardSuccess");
            await applyRow(message, rows().t1);
            await settle();
            assert.equal(a.system.hb.value, 10 - 4, "full: 4 slots");
            assert.equal(b.system.hb.value, 10 - 2, "Evaded area: half, 2 slots");
            assert.isTrue(rows().t1.applied);
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });
      });

      describe("0 HB (p.92-94)", function () {
        useQuenchTimeout(this);

        it("a crawler reduced to 0 HB gains Dying, its countdown the CON Mod", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.hb.value": 0 });
            const dying = actor.system.conditions.find((c) => c.key === "dying");
            assert.exists(dying);
            assert.equal(dying.remaining, Math.max(0, actor.system.stats.con.mod));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Mob reduced to 0 HB is marked defeated in its Combat", async function () {
          const mob = await createTestMob("doomed", { system: { level: 3, hb: { value: 3 } } });
          let combat;
          try {
            let combatant;
            ({ combat, combatant } = await createTestCombat(mob));
            await mob.update({ "system.hb.value": 0 });
            await waitFor(() => combat.combatants.get(combatant.id)?.defeated === true, { message: "the Mob's combatant was never marked defeated" });
            assert.isTrue(mob.statuses.has(CONFIG.specialStatusEffects.DEFEATED));
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(mob);
          }
        });

        it("a GM's hand-set defeated on a living Mob survives other updates", async function () {
          const mob = await createTestMob("fled", { system: { level: 3, hb: { value: 3 } } });
          try {
            await setDefeated(mob, true);
            await addConditionToActorSafe(mob);
            await mob.update({ "system.hb.value": 2 });
            await settle(100);
            assert.isTrue(mob.statuses.has(CONFIG.specialStatusEffects.DEFEATED));
          } finally {
            await deleteTestActor(mob);
          }
        });
      });

      describe("Spells, presets, mending, floors", function () {
        useQuenchTimeout(this);

        it("a Spell added to an actor at Rank 0 arrives at Rank 1", async function () {
          const actor = await createTestCharacter();
          try {
            const spell = await createTestItem(actor, "spell", "Heal", { system: { rank: 0 } });
            assert.equal(spell.system.rank, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Difficulty presets at Floor 3 (p.59)", function () {
          const presets = buildDifficultyPresets({ floor: 3, selected: "opposed", opposed: { name: "Goblin", stat: "INT", mod: 2 } });
          const value = (key) => presets.find((p) => p.key === key)?.value;
          assert.equal(value("unopposed"), 16);
          assert.equal(value("stat"), 13);
          assert.equal(value("opposed"), 15);
          assert.equal(selectedPresetValue(presets), 15);
          assert.isNull(selectedPresetValue(buildDifficultyPresets({ floor: 3 })), "Custom by default");
        });

        it("hourly mending: +1 HB and +5 Mana per hour, clamped (p.95)", function () {
          const actor = { system: { hb: { value: 7, effectiveMax: 10 }, mana: { value: 2, max: 20 } } };
          assert.deepEqual(mendingUpdates(actor, 2), { "system.hb.value": 9, "system.mana.value": 12 });
          assert.deepEqual(mendingUpdates(actor, 10), { "system.hb.value": 10, "system.mana.value": 20 });
        });

        it("end-of-floor Popularity from the Charisma score (p.280) and collapse timers (p.63)", function () {
          assert.equal(endOfFloorPopularityDelta(15, 3), 1);
          assert.equal(endOfFloorPopularityDelta(6, 3), -1);
          assert.equal(endOfFloorPopularityDelta(10, 3), 0);
          assert.equal(endOfFloorPopularityDelta(1, 0), 0);
          assert.equal(collapseDays(4), 10);
          assert.isNull(collapseDays(9));
        });

        it("grinding hours equal to the Level grant a Level, and any Level gain resets them (p.171)", async function () {
          const actor = await createTestCharacter("grinder", { system: { attributes: { level: { value: 3 } } } });
          try {
            await addGrindLevelHours(actor, 2);
            assert.equal(actor.system.grindLevelHours, 2);
            const result = await addGrindLevelHours(actor, 1);
            assert.isTrue(result.leveled);
            assert.equal(actor.system.attributes.level.value, 4);
            assert.equal(actor.system.grindLevelHours, 0);
            await actor.update({ "system.grindLevelHours": 2 });
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.grindLevelHours, 0);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a PvE combat lists Mobs first with no initiative roll", async function () {
          const mob = await createTestMob("first");
          const pc = await createTestCharacter("second");
          let combat;
          try {
            ({ combat } = await createTestCombat(mob));
            await combat.createEmbeddedDocuments("Combatant", [{ actorId: pc.id }]);
            await settle();
            const byActor = (a) => combat.combatants.find((c) => c.actorId === a.id);
            assert.equal(byActor(mob).initiative, PVE_INITIATIVE.mob);
            assert.equal(byActor(pc).initiative, PVE_INITIATIVE.character);
            assert.isFalse(combat.isPvP);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });
      });
    },
    { displayName: "CarlRPG: table batch (area attacks, 0 HB, presets, floors)" },
  );
}
