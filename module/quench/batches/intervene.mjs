/**
 * Intervene on Check, Attack and Driving cards and on an Attack card row's
 * Evade (kept on the row: module/chat/row-evade.mjs), and rerolls (AI Favor,
 * Fuzzy Dice) revising them in place (module/chat/check-revision.mjs;
 * docs/intervene.md; docs/reaction-card-redesign.md, phase 3).
 */
import CarlDice from "../../dice/dice.mjs";
import { actionRecord, undoAction } from "../../helpers/actions.mjs";
import { setPhase } from "../../helpers/combat-phases.mjs";
import { rollDrivingCheck } from "../../helpers/vehicle-driving.mjs";
import {
  cardFight,
  intervene,
  interveneOpen,
  interveneRow,
  interventionsOf,
  interveners,
  rerollSources,
} from "../../chat/check-revision.mjs";
import { canReroll, rerollMessage, rerollRow } from "../../chat/ai-favor-reroll.mjs";
import { applyRow, evadeRow } from "../../chat/attack-targets-card.mjs";
import {
  rowInjury,
  rowInterveneOpen,
  rowInterveners,
  rowRerollSources,
} from "../../chat/row-evade.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  createTestVehicle,
  deleteTestActor,
  deleteTestCombat,
  PIN_D20_MID,
  pressDialog,
  settle,
  useQuenchTimeout,
  withDialog,
  withFakeTargets,
  withPinnedDice,
  withSetting,
} from "../helpers.mjs";

/** An unstarted combat with these actors as combatants. */
async function combatOf(...actors) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments(
    "Combatant",
    actors.map((a) => ({ actorId: a.id })),
  );
  return combat;
}

/** Delete the phase notices a test fight posted. */
async function deleteNotices(combat) {
  if (!combat?.id) return;
  await settle(150);
  const ids = game.messages
    .filter((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id)
    .map((m) => m.id);
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
            name: "Punch",
            system: {
              category: "attack",
              isHandToHand: true,
              rank: 3,
              governingStat: "",
              baseDamage: { dice: "1d6" },
            },
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
          const message = await withSetting("currentFloor", 3, () =>
            withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: mob }], () =>
                CarlDice.rollAttack(pc, punch, { skipDialog: true }),
              ),
            ),
          );
          made.push(message);
          return message;
        };
        const row = (message) => game.messages.get(message.id).getFlag("carl-rpg", "targetRows").t0;
        const shortBy = (message) =>
          row(message).difficulty -
          game.messages.get(message.id).getFlag("carl-rpg", "aiReroll").total;

        it("turns a Near Miss into a hit on the same card, damage untouched, for the helper's Action", async function () {
          const message = await attack();
          const need = shortBy(message);
          assert.isTrue(need >= 1 && need <= 6, `the Punch falls short by ${need}`);
          assert.isFalse(row(message).hit);
          assert.isTrue(interveneOpen(message));
          assert.deepEqual(
            interveners(message)
              .map((a) => a.id)
              .sort(),
            [helper.id, other.id].sort(),
            "not the roller",
          );
          const damage = foundry.utils.deepClone(message.getFlag("carl-rpg", "damageByType"));

          assert.isTrue(await intervene(message, { intervener: helper, roll: await d6(need) }));
          const revised = game.messages.get(message.id);
          assert.isTrue(row(revised).hit, "a hit now");
          assert.lengthOf(interventionsOf(revised), 1);
          assert.deepEqual(revised.getFlag("carl-rpg", "damageByType"), damage, "the same damage");
          assert.equal(
            revised.getFlag("carl-rpg", "attackTotal"),
            revised.getFlag("carl-rpg", "aiReroll").total + need,
          );
          assert.lengthOf(spentBy(helper), 1, "the helper's Action");
          assert.include(spentBy(helper)[0].label, pc.name);
        });

        it("an AI Favor reroll stays on the same card, keeps the d6s, and can be Intervened on again", async function () {
          const message = await attack();
          await intervene(message, { intervener: helper, roll: await d6(1) });
          assert.isTrue(
            await withPinnedDice(PIN_D20_MID, () => rerollMessage(game.messages.get(message.id))),
          );
          await settle();
          const revised = game.messages.get(message.id);
          assert.isTrue(revised.getFlag("carl-rpg", "aiReroll").used);
          assert.notOk(revised.getFlag("carl-rpg", "aiRerolled"), "not marked replaced");
          assert.lengthOf(interventionsOf(revised), 1, "the d6 carried over");
          assert.equal(pc.system.details.aiFavor, 1);
          assert.isTrue(
            await intervene(revised, { intervener: other, roll: await d6(2) }),
            "another after the reroll",
          );
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
          assert.exists(
            game.messages.get(message.id),
            "the Attack's own undo is refused while a d6 is on it",
          );
          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.lengthOf(interventionsOf(game.messages.get(message.id)), 0);
          assert.isFalse(row(message).hit, "a miss again");
          assert.lengthOf(spentBy(helper), 0, "the Action back");
        });

        it("an Attack at no one: no damage on a miss, rolled when an Intervene makes it a hit, gone when that's undone", async function () {
          const preset = {
            advantage: "normal",
            difficulty: 14,
            modifier: 0,
            checked: new Set(),
            manaCostChoice: 0,
            checkedDebuffs: null,
          };
          const message = await withPinnedDice(PIN_D20_MID, () =>
            withFakeTargets([], () => CarlDice.rollAttack(pc, punch, { presetOptions: preset })),
          );
          made.push(message);
          assert.notExists(
            message.getFlag("carl-rpg", "damageByType"),
            "10 + 3 vs. 14: a miss, no damage",
          );
          await intervene(message, { intervener: helper, roll: await d6(1) });
          assert.exists(
            game.messages.get(message.id).getFlag("carl-rpg", "damageByType"),
            "a hit: its damage rolled",
          );
          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.notExists(
            game.messages.get(message.id).getFlag("carl-rpg", "damageByType"),
            "a miss again: no damage",
          );
        });

        it("not on a Stat Check, nor once the round has moved on", async function () {
          const stat = await withPinnedDice(PIN_D20_MID, () =>
            CarlDice.rollStatCheck(pc, "str", { skipDialog: true }),
          );
          made.push(stat);
          assert.isFalse(interveneOpen(stat), "no Intervene on a Stat Check (p.82)");
          const message = await attack();
          assert.exists(cardFight(message.getFlag("carl-rpg", "aiReroll")));
          await combat.update({ round: combat.round + 1 });
          assert.isFalse(interveneOpen(game.messages.get(message.id)), "closed with its round");
        });
      });

      describe("Stage 2: a row's Evade and a Driving Check, revised in place", function () {
        useQuenchTimeout(this);

        let mob;
        let pc;
        let helper;
        let other;
        let combat;
        let vehicles;
        let before;
        beforeEach(async function () {
          before = new Set(game.messages.keys());
          vehicles = [];
          mob = await createTestMob("stage2-mob", { system: { actionsPerRound: 6 } });
          pc = await createTestCharacter("stage2-pc", { system: { details: { aiFavor: 2 } } });
          helper = await createTestCharacter("stage2-helper");
          other = await createTestCharacter("stage2-other");
          combat = await combatOf(mob, pc, helper, other);
          await combat.startCombat();
          // Crawler Actions: a Mob Attack now posts its card at once.
          await setPhase(combat, "act");
        });
        afterEach(async function () {
          await settle(150);
          const ids = game.messages.filter((m) => !before.has(m.id)).map((m) => m.id);
          if (ids.length) await ChatMessage.deleteDocuments(ids);
          await deleteTestCombat(combat);
          for (const a of [...vehicles, mob, pc, helper, other]) await deleteTestActor(a);
        });

        const of = (actor) => combat.combatants.find((c) => c.actor === actor);
        const spentBy = (actor) => actionRecord(combat, of(actor).id).spent;
        const flag = (message, key) => game.messages.get(message.id).getFlag("carl-rpg", key);
        const newMessages = (pred) => game.messages.filter((m) => !before.has(m.id) && pred(m));
        const rowOf = (attack) => flag(attack, "targetRows").t0;
        const checkOf = (attack, which = "evade") => rowOf(attack).checks?.[which] ?? null;
        /** Cards posted since the Attack (an Evade posts none now). */
        const postedAfter = (attack) =>
          newMessages(
            (m) =>
              m.id !== attack.id &&
              !m.getFlag("carl-rpg", "phaseNotice") &&
              m.timestamp >= attack.timestamp,
          );

        /** pc's Evade total with the pinned d20 (seated or not). */
        const evadeTotal = async () =>
          (
            await withPinnedDice(PIN_D20_MID, () =>
              CarlDice.rollEvadeCheck(pc, {
                difficulty: 0,
                skipDialog: true,
                post: false,
                isAction: false,
              }),
            )
          ).total;

        /** The Mob's Attack on pc, its to-hit `beyond` pc's Evade total. */
        const mobAttack = async (beyond) => {
          const total = await evadeTotal();
          const old = mob.items.filter((i) => i.type === "mobAttack").map((i) => i.id);
          if (old.length) await mob.deleteEmbeddedDocuments("Item", old);
          await mob.createEmbeddedDocuments("Item", [
            {
              name: "Claw",
              type: "mobAttack",
              system: { toHit: String(total + beyond), damage: "1d4" },
            },
          ]);
          await withFakeTargets([{ actor: pc }], () =>
            CarlDice.rollMobAttack(mob, 0, { skipDialog: true }),
          );
          await settle();
          const attack = newMessages(
            (m) => m.getFlag("carl-rpg", "targetRows") && m.speaker?.actor === mob.id,
          ).at(-1);
          assert.exists(attack, "the Mob's Attack card");
          return attack;
        };

        /** pc rolls the row's Evade (kept on the row). */
        const evade = async (attack) => {
          await withPinnedDice(PIN_D20_MID, () => evadeRow(attack, "t0", { skipDialog: true }));
          await settle();
          return game.messages.get(attack.id);
        };
        const help = async (attack, which, value) =>
          interveneRow(game.messages.get(attack.id), "t0", which, {
            intervener: helper,
            roll: await d6(value),
          });

        it("a row's Near Miss Evade made a Success on the row, for the helper's Action - no card posted", async function () {
          const attack = await mobAttack(1);
          await evade(attack);
          assert.equal(checkOf(attack).degree, "nearMissFail");
          assert.isFalse(rowOf(attack).evade.success);
          assert.lengthOf(postedAfter(attack), 0, "the Evade posts no card");
          assert.isTrue(rowInterveneOpen(game.messages.get(attack.id), "t0", "evade"));
          assert.deepEqual(
            rowInterveners(game.messages.get(attack.id), "t0", "evade")
              .map((a) => a.id)
              .sort(),
            [helper.id, other.id].sort(),
            "not the evader",
          );

          assert.isTrue(await help(attack, "evade", 1));
          assert.isTrue(rowOf(attack).evade.success, "Evaded now");
          assert.equal(checkOf(attack).degree, "standardSuccess");
          assert.lengthOf(checkOf(attack).interventions, 1);
          assert.lengthOf(postedAfter(attack), 0, "still no card");
          assert.lengthOf(spentBy(helper), 1, "the helper's Action");
          assert.lengthOf(spentBy(pc), 1, "pc's own Evade Action, once");
        });

        it("an occupant's Near Miss: the hit on the vehicle goes, and comes back on undo", async function () {
          const ride = await createTestVehicle("stage2-ride", { system: { move: 0 } });
          vehicles.push(ride);
          await ride.update({
            "system.occupants": [{ uuid: pc.uuid, role: "passenger", name: pc.name }],
            "system.parked": true,
          });
          const attack = await mobAttack(1);
          await evade(attack);
          assert.equal(checkOf(attack).degree, "nearMissFail");
          assert.equal(
            rowOf(attack).redirectUuid,
            ride.uuid,
            "a Near Miss on an occupant hits the vehicle (p.72)",
          );

          await help(attack, "evade", 2);
          assert.isNull(rowOf(attack).redirectUuid, "Evaded: nothing hits the vehicle");

          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.lengthOf(checkOf(attack).interventions, 0);
          assert.equal(rowOf(attack).redirectUuid, ride.uuid, "the vehicle is hit again");
          assert.isFalse(rowOf(attack).evade.success);
        });

        it("a Major Fail helped to a Standard Fail loses its injury, and gets it back on undo", async function () {
          const attack = await mobAttack(10);
          await evade(attack);
          assert.equal(checkOf(attack).degree, "majorFail");
          assert.equal(rowInjury(rowOf(attack)), "minorInjury");

          await help(attack, "evade", 6);
          assert.equal(checkOf(attack).degree, "standardFail");
          assert.isNull(rowInjury(rowOf(attack)), "no injury now");
          assert.equal(rowOf(attack).evade.degree, "standardFail");

          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.equal(checkOf(attack).degree, "majorFail");
          assert.equal(rowInjury(rowOf(attack)), "minorInjury");
        });

        it("a free Evade: failed, helped to a Success, undone, then the paid Evade replaces it", async function () {
          const attack = await mobAttack(1);
          await attack.update({ "flags.carl-rpg.targetRows.t0.freeEvade": true });
          await evade(attack);
          assert.exists(checkOf(attack, "free"));
          assert.isNull(rowOf(attack).evade, "a failed free Evade decides nothing");
          assert.isTrue(rowOf(attack).freeUsed);
          assert.lengthOf(spentBy(pc), 0, "free");

          await help(attack, "free", 1);
          assert.isTrue(
            rowOf(attack).evade.success,
            "helped to a Success: Evaded, no paid Evade needed",
          );

          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          assert.isNull(rowOf(attack).evade, "failed again");
          assert.isTrue(rowOf(attack).freeUsed);
          assert.isTrue(
            rowInterveneOpen(game.messages.get(attack.id), "t0", "free"),
            "still open until a paid Evade",
          );

          await evade(attack);
          assert.exists(checkOf(attack, "evade"), "the paid Evade");
          assert.lengthOf(spentBy(pc), 1, "the paid Evade's Action");
          assert.isFalse(
            rowInterveneOpen(game.messages.get(attack.id), "t0", "free"),
            "the free Evade is replaced",
          );
          assert.lengthOf(rowRerollSources(game.messages.get(attack.id), "t0", "free"), 0);
          assert.isTrue(rowInterveneOpen(game.messages.get(attack.id), "t0", "evade"));
        });

        it("a row's Evade AI Favor reroll stays on the row; applying the row closes it", async function () {
          const attack = await mobAttack(1);
          await evade(attack);
          assert.lengthOf(rowRerollSources(game.messages.get(attack.id), "t0", "evade"), 1);
          assert.isTrue(
            await withPinnedDice(PIN_D20_MID, () =>
              rerollRow(game.messages.get(attack.id), "t0", "evade"),
            ),
          );
          await settle();
          assert.exists(checkOf(attack).aiRerolled, "the old result kept for the record");
          assert.equal(pc.system.details.aiFavor, 1);
          assert.lengthOf(
            rowRerollSources(game.messages.get(attack.id), "t0", "evade"),
            0,
            "once per Check",
          );
          assert.lengthOf(postedAfter(attack), 0, "no card");

          assert.isTrue(rowInterveneOpen(game.messages.get(attack.id), "t0", "evade"));
          await applyRow(game.messages.get(attack.id), rowOf(attack));
          assert.isFalse(
            rowInterveneOpen(game.messages.get(attack.id), "t0", "evade"),
            "the row is applied",
          );
        });

        it("undoing the row's Evade puts the row back - not while someone's d6 is on it", async function () {
          const attack = await mobAttack(1);
          await evade(attack);
          await help(attack, "evade", 1);
          const evadeEntry = () => spentBy(pc).find((e) => e.tag === "evade");
          await undoAction(combat, of(pc).id, evadeEntry().id);
          assert.exists(checkOf(attack), "refused: Intervene first");
          await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
          await undoAction(combat, of(pc).id, evadeEntry().id);
          assert.isNull(checkOf(attack), "the Evade is gone");
          assert.isNull(rowOf(attack).evade);
          assert.lengthOf(spentBy(pc), 0, "and its Action is back");
        });

        /** pc at the wheel of a new vehicle, with Driving at Rank 10. */
        const drive = async (data = {}) => {
          if (!pc.items.find((i) => i.name === "Driving")) {
            await pc.createEmbeddedDocuments("Item", [
              {
                name: "Driving",
                type: "skill",
                system: { rank: 10, governingStat: "dex", category: "utility" },
              },
            ]);
          }
          const v = await createTestVehicle(
            "stage2-car",
            foundry.utils.mergeObject({ system: { move: 80 } }, data),
          );
          vehicles.push(v);
          await v.update({
            "system.occupants": [{ uuid: pc.uuid, role: "driver", name: pc.name }],
            "system.parked": false,
          });
          return v;
        };
        const drivingCards = (v) =>
          newMessages((m) => m.getFlag("carl-rpg", "driving")?.vehicleUuid === v.uuid);
        const rollDriving = async (v) => {
          await withPinnedDice(PIN_D20_MID, () => rollDrivingCheck(v, { skipDialog: true }));
          await settle();
          return drivingCards(v).at(-1);
        };

        it("a Driving Check's AI Favor reroll stays on the card and keeps its Check id", async function () {
          await withSetting("currentFloor", 1, async () => {
            const v = await drive();
            const card = await rollDriving(v);
            const checkId = flag(card, "driving").checkId;
            assert.isTrue(await withPinnedDice(PIN_D20_MID, () => rerollMessage(card)));
            await settle();
            assert.lengthOf(drivingCards(v), 1, "no new card");
            assert.equal(flag(card, "driving").checkId, checkId);
            assert.equal(v.system.round.checkId, checkId, "the round is still this card's");
            assert.equal(v.system.round.degree, flag(card, "driving").degree);
            assert.isTrue(flag(card, "aiReroll").used);
            assert.deepEqual(flag(card, "driving").rerolledBy, ["favor"]);
            assert.equal(pc.system.details.aiFavor, 1);
            assert.isFalse(canReroll(game.messages.get(card.id)), "once per Check");
          });
        });

        it("Intervene on a Driving Check: the round's result follows, and returns on undo", async function () {
          // Learn the Check's total, then pick the Floor that makes it a Near Miss.
          const probeTotal = await withSetting("currentFloor", 1, async () => {
            const v = await drive();
            const total = flag(await rollDriving(v), "driving").roll.total;
            // Off the road, so the real Check's vehicle is pc's only seat.
            vehicles.splice(vehicles.indexOf(v), 1);
            await deleteTestActor(v);
            return total;
          });
          const floor = Math.ceil((probeTotal - 10 + 1) / 2);
          await withSetting("currentFloor", floor, async () => {
            const v = await drive();
            const card = await rollDriving(v);
            assert.equal(
              flag(card, "driving").degree,
              "nearMissFail",
              `${probeTotal} vs. 10 + 2 x ${floor}`,
            );
            assert.equal(v.system.round.degree, "nearMissFail");
            assert.isTrue(interveneOpen(card));

            assert.isTrue(await intervene(card, { intervener: helper, roll: await d6(2) }));
            assert.equal(flag(card, "driving").degree, "standardSuccess");
            assert.equal(v.system.round.degree, "standardSuccess", "full Move this round");
            assert.equal(v.system.round.checkId, flag(card, "driving").checkId);
            assert.lengthOf(drivingCards(v), 1, "no new card");

            await undoAction(combat, of(helper).id, spentBy(helper)[0].id);
            assert.equal(flag(card, "driving").degree, "nearMissFail");
            assert.equal(v.system.round.degree, "nearMissFail");
          });
        });

        it("Fuzzy Dice and AI Favor: a picker with both, each once, the same card", async function () {
          await withSetting("currentFloor", 1, async () => {
            const v = await drive({ system: { upgrades: { fuzzyDice: { installed: true } } } });
            const card = await rollDriving(v);
            assert.deepEqual(
              rerollSources(card).map((s) => s.key),
              ["favor", "fuzzyDice"],
            );

            const went = await withPinnedDice(PIN_D20_MID, () =>
              withDialog(
                () => rerollMessage(card),
                (dialog) => {
                  dialog.element.querySelector('input[value="fuzzyDice"]').checked = true;
                  pressDialog(dialog, "ok");
                },
                "carl-reroll-pick",
              ),
            );
            assert.isTrue(went);
            await settle();
            assert.equal(
              v.system.upgrades.fuzzyDice.usedFloor,
              1,
              "the Fuzzy Dice are used for this Floor",
            );
            assert.equal(pc.system.details.aiFavor, 2, "no AI Favor spent");
            assert.deepEqual(flag(card, "driving").rerolledBy, ["fuzzyDice"]);
            assert.lengthOf(drivingCards(v), 1, "no new card");

            const left = rerollSources(game.messages.get(card.id));
            assert.deepEqual(
              left.map((s) => s.key),
              ["favor"],
              "AI Favor still on offer",
            );
            assert.isTrue(
              await withPinnedDice(PIN_D20_MID, () => rerollMessage(game.messages.get(card.id))),
              "one source: no picker",
            );
            await settle();
            assert.equal(pc.system.details.aiFavor, 1);
            assert.deepEqual(flag(card, "driving").rerolledBy, ["fuzzyDice", "favor"]);
            assert.lengthOf(rerollSources(game.messages.get(card.id)), 0);
          });
        });
      });
    },
    { displayName: "CarlRPG: Intervene and in-place rerolls" },
  );
}
