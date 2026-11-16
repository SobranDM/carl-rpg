/**
 * The phased PvE round (module/helpers/combat-phases.mjs, CarlRPGCombat's
 * cycle overrides, module/apps/combat-tracker.mjs; docs/combat-phases.md).
 */
import { CarlRPGCombatTracker } from "../../apps/combat-tracker.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { currentPhase, isPhased, usesPhases } from "../../helpers/combat-phases.mjs";
import { declaredAttacks, recordDeclaration, removeDeclaration } from "../../helpers/declarations.mjs";
import { DECLARED_MARK_NAME, declaredCounts, drawMark } from "../../helpers/declared-marks.mjs";
import { CarlDeclareHud } from "../../apps/declare-hud.mjs";
import CarlDice from "../../dice/dice.mjs";
import { applyOp, decorateReactionCard, reactionActionEntries, reactionCardFor } from "../../chat/reaction-card.mjs";
import {
  crawlerKey, decidingEvade, evadableHitsFor, hitEvadable, hitList, hitMissed, tauntList,
} from "../../helpers/reaction-state.mjs";
import {
  buildDamageState, damageCardActionEntries, damageCardFor, decorateDamageCard, postDamageCard, rollAllDamage,
  rollAttackOnCard, unrolledAttacks,
} from "../../helpers/reaction-resolve.mjs";
import {
  createTestCharacter,
  createTestMob,
  deleteTestActor,
  deleteTestCombat,
  PIN_D20_MID,
  pressDialog,
  settle,
  useQuenchTimeout,
  waitFor,
  withDialog,
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

/** Delete the phase notices a test combat posted. */
async function deleteNotices(combat) {
  if (!combat?.id) return;
  // The round-start notice is posted from _onStartRound, just after the
  // update that started the round resolves.
  await settle(150);
  const ids = game.messages.filter((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id
    || m.getFlag("carl-rpg", "reaction")?.combatId === combat.id
    || m.getFlag("carl-rpg", "reactionDamage")?.combatId === combat.id).map((m) => m.id);
  if (ids.length) await ChatMessage.deleteDocuments(ids);
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.combat-phases",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("The phased round", function () {
        useQuenchTimeout(this);

        let mob;
        let pc;
        let combat;
        beforeEach(async function () {
          mob = await createTestMob("phase-mob");
          pc = await createTestCharacter("phase-pc");
          combat = await combatOf(mob, pc);
        });
        afterEach(async function () {
          await deleteNotices(combat);
          await deleteTestCombat(combat);
          await deleteTestActor(mob);
          await deleteTestActor(pc);
        });

        it("a fight with a Mob is phased once started, with no combatant on turn", async function () {
          assert.isTrue(usesPhases(combat));
          assert.isFalse(isPhased(combat), "not before it starts");
          assert.isNull(currentPhase(combat));
          await combat.startCombat();
          assert.equal(combat.round, 1);
          assert.isTrue(isPhased(combat));
          assert.equal(currentPhase(combat), "declare");
          assert.isNull(combat.turn, "no turn is current");
          assert.deepEqual(combat.getFlag("carl-rpg", "phase"), { round: 1, step: "declare" });
        });

        it("Next Phase runs declare -> react -> act, and End Round returns to declare", async function () {
          await combat.startCombat();
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "react");
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "act");
          await combat.nextTurn();
          assert.equal(combat.round, 2, "End Round advances the round");
          assert.equal(currentPhase(combat), "declare");
          assert.deepEqual(combat.getFlag("carl-rpg", "phase"), { round: 2, step: "declare" });
        });

        it("a round only ends from the Crawler Action Phase", async function () {
          await combat.startCombat();
          await combat.nextRound();
          assert.equal(combat.round, 1, "refused in declare");
          await combat.nextTurn();
          await combat.nextRound();
          assert.equal(combat.round, 1, "refused in react");
          await combat.nextTurn();
          await combat.nextRound();
          assert.equal(combat.round, 2, "allowed from act");
        });

        it("End Round still runs Clean Up (durations tick)", async function () {
          await addConditionToActor(pc, "blinded");
          const remaining = () => pc.system.conditions.find((c) => c.key === "blinded")?.remaining;
          await combat.startCombat();
          assert.equal(remaining(), 2);
          await combat.nextTurn();
          await combat.nextTurn();
          await combat.nextTurn();
          await waitFor(() => remaining() === 1, { message: "Blinded never ticked down at End Round" });
        });

        it("a double-click on Next Phase advances one step", async function () {
          await combat.startCombat();
          await combat.nextTurn();
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "act");
          await Promise.all([combat.nextTurn(), combat.nextTurn()]);
          assert.equal(combat.round, 2);
          assert.equal(currentPhase(combat), "declare", "the second click didn't skip Declaration");
        });

        it("going back to Declaration isn't announced as a new round", async function () {
          await combat.startCombat();
          await combat.nextTurn();
          await combat.previousTurn();
          const notices = () => game.messages
            .map((m) => m.getFlag("carl-rpg", "phaseNotice"))
            .filter((n) => n?.combatId === combat.id && n.step === "declare");
          await waitFor(() => notices().length === 2, { message: "expected the round-start and the rewind notices" });
          assert.deepEqual(notices().map((n) => n.roundStart).sort(), [false, true]);
        });

        it("Previous Phase steps back from react only", async function () {
          await combat.startCombat();
          await combat.nextTurn();
          await combat.previousTurn();
          assert.equal(currentPhase(combat), "declare", "react -> declare");
          await combat.nextTurn();
          await combat.nextTurn();
          await combat.previousTurn();
          assert.equal(currentPhase(combat), "act", "act refuses to go back");
        });

        it("Surprise comes before round 1's declaration when ticked", async function () {
          await combat.setSurprise(true);
          await combat.startCombat();
          assert.equal(currentPhase(combat), "surprise");
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "declare");
          assert.equal(combat.round, 1);
        });

        it("a phase flag from another round reads as declare", async function () {
          await combat.startCombat();
          await combat.setFlag("carl-rpg", "phase", { round: 7, step: "act" });
          assert.equal(currentPhase(combat), "declare");
        });

        it("rewinding a round resets it to declare", async function () {
          await combat.startCombat();
          await combat.nextTurn();
          await combat.nextTurn();
          await combat.nextTurn();
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "react");
          await combat.previousRound();
          assert.equal(combat.round, 1);
          assert.equal(currentPhase(combat), "declare");
        });

        it("each step change posts a phase notice", async function () {
          await combat.startCombat();
          await combat.nextTurn();
          await waitFor(() => game.messages.some((m) => {
            const notice = m.getFlag("carl-rpg", "phaseNotice");
            return notice?.combatId === combat.id && notice.step === "react";
          }), { message: "no Reaction notice was posted" });
        });

        it("the tracker shows the phase bar and groups Mobs and Crawlers", async function () {
          assert.instanceOf(ui.combat, CarlRPGCombatTracker);
          await combat.startCombat();
          await combat.activate();
          await ui.combat.render({ force: true, combat });
          await waitFor(() => ui.combat.element?.querySelector(".carl-phase-step.active"), { message: "no phase bar" });
          const el = ui.combat.element;
          assert.equal(el.querySelector(".carl-phase-step.active").dataset.step, "declare");
          const groups = [...el.querySelectorAll(".carl-combat-group")].map((g) => g.dataset.group);
          assert.deepEqual(groups, ["mobs", "crawlers"]);
          assert.notExists(el.querySelector(".combat-tracker .token-initiative"), "no initiative column");
          assert.exists(el.querySelector(".carl-next-phase"), "the GM's Next Phase button");
        });
      });

      describe("Declaring Mob Attacks", function () {
        useQuenchTimeout(this);

        const bite = { name: "Bite", toHit: "14+F", damage: "1d6+F", damageType: "piercing", range: "", effect: "" };
        let mob;
        let pc;
        let combat;
        beforeEach(async function () {
          // Several declarations a round: more Actions than a plain Mob's one
          // (helpers/actions.mjs - its own batch tests the budgets).
          mob = await createTestMob("declare-mob", { system: { attacks: [bite], actionsPerRound: 6 } });
          pc = await createTestCharacter("declare-pc");
          combat = await combatOf(mob, pc);
          await combat.startCombat();
        });
        afterEach(async function () {
          await deleteNotices(combat);
          await deleteTestCombat(combat);
          await deleteTestActor(mob);
          await deleteTestActor(pc);
        });

        const declare = () => withSetting("currentFloor", 2, () =>
          withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true })));
        const mobCards = () => game.messages.filter((m) => m.speaker?.actor === mob.id && m.getFlag("carl-rpg", "targetRows"));

        it("in Declaration an Attack is recorded, not rolled", async function () {
          const result = await declare();
          assert.isNull(result, "no card");
          assert.lengthOf(mobCards(), 0, "nothing posted to chat");
          const [d] = declaredAttacks(combat);
          assert.exists(d);
          assert.equal(d.attackName, "Bite");
          assert.equal(d.damage, "1d6+F", "the formula is kept for Resolution, not rolled");
          assert.equal(d.damageType, "piercing");
          assert.isFalse(d.damageIsMagic);
          assert.equal(d.difficulty, 16, "to-hit 14 + Floor 2");
          assert.equal(d.round, 1);
          const rows = Object.values(d.targetRows);
          assert.lengthOf(rows, 1);
          assert.equal(rows[0].name, pc.name);
          assert.isTrue(rows[0].hit);
          assert.notProperty(d, "damageByType");
        });

        it("a declaration can be withdrawn", async function () {
          await declare();
          await declare();
          const [first, second] = declaredAttacks(combat);
          await removeDeclaration(combat, first.id);
          assert.deepEqual(declaredAttacks(combat).map((d) => d.id), [second.id]);
        });

        it("a new round starts with no declarations", async function () {
          await declare();
          assert.lengthOf(declaredAttacks(combat), 1);
          await combat.nextTurn();
          // The Attack lands on a crawler who hasn't Evaded: Lock Results asks first.
          await withDialog(() => combat.nextTurn(), (dialog) => pressDialog(dialog, "yes"), "carl-lock-warning");
          assert.equal(currentPhase(combat), "resolve");
          // Its damage is unrolled: leaving Resolution offers to roll it.
          await withDialog(() => combat.nextTurn(), (dialog) => pressDialog(dialog, "yes"), "carl-unrolled-warning");
          assert.equal(currentPhase(combat), "act");
          await combat.nextTurn();
          assert.equal(combat.round, 2);
          assert.lengthOf(declaredAttacks(combat), 0, "last round's are gone");
          await declare();
          assert.lengthOf(declaredAttacks(combat), 1);
          assert.equal(combat.getFlag("carl-rpg", "declared").round, 2, "the store was replaced for the new round");
          assert.lengthOf(Object.keys(combat.getFlag("carl-rpg", "declared").attacks), 1);
        });

        it("outside Declaration a Mob Attack still resolves at once", async function () {
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "react");
          const message = await declare();
          try {
            assert.exists(message, "a card was posted");
            assert.isNotEmpty(message.getFlag("carl-rpg", "damageByType"), "damage rolled");
            assert.lengthOf(declaredAttacks(combat), 0);
          } finally {
            await message?.delete();
          }
        });

        it("with nothing targeted, Declaration refuses instead of posting a preview", async function () {
          const result = await withFakeTargets([], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
          assert.isNull(result);
          assert.lengthOf(mobCards(), 0);
          assert.lengthOf(game.messages.filter((m) => m.speaker?.actor === mob.id && m.getFlag("carl-rpg", "damageByType")), 0,
            "no damage preview card");
          assert.lengthOf(declaredAttacks(combat), 0);
        });

        it("withdrawing a declaration gives back the one-shot Debuffs it spent", async function () {
          await addConditionToActor(mob, "queasy");
          const queasy = () => mob.system.conditions.some((c) => c.key === "queasy");
          await declare();
          assert.isFalse(queasy(), "spent on the declared Attack");
          await removeDeclaration(combat, declaredAttacks(combat)[0].id);
          assert.isTrue(queasy(), "back after withdrawing");
        });

        it("two declarations at the start of a round both survive", async function () {
          await combat.nextTurn();
          await combat.nextTurn();
          await combat.nextTurn();
          assert.equal(combat.round, 2);
          await Promise.all([declare(), declare()]);
          assert.lengthOf(declaredAttacks(combat), 2);
        });

        it("the Declare HUD shows a controlled Mob's Attacks, declares on click and withdraws", async function () {
          const hud = game.carlrpg.declareHud;
          assert.instanceOf(hud, CarlDeclareHud);
          const original = CarlDeclareHud.declaringMobs;
          const fakeToken = { id: "quenchFakeToken", name: mob.name, document: { uuid: "Scene.none.Token.quenchFakeToken" } };
          CarlDeclareHud.declaringMobs = () => [{ token: fakeToken, actor: mob, combat }];
          const button = () => hud.element?.querySelector('[data-action="declare"]');
          const shiftClick = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
          try {
            await hud.render({ force: true });
            await waitFor(() => button(), { message: "the HUD never showed the Attack" });
            assert.equal(hud.element.parentElement?.id, "ui-right-column-1", "beside the sidebar");
            assert.include(button().textContent, "Bite");

            await withFakeTargets([], async () => {
              shiftClick(button());
              await settle(150);
            });
            assert.lengthOf(declaredAttacks(combat), 0, "nothing targeted: nothing declared");

            await withFakeTargets([{ actor: pc }], async () => {
              shiftClick(button());
              await waitFor(() => declaredAttacks(combat).length === 1, { message: "the click didn't declare" });
            });
            await hud.render({ force: true });
            await waitFor(() => hud.element?.querySelector('[data-action="removeDeclaration"]'), { message: "no declared entry" });
            hud.element.querySelector('[data-action="removeDeclaration"]').click();
            await waitFor(() => declaredAttacks(combat).length === 0, { message: "the remove button didn't withdraw" });
          } finally {
            CarlDeclareHud.declaringMobs = original;
            await hud.close({ animate: false });
          }
        });

        it("the HUD closes itself when no Mob in Declaration is selected", async function () {
          const hud = game.carlrpg.declareHud;
          const original = CarlDeclareHud.declaringMobs;
          const fakeToken = { id: "quenchFakeToken", name: mob.name, document: { uuid: "Scene.none.Token.quenchFakeToken" } };
          CarlDeclareHud.declaringMobs = () => [{ token: fakeToken, actor: mob, combat }];
          try {
            await hud.render({ force: true });
            await waitFor(() => hud.rendered, { message: "the HUD never opened" });
          } finally {
            CarlDeclareHud.declaringMobs = original;
          }
          assert.lengthOf(CarlDeclareHud.declaringMobs().filter((m) => m.actor === mob), 0, "no Mob token is controlled");
          hud.refresh();
          await waitFor(() => !hud.rendered, { message: "the HUD stayed open with nothing to show" });
        });

        it("a declared Mob token is counted for its mark until Declaration ends", async function () {
          await recordDeclaration(combat, { mobUuid: mob.uuid, tokenId: "quenchMarkToken", mobName: mob.name, attackName: "Bite", targetRows: {} });
          await recordDeclaration(combat, { mobUuid: mob.uuid, tokenId: "quenchMarkToken", mobName: mob.name, attackName: "Claw", targetRows: {} });
          assert.equal(declaredCounts().get("quenchMarkToken"), 2);
          await combat.nextTurn();
          assert.isUndefined(declaredCounts().get("quenchMarkToken"), "gone once Reaction starts");
        });

        it("the mark is a check, with a count for two or more, and is removed at 0", async function () {
          const token = new PIXI.Container();
          token.w = 100;
          token.h = 100;
          try {
            drawMark(token, 1);
            const mark = token.getChildByName(DECLARED_MARK_NAME);
            assert.exists(mark);
            assert.notExists(mark.children.find((c) => c instanceof PIXI.Text), "no count for one");
            drawMark(token, 3);
            const counted = token.getChildByName(DECLARED_MARK_NAME);
            assert.equal(counted.children.find((c) => c instanceof PIXI.Text)?.text, "3");
            assert.lengthOf(token.children.filter((c) => c.name === DECLARED_MARK_NAME), 1, "redrawn, not stacked");
            drawMark(token, 0);
            assert.notExists(token.getChildByName(DECLARED_MARK_NAME));
          } finally {
            token.destroy({ children: true });
          }
        });

        it("the tracker lists the GM's declarations during Declaration", async function () {
          await declare();
          await combat.activate();
          await ui.combat.render({ force: true, combat });
          await waitFor(() => ui.combat.element?.querySelector(".carl-declared-item"), { message: "no declared list" });
          const item = ui.combat.element.querySelector(".carl-declared-item");
          assert.include(item.textContent, "Bite");
          assert.include(item.textContent, pc.name);
          item.querySelector('[data-action="removeDeclaration"]').click();
          await waitFor(() => declaredAttacks(combat).length === 0, { message: "remove button didn't withdraw it" });
        });
      });

      describe("The Reaction card", function () {
        useQuenchTimeout(this);

        /** A rolled-Check payload, as a client sends it. */
        const rolled = (total, naturalRoll, difficulty) => ({ total, naturalRoll, difficulty, formula: "1d20", breakdown: "", roll: null });
        const attackWith = (toHit) => ({ name: "Maul", toHit, damage: "100", damageType: "", range: "", effect: "" });

        let mob;
        let pc1;
        let pc2;
        let combat;
        beforeEach(async function () {
          // 0: to-hit 16; 1: an easy 1; 2: an easy Area Attack; 3: a hard 40.
          mob = await createTestMob("react-mob", {
            system: {
              attacks: [attackWith("16"), attackWith("1"), { ...attackWith("1"), name: "Blast", range: "20ft Burst" }, attackWith("40")],
              actionsPerRound: 6,
            },
          });
          pc1 = await createTestCharacter("react-pc1");
          pc2 = await createTestCharacter("react-pc2");
          combat = await combatOf(mob, pc1, pc2);
          await combat.startCombat();
        });
        afterEach(async function () {
          await deleteNotices(combat);
          await deleteTestCombat(combat);
          for (const actor of [mob, pc1, pc2]) await deleteTestActor(actor);
        });

        const declareOn = (target, index = 0) => withSetting("currentFloor", 1, () =>
          withFakeTargets([{ actor: target }], () => CarlDice.rollMobAttack(mob, index, { skipDialog: true })));
        const startReaction = async () => {
          // The round-start notice lands just after startCombat - wait for it,
          // so "the card is the latest message" isn't racing it.
          await waitFor(() => game.messages.some((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id),
            { message: "no round-start notice" });
          await combat.nextTurn();
          return reactionCardFor(combat);
        };
        const hbOf = (actor) => actor.system.hb.value;
        const state = (card) => card.getFlag("carl-rpg", "reaction");
        const op = (card, name, data) => applyOp(card.id, name, data, game.user);
        const onlyHit = (card) => hitList(state(card))[0];

        it("Start Reaction posts the card last in chat, one entry per Attack and target", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          assert.exists(card, "a Reaction card");
          assert.equal(game.messages.contents.at(-1).id, card.id, "after the Reaction notice");
          const hits = hitList(state(card));
          assert.lengthOf(hits, 1);
          assert.equal(hits[0].targetUuid, pc1.uuid);
          assert.equal(state(card).stage, "taunt");
          assert.isNull(hits[0].free, "not Disadvantaged: no free Evade");
        });

        it("with nothing declared there is no card, and Lock Results goes straight to Crawler Actions", async function () {
          const card = await startReaction();
          assert.isNull(card);
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "act");
        });

        it("a Disadvantaged Attack's free Evade is rolled when the card posts", async function () {
          await addConditionToActor(mob, "terrified");
          await declareOn(pc1, 1); // to-hit 1, -5: an easy Evade
          const card = await withPinnedDice(PIN_D20_MID, () => startReaction());
          const hit = onlyHit(card);
          assert.exists(hit.free, "rolled automatically");
          assert.isTrue(hit.free.success);
          assert.isTrue(hitMissed(hit), "shown as a miss");
          assert.lengthOf(evadableHitsFor(state(card), pc1.uuid), 0, "nothing left to Evade");
        });

        it("a successful Taunt pulls the Mob's Attacks; a failed one moves nothing", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "taunt", { byUuid: pc2.uuid, byName: pc2.name, mobUuid: mob.uuid, rank: 1, check: rolled(5, 4, 20) });
          assert.equal(onlyHit(card).targetUuid, pc1.uuid, "failed: still on pc1");
          await op(card, "taunt", { byUuid: pc2.uuid, byName: pc2.name, mobUuid: mob.uuid, rank: 1, check: rolled(25, 15, 20) });
          const hit = onlyHit(card);
          assert.equal(hit.targetUuid, pc2.uuid, "pulled onto the taunter");
          assert.equal(hit.tauntedBy.uuid, pc2.uuid);
          assert.equal(hit.originalUuid, pc1.uuid);
          assert.lengthOf(tauntList(state(card)), 2);
        });

        it("Taunt Rank 5 rolls a free Evade against each Attack it pulls", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await withPinnedDice(PIN_D20_MID, () =>
            op(card, "taunt", { byUuid: pc2.uuid, byName: pc2.name, mobUuid: mob.uuid, rank: 5, check: rolled(25, 15, 20) }));
          assert.exists(onlyHit(card).free, "free Evade from Rank 5");
        });

        it("Catch moves an Attack to the Catcher, who can't Evade it", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: onlyHit(card).id });
          const hit = onlyHit(card);
          assert.equal(hit.targetUuid, pc2.uuid);
          assert.equal(hit.caughtBy.uuid, pc2.uuid);
          await op(card, "openEvades", {});
          assert.lengthOf(evadableHitsFor(state(card), pc2.uuid), 0, "the Catcher's Evade skips it");
          assert.lengthOf(evadableHitsFor(state(card), pc1.uuid), 0, "it's no longer pc1's");
        });

        it("Taunts and Catches come first, then Evades; one Evade per crawler", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          const hitId = onlyHit(card).id;
          assert.isFalse(await op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(20, 12, 16) } }), "no Evades yet");
          await op(card, "openEvades", {});
          assert.equal(state(card).stage, "evade");
          assert.isFalse(await op(card, "taunt", { byUuid: pc2.uuid, byName: pc2.name, mobUuid: mob.uuid, rank: 1, check: rolled(25, 15, 20) }),
            "no Taunts once Evades are open");
          assert.isTrue(await op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(20, 12, 16) } }));
          assert.isTrue(onlyHit(card).evade.success);
          assert.isFalse(await op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(30, 19, 16) } }), "only one Evade");
        });

        it("Intervene adds its d6 and re-grades the Check, but not on one's own", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "openEvades", {});
          const hitId = onlyHit(card).id;
          await op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(15, 10, 16) } });
          assert.equal(onlyHit(card).evade.degree, "nearMissFail");
          const ref = { type: "hit", hitId, which: "evade" };
          assert.isFalse(await op(card, "intervene", { byUuid: pc1.uuid, byName: pc1.name, ref, value: 4 }), "not your own Check");
          assert.isTrue(await op(card, "intervene", { byUuid: pc2.uuid, byName: pc2.name, ref, value: 3 }));
          const evade = onlyHit(card).evade;
          assert.equal(evade.total, 18);
          assert.isTrue(evade.success);
          assert.lengthOf(evade.interventions, 1);
        });

        it("AI Reroll spends AI Favor and replaces a failed Check - not a Natural 1", async function () {
          await pc1.update({ "system.details.aiFavor": 2 });
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "openEvades", {});
          const hitId = onlyHit(card).id;
          await op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(8, 5, 16) } });
          const ref = { type: "hit", hitId, which: "evade" };
          assert.isTrue(await op(card, "reroll", { ref, naturalRoll: 18, total: 21, roll: null, breakdown: "" }));
          const evade = onlyHit(card).evade;
          assert.isTrue(evade.success);
          assert.equal(evade.aiRerolled.base, 8, "the old result is kept for the record");
          assert.equal(pc1.system.details.aiFavor, 1, "1 AI Favor spent");
          assert.isFalse(await op(card, "reroll", { ref, naturalRoll: 19, total: 22, roll: null, breakdown: "" }), "once per Check");
        });

        it("a Natural 1 can't be rerolled", async function () {
          await pc1.update({ "system.details.aiFavor": 2 });
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "openEvades", {});
          const hitId = onlyHit(card).id;
          await op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(3, 1, 16) } });
          assert.isFalse(await op(card, "reroll", { ref: { type: "hit", hitId, which: "evade" }, naturalRoll: 18, total: 20, roll: null, breakdown: "" }));
          assert.equal(pc1.system.details.aiFavor, 2);
        });

        it("Lock Results posts the Damage card unrolled; its button rolls and applies the damage", async function () {
          await declareOn(pc1);
          await declareOn(pc2);
          const card = await startReaction();
          await op(card, "openEvades", {});
          const [hit1, hit2] = hitList(state(card));
          await op(card, "evade", { uuid: pc1.uuid, checks: { [hit1.id]: rolled(8, 5, 16) } });
          await op(card, "evade", { uuid: pc2.uuid, checks: { [hit2.id]: rolled(20, 12, 16) } });
          const hb1 = hbOf(pc1);
          const hb2 = hbOf(pc2);
          assert.isAbove(hb1, 0, "pc1 has HB to lose");
          await combat.nextTurn(); // Lock Results
          assert.isTrue(state(card).locked, "the card is locked");
          assert.equal(currentPhase(combat), "resolve", "Resolution, waiting on the damage");
          assert.isFalse(await op(card, "intervene", { byUuid: pc2.uuid, byName: pc2.name, ref: { type: "hit", hitId: hit1.id, which: "evade" }, value: 6 }),
            "nothing changes once locked");

          const damage = damageCardFor(combat);
          assert.exists(damage, "a Damage card was posted");
          assert.equal(game.messages.contents.at(-1).id, damage.id, "after the Resolution notice");
          assert.equal(hbOf(pc1), hb1, "nothing applied before the roll");
          assert.deepEqual(unrolledAttacks(damage.getFlag("carl-rpg", "reactionDamage")), [hit1.attackId],
            "only the Attack that landed waits on a roll");

          // Before: one merged cell with the formula button. After: Damage and Slots.
          const html = document.createElement("div");
          html.innerHTML = `<div class="carl-reaction-damage"></div>`;
          decorateDamageCard(damage, html);
          assert.lengthOf(html.querySelectorAll(".carl-damage-table"), 2, "a table per target");
          const button = html.querySelector(".carl-damage-roll-button");
          assert.include(button.textContent, "100", "the button shows the formula");
          assert.equal(button.closest("td").colSpan, 2);

          const [entry] = damageCardActionEntries;
          await entry.onClick(new MouseEvent("click"), damage, button);
          await waitFor(() => hbOf(pc1) < hb1, { message: "the failed Evade took no damage" });
          assert.equal(hbOf(pc2), hb2, "the successful Evade took none");
          const row = damage.getFlag("carl-rpg", "reactionDamage").rows[hit1.id];
          assert.equal(row.status, "rolled");
          assert.equal(row.result.raw, 100);
          assert.isAbove(row.result.slots, 0);
          decorateDamageCard(damage, html);
          assert.exists(html.querySelector(`[data-row-id="${hit1.id}"] .carl-damage-amount`), "the Damage cell");
          assert.exists(html.querySelector(`[data-row-id="${hit1.id}"] .carl-damage-slots`), "the Slots cell");
          assert.notExists(html.querySelector(".carl-damage-roll-button"), "nothing left to roll");

          assert.isFalse(await rollAttackOnCard(damage, hit1.attackId), "an Attack rolls once");
          await combat.nextTurn();
          assert.equal(currentPhase(combat), "act", "nothing unrolled: on to Crawler Actions");
        });

        it("the Evade button rolls one Check per incoming Attack, from one dialog", async function () {
          await declareOn(pc1);
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "openEvades", {});
          const html = document.createElement("div");
          html.innerHTML = `<div class="carl-reaction"></div>`;
          decorateReactionCard(card, html);
          const button = html.querySelector('[data-op="evade"]');
          assert.exists(button);
          const [entry] = reactionActionEntries;
          await withDialog(
            () => entry.onClick(new MouseEvent("click"), card, button),
            (dialog) => pressDialog(dialog, "roll"),
            "carl-roll-dialog",
          );
          await waitFor(() => hitList(state(card)).every((hit) => hit.evade), { message: "not every Attack got an Evade" });
          assert.lengthOf(hitList(state(card)), 2);
          assert.isTrue(state(card).crawlers[crawlerKey(pc1.uuid)].evaded);
          assert.isTrue(hitList(state(card)).every((hit) => hit.evade.kind === "evade" && hit.evade.difficulty === 16),
            "each Attack has its own Evade against its own Difficulty");
        });

        it("two operations sent at once are applied one after the other", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "openEvades", {});
          const hitId = onlyHit(card).id;
          const results = await Promise.all([
            op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(20, 12, 16) } }),
            op(card, "evade", { uuid: pc1.uuid, checks: { [hitId]: rolled(5, 3, 16) } }),
          ]);
          assert.deepEqual(results, [true, false], "the second sees the first's result and is refused");
          assert.isTrue(onlyHit(card).evade.success);
        });

        it("an Intervene that turns a failed Taunt into a Success pulls the Attacks then", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "taunt", { byUuid: pc2.uuid, byName: pc2.name, mobUuid: mob.uuid, rank: 1, check: rolled(18, 12, 20) });
          assert.equal(onlyHit(card).targetUuid, pc1.uuid, "a Near Miss: nothing moved yet");
          const [taunt] = tauntList(state(card));
          await op(card, "intervene", { byUuid: pc1.uuid, byName: pc1.name, ref: { type: "taunt", tauntId: taunt.id }, value: 4 });
          assert.equal(onlyHit(card).targetUuid, pc2.uuid, "pulled once it succeeded");
        });

        it("a crawler who doesn't Evade takes the full hit", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          const before = hbOf(pc1);
          assert.isAbove(before, 0);
          const damage = await postDamageCard(combat, state(card));
          assert.equal(damage.getFlag("carl-rpg", "reactionDamage").rows[onlyHit(card).id].status, "pending");
          await rollAllDamage(damage);
          await waitFor(() => hbOf(pc1) < before, { message: "no damage taken" });
          assert.equal(damage.getFlag("carl-rpg", "reactionDamage").rows[onlyHit(card).id].result.raw, 100, "the full hit");
        });

        it("a failed free Evade has no consequences of its own", async function () {
          await addConditionToActor(mob, "terrified");
          await declareOn(pc1, 3); // to-hit 40 - 5: the free Evade fails badly
          const card = await withPinnedDice(PIN_D20_MID, () => startReaction());
          const hit = onlyHit(card);
          assert.isFalse(hit.free.success);
          assert.equal(hit.free.degree, "majorFail");
          assert.isNull(decidingEvade(hit), "it decides nothing");
          assert.isTrue(hitEvadable(hit), "the crawler can still Evade");
          const row = buildDamageState(combat, state(card)).rows[hit.id];
          assert.isNull(row.evade, "no Evade decides the hit");
          assert.lengthOf(row.notes, 0, "no Injury from a roll the player didn't choose");
          assert.equal(row.status, "pending", "it takes the hit, with no +Floor or doubling");
        });

        it("a successful free Evade against an Area Attack halves it instead of missing", async function () {
          await addConditionToActor(mob, "terrified");
          await declareOn(pc1, 2);
          const card = await withPinnedDice(PIN_D20_MID, () => startReaction());
          const hit = onlyHit(card);
          assert.isTrue(hit.isArea);
          assert.isTrue(hit.free.success);
          assert.isFalse(hitMissed(hit), "an Area Attack still lands");
          assert.isFalse(hitEvadable(hit), "nothing more to Evade");
          const damage = await postDamageCard(combat, state(card));
          const tags = damage.getFlag("carl-rpg", "reactionDamage").rows[hit.id].tags.map((t) => t.key);
          assert.include(tags, "CARLRPG.Resolve.EvadedHalf");
          await rollAllDamage(damage);
          assert.equal(damage.getFlag("carl-rpg", "reactionDamage").rows[hit.id].result.raw, 50, "half of 100");
        });

        it("both cards show the Mob Attack's printed effect", async function () {
          const attacks = foundry.utils.deepClone(mob.system.toObject().attacks);
          attacks[0].effect = "The target is Poisoned.";
          attacks[0].range = "Melee";
          await mob.update({ "system.attacks": attacks });
          await declareOn(pc1);
          const card = await startReaction();
          const html = document.createElement("div");
          html.innerHTML = `<div class="carl-reaction"></div>`;
          decorateReactionCard(card, html);
          assert.include(html.querySelector(".carl-attack-effect")?.textContent, "Poisoned", "on the Reaction card");
          assert.include(html.querySelector(".carl-attack-range")?.textContent, "Melee");

          const damage = await postDamageCard(combat, state(card));
          const table = document.createElement("div");
          table.innerHTML = `<div class="carl-reaction-damage"></div>`;
          decorateDamageCard(damage, table);
          assert.include(table.querySelector(".carl-damage-attack .carl-attack-effect")?.textContent, "Poisoned", "on the Damage card");
        });

        it("an opened roll breakdown stays open when the card redraws", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "openEvades", {});
          await op(card, "evade", { uuid: pc1.uuid, checks: { [onlyHit(card).id]: rolled(20, 12, 16) } });
          const draw = () => {
            const html = document.createElement("div");
            html.innerHTML = `<div class="carl-reaction"></div>`;
            document.body.append(html);
            decorateReactionCard(card, html);
            return html;
          };
          const first = draw();
          try {
            const details = first.querySelector("details.carl-check");
            assert.isFalse(details.open, "closed to start");
            details.open = true;
            await settle(50); // "toggle" is dispatched asynchronously
          } finally {
            first.remove();
          }
          const second = draw();
          try {
            assert.isTrue(second.querySelector("details.carl-check").open, "still open after the redraw");
            second.querySelector("details.carl-check").open = false;
            await settle(50);
          } finally {
            second.remove();
          }
          const third = draw();
          try {
            assert.isFalse(third.querySelector("details.carl-check").open, "closed again when closed");
          } finally {
            third.remove();
          }
        });

        it("Previous Phase out of Reaction discards the card", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await combat.previousTurn();
          assert.equal(currentPhase(combat), "declare");
          assert.isFalse(game.messages.has(card.id), "the card is gone");
          assert.lengthOf(declaredAttacks(combat), 1, "the declaration stays");
        });

        it("the card draws a section per target and the GM's buttons", async function () {
          await declareOn(pc1);
          await declareOn(pc2);
          const card = await startReaction();
          const html = document.createElement("div");
          html.innerHTML = `<div class="carl-reaction"></div>`;
          decorateReactionCard(card, html);
          assert.lengthOf(html.querySelectorAll(".carl-reaction-section"), 2);
          assert.exists(html.querySelector('[data-op="openEvades"]'));
          assert.exists(html.querySelector('[data-op="lock"]'));
          assert.notExists(html.querySelector('[data-op="evade"]'), "Evades aren't open yet");
          await op(card, "openEvades", {});
          decorateReactionCard(card, html);
          assert.exists(html.querySelector('[data-op="evade"]'));
        });
      });

      describe("Fights that keep core's turns", function () {
        useQuenchTimeout(this);

        it("a crawlers-only fight (PvP) isn't phased", async function () {
          const a = await createTestCharacter("pvp-a");
          const b = await createTestCharacter("pvp-b");
          let combat;
          try {
            combat = await combatOf(a, b);
            await combat.startCombat();
            await settle(100);
            assert.isTrue(combat.isPvP);
            assert.isFalse(isPhased(combat));
            assert.equal(combat.turn, 0, "core's first turn");
            await combat.nextTurn();
            assert.equal(combat.turn, 1, "Next Turn is a turn, not a phase");

            // The tracker renders core's controls and initiative column.
            await combat.activate();
            await ui.combat.render({ force: true, combat });
            await waitFor(() => ui.combat.element?.querySelector('.combat-controls [data-action="nextRound"]'),
              { message: "core's round controls never rendered" });
            const el = ui.combat.element;
            assert.notExists(el.querySelector(".carl-phase-step"), "no phase bar");
            assert.notExists(el.querySelector(".carl-combat-group"), "no groups");
            assert.exists(el.querySelector(".combat-tracker .token-initiative"), "initiative column");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a Mob joining a running PvP fight makes it phased, with no turn", async function () {
          const a = await createTestCharacter("join-a");
          const b = await createTestCharacter("join-b");
          const mob = await createTestMob("join-mob");
          let combat;
          try {
            combat = await combatOf(a, b);
            await combat.startCombat();
            await settle(100);
            assert.equal(combat.turn, 0);
            await combat.createEmbeddedDocuments("Combatant", [{ actorId: mob.id }]);
            await waitFor(() => combat.turn === null, { message: "core's turn was never cleared" });
            assert.isTrue(isPhased(combat));
            assert.equal(currentPhase(combat), "declare");
          } finally {
            await deleteNotices(combat);
            await deleteTestCombat(combat);
            for (const actor of [a, b, mob]) await deleteTestActor(actor);
          }
        });

        it("with the setting off, a fight with a Mob uses turns", async function () {
          const mob = await createTestMob("off-mob");
          const pc = await createTestCharacter("off-pc");
          let combat;
          try {
            await withSetting("phasedCombat", false, async () => {
              combat = await combatOf(mob, pc);
              await combat.startCombat();
              assert.isFalse(isPhased(combat));
              assert.equal(combat.turn, 0);
              assert.isUndefined(combat.getFlag("carl-rpg", "phase"));
            });
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });
      });
    },
    { displayName: "CarlRPG: combat phases" },
  );
}
