/**
 * Intervene on Check and Attack cards, and the AI Favor reroll revising a
 * card in place (module/chat/check-revision.mjs; docs/intervene.md).
 */
import CarlDice from "../../dice/dice.mjs";
import { actionRecord, undoAction } from "../../helpers/actions.mjs";
import { cardFight, intervene, interveneOpen, interventionsOf, interveners } from "../../chat/check-revision.mjs";
import { rerollMessage } from "../../chat/ai-favor-reroll.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  deleteTestCombat,
  PIN_D20_MID,
  settle,
  useQuenchTimeout,
  withFakeTargets,
  withPinnedDice,
  withSetting,
} from "../helpers.mjs";

/** An unstarted combat with these actors as combatants. */
async function combatOf(...actors) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments("Combatant", actors.map((a) => ({ actorId: a.id })));
  return combat;
}

/** Delete the phase notices a test fight posted. */
async function deleteNotices(combat) {
  if (!combat?.id) return;
  await settle(150);
  const ids = game.messages.filter((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id).map((m) => m.id);
  if (ids.length) await ChatMessage.deleteDocuments(ids);
}

/** A d6 "roll" showing this face. */
const d6 = (face) => new Roll(String(face)).evaluate();

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.intervene",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("Intervene and in-place rerolls", function () {
        useQuenchTimeout(this);

        let mob;
        let pc;
        let helper;
        let other;
        let combat;
        let punch;
        let made;
        beforeEach(async function () {
          made = [];
          mob = await createTestMob("intervene-mob", { system: { stats: { dex: { value: 3 } } } });
          pc = await createTestCharacter("intervene-pc", { system: { details: { aiFavor: 2 } } });
          helper = await createTestCharacter("intervene-helper");
          other = await createTestCharacter("intervene-other");
          punch = await createTestItem(pc, "skill", "Punch", {
            name: "Punch", system: { category: "attack", isHandToHand: true, rank: 3, governingStat: "", baseDamage: { dice: "1d6" } },
          });
          combat = await combatOf(mob, pc, helper, other);
          await combat.startCombat();
        });
        afterEach(async function () {
          for (const m of made) if (m && game.messages.get(m.id)) await m.delete();
          await deleteNotices(combat);
          await deleteTestCombat(combat);
          for (const a of [mob, pc, helper, other]) await deleteTestActor(a);
        });

        const of = (actor) => combat.combatants.find((c) => c.actor === actor);
        const spentBy = (actor) => actionRecord(combat, of(actor).id).spent;
        /** Punch the Mob at a Floor where 10 + 3 falls 1-6 short of its Evade. */
        const attack = async () => {
          const message = await withSetting("currentFloor", 3, () => withPinnedDice(PIN_D20_MID, () =>
            withFakeTargets([{ actor: mob }], () => CarlDice.rollAttack(pc, punch, { skipDialog: true }))));
          made.push(message);
          return message;
        };
        const row = (message) => game.messages.get(message.id).getFlag("carl-rpg", "targetRows").t0;
        const shortBy = (message) => row(message).difficulty - game.messages.get(message.id).getFlag("carl-rpg", "aiReroll").total;

        it("turns a Near Miss into a hit on the same card, damage untouched, for the helper's Action", async function () {
          const message = await attack();
          const need = shortBy(message);
          assert.isTrue(need >= 1 && need <= 6, `the Punch falls short by ${need}`);
          assert.isFalse(row(message).hit);
          assert.isTrue(interveneOpen(message));
          assert.deepEqual(interveners(message).map((a) => a.id).sort(), [helper.id, other.id].sort(), "not the roller");
          const damage = foundry.utils.deepClone(message.getFlag("carl-rpg", "damageByType"));

          assert.isTrue(await intervene(message, { intervener: helper, roll: await d6(need) }));
          const revised = game.messages.get(message.id);
          assert.isTrue(row(revised).hit, "a hit now");
          assert.lengthOf(interventionsOf(revised), 1);
          assert.deepEqual(revised.getFlag("carl-rpg", "damageByType"), damage, "the same damage");
          assert.equal(revised.getFlag("carl-rpg", "attackTotal"), revised.getFlag("carl-rpg", "aiReroll").total + need);
          assert.lengthOf(spentBy(helper), 1, "the helper's Action");
          assert.include(spentBy(helper)[0].label, pc.name);
        });

        it("an AI Favor reroll stays on the same card, keeps the d6s, and can be Intervened on again", async function () {
          const message = await attack();
          await intervene(message, { intervener: helper, roll: await d6(1) });
          assert.isTrue(await withPinnedDice(PIN_D20_MID, () => rerollMessage(game.messages.get(message.id))));
          await settle();
          const revised = game.messages.get(message.id);
          assert.isTrue(revised.getFlag("carl-rpg", "aiReroll").used);
          assert.notOk(revised.getFlag("carl-rpg", "aiRerolled"), "not marked replaced");
          assert.lengthOf(interventionsOf(revised), 1, "the d6 carried over");
          assert.equal(pc.system.details.aiFavor, 1);
          assert.isTrue(await intervene(revised, { intervener: other, roll: await d6(2) }), "another after the reroll");
          assert.lengthOf(interventionsOf(game.messages.get(message.id)), 2);
        });

        it("two Intervenes at once both land", async function () {
          const message = await attack();
          await Promise.all([
            intervene(message, { intervener: helper, roll: await d6(1) }),
            intervene(message, { intervener: other, roll: await d6(1) }),
          ]);
          assert.lengthOf(interventionsOf(game.messages.get(message.id)), 2);
        });

        it("undoing an Intervene takes the d6 off and re-grades the card; the roller's undo waits for it", async function () {
          const message = await attack();
          const need = shortBy(message);
          await intervene(message, { intervener: helper, roll: await d6(need) });
          assert.isTrue(row(message).hit);
          await undoAction(combat, of(pc).id, spentBy(pc).at(-1).id);
          assert.exists(game.messages.get(message.id), "the Attack's own undo is refused while a d6 is on it");
          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.lengthOf(interventionsOf(game.messages.get(message.id)), 0);
          assert.isFalse(row(message).hit, "a miss again");
          assert.lengthOf(spentBy(helper), 0, "the Action back");
        });

        it("an Attack at no one: no damage on a miss, rolled when an Intervene makes it a hit, gone when that's undone", async function () {
          const preset = { advantage: "normal", difficulty: 14, modifier: 0, checked: new Set(), manaCostChoice: 0, checkedDebuffs: null };
          const message = await withPinnedDice(PIN_D20_MID, () =>
            withFakeTargets([], () => CarlDice.rollAttack(pc, punch, { presetOptions: preset })));
          made.push(message);
          assert.notExists(message.getFlag("carl-rpg", "damageByType"), "10 + 3 vs. 14: a miss, no damage");
          await intervene(message, { intervener: helper, roll: await d6(1) });
          assert.exists(game.messages.get(message.id).getFlag("carl-rpg", "damageByType"), "a hit: its damage rolled");
          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.notExists(game.messages.get(message.id).getFlag("carl-rpg", "damageByType"), "a miss again: no damage");
        });

        it("not on a Stat Check, nor once the round has moved on", async function () {
          const stat = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollStatCheck(pc, "str", { skipDialog: true }));
          made.push(stat);
          assert.isFalse(interveneOpen(stat), "no Intervene on a Stat Check (p.82)");
          const message = await attack();
          assert.exists(cardFight(message.getFlag("carl-rpg", "aiReroll")));
          await combat.update({ round: combat.round + 1 });
          assert.isFalse(interveneOpen(game.messages.get(message.id)), "closed with its round");
        });
      });
    },
    { displayName: "CarlRPG: Intervene and in-place rerolls" },
  );
}
