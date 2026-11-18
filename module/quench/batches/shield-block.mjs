/**
 * Shield Block (p.198; docs/rules-fixes.md D; module/helpers/shield-block.mjs):
 * who can block (the Skill and a Shield in hand; physical, non-Area -
 * magical too from Rank 5; never a Caught hit), what a block does (half the
 * damage before DR, the STR Mod off too at Rank 15, its Debuffs still
 * land), what a bad block costs the Shield (Major Fail -1 DR, Critical Fail
 * -2, broken at 0, Repair), one Action per Attack, and the Rank 10 Shield
 * Bash. On the Reaction card (phased) and an Attack card's rows.
 */
import CarlDice from "../../dice/dice.mjs";
import { applyRow, blockRow, rowBlockable } from "../../chat/attack-targets-card.mjs";
import { applyOp, reactionCardFor } from "../../chat/reaction-card.mjs";
import { actionRecord } from "../../helpers/actions.mjs";
import { computeDamageApplication, blockedDamage } from "../../helpers/damage-pipeline.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { slotsOf } from "../../helpers/gear.mjs";
import { shieldDrState } from "../../helpers/modifiers.mjs";
import { mobAttacksOf } from "../../helpers/mob-attacks.mjs";
import { hitBlockable, hitEvadable, hitList, hitStatus } from "../../helpers/reaction-state.mjs";
import { postDamageCard, rollAttackOnCard } from "../../helpers/reaction-resolve.mjs";
import {
  attackIsMagical, bashDice, bashOffered, blockableAttack, blockReduction, buildShieldBash, repairShield, rollShieldBash,
  shieldBlocker, shieldLossFor,
} from "../../helpers/shield-block.mjs";
import {
  createTestCharacter, createTestItem, createTestMob, deleteTestActor, deleteTestCombat, PIN_D20_MID, settle, useQuenchTimeout,
  waitFor, withFakeTargets, withPinnedDice, withSetting,
} from "../helpers.mjs";

const drChange = (value) => ({ targetType: "resource", target: "dr", mode: "add", value: String(value) });
const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);

/** Give a crawler the Shield Block Skill at a Rank and a Shield (DR `dr`) in its Off Hand. */
async function arm(actor, { rank = 3, dr = 3, skill = true, inHand = true } = {}) {
  if (skill) await createTestItem(actor, "skill", "Shield Block", { name: "Shield Block", system: { rank, governingStat: "str" } });
  const shield = await createTestItem(actor, "item", "Shield", { system: { shield: true, slots: [], changes: [drChange(dr)] } });
  if (inHand) await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, shield);
  return actor.items.get(shield.id);
}

/** A fabricated Reaction card state with one hit, for the pure gate. */
function oneHit({ isArea = false, damage = "10", damageIsMagic = false, hit = {} } = {}) {
  return {
    attacks: { a: { id: "a", isArea, damage, damageIsMagic } },
    hits: { h: { id: "h", attackId: "a", row: { hit: true, isCharacter: true, difficulty: 15 }, caughtBy: null, free: null, evade: null, block: null, ...hit } },
  };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.shield-block",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("the gate", function () {
        useQuenchTimeout(this);

        it("physical, non-Area, with damage; magical only from Rank 5", function () {
          assert.isTrue(blockableAttack({ isArea: false, hasDamage: true, magical: false }, 1));
          assert.isFalse(blockableAttack({ isArea: true, hasDamage: true, magical: false }, 15), "never Area");
          assert.isFalse(blockableAttack({ isArea: false, hasDamage: false, magical: false }, 15), "nothing to halve");
          assert.isFalse(blockableAttack({ magical: true }, 4), "magical below Rank 5");
          assert.isTrue(blockableAttack({ magical: true }, 5), "magical at Rank 5");
        });

        it("magical: a Spell, or magical damage; unknown counts as magical", function () {
          assert.isFalse(attackIsMagical({ damageIsMagic: false }));
          assert.isTrue(attackIsMagical({ damageIsMagic: false, isSpell: true }), "a Spell");
          assert.isTrue(attackIsMagical({ damageIsMagic: true }));
          assert.isTrue(attackIsMagical({}));
        });

        it("a Reaction card hit: not Caught (Catcher, p.191), not Area, not Evaded; after a failed Evade is fine", function () {
          assert.isTrue(hitBlockable(oneHit(), oneHit().hits.h));
          const caught = oneHit({ hit: { caughtBy: { uuid: "x", name: "x" } } });
          assert.isFalse(hitBlockable(caught, caught.hits.h), "Caught");
          const area = oneHit({ isArea: true });
          assert.isFalse(hitBlockable(area, area.hits.h), "Area");
          const evaded = oneHit({ hit: { evade: { success: true } } });
          assert.isFalse(hitBlockable(evaded, evaded.hits.h), "Evaded");
          const failed = oneHit({ hit: { evade: { success: false, degree: "standardFail" } } });
          assert.isTrue(hitBlockable(failed, failed.hits.h), "a failed Evade");
          const magic = oneHit({ damageIsMagic: true });
          assert.isFalse(hitBlockable(magic, magic.hits.h));
          assert.isTrue(hitBlockable(magic, magic.hits.h, { magicOk: true }), "Rank 5");
          const blocked = oneHit({ hit: { block: { success: true } } });
          assert.isFalse(hitBlockable(blocked, blocked.hits.h), "once");
          assert.isFalse(hitEvadable(blocked.hits.h), "a blocked hit isn't Evaded too");
          assert.equal(hitStatus(blocked, blocked.hits.h).status, "blocked");
        });

        it("the Skill and an unbroken Shield in hand", async function () {
          const pc = await createTestCharacter("sb-gate");
          try {
            assert.isNull(shieldBlocker(pc));
            const shield = await arm(pc, { rank: 4, inHand: false });
            assert.isNull(shieldBlocker(pc), "not in hand");
            await assignItemToSlot(pc, { slotType: "gear", slotKey: "offHand" }, shield);
            const blocker = shieldBlocker(pc);
            assert.equal(blocker?.shield.id, shield.id);
            assert.equal(blocker.rank, 4);
            assert.include(slotsOf(pc.items.get(shield.id)), "held", "a Shield is always Held");
            await shield.update({ "system.shieldDamage": 3 });
            assert.isTrue(shieldDrState(pc.items.get(shield.id)).broken);
            assert.isNull(shieldBlocker(pc), "a broken Shield can't block");
          } finally {
            await deleteTestActor(pc);
          }
        });

        it("no Skill, no block", async function () {
          const pc = await createTestCharacter("sb-noskill");
          try {
            await arm(pc, { skill: false });
            assert.isNull(shieldBlocker(pc));
          } finally {
            await deleteTestActor(pc);
          }
        });
      });

      describe("the damage", function () {
        it("half before DR: 30 against DR 3 is 12, not 13", function () {
          const target = { system: { drEffective: 3, resistancesEffective: {}, hb: { slotValue: 1 } } };
          assert.deepEqual(blockedDamage({ "": 30 }), { "": 15 });
          assert.equal(computeDamageApplication(blockedDamage({ "": 30 }), target, false).totalFinalDamage, 12);
        });

        it("Rank 15: the STR Mod off after halving (the book's 30 -> 15 -> 10)", function () {
          assert.deepEqual(blockedDamage({ "": 30 }, 5), { "": 10 });
          const strong = { system: { stats: { str: { mod: 5 } } } };
          assert.equal(blockReduction(strong, 14), 0);
          assert.equal(blockReduction(strong, 15), 5);
          assert.equal(blockReduction({ system: { stats: { str: { mod: -2 } } } }, 15), 0, "never adds damage");
        });

        it("each damage type keeps its share", function () {
          assert.deepEqual(blockedDamage({ fire: 20, "": 10 }), { fire: 10, "": 5 });
        });
      });

      describe("the Shield's DR", function () {
        useQuenchTimeout(this);

        it("Shield damage lowers its DR; broken at 0 gives none; Repair puts it back", async function () {
          const pc = await createTestCharacter("sb-dr");
          try {
            const shield = await arm(pc, { dr: 3 });
            const base = pc.system.drEffective;
            assert.isAtLeast(base, 3);
            assert.equal(shieldLossFor("majorFail"), 1);
            assert.equal(shieldLossFor("criticalFail"), 2);
            assert.equal(shieldLossFor("standardFail"), 0);
            await shield.update({ "system.shieldDamage": 1 });
            assert.equal(pc.system.drEffective, base - 1);
            await shield.update({ "system.shieldDamage": 5 });
            assert.equal(pc.system.drEffective, base - 3, "never more than it gave");
            assert.isTrue(shieldDrState(pc.items.get(shield.id)).broken);
            await repairShield(pc.items.get(shield.id));
            assert.equal(pc.items.get(shield.id).system.shieldDamage, 0);
            assert.equal(pc.system.drEffective, base);
          } finally {
            await deleteTestActor(pc);
          }
        });
      });

      describe("the Reaction card", function () {
        useQuenchTimeout(this);

        const rolled = (total, naturalRoll, difficulty) => ({ total, naturalRoll, difficulty, formula: "1d20", breakdown: "", roll: null });
        const EFFECTS = [
          { debuffKey: "burned", stacks: 1, trigger: "hit", label: "" },
          { debuffKey: "poisoned", stacks: 1, trigger: "majorFail", label: "" },
        ];
        let mob;
        let pc1;
        let pc2;
        let combat;
        beforeEach(async function () {
          // 0: Maul 30 Bludgeoning with Debuffs; 1: Flame 10 Fire; 2: Slam, an Area Attack.
          mob = await createTestMob("sb-mob", {
            system: {
              attacks: [
                { name: "Maul", toHit: "16", damage: "30", damageType: "bludgeoning", range: "", effect: "" },
                { name: "Flame", toHit: "16", damage: "10", damageType: "fire", range: "", effect: "" },
                { name: "Slam", toHit: "16", damage: "10", damageType: "bludgeoning", range: "", effect: "", isArea: true },
              ],
              actionsPerRound: 6,
            },
          });
          await mobAttacksOf(mob)[0].update({ "system.targetEffects": EFFECTS });
          await mobAttacksOf(mob)[2].update({ "system.isArea": true });
          pc1 = await createTestCharacter("sb-pc1");
          pc2 = await createTestCharacter("sb-pc2");
          combat = null;
        });
        afterEach(async function () {
          await settle(150);
          const ids = game.messages.filter((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat?.id
            || m.getFlag("carl-rpg", "reaction")?.combatId === combat?.id
            || m.getFlag("carl-rpg", "reactionDamage")?.combatId === combat?.id).map((m) => m.id);
          if (ids.length) await ChatMessage.deleteDocuments(ids);
          await deleteTestCombat(combat);
          for (const actor of [mob, pc1, pc2]) await deleteTestActor(actor);
        });

        // Started once the crawlers are armed: equipping in a fight takes an Action.
        const begin = async () => {
          combat = await Combat.create({});
          await combat.createEmbeddedDocuments("Combatant", [mob, pc1, pc2].map((a) => ({ actorId: a.id })));
          await combat.startCombat();
        };
        const declareOn = (target, index = 0) => withSetting("currentFloor", 1, () =>
          withFakeTargets([{ actor: target }], () => CarlDice.rollMobAttack(mob, index, { skipDialog: true })));
        const startReaction = async () => {
          await waitFor(() => game.messages.some((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id),
            { message: "no round-start notice" });
          await combat.nextTurn();
          return reactionCardFor(combat);
        };
        const state = (card) => card.getFlag("carl-rpg", "reaction");
        const op = (card, name, data) => applyOp(card.id, name, data, game.user);
        const hits = (card) => hitList(state(card));
        const spent = (actor) => actionRecord(combat, combat.combatants.find((c) => c.actor === actor).id).spent.length;
        const block = (card, actor, hit, check) => op(card, "block", { uuid: actor.uuid, hitId: hit.id, check });
        const resolve = async (card) => {
          const damage = await postDamageCard(combat, state(card));
          const data = () => damage.getFlag("carl-rpg", "reactionDamage");
          for (const id of Object.keys(data().attacks)) await rollAttackOnCard(damage, id);
          await settle();
          return data;
        };

        it("one Action per Attack: three Attacks, three Checks - the third refused with two Actions", async function () {
          await arm(pc1);
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const [h1, h2, h3] = hits(card);
          assert.isTrue(await block(card, pc1, h1, rolled(20, 15, h1.row.difficulty)));
          assert.equal(spent(pc1), 1);
          assert.isTrue(await block(card, pc1, h2, rolled(20, 15, h2.row.difficulty)));
          assert.equal(spent(pc1), 2, "a second Action, not covered like an Evade");
          assert.isFalse(await block(card, pc1, h3, rolled(20, 15, h3.row.difficulty)), "no Action left");
          assert.isNull(state(card).hits[h3.id].block ?? null);
          assert.isFalse(await block(card, pc1, h1, rolled(20, 15, h1.row.difficulty)), "each Attack once");
        });

        it("no Shield, magic below Rank 5, an Area Attack: refused", async function () {
          await createTestItem(pc2, "skill", "Shield Block", { name: "Shield Block", system: { rank: 3 } });
          await arm(pc1, { rank: 3 });
          await begin();
          await declareOn(pc2);
          await declareOn(pc1, 1);
          await declareOn(pc1, 2);
          const card = await startReaction();
          const [onPc2, flame, slam] = hits(card);
          assert.isFalse(await block(card, pc2, onPc2, rolled(20, 15, 16)), "no Shield");
          assert.isFalse(await block(card, pc1, flame, rolled(20, 15, 16)), "Fire below Rank 5");
          assert.isFalse(await block(card, pc1, slam, rolled(20, 15, 16)), "Area");
          assert.equal(spent(pc1), 0);
        });

        it("Rank 5: magical damage too", async function () {
          await arm(pc1, { rank: 5 });
          await begin();
          await declareOn(pc1, 1);
          const card = await startReaction();
          assert.isTrue(await block(card, pc1, hits(card)[0], rolled(20, 15, 16)));
        });

        it("a Caught hit can't be blocked; Catching a blocked one drops the block and gives its Action back", async function () {
          await arm(pc1);
          await arm(pc2);
          await createTestItem(pc2, "skill", "Catcher", { name: "Catcher", system: { rank: 1 } });
          await begin();
          await declareOn(pc1);
          const card = await startReaction();
          const hit = hits(card)[0];
          assert.isTrue(await block(card, pc1, hit, rolled(20, 15, 16)));
          assert.equal(spent(pc1), 1);
          assert.isTrue(await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: hit.id }));
          await settle(100);
          assert.isNull(state(card).hits[hit.id].block);
          assert.equal(spent(pc1), 0, "the block's Action came back");
          assert.isFalse(await block(card, pc2, state(card).hits[hit.id], rolled(20, 15, 16)), "the Catcher can't block it");
        });

        it("a successful block: half before DR, and its Debuffs still land", async function () {
          await arm(pc1, { dr: 3 });
          const dr = pc1.system.drEffective;
          await begin();
          await declareOn(pc1);
          const card = await startReaction();
          const hit = hits(card)[0];
          assert.isTrue(await block(card, pc1, hit, rolled(25, 15, hit.row.difficulty)));
          assert.equal(hitStatus(state(card), state(card).hits[hit.id]).status, "blocked");
          const data = await resolve(card);
          const row = Object.values(data().rows)[0];
          assert.isTrue(row.block.success);
          assert.equal(row.result.final, Math.max(0, 15 - dr), "30 halved to 15, then DR");
          assert.includeMembers(keys(pc1), ["burned", "poisoned"], "still a hit - not Evaded");
        });

        it("Rank 15: the STR Mod comes off after halving", async function () {
          await pc1.update({ "system.stats.str.value": 20 });
          const str = pc1.system.stats.str.mod;
          await arm(pc1, { rank: 15, dr: 1 });
          const dr = pc1.system.drEffective;
          await begin();
          await declareOn(pc1);
          const card = await startReaction();
          const hit = hits(card)[0];
          await block(card, pc1, hit, rolled(40, 15, hit.row.difficulty));
          const data = await resolve(card);
          const row = Object.values(data().rows)[0];
          assert.equal(row.block.reduction, Math.max(0, str));
          assert.equal(row.result.final, Math.max(0, 15 - Math.max(0, str) - dr));
        });

        it("a Major Fail costs the Shield 1 DR, a Critical Fail 2 - at Lock Results; at 0 it breaks", async function () {
          const shield = await arm(pc1, { dr: 3 });
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const [h1, h2] = hits(card);
          await block(card, pc1, h1, rolled(4, 4, 16)); // fails by 12: Major Fail
          assert.equal(pc1.items.get(shield.id).system.shieldDamage, 0, "not before Lock Results");
          await block(card, pc1, h2, rolled(1, 1, 16)); // Natural 1: Critical Fail
          const data = await resolve(card);
          assert.equal(pc1.items.get(shield.id).system.shieldDamage, 3);
          assert.isTrue(shieldDrState(pc1.items.get(shield.id)).broken, "3 DR gone: broken");
          assert.isNull(shieldBlocker(pc1), "it can't block now");
          const tags = Object.values(data().rows).flatMap((r) => r.tags.map((t) => t.key));
          assert.include(tags, "CARLRPG.ShieldBlock.Tag.broken");
        });

        it("Rank 10: a Natural 20 offers one free Shield Bash at the Mob", async function () {
          await arm(pc1, { rank: 10 });
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const [h1, h2] = hits(card);
          await block(card, pc1, h1, rolled(30, 20, 16));
          await block(card, pc1, h2, rolled(30, 19, 16));
          const b1 = state(card).hits[h1.id].block;
          assert.isTrue(bashOffered(b1, b1.rank));
          assert.isFalse(bashOffered(state(card).hits[h2.id].block, 10), "a 19 isn't a Critical Hit");
          assert.isFalse(bashOffered(b1, 9), "below Rank 10");
          assert.equal(bashDice(10), "3d6");
          assert.equal(bashDice(15), "4d6");
          const before = spent(pc1);
          const bash = await withPinnedDice(PIN_D20_MID, () =>
            rollShieldBash(pc1, { targetUuid: state(card).attacks[h1.attackId].mobUuid, rank: 10, skipDialog: true }));
          assert.ok(bash, "the Attack card");
          assert.equal(spent(pc1), before, "free - no Action");
          assert.deepEqual(bash.getFlag("carl-rpg", "targetUuids"), [state(card).attacks[h1.attackId].mobUuid]);
          assert.isTrue(await op(card, "bash", { uuid: pc1.uuid, hitId: h1.id }));
          assert.isFalse(await op(card, "bash", { uuid: pc1.uuid, hitId: h1.id }), "once");
          assert.isFalse(await op(card, "bash", { uuid: pc1.uuid, hitId: h2.id }), "not without a Natural 20");
          await bash.delete();
        });
      });

      describe("an Attack card's rows (outside the phases)", function () {
        useQuenchTimeout(this);

        /** A Mob Attack card with one row on `pc`, `damage` untyped-physical, and its row. */
        async function card(pc, { damage = { bludgeoning: 20 }, row = {}, flags = {} } = {}) {
          const base = {
            id: "t0", uuid: pc.uuid, name: pc.name, isCharacter: true, zone: "full", difficulty: 16, role: "target",
            hit: true, amazing: false, freeEvade: false, freeUsed: false, evade: null, applied: false, replaced: false,
          };
          return ChatMessage.create({
            content: '<div class="carl-chat-card"></div>',
            flags: { "carl-rpg": {
              isArea: false, floor: 1, damageIsMagic: false, damageByType: damage, attackerType: "mob",
              targetEffects: [{ id: "te0", debuffKey: "burned", stacks: 1, trigger: "hit", label: "", sourceLabel: "Test" }],
              targetUuids: [pc.uuid], targetRows: { t0: { ...base, ...row } }, ...flags,
            } },
          });
        }
        const blockCheck = (shield, degree, success, rank = 3) => ({
          id: "c", kind: "block", natural: 10, base: 10, total: 10, difficulty: 16, degree, success, interventions: [],
          shieldId: shield.id, shieldName: shield.name, rank,
        });

        it("offered to a target with the Skill and a Shield - not for magic, Area or after an Evade", async function () {
          const pc = await createTestCharacter("sb-row");
          const messages = [];
          try {
            const plain = await card(pc);
            messages.push(plain);
            const row = () => plain.getFlag("carl-rpg", "targetRows").t0;
            assert.isFalse(rowBlockable(row(), plain.flags["carl-rpg"]), "no Skill or Shield yet");
            await arm(pc);
            assert.isTrue(rowBlockable(row(), plain.flags["carl-rpg"]));
            const magic = await card(pc, { flags: { damageIsMagic: true } });
            messages.push(magic);
            assert.isFalse(rowBlockable(magic.getFlag("carl-rpg", "targetRows").t0, magic.flags["carl-rpg"]));
            const area = await card(pc, { flags: { isArea: true } });
            messages.push(area);
            assert.isFalse(rowBlockable(area.getFlag("carl-rpg", "targetRows").t0, area.flags["carl-rpg"]));
            const evaded = await card(pc, { row: { evade: { degree: "standardSuccess", success: true } } });
            messages.push(evaded);
            assert.isFalse(rowBlockable(evaded.getFlag("carl-rpg", "targetRows").t0, evaded.flags["carl-rpg"]));
          } finally {
            for (const m of messages) await m.delete();
            await deleteTestActor(pc);
          }
        });

        it("the row's Shield Block icon rolls the Check and keeps it on the row, with the Shield and Rank", async function () {
          const pc = await createTestCharacter("sb-row-roll");
          let message;
          try {
            const shield = await arm(pc, { rank: 4 });
            message = await card(pc);
            await withPinnedDice(PIN_D20_MID, () => blockRow(message, "t0", { skipDialog: true }));
            await waitFor(() => !!message.getFlag("carl-rpg", "targetRows").t0.checks?.block, { message: "no block on the row" });
            const row = message.getFlag("carl-rpg", "targetRows").t0;
            assert.equal(row.checks.block.shieldId, shield.id);
            assert.equal(row.checks.block.rank, 4);
            assert.equal(row.checks.block.difficulty, 16, "against what its Evade would roll against");
            assert.deepEqual(row.block, { degree: row.checks.block.degree, success: row.checks.block.success });
            assert.isFalse(rowBlockable(row, message.flags["carl-rpg"]), "once");
          } finally {
            await message?.delete();
            await deleteTestActor(pc);
          }
        });

        it("Apply: a successful block halves before DR and the Debuff still lands", async function () {
          const pc = await createTestCharacter("sb-row-apply");
          let message;
          try {
            const shield = await arm(pc, { dr: 2 });
            const dr = pc.system.drEffective;
            message = await card(pc, {
              row: { checks: { block: blockCheck(shield, "standardSuccess", true) }, block: { degree: "standardSuccess", success: true } },
            });
            const lines = await applyRow(message, message.getFlag("carl-rpg", "targetRows").t0);
            await settle();
            const total = Math.max(0, 10 - dr);
            assert.isTrue(lines.some((l) => l.includes(`= ${total} total`)), `20 halved to 10, then DR: ${lines.join(" | ")}`);
            assert.include(keys(pc), "burned", "still a hit");
          } finally {
            await message?.delete();
            await deleteTestActor(pc);
          }
        });

        it("Apply: a Critical Fail costs the Shield 2 DR", async function () {
          const pc = await createTestCharacter("sb-row-crit");
          let message;
          try {
            const shield = await arm(pc, { dr: 3 });
            message = await card(pc, {
              row: { checks: { block: blockCheck(shield, "criticalFail", false) }, block: { degree: "criticalFail", success: false } },
            });
            await applyRow(message, message.getFlag("carl-rpg", "targetRows").t0);
            await settle();
            assert.equal(pc.items.get(shield.id).system.shieldDamage, 2);
            assert.isFalse(shieldDrState(pc.items.get(shield.id)).broken, "1 DR left");
          } finally {
            await message?.delete();
            await deleteTestActor(pc);
          }
        });

        it("the Shield Bash is an unsaved STR Attack Skill: 3d6 + STR Bludgeoning", async function () {
          const pc = await createTestCharacter("sb-bash");
          try {
            const { item } = buildShieldBash(pc, 10);
            assert.equal(item.system.category, "attack");
            assert.equal(item.system.governingStat, "str");
            assert.deepEqual({ ...item.system.baseDamage }, { dice: "3d6", stat: "str", damageType: "bludgeoning" });
            assert.isFalse(item.system.isMagicDamage);
            assert.isUndefined(pc.items.get(item.id), "not saved on the crawler");
          } finally {
            await deleteTestActor(pc);
          }
        });
      });
    },
    { displayName: "CarlRPG: Shield Block" },
  );
}
