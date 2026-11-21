/**
 * Shield Block (p.198; docs/rules-fixes.md D; module/helpers/shield-block.mjs):
 * who can block (the Skill and a Shield in hand; physical, non-Area -
 * magical too from Rank 5; never a Caught hit), what a block does (half the
 * damage before DR, the STR Mod off too at Rank 15, its Debuffs still
 * land), what a bad block costs the Shield (Major Fail -1 DR, Critical Fail
 * -2, broken at 0, Repair), one Action for every Attack it can block (the
 * 2026-11-18 ruling, as Evade), and the Rank 10 Shield Bash. On the
 * Reaction card (phased) and an Attack card's rows.
 */
import CarlDice from "../../dice/dice.mjs";
import { applyRow, blockRow, rowBlockable } from "../../chat/attack-targets-card.mjs";
import { applyOp, reactionCardFor } from "../../chat/reaction-card.mjs";
import { actionRecord, undoAction } from "../../helpers/actions.mjs";
import { computeDamageApplication, blockedDamage } from "../../helpers/damage-pipeline.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { slotsOf } from "../../helpers/gear.mjs";
import { shieldDrState } from "../../helpers/modifiers.mjs";
import { mobAttacksOf } from "../../helpers/mob-attacks.mjs";
import {
  crawlerKey,
  hitBlockable,
  hitEvadable,
  hitList,
  hitStatus,
} from "../../helpers/reaction-state.mjs";
import {
  damageBlockingShields,
  postDamageCard,
  rollAttackOnCard,
} from "../../helpers/reaction-resolve.mjs";
import { boardVehicle } from "../../helpers/vehicles.mjs";
import {
  attackIsMagical,
  BLOCK_TAG,
  bashDice,
  bashOffered,
  blockableAttack,
  blockReduction,
  buildShieldBash,
  keptBlockRoll,
  repairShield,
  rollBlockAgain,
  rollShieldBash,
  shieldBlocker,
  shieldLossFor,
} from "../../helpers/shield-block.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  createTestVehicle,
  deleteTestActor,
  deleteTestCombat,
  PIN_D20_MID,
  settle,
  useQuenchTimeout,
  waitFor,
  withFakeTargets,
  withPinnedDice,
  withSetting,
} from "../helpers.mjs";

const drChange = (value) => ({
  targetType: "resource",
  target: "dr",
  mode: "add",
  value: String(value),
});
const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);

/** Give a crawler the Shield Block Skill at a Rank and a Shield (DR `dr`) in its Off Hand. */
async function arm(actor, { rank = 3, dr = 3, skill = true, inHand = true } = {}) {
  if (skill)
    await createTestItem(actor, "skill", "Shield Block", {
      name: "Shield Block",
      system: { rank, governingStat: "str" },
    });
  const shield = await createTestItem(actor, "item", "Shield", {
    system: { shield: true, slots: [], changes: [drChange(dr)] },
  });
  if (inHand) await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, shield);
  return actor.items.get(shield.id);
}

/** A fabricated Reaction card state with one hit, for the pure gate. */
function oneHit({ isArea = false, damage = "10", damageIsMagic = false, hit = {} } = {}) {
  return {
    attacks: { a: { id: "a", isArea, damage, damageIsMagic } },
    hits: {
      h: {
        id: "h",
        attackId: "a",
        row: { hit: true, isCharacter: true, difficulty: 15 },
        caughtBy: null,
        free: null,
        evade: null,
        block: null,
        ...hit,
      },
    },
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
          assert.isFalse(
            blockableAttack({ isArea: true, hasDamage: true, magical: false }, 15),
            "never Area",
          );
          assert.isFalse(
            blockableAttack({ isArea: false, hasDamage: false, magical: false }, 15),
            "nothing to halve",
          );
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

        it("a Reaction card hit: not a Near Miss on a crawler riding a vehicle - it hits the vehicle (p.72)", function () {
          const nearMiss = { evade: { success: false, degree: "nearMissFail" } };
          const riding = oneHit({
            hit: {
              ...nearMiss,
              row: { hit: true, isCharacter: true, difficulty: 15, vehicleUuid: "Actor.ride" },
            },
          });
          assert.isFalse(hitBlockable(riding, riding.hits.h), "redirected to the vehicle");
          assert.isTrue(
            hitBlockable(oneHit({ hit: nearMiss }), oneHit({ hit: nearMiss }).hits.h),
            "on foot, a Near Miss can still be blocked",
          );
        });

        it("Lock: a failed block on a hit a Near Miss sent to the vehicle costs the Shield nothing", async function () {
          const pc = await createTestCharacter("sb-ride");
          const ride = await createTestVehicle("sb-ride-car", { system: { occupancy: 2 } });
          try {
            const shield = await arm(pc);
            assert.isTrue(await boardVehicle(ride, pc), "seated");
            const state = (degree) => ({
              attacks: { a: { id: "a", isArea: false, damage: "10", damageIsMagic: false } },
              hits: {
                h: {
                  id: "h",
                  attackId: "a",
                  targetUuid: pc.uuid,
                  row: { hit: true, isCharacter: true, vehicleUuid: ride.uuid },
                  caughtBy: null,
                  free: null,
                  evade: { success: false, degree },
                  block: { success: false, degree: "criticalFail", shieldId: shield.id },
                },
              },
            });
            assert.deepEqual(
              await damageBlockingShields(state("nearMissFail")),
              {},
              "the vehicle took it: no Shield DR lost",
            );
            assert.exists(
              (await damageBlockingShields(state("standardFail"))).h,
              "a plain failed Evade: the failed block costs DR",
            );
          } finally {
            await deleteTestActor(ride);
            await deleteTestActor(pc);
          }
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

        it("one block's later Checks: the d20 again with the rest of the first one's total", async function () {
          assert.deepEqual(keptBlockRoll({ formula: "2d20kh", natural: 14, total: 21 }), {
            formula: "2d20kh",
            rest: 7,
          });
          assert.isNull(
            keptBlockRoll({ formula: "1d20 + 5", natural: 14, total: 21 }),
            "only a bare d20 expression",
          );
          assert.isNull(keptBlockRoll({ formula: "1d20", natural: null, total: 21 }));
          const again = await withPinnedDice(PIN_D20_MID, () =>
            rollBlockAgain({ formula: "1d20", rest: 7 }, 16),
          );
          assert.equal(again.total, again.naturalRoll + 7);
          assert.equal(again.formula, "1d20", "the d20 part, as an AI Reroll needs it");
          assert.equal(again.difficulty, 16, "against its own Attack's to-hit");
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
          const target = {
            system: { drEffective: 3, resistancesEffective: {}, hb: { slotValue: 1 } },
          };
          assert.deepEqual(blockedDamage({ "": 30 }), { "": 15 });
          assert.equal(
            computeDamageApplication(blockedDamage({ "": 30 }), target, false).totalFinalDamage,
            12,
          );
        });

        it("Rank 15: the STR Mod off after halving (the book's 30 -> 15 -> 10)", function () {
          assert.deepEqual(blockedDamage({ "": 30 }, 5), { "": 10 });
          const strong = { system: { stats: { str: { mod: 5 } } } };
          assert.equal(blockReduction(strong, 14), 0);
          assert.equal(blockReduction(strong, 15), 5);
          assert.equal(
            blockReduction({ system: { stats: { str: { mod: -2 } } } }, 15),
            0,
            "never adds damage",
          );
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

        const rolled = (total, naturalRoll, difficulty) => ({
          total,
          naturalRoll,
          difficulty,
          formula: "1d20",
          breakdown: "",
          roll: null,
        });
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
                {
                  name: "Maul",
                  toHit: "16",
                  damage: "30",
                  damageType: "bludgeoning",
                  range: "",
                  effect: "",
                },
                {
                  name: "Flame",
                  toHit: "16",
                  damage: "10",
                  damageType: "fire",
                  range: "",
                  effect: "",
                },
                {
                  name: "Slam",
                  toHit: "16",
                  damage: "10",
                  damageType: "bludgeoning",
                  range: "",
                  effect: "",
                  isArea: true,
                },
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
          const ids = game.messages
            .filter(
              (m) =>
                m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat?.id ||
                m.getFlag("carl-rpg", "reaction")?.combatId === combat?.id ||
                m.getFlag("carl-rpg", "reactionDamage")?.combatId === combat?.id,
            )
            .map((m) => m.id);
          if (ids.length) await ChatMessage.deleteDocuments(ids);
          await deleteTestCombat(combat);
          for (const actor of [mob, pc1, pc2]) await deleteTestActor(actor);
        });

        // Started once the crawlers are armed: equipping in a fight takes an Action.
        const begin = async () => {
          combat = await Combat.create({});
          await combat.createEmbeddedDocuments(
            "Combatant",
            [mob, pc1, pc2].map((a) => ({ actorId: a.id })),
          );
          await combat.startCombat();
        };
        const declareOn = (target, index = 0) =>
          withSetting("currentFloor", 1, () =>
            withFakeTargets([{ actor: target }], () =>
              CarlDice.rollMobAttack(mob, index, { skipDialog: true }),
            ),
          );
        const startReaction = async () => {
          await waitFor(
            () =>
              game.messages.some(
                (m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id,
              ),
            { message: "no round-start notice" },
          );
          await combat.nextTurn();
          return reactionCardFor(combat);
        };
        const state = (card) => card.getFlag("carl-rpg", "reaction");
        const op = (card, name, data) => applyOp(card.id, name, data, game.user);
        const hits = (card) => hitList(state(card));
        const spent = (actor) =>
          actionRecord(combat, combat.combatants.find((c) => c.actor === actor).id).spent.length;
        // One Shield Block Action: a Check per hit (`check`, or one each from an array).
        const block = (card, actor, list, check) =>
          op(card, "block", {
            uuid: actor.uuid,
            checks: Object.fromEntries(
              list.map((hit, i) => [hit.id, Array.isArray(check) ? check[i] : check]),
            ),
          });
        const blockOn = (card, hit) => state(card).hits[hit.id].block ?? null;
        const blocker = (card, actor) => state(card).crawlers[crawlerKey(actor.uuid)] ?? {};
        const tags = (actor) =>
          actionRecord(combat, combat.combatants.find((c) => c.actor === actor).id).spent.map(
            (e) => e.tag,
          );
        const resolve = async (card) => {
          const damage = await postDamageCard(combat, state(card));
          const data = () => damage.getFlag("carl-rpg", "reactionDamage");
          for (const id of Object.keys(data().attacks)) await rollAttackOnCard(damage, id);
          await settle();
          return data;
        };

        it("one Action covers every Attack it can block: three Attacks, three Checks, one Action", async function () {
          await arm(pc1);
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const list = hits(card);
          assert.isTrue(
            await block(card, pc1, list, [
              rolled(20, 15, 16),
              rolled(5, 2, 16),
              rolled(18, 13, 16),
            ]),
          );
          assert.equal(spent(pc1), 1, "one Action");
          assert.deepEqual(tags(pc1), [BLOCK_TAG]);
          assert.deepEqual(
            list.map((h) => blockOn(card, h)?.total),
            [20, 5, 18],
            "a separate Check against each",
          );
          assert.deepEqual(
            list.map((h) => hitStatus(state(card), state(card).hits[h.id]).status),
            ["blocked", "hit", "blocked"],
          );
          assert.isTrue(blocker(card, pc1).blocked);
          assert.deepEqual(
            blocker(card, pc1).blockRoll,
            { formula: "1d20", rest: 5 },
            "kept for later Attacks",
          );
          assert.isFalse(await block(card, pc1, list, rolled(20, 15, 16)), "nothing left to block");
          assert.equal(spent(pc1), 1);
        });

        it("skips what it can't block: Area, magic below Rank 5, a Caught hit; no Shield, no block", async function () {
          await createTestItem(pc2, "skill", "Shield Block", {
            name: "Shield Block",
            system: { rank: 3 },
          });
          await arm(pc1, { rank: 3 });
          await createTestItem(pc1, "skill", "Catcher", { name: "Catcher", system: { rank: 1 } });
          await begin();
          await declareOn(pc1);
          await declareOn(pc1, 1);
          await declareOn(pc1, 2);
          await declareOn(pc2);
          const card = await startReaction();
          const [maul, flame, slam, onPc2] = hits(card);
          assert.isFalse(await block(card, pc2, [onPc2], rolled(20, 15, 16)), "no Shield");
          assert.isTrue(
            await op(card, "catch", { byUuid: pc1.uuid, byName: pc1.name, hitId: onPc2.id }),
          );
          assert.equal(state(card).hits[onPc2.id].targetUuid, pc1.uuid);
          const all = hits(card).filter((h) => h.targetUuid === pc1.uuid);
          assert.lengthOf(all, 4);
          assert.isTrue(await block(card, pc1, all, rolled(20, 15, 16)));
          assert.isOk(blockOn(card, maul), "the physical one");
          assert.isNull(blockOn(card, flame), "Fire below Rank 5");
          assert.isNull(blockOn(card, slam), "Area");
          assert.isNull(blockOn(card, onPc2), "Caught (Catcher, p.191)");
          assert.equal(spent(pc1), 2, "the Catch and one block");
        });

        it("only magic left below Rank 5: refused, no Action", async function () {
          await arm(pc1, { rank: 3 });
          await begin();
          await declareOn(pc1, 1);
          await declareOn(pc1, 2);
          const card = await startReaction();
          assert.isFalse(await block(card, pc1, hits(card), rolled(20, 15, 16)));
          assert.equal(spent(pc1), 0);
        });

        it("Rank 5: magical damage too, in the same Action", async function () {
          await arm(pc1, { rank: 5 });
          await begin();
          await declareOn(pc1);
          await declareOn(pc1, 1);
          const card = await startReaction();
          assert.isTrue(await block(card, pc1, hits(card), rolled(20, 15, 16)));
          assert.isTrue(hits(card).every((h) => !!h.block));
          assert.equal(spent(pc1), 1);
        });

        it("an Attack Taunted onto them later is blocked with the same block, at no further Action", async function () {
          await arm(pc1);
          await begin();
          await declareOn(pc1);
          await declareOn(pc2);
          const card = await startReaction();
          const [own, onPc2] = hits(card);
          assert.isTrue(await block(card, pc1, [own], rolled(20, 15, 16)));
          assert.isTrue(
            await op(card, "taunt", {
              byUuid: pc1.uuid,
              byName: pc1.name,
              mobUuid: mob.uuid,
              rank: 1,
              check: rolled(25, 15, 20),
            }),
          );
          const pulled = state(card).hits[onPc2.id];
          assert.equal(pulled.targetUuid, pc1.uuid, "Taunted onto them");
          assert.isOk(pulled.block, "blocked on arrival");
          assert.isTrue(pulled.block.auto);
          assert.equal(
            pulled.block.total,
            pulled.block.natural + 5,
            "the first Check's numbers, the d20 again",
          );
          assert.equal(spent(pc1), 2, "the block and the Taunt - nothing for the new Attack");
          assert.deepEqual(
            tags(pc1).filter((t) => t === BLOCK_TAG),
            [BLOCK_TAG],
          );
        });

        it("undo gives the one Action back and clears every block it made", async function () {
          await arm(pc1);
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const list = hits(card);
          assert.isTrue(await block(card, pc1, list, rolled(20, 15, 16)));
          const combatant = combat.combatants.find((c) => c.actor === pc1);
          await undoAction(combat, combatant.id, actionRecord(combat, combatant.id).spent[0].id);
          await settle(100);
          assert.equal(spent(pc1), 0, "the Action is back");
          assert.isTrue(
            list.every((h) => blockOn(card, h) === null),
            "no blocks left",
          );
          assert.isNotOk(blocker(card, pc1).blocked);
          assert.isTrue(await block(card, pc1, list, rolled(20, 15, 16)), "and it can block again");
          assert.equal(spent(pc1), 1);
        });

        it("a Catch moving a blocked hit drops that block; the Action comes back once it blocks nothing", async function () {
          await arm(pc1);
          await createTestItem(pc2, "skill", "Catcher", { name: "Catcher", system: { rank: 1 } });
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const [h1, h2] = hits(card);
          assert.isTrue(await block(card, pc1, [h1, h2], rolled(20, 15, 16)));
          assert.isTrue(
            await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: h1.id }),
          );
          await settle(100);
          assert.isNull(blockOn(card, h1), "the Caught one's block is gone");
          assert.isOk(blockOn(card, h2), "the other stays");
          assert.equal(spent(pc1), 1, "still covers one");
          assert.isFalse(
            await block(card, pc2, [state(card).hits[h1.id]], rolled(20, 15, 16)),
            "the Catcher can't block it",
          );
          assert.isTrue(
            await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: h2.id }),
          );
          await settle(100);
          assert.equal(spent(pc1), 0, "blocks nothing now: its Action came back");
          assert.isNotOk(blocker(card, pc1).blocked);
        });

        it("a Taunt pulling every blocked hit away gives the Action back", async function () {
          await arm(pc1);
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const list = hits(card);
          assert.isTrue(await block(card, pc1, list, rolled(20, 15, 16)));
          assert.isTrue(
            await op(card, "taunt", {
              byUuid: pc2.uuid,
              byName: pc2.name,
              mobUuid: mob.uuid,
              rank: 1,
              check: rolled(25, 15, 20),
            }),
          );
          await settle(100);
          assert.isTrue(
            list.every((h) => state(card).hits[h.id].targetUuid === pc2.uuid),
            "Taunted away",
          );
          assert.isTrue(list.every((h) => blockOn(card, h) === null));
          assert.equal(spent(pc1), 0);
          assert.isNotOk(blocker(card, pc1).blocked);
        });

        it("a successful block: half before DR, and its Debuffs still land", async function () {
          await arm(pc1, { dr: 3 });
          const dr = pc1.system.drEffective;
          await begin();
          await declareOn(pc1);
          const card = await startReaction();
          const hit = hits(card)[0];
          assert.isTrue(await block(card, pc1, [hit], rolled(25, 15, hit.row.difficulty)));
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
          await block(card, pc1, [hit], rolled(40, 15, hit.row.difficulty));
          const data = await resolve(card);
          const row = Object.values(data().rows)[0];
          assert.equal(row.block.reduction, Math.max(0, str));
          assert.equal(row.result.final, Math.max(0, 15 - Math.max(0, str) - dr));
        });

        it("a Major Fail costs the Shield 1 DR, a Critical Fail 2 - stacked in one block, at Lock Results; at 0 it breaks", async function () {
          const shield = await arm(pc1, { dr: 3 });
          await begin();
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          const [h1, h2] = hits(card);
          // Fails by 12: a Major Fail; a Natural 1: a Critical Fail - one Action.
          await block(card, pc1, [h1, h2], [rolled(4, 4, 16), rolled(1, 1, 16)]);
          assert.equal(spent(pc1), 1);
          assert.equal(pc1.items.get(shield.id).system.shieldDamage, 0, "not before Lock Results");
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
          await block(card, pc1, [h1, h2], [rolled(30, 20, 16), rolled(30, 19, 16)]);
          const b1 = state(card).hits[h1.id].block;
          assert.isTrue(bashOffered(b1, b1.rank));
          assert.isFalse(
            bashOffered(state(card).hits[h2.id].block, 10),
            "a 19 isn't a Critical Hit",
          );
          assert.isFalse(bashOffered(b1, 9), "below Rank 10");
          assert.equal(bashDice(10), "3d6");
          assert.equal(bashDice(15), "4d6");
          const before = spent(pc1);
          const bash = await withPinnedDice(PIN_D20_MID, () =>
            rollShieldBash(pc1, {
              targetUuid: state(card).attacks[h1.attackId].mobUuid,
              rank: 10,
              skipDialog: true,
            }),
          );
          assert.ok(bash, "the Attack card");
          assert.equal(spent(pc1), before, "free - no Action");
          assert.deepEqual(bash.getFlag("carl-rpg", "targetUuids"), [
            state(card).attacks[h1.attackId].mobUuid,
          ]);
          assert.isTrue(await op(card, "bash", { uuid: pc1.uuid, hitId: h1.id }));
          assert.isFalse(await op(card, "bash", { uuid: pc1.uuid, hitId: h1.id }), "once");
          assert.isFalse(
            await op(card, "bash", { uuid: pc1.uuid, hitId: h2.id }),
            "not without a Natural 20",
          );
          await bash.delete();
        });
      });

      describe("an Attack card's rows (outside the phases)", function () {
        useQuenchTimeout(this);

        /** A Mob Attack card with one row on `pc`, `damage` untyped-physical, and its row. */
        async function card(pc, { damage = { bludgeoning: 20 }, row = {}, flags = {} } = {}) {
          const base = {
            id: "t0",
            uuid: pc.uuid,
            name: pc.name,
            isCharacter: true,
            zone: "full",
            difficulty: 16,
            role: "target",
            hit: true,
            amazing: false,
            freeEvade: false,
            freeUsed: false,
            evade: null,
            applied: false,
            replaced: false,
          };
          return ChatMessage.create({
            content: '<div class="carl-chat-card"></div>',
            flags: {
              "carl-rpg": {
                isArea: false,
                floor: 1,
                damageIsMagic: false,
                damageByType: damage,
                attackerType: "mob",
                targetEffects: [
                  {
                    id: "te0",
                    debuffKey: "burned",
                    stacks: 1,
                    trigger: "hit",
                    label: "",
                    sourceLabel: "Test",
                  },
                ],
                targetUuids: [pc.uuid],
                targetRows: { t0: { ...base, ...row } },
                ...flags,
              },
            },
          });
        }
        const blockCheck = (shield, degree, success, rank = 3) => ({
          id: "c",
          kind: "block",
          natural: 10,
          base: 10,
          total: 10,
          difficulty: 16,
          degree,
          success,
          interventions: [],
          shieldId: shield.id,
          shieldName: shield.name,
          rank,
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
            assert.isFalse(
              rowBlockable(magic.getFlag("carl-rpg", "targetRows").t0, magic.flags["carl-rpg"]),
            );
            const area = await card(pc, { flags: { isArea: true } });
            messages.push(area);
            assert.isFalse(
              rowBlockable(area.getFlag("carl-rpg", "targetRows").t0, area.flags["carl-rpg"]),
            );
            const evaded = await card(pc, {
              row: { evade: { degree: "standardSuccess", success: true } },
            });
            messages.push(evaded);
            assert.isFalse(
              rowBlockable(evaded.getFlag("carl-rpg", "targetRows").t0, evaded.flags["carl-rpg"]),
            );
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
            await waitFor(() => !!message.getFlag("carl-rpg", "targetRows").t0.checks?.block, {
              message: "no block on the row",
            });
            const row = message.getFlag("carl-rpg", "targetRows").t0;
            assert.equal(row.checks.block.shieldId, shield.id);
            assert.equal(row.checks.block.rank, 4);
            assert.equal(
              row.checks.block.difficulty,
              16,
              "against what its Evade would roll against",
            );
            assert.deepEqual(row.block, {
              degree: row.checks.block.degree,
              success: row.checks.block.success,
            });
            assert.isFalse(rowBlockable(row, message.flags["carl-rpg"]), "once");
          } finally {
            await message?.delete();
            await deleteTestActor(pc);
          }
        });

        it("in a phased fight: one Shield Block Action covers every card's row this round, as a row's Evade does", async function () {
          const pc = await createTestCharacter("sb-row-fight");
          const mob = await createTestMob("sb-row-mob");
          const messages = [];
          let combat;
          try {
            await arm(pc);
            combat = await Combat.create({});
            await combat.createEmbeddedDocuments(
              "Combatant",
              [mob, pc].map((a) => ({ actorId: a.id })),
            );
            await combat.startCombat();
            const spentTags = () =>
              actionRecord(combat, combat.combatants.find((c) => c.actor === pc).id).spent.map(
                (e) => e.tag,
              );
            messages.push(await card(pc), await card(pc));
            for (const message of messages) {
              await withPinnedDice(PIN_D20_MID, () =>
                blockRow(message, "t0", { skipDialog: true }),
              );
              await waitFor(() => !!message.getFlag("carl-rpg", "targetRows").t0.checks?.block, {
                message: "no block on the row",
              });
            }
            assert.deepEqual(spentTags(), [BLOCK_TAG], "the first card paid; the second was free");
          } finally {
            await settle(150);
            for (const m of messages) await m.delete();
            const notices = game.messages
              .filter((m) => combat && m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id)
              .map((m) => m.id);
            if (notices.length) await ChatMessage.deleteDocuments(notices);
            await deleteTestCombat(combat);
            await deleteTestActor(mob);
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
              row: {
                checks: { block: blockCheck(shield, "standardSuccess", true) },
                block: { degree: "standardSuccess", success: true },
              },
            });
            const lines = await applyRow(message, message.getFlag("carl-rpg", "targetRows").t0);
            await settle();
            const total = Math.max(0, 10 - dr);
            // The digest's math (damage-card.mjs): "10 - 2 (DR) = 8 damage".
            const sums = lines.map((l) => {
              const div = document.createElement("div");
              div.innerHTML = l;
              return div.querySelector(".carl-digest-sum")?.textContent ?? "";
            });
            assert.isTrue(
              sums.some((s) => s.startsWith("10") && s.endsWith(`${total} damage`)),
              `20 halved to 10, then DR: ${sums.join(" | ")}`,
            );
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
              row: {
                checks: { block: blockCheck(shield, "criticalFail", false) },
                block: { degree: "criticalFail", success: false },
              },
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
            assert.deepEqual(
              { ...item.system.baseDamage },
              { dice: "3d6", stat: "str", damageType: "bludgeoning" },
            );
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
