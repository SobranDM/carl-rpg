/**
 * Combat Actions (module/helpers/actions.mjs; docs/action-tracking.md): the
 * budgets, spending and refusing, refunds and GM adjustments, AI Favor's
 * Action, and the places that spend one.
 */
import CarlDice from "../../dice/dice.mjs";
import {
  actionBubbles, actionRecord, adjustActions, baseBudget, buyFavorAction, canAct, combatantInFight, evadeIsFree, hasSpent,
  isInCombat, payingPool, refundAction, resetActions, spendAction, spendBubble, undoAction,
} from "../../helpers/actions.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { useConsumable } from "../../helpers/consumables.mjs";
import { currentPhase } from "../../helpers/combat-phases.mjs";
import { declaredAttacks, removeDeclaration } from "../../helpers/declarations.mjs";
import { placeInHotlist, useHotlistSlot } from "../../helpers/hotlist.mjs";
import { applyOp, reactionCardFor, rollTaunt } from "../../chat/reaction-card.mjs";
import { runRecords } from "../../helpers/action-undo.mjs";
import { hitList } from "../../helpers/reaction-state.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  createTestPet,
  createTestVehicle,
  deleteTestActor,
  deleteTestCombat,
  pressDialog,
  settle,
  useQuenchTimeout,
  waitFor,
  withDialog,
  withFakeTargets,
} from "../helpers.mjs";
import { queueForCard as withCard } from "../../helpers/actor-queue.mjs";

/** An unstarted combat with these actors as combatants. */
async function combatOf(...actors) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments("Combatant", actors.map((a) => ({ actorId: a.id })));
  return combat;
}

/** Delete the cards a test combat posted. */
async function deleteCards(combat) {
  if (!combat?.id) return;
  await settle(150);
  const ids = game.messages.filter((m) => {
    const f = m.flags?.["carl-rpg"] ?? {};
    return f.phaseNotice?.combatId === combat.id || f.reaction?.combatId === combat.id || f.reactionDamage?.combatId === combat.id;
  }).map((m) => m.id);
  if (ids.length) await ChatMessage.deleteDocuments(ids);
}

const free = (combat, combatant) => actionBubbles(combat, combatant).filter((b) => !b.spent);

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.action-tracking",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("Budgets", function () {
        useQuenchTimeout(this);

        let mob;
        let boss;
        let pc1;
        let pc2;
        let combat;
        beforeEach(async function () {
          mob = await createTestMob("budget-mob");
          boss = await createTestMob("budget-boss", { system: { mobTier: "borough" } });
          pc1 = await createTestCharacter("budget-pc1");
          pc2 = await createTestCharacter("budget-pc2");
          combat = await combatOf(mob, boss, pc1, pc2);
        });
        afterEach(async function () {
          await deleteCards(combat);
          await deleteTestCombat(combat);
          for (const a of [mob, boss, pc1, pc2]) await deleteTestActor(a);
        });

        const of = (actor) => combat.combatants.find((c) => c.actor === actor);

        it("crawlers 2; a Mob 1 Move + 1 Action; a Boss 1 per crawler", async function () {
          await combat.startCombat();
          assert.deepEqual(baseBudget(combat, of(pc1)), { move: 0, action: 2 });
          assert.deepEqual(baseBudget(combat, of(mob)), { move: 1, action: 1 });
          assert.deepEqual(baseBudget(combat, of(boss)), { move: 0, action: 2 }, "two crawlers in the fight");
          const pools = actionBubbles(combat, of(mob)).map((b) => b.pool);
          assert.deepEqual(pools, ["move", "action"], "one yellow, one green");
        });

        it("an Elite counts like a Boss, and a stat block's own count wins", async function () {
          await mob.update({ "system.isElite": true });
          await combat.startCombat();
          assert.deepEqual(baseBudget(combat, of(mob)), { move: 0, action: 2 });
          await mob.update({ "system.actionsPerRound": 3 });
          assert.deepEqual(baseBudget(combat, of(mob)), { move: 0, action: 3 });
        });

        it("Surprise: one Action for each crawler, none for the Mobs", async function () {
          await combat.setSurprise(true);
          await combat.startCombat();
          assert.equal(currentPhase(combat), "surprise");
          assert.deepEqual(baseBudget(combat, of(pc1)), { move: 0, action: 1 });
          assert.deepEqual(baseBudget(combat, of(mob)), { move: 0, action: 0 });
        });

        it("a Pet that hasn't been commanded has none but Evades free; a Mount has one", async function () {
          const pet = await createTestPet("budget-pet", { system: { ownerId: pc1.id } });
          const mount = await createTestPet("budget-mount", { system: { ownerId: pc1.id, isMount: true } });
          try {
            await combat.createEmbeddedDocuments("Combatant", [pet, mount].map((a) => ({ actorId: a.id })));
            await combat.startCombat();
            assert.deepEqual(baseBudget(combat, of(pet)), { move: 0, action: 0 });
            assert.deepEqual(baseBudget(combat, of(mount)), { move: 0, action: 1 });
            assert.isTrue(evadeIsFree(pet), "an uncommanded Pet still Evades, for free");
            assert.isFalse(evadeIsFree(mount), "a Mount pays with its Action");
            await pet.update({ "system.command": { state: "restricted", combatId: combat.id, round: 1 } });
            assert.deepEqual(baseBudget(combat, of(pet)), { move: 0, action: 2 }, "commanded: two");
            assert.isFalse(evadeIsFree(pet), "commanded: Evade is an Action again");
          } finally {
            await deleteTestActor(pet);
            await deleteTestActor(mount);
          }
        });
      });

      describe("Spending and refusing", function () {
        useQuenchTimeout(this);

        let mob;
        let pc;
        let combat;
        beforeEach(async function () {
          mob = await createTestMob("spend-mob", { system: { attacks: [{ name: "Bite", toHit: "14", damage: "3", damageType: "", range: "", effect: "" }] } });
          pc = await createTestCharacter("spend-pc");
          combat = await combatOf(mob, pc);
          await combat.startCombat();
        });
        afterEach(async function () {
          await deleteCards(combat);
          await deleteTestCombat(combat);
          await deleteTestActor(mob);
          await deleteTestActor(pc);
        });

        const of = (actor) => combat.combatants.find((c) => c.actor === actor);

        it("is only tracked in a phased fight", async function () {
          const loner = await createTestCharacter("loner");
          try {
            assert.isFalse(isInCombat(loner));
            assert.isNull(combatantInFight(loner));
            assert.isTrue(canAct(loner, "attack", { warn: false }), "outside a fight: always");
            assert.isNull(await spendAction(loner, "attack", "x"), "and nothing recorded");
            assert.isTrue(isInCombat(pc));
            assert.exists(combatantInFight(pc));
          } finally {
            await deleteTestActor(loner);
          }
        });

        it("two Actions, then refused - for the GM too", async function () {
          await spendAction(pc, "attack", "Attack: A");
          await spendAction(pc, "other", "Cast: B");
          assert.lengthOf(free(combat, of(pc)), 0);
          assert.isFalse(canAct(pc, "other", { warn: false }));
          assert.deepEqual(actionRecord(combat, of(pc).id).spent.map((e) => e.label), ["Attack: A", "Cast: B"]);
        });

        it("a Mob's Move-only Action can't pay for an Attack, but can for a Move", async function () {
          await spendAction(mob, "attack", "Attack: Bite");
          assert.isFalse(canAct(mob, "attack", { warn: false }), "only the Move is left");
          assert.isTrue(canAct(mob, "move", { warn: false }));
          await spendBubble(combat, of(mob).id, "move");
          assert.lengthOf(free(combat, of(mob)), 0);
        });

        it("a Move uses the yellow first", async function () {
          assert.equal(payingPool(combat, of(mob), "move"), "move");
          assert.equal(payingPool(combat, of(mob), "attack"), "action");
        });

        it("a spent Action can be undone, and the GM can add or take one away", async function () {
          const id = await spendAction(pc, "attack", "Attack: A");
          await refundAction(combat, of(pc).id, id);
          assert.lengthOf(actionRecord(combat, of(pc).id).spent, 0);
          await adjustActions(combat, of(pc).id, 1);
          assert.lengthOf(actionBubbles(combat, of(pc)), 3, "a third Action");
          await adjustActions(combat, of(pc).id, -1);
          await adjustActions(combat, of(pc).id, -1);
          assert.lengthOf(actionBubbles(combat, of(pc)), 1);
          await resetActions(combat, of(pc).id);
          assert.lengthOf(actionBubbles(combat, of(pc)), 2);
        });

        it("AI Favor's Action: costs 1 AI Favor, once a round, and can't Attack", async function () {
          await pc.update({ "system.details.aiFavor": 2 });
          assert.isTrue(await buyFavorAction(pc));
          assert.equal(pc.system.details.aiFavor, 1);
          assert.isFalse(await buyFavorAction(pc), "once a round");
          await spendAction(pc, "attack", "A");
          await spendAction(pc, "attack", "B");
          assert.isFalse(canAct(pc, "attack", { warn: false }), "the gold one isn't for Attacks");
          assert.isTrue(canAct(pc, "other", { warn: false }));
          await spendAction(pc, "other", "Help");
          assert.equal(actionRecord(combat, of(pc).id).spent.at(-1).pool, "favor");
        });

        it("a new round starts with every Action back", async function () {
          await spendAction(pc, "attack", "A");
          await combat.nextTurn();
          await combat.nextTurn();
          await combat.nextTurn(); // End Round
          assert.equal(combat.round, 2);
          assert.lengthOf(free(combat, of(pc)), 2);
        });

        it("a Skill Check spends one by default; a Stat Check doesn't", async function () {
          const skill = await createTestItem(pc, "skill", "Climbing", { system: { category: "utility", rank: 1 } });
          await CarlDice.rollStatCheck(pc, "str", { skipDialog: true });
          assert.lengthOf(actionRecord(combat, of(pc).id).spent, 0, "a Stat Check is usually the GM's call");
          await CarlDice.rollSkillCheck(pc, skill, { skipDialog: true });
          assert.lengthOf(actionRecord(combat, of(pc).id).spent, 1);
          await CarlDice.rollSkillCheck(pc, skill, { skipDialog: true });
          assert.isNull(await CarlDice.rollSkillCheck(pc, skill, { skipDialog: true }), "refused with none left");
        });

        it("putting gear in the Hotlist, or on, is the Retrieve Action", async function () {
          const club = await createTestItem(pc, "item", "Club");
          const hat = await createTestItem(pc, "item", "Hat");
          assert.isTrue(await placeInHotlist(pc, 0, club));
          assert.lengthOf(actionRecord(combat, of(pc).id).spent, 1);
          await hat.update({ "system.equipped": true });
          assert.lengthOf(actionRecord(combat, of(pc).id).spent, 2, "the Equipped box");
          await hat.update({ "system.equipped": false });
          assert.isTrue(hat.system.equipped, "refused with none left");
        });

        it("a declared Mob Attack spends the Mob's Action; withdrawing it refunds it", async function () {
          await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          assert.lengthOf(declaredAttacks(combat), 1);
          assert.isFalse(canAct(mob, "attack", { warn: false }));
          const second = await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          assert.isNull(second);
          assert.lengthOf(declaredAttacks(combat), 1, "no second declaration");
          await removeDeclaration(combat, declaredAttacks(combat)[0].id);
          assert.isTrue(canAct(mob, "attack", { warn: false }), "refunded");
        });

        it("the Reaction card's Evade spends one Action, however many Attacks", async function () {
          await mob.update({ "system.actionsPerRound": 2 });
          await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          await combat.nextTurn();
          const card = reactionCardFor(combat);
          const checks = Object.fromEntries(hitList(card.getFlag("carl-rpg", "reaction"))
            .map((h) => [h.id, { total: 20, naturalRoll: 12, difficulty: 14, formula: "1d20", breakdown: "", roll: null }]));
          assert.isTrue(await applyOp(card.id, "evade", { uuid: pc.uuid, checks }, game.user));
          const spent = actionRecord(combat, of(pc).id).spent;
          assert.lengthOf(spent, 1, "one Evade Action");
          assert.equal(spent[0].tag, "evade");
          assert.isTrue(hasSpent(pc, "evade"));
        });

        it("the tracker shows each combatant's bubbles", async function () {
          await spendAction(pc, "attack", "Attack: A");
          await combat.activate();
          await ui.combat.render({ force: true, combat });
          await waitFor(() => ui.combat.element?.querySelector(".carl-action-bubble"), { message: "no bubbles" });
          const row = (actor) => ui.combat.element.querySelector(`[data-combatant-id="${of(actor).id}"]`);
          assert.lengthOf(row(pc).querySelectorAll(".carl-action-bubble"), 2);
          assert.lengthOf(row(pc).querySelectorAll(".carl-action-bubble.spent"), 1, "one red");
          assert.lengthOf(row(mob).querySelectorAll(".carl-action-bubble.move"), 1, "the Mob's yellow");
        });
      });

      describe("The Hotlist, gear and the Reaction card", function () {
        useQuenchTimeout(this);

        let mob;
        let pc;
        let combat;
        let skill;
        let blade;
        beforeEach(async function () {
          mob = await createTestMob("hotlist-mob", { system: { actionsPerRound: 4, attacks: [{ name: "Bite", toHit: "14", damage: "3", damageType: "", range: "", effect: "" }] } });
          pc = await createTestCharacter("hotlist-pc");
          skill = await createTestItem(pc, "skill", "Longsword", { system: { category: "attack", rank: 1 } });
          blade = await createTestItem(pc, "item", "blade", { system: { weaponSkill: skill.name } });
          // Set up before the fight, where it costs nothing.
          await placeInHotlist(pc, 0, blade);
          combat = await combatOf(mob, pc);
          await combat.startCombat();
        });
        afterEach(async function () {
          await deleteCards(combat);
          await deleteTestCombat(combat);
          await deleteTestActor(mob);
          await deleteTestActor(pc);
        });

        const spent = () => actionRecord(combat, combat.combatants.find((c) => c.actor === pc).id).spent;

        it("Swap from the Hotlist alone is one Action (Use a Hotlist Item)", async function () {
          await useHotlistSlot(pc, 0, { skipDialog: true });
          assert.equal(pc.system.gearSlots.mainHand, blade.id);
          assert.lengthOf(spent(), 1);
          assert.include(spent()[0].label, blade.name);
        });

        it("an Attack with a weapon from the Hotlist is one Action - the swap is part of it", async function () {
          const result = await CarlDice.rollAttack(pc, skill, { skipDialog: true });
          assert.exists(result, "the Attack was made");
          assert.equal(pc.system.gearSlots.mainHand, blade.id, "swapped in");
          assert.lengthOf(spent(), 1, "no Retrieve on top");
          assert.equal(spent()[0].kind, "attack");
        });

        it("undoing an Attack made with a Hotlist weapon puts the weapon back and takes the card away", async function () {
          const message = await CarlDice.rollAttack(pc, skill, { skipDialog: true });
          assert.exists(message);
          assert.lengthOf(spent(), 1);
          await undoAction(combat, combat.combatants.find((c) => c.actor === pc).id, spent()[0].id);
          assert.lengthOf(spent(), 0, "the Action is back");
          assert.notExists(game.messages.get(message.id), "the Attack card is gone");
          assert.equal(pc.system.hotlist[0], blade.id, "the weapon back in the Hotlist");
          assert.notEqual(pc.system.gearSlots.mainHand, blade.id, "and out of the hand");
          assert.isFalse(pc.items.get(blade.id).system.equipped);
        });

        it("a cancelled swap-and-Attack costs nothing", async function () {
          const result = await withDialog(() => CarlDice.rollAttack(pc, skill), (dialog) => pressDialog(dialog, "cancel"), "carl-roll-dialog");
          assert.isNull(result);
          assert.lengthOf(spent(), 0);
          assert.equal(pc.system.hotlist[0], blade.id, "nothing swapped");
        });

        it("Previous Phase out of Reaction gives back what the card spent", async function () {
          // A Taunt needs an Attack aimed at someone else to pull.
          const ally = await createTestCharacter("spend-ally");
          try {
            await withFakeTargets([{ actor: ally }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            await combat.nextTurn();
            const card = reactionCardFor(combat);
            const check = { total: 25, naturalRoll: 15, difficulty: 12, formula: "1d20", breakdown: "", roll: null };
            assert.isTrue(await applyOp(card.id, "taunt", { byUuid: pc.uuid, byName: pc.name, mobUuid: mob.uuid, rank: 1, check }, game.user));
            assert.lengthOf(spent(), 1, "the Taunt");
            await combat.previousTurn();
            assert.equal(currentPhase(combat), "declare");
            assert.lengthOf(spent(), 0, "refunded with the card");
          } finally {
            await deleteTestActor(ally);
          }
        });
      });
      describe("Paying once, and undoing", function () {
        useQuenchTimeout(this);

        const bite = { name: "Bite", toHit: "14", damage: "3", damageType: "", range: "", effect: "" };
        const check = { total: 25, naturalRoll: 15, difficulty: 12, formula: "1d20", breakdown: "", roll: null };
        let mob;
        let pc;
        let combat;
        beforeEach(async function () {
          mob = await createTestMob("undo-mob", { system: { actionsPerRound: 4, attacks: [bite] } });
          pc = await createTestCharacter("undo-pc");
          combat = await combatOf(mob, pc);
          await combat.startCombat();
        });
        afterEach(async function () {
          await deleteCards(combat);
          await deleteTestCombat(combat);
          await deleteTestActor(mob);
          await deleteTestActor(pc);
        });

        const of = (actor) => combat.combatants.find((c) => c.actor === actor);
        const spentBy = (actor) => actionRecord(combat, of(actor).id).spent;
        const undoLast = (actor) => undoAction(combat, of(actor).id, spentBy(actor).at(-1).id);

        it("equipping over worn gear is one Retrieve, however many items it moves", async function () {
          const club = await createTestItem(pc, "item", "Club");
          const axe = await createTestItem(pc, "item", "Axe");
          await assignItemToSlot(pc, { slotType: "gear", slotKey: "mainHand" }, club);
          assert.lengthOf(spentBy(pc), 1);
          await assignItemToSlot(pc, { slotType: "gear", slotKey: "mainHand" }, axe);
          assert.lengthOf(spentBy(pc), 2, "the Axe in, the Club off: one Action");
          assert.isFalse(pc.items.get(club.id).system.equipped, "the Club came off");
          await resetActions(combat, of(pc).id);
          const hat = await createTestItem(pc, "item", "Hat");
          const boots = await createTestItem(pc, "item", "Boots");
          await pc.updateEmbeddedDocuments("Item", [{ _id: hat.id, "system.equipped": true }, { _id: boots.id, "system.equipped": true }]);
          assert.lengthOf(spentBy(pc), 1, "two Equipped boxes in one update: one Action");
        });

        it("undoing a Retrieve takes the gear off again", async function () {
          const club = await createTestItem(pc, "item", "Club");
          await assignItemToSlot(pc, { slotType: "gear", slotKey: "mainHand" }, club);
          assert.equal(pc.system.gearSlots.mainHand, club.id);
          await undoLast(pc);
          assert.lengthOf(spentBy(pc), 0);
          assert.equal(pc.system.gearSlots.mainHand, "");
          assert.isFalse(pc.items.get(club.id).system.equipped);
        });

        it("undoing a Cast gives back the Mana it cost - even after more was spent - and takes the card away", async function () {
          await pc.update({ "system.stats.int.value": 6 });
          const max = pc.system.mana.max;
          assert.isAtLeast(max, 4, "room to spend");
          await pc.update({ "system.mana.value": max });
          const zap = await createTestItem(pc, "spell", "Zap", { system: { rank: 1, manaCost: 2, governingStat: "int" } });
          const message = await CarlDice.rollSkillCheck(pc, zap, { skipDialog: true });
          assert.exists(message);
          assert.equal(pc.system.mana.value, max - 2);
          await pc.update({ "system.mana.value": max - 3 }); // something else spent 1 more
          await undoLast(pc);
          assert.equal(pc.system.mana.value, max - 1, "the Cast's 2 back, the other 1 still spent");
          assert.notExists(game.messages.get(message.id));
          assert.lengthOf(spentBy(pc), 0);
        });

        it("undoing a declared Attack withdraws it", async function () {
          await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          assert.lengthOf(declaredAttacks(combat), 1);
          assert.lengthOf(spentBy(mob), 1);
          await undoLast(mob);
          assert.lengthOf(declaredAttacks(combat), 0, "withdrawn");
          assert.lengthOf(spentBy(mob), 0, "the Action back");
        });

        it("two declarations started at once are two Actions - the second waits its turn", async function () {
          const declare = () => withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          await Promise.all([declare(), declare()]);
          const declared = declaredAttacks(combat);
          assert.lengthOf(declared, 2);
          assert.lengthOf(spentBy(mob), 2, "each paid for");
          assert.sameMembers(declared.map((d) => d.action?.id), spentBy(mob).map((e) => e.id), "each tied to its own Action");

          await resetActions(combat, of(mob).id);
          for (const d of declaredAttacks(combat)) await removeDeclaration(combat, d.id);
          await mob.update({ "system.actionsPerRound": 1 });
          await Promise.all([declare(), declare()]);
          assert.lengthOf(declaredAttacks(combat), 1, "with one Action, the second is refused");
          assert.lengthOf(spentBy(mob), 1);
        });

        it("undoing a declaration gives its one-shot Debuff back once", async function () {
          await addConditionToActor(mob, "queasy");
          const queasy = () => mob.system.conditions.filter((c) => c.key === "queasy").length;
          await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          assert.equal(queasy(), 0, "spent on the declared Attack");
          await undoLast(mob);
          assert.equal(queasy(), 1, "back - once");
        });

        it("gear moved by a later Action has to be undone first", async function () {
          const club = await createTestItem(pc, "item", "Club");
          const hat = await createTestItem(pc, "item", "Hat");
          await assignItemToSlot(pc, { slotType: "gear", slotKey: "mainHand" }, club);
          await assignItemToSlot(pc, { slotType: "gear", slotKey: "head" }, hat);
          const [first] = spentBy(pc);
          await undoAction(combat, of(pc).id, first.id);
          assert.lengthOf(spentBy(pc), 2, "refused");
          assert.equal(pc.system.gearSlots.head, hat.id, "the Hat stays on");
          await undoLast(pc);
          await undoAction(combat, of(pc).id, first.id);
          assert.lengthOf(spentBy(pc), 0, "in order, both undone");
          assert.equal(pc.system.gearSlots.mainHand, "");
        });

        it("undoing a Taunt puts the Reaction card back - unless it has changed since", async function () {
          // A Taunt needs an Attack aimed at someone else to pull.
          const ally = await createTestCharacter("undo-ally");
          try {
            await withFakeTargets([{ actor: ally }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            await combat.nextTurn();
            const card = reactionCardFor(combat);
            const taunts = () => Object.keys(card.getFlag("carl-rpg", "reaction").taunts ?? {});
            const taunt = (made) => applyOp(card.id, "taunt", { byUuid: pc.uuid, byName: pc.name, mobUuid: mob.uuid, rank: 1, check: made }, game.user);
            assert.isTrue(await taunt(check));
            assert.lengthOf(taunts(), 1);
            await undoLast(pc);
            assert.lengthOf(taunts(), 0, "the Taunt is gone");
            assert.lengthOf(spentBy(pc), 0, "and its Action is back");

            assert.isTrue(await taunt({ ...check, total: 5, naturalRoll: 3 }));
            const [tauntId] = taunts();
            // The card moves on: the ally helps the (still failed) Taunt.
            await applyOp(card.id, "intervene", { byUuid: ally.uuid, byName: ally.name, ref: { type: "taunt", tauntId }, value: 1 }, game.user);
            await undoLast(pc);
            assert.lengthOf(taunts(), 1, "refused: the card changed since");
            assert.lengthOf(spentBy(pc), 1);
          } finally {
            await deleteTestActor(ally);
          }
        });

        it("an undo whose Reaction card changes while it waits takes nothing back, Action included, and says why", async function () {
          const ally = await createTestCharacter("undo-wait-ally");
          const warn = ui.notifications.warn;
          const warned = [];
          let release = () => {};
          try {
            await withFakeTargets([{ actor: ally }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            await combat.nextTurn();
            const card = reactionCardFor(combat);
            const taunts = () => Object.keys(card.getFlag("carl-rpg", "reaction").taunts ?? {});
            assert.isTrue(await applyOp(card.id, "taunt", {
              byUuid: pc.uuid, byName: pc.name, mobUuid: mob.uuid, rank: 1, check: { ...check, total: 5, naturalRoll: 3 },
            }, game.user));
            const [tauntId] = taunts();
            // Hold the card's queue, so what follows waits in it, in order:
            // the ally's Intervene, then the undo - checked (and passed)
            // before the Intervene has changed anything.
            const gate = new Promise((resolve) => { release = resolve; });
            const held = withCard(card.id, () => gate);
            const intervened = applyOp(card.id, "intervene", {
              byUuid: ally.uuid, byName: ally.name, ref: { type: "taunt", tauntId }, value: 1,
            }, game.user);
            ui.notifications.warn = (text) => { warned.push(String(text)); };
            const undone = undoLast(pc);
            release();
            await Promise.all([held, intervened, undone]);
            await settle();
            assert.lengthOf(taunts(), 1, "the Taunt stays on the card");
            assert.lengthOf(spentBy(pc), 1, "and its Action stays spent - no free Taunt");
            assert.include(warned, game.i18n.localize("CARLRPG.Actions.Undo.ReactionChanged"), "the asker is told why");
          } finally {
            release();
            ui.notifications.warn = warn;
            await deleteTestActor(ally);
          }
        });

        it("undoing a Reaction-card Taunt takes back the roll's advancement mark and cooldown", async function () {
          const ally = await createTestCharacter("undo-mark-ally");
          try {
            const tauntSkill = await createTestItem(pc, "skill", "Taunt", { system: { rank: 1, cooldown: "5 minutes", governingStat: "cha" } });
            await withFakeTargets([{ actor: ally }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            await combat.nextTurn();
            const card = reactionCardFor(combat);
            const item = () => pc.items.get(tauntSkill.id);
            assert.isFalse(!!item().system.marked, "not marked yet");
            // Rolled as the card's Taunt button rolls it (on the taunter's client), then applied.
            const taunter = { uuid: pc.uuid, name: pc.name, actor: pc };
            assert.isTrue(await rollTaunt(card, { taunter, item: item(), rank: 1, mob, mobUuid: mob.uuid }, { skipDialog: true }));
            assert.lengthOf(spentBy(pc), 1, "the Taunt's Action");
            assert.isTrue(item().system.marked, "the roll marked Taunt");
            assert.exists(item().getFlag("carl-rpg", "cooldown"), "and started its cooldown");
            const kinds = spentBy(pc)[0].undo.map((r) => r.t);
            assert.equal(kinds.at(-1), "reaction", "the card's record last, so it runs first");
            await undoLast(pc);
            assert.lengthOf(spentBy(pc), 0, "the Action is back");
            assert.lengthOf(Object.keys(card.getFlag("carl-rpg", "reaction").taunts ?? {}), 0, "the Taunt is off the card");
            assert.isFalse(!!item().system.marked, "the mark is gone");
            assert.notExists(item().getFlag("carl-rpg", "cooldown"), "and the cooldown");
          } finally {
            await deleteTestActor(ally);
          }
        });

        it("a Reaction-card op refused on the GM's client tells whoever asked - why, once", async function () {
          const ally = await createTestCharacter("refused-ally");
          // Another user's op, applied here: their notices go out on the socket.
          const asker = { id: "quenchAsker00001", name: "Asker", isGM: true, isSelf: false };
          const emit = game.socket.emit;
          const notices = [];
          game.socket.emit = function (name, payload, ...rest) {
            if (payload?.type === "userNotice") {
              notices.push(payload);
              return undefined;
            }
            return emit.call(this, name, payload, ...rest);
          };
          try {
            await withFakeTargets([{ actor: ally }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
            await combat.nextTurn();
            const card = reactionCardFor(combat);
            assert.isFalse(await applyOp(card.id, "catch", { byUuid: pc.uuid, byName: pc.name, hitId: "gone" }, asker));
            assert.deepEqual(notices.map((n) => [n.userId, n.key]), [[asker.id, "CARLRPG.Reaction.Refused"]], "told it didn't go through");
            notices.length = 0;
            await spendAction(pc, "other", "A");
            await spendAction(pc, "other", "B");
            assert.isFalse(await applyOp(card.id, "taunt", { byUuid: pc.uuid, byName: pc.name, mobUuid: mob.uuid, rank: 1, check }, asker));
            assert.deepEqual(notices.map((n) => n.key), ["CARLRPG.Actions.NoneLeft"], "told why - and only that");
            notices.length = 0;
            assert.isFalse(await applyOp(card.id, "catch", { byUuid: pc.uuid, byName: pc.name, hitId: "gone" }, game.user));
            assert.lengthOf(notices, 0, "the GM's own op: nothing sent");
          } finally {
            game.socket.emit = emit;
            await deleteTestActor(ally);
          }
        });

        it("an undo record of an unknown kind refuses the undo: nothing taken back, no Action refunded", async function () {
          await spendAction(pc, "other", "Mystery", { undo: [{ t: "mystery" }] });
          const warn = ui.notifications.warn;
          const warned = [];
          ui.notifications.warn = (text) => { warned.push(String(text)); };
          try {
            await undoLast(pc);
          } finally {
            ui.notifications.warn = warn;
          }
          assert.lengthOf(spentBy(pc), 1, "still spent");
          assert.include(warned, game.i18n.localize("CARLRPG.Actions.Undo.Blocked"), "and the asker is told");
          assert.equal(await runRecords([{ t: "mystery" }], { stopOnRefusal: true }), "Blocked", "run anyway, it refuses");
        });

        it("undo is refused once the Action's card has been acted on", async function () {
          const message = await ChatMessage.create({ content: "quench", flags: { "carl-rpg": { damageApplied: true } } });
          try {
            await spendAction(pc, "attack", "Attack: x", { undo: [{ t: "message", id: message.id }] });
            await undoLast(pc);
            assert.lengthOf(spentBy(pc), 1, "still spent");
            assert.exists(game.messages.get(message.id), "the card stays");
          } finally {
            await message.delete();
          }
        });

        it("an Attack Scroll is an Attack: AI Favor's Action can't pay for it", async function () {
          const MAGIC_MISSILE = "Compendium.carl-rpg.skills-and-spells.Item.mK52l4gB8AAiWOCw";
          const scroll = await createTestItem(pc, "item", "Scroll of Magic Missile", {
            system: { quantity: 1, consumable: { kind: "scroll", spell: { uuid: MAGIC_MISSILE, rank: 5 } } },
          });
          await pc.update({ "system.hotlist": [scroll.id], "system.details.aiFavor": 1 });
          await spendAction(pc, "attack", "A");
          await spendAction(pc, "attack", "B");
          assert.isTrue(await buyFavorAction(pc));
          assert.isNull(await useConsumable(pc, scroll, { skipDialog: true }), "refused");
          assert.exists(pc.items.get(scroll.id), "the scroll is kept");
          assert.lengthOf(spentBy(pc), 2, "the gold bubble unspent");
        });

        it("a vehicle's own weapons take no Action - its crew acts", async function () {
          // A vehicle is never a combatant (CarlRPGCombatant refuses it).
          const vehicle = await createTestVehicle("undo-vehicle", { system: { attacks: [bite] } });
          let message = null;
          try {
            assert.isNull(combatantInFight(vehicle), "not tracked");
            assert.isTrue(canAct(vehicle, "attack", { warn: false }));
            message = await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(vehicle, 0, { skipDialog: true }));
            assert.exists(message, "it fires");
          } finally {
            await message?.delete();
            await deleteTestActor(vehicle);
          }
        });
      });
    },
    { displayName: "CarlRPG: combat action tracking" },
  );
}
