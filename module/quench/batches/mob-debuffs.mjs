/**
 * Mob Attack Debuffs at Resolution (docs/mob-sheet.md, phase 2): each
 * Debuff lands by its trigger - on a hit, on an Evade Major Fail or worse,
 * on a Critical Fail - with no Evade rolled counting as the worst (ruled
 * 2026-11-17); none on a successful Evade, a full Immunity, or a Catcher at
 * Rank 15 (p.187). On the Damage card (Declaration and Reaction) and on a
 * Mob Attack card's rows outside them.
 */
import CarlDice from "../../dice/dice.mjs";
import { applyRow } from "../../chat/attack-targets-card.mjs";
import { landDebuffs } from "../../helpers/land-debuffs.mjs";
import { applyOp, reactionCardFor } from "../../chat/reaction-card.mjs";
import { debuffLandsOn } from "../../helpers/modifiers.mjs";
import { mobAttacksOf } from "../../helpers/mob-attacks.mjs";
import { hitList } from "../../helpers/reaction-state.mjs";
import { decorateDamageCard, postDamageCard, rollAttackOnCard } from "../../helpers/reaction-resolve.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  deleteTestCombat,
  settle,
  useQuenchTimeout,
  waitFor,
  withFakeTargets,
  withSetting,
} from "../helpers.mjs";

/** One Debuff per trigger. */
const EFFECTS = [
  { debuffKey: "burned", stacks: 1, trigger: "hit", label: "" },
  { debuffKey: "poisoned", stacks: 1, trigger: "majorFail", label: "" },
  { debuffKey: "stunned", stacks: 1, trigger: "criticalFail", label: "" },
];
const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);
const effectsOf = (list) => list.map((te, i) => ({ id: `te${i}`, sourceLabel: "Test Maul", ...te }));

/** An unstarted combat with these actors as combatants. */
async function combatOf(...actors) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments("Combatant", actors.map((a) => ({ actorId: a.id })));
  return combat;
}

/** Delete the phase notices and cards a test combat posted. */
async function deleteNotices(combat) {
  if (!combat?.id) return;
  await settle(150);
  const ids = game.messages.filter((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id
    || m.getFlag("carl-rpg", "reaction")?.combatId === combat.id
    || m.getFlag("carl-rpg", "reactionDamage")?.combatId === combat.id).map((m) => m.id);
  if (ids.length) await ChatMessage.deleteDocuments(ids);
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.mob-debuffs",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("which Debuffs land, by trigger", function () {
        const lands = (row) => EFFECTS.filter((te) => debuffLandsOn(te, row)).map((te) => te.debuffKey);

        it("no Evade rolled: every trigger lands", function () {
          assert.deepEqual(lands({ evade: null }), ["burned", "poisoned", "stunned"]);
        });

        it("a failed Evade lands by its Degree", function () {
          assert.deepEqual(lands({ evade: { degree: "standardFail", success: false } }), ["burned"]);
          assert.deepEqual(lands({ evade: { degree: "nearMissFail", success: false } }), ["burned"]);
          assert.deepEqual(lands({ evade: { degree: "majorFail", success: false } }), ["burned", "poisoned"]);
          assert.deepEqual(lands({ evade: { degree: "criticalFail", success: false } }), ["burned", "poisoned", "stunned"]);
        });

        it("landDebuffs adds them to a crawler; none to an Immune one", async function () {
          const plain = await createTestCharacter("lands");
          const immune = await createTestCharacter("immune", { system: { resistances: { fire: "immune" } } });
          try {
            const row = { evade: { degree: "majorFail", success: false } };
            const done = await landDebuffs(plain, effectsOf(EFFECTS), row, { fire: 4 });
            assert.deepEqual(done.landed.map((t) => t.debuffKey), ["burned", "poisoned"]);
            assert.includeMembers(keys(plain), ["burned", "poisoned"]);
            assert.notInclude(keys(plain), "stunned");
            const skipped = await landDebuffs(immune, effectsOf(EFFECTS), row, { fire: 4 });
            assert.lengthOf(skipped.landed, 0);
            assert.lengthOf(skipped.lines, 1, "the GM is told why");
            assert.lengthOf(keys(immune), 0);
          } finally {
            await deleteTestActor(plain);
            await deleteTestActor(immune);
          }
        });
      });

      describe("a Mob Attack card's rows (outside Declaration)", function () {
        useQuenchTimeout(this);

        it("carries the Attack's Debuffs; an unEvaded row lands every trigger", async function () {
          const mob = await createTestMob("card-mob", {
            system: { attacks: [{ name: "Maul", toHit: "16", damage: "3", damageType: "", range: "", effect: "" }] },
          });
          const pc = await createTestCharacter("card-pc");
          let message;
          try {
            await mobAttacksOf(mob)[0].update({ "system.targetEffects": EFFECTS });
            message = await withSetting("currentFloor", 1, () =>
              withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true })));
            const effects = message.getFlag("carl-rpg", "targetEffects") ?? [];
            assert.deepEqual(effects.map((t) => [t.debuffKey, t.trigger]),
              [["burned", "hit"], ["poisoned", "majorFail"], ["stunned", "criticalFail"]]);
            assert.include(message.content, game.i18n.localize("CARLRPG.MobAttack.Trigger.majorFail"), "the pill says when");
            const row = Object.values(message.getFlag("carl-rpg", "targetRows"))[0];
            await applyRow(message, row);
            await settle();
            assert.includeMembers(keys(pc), ["burned", "poisoned", "stunned"]);
          } finally {
            await message?.delete();
            await deleteTestActor(mob);
            await deleteTestActor(pc);
          }
        });
      });

      describe("an Attack card row with a rolled Evade", function () {
        useQuenchTimeout(this);

        it("a plain failed Evade: only the on-a-hit Debuff lands", async function () {
          const pc = await createTestCharacter("row-evade");
          let message;
          try {
            const row = {
              id: "t0", uuid: pc.uuid, name: pc.name, isCharacter: true, zone: "full", difficulty: 16,
              hit: true, amazing: false, freeEvade: false, freeUsed: false,
              evade: { degree: "standardFail", success: false }, applied: false, replaced: false,
            };
            message = await ChatMessage.create({
              content: '<div class="carl-chat-card"></div>',
              flags: { "carl-rpg": {
                isArea: false, floor: 1, damageIsMagic: false, damageByType: { "": 1 },
                targetEffects: effectsOf(EFFECTS), targetUuids: [pc.uuid], targetRows: { t0: row },
              } },
            });
            await applyRow(message, message.getFlag("carl-rpg", "targetRows").t0);
            await settle();
            assert.include(keys(pc), "burned");
            assert.notInclude(keys(pc), "poisoned");
            assert.notInclude(keys(pc), "stunned");
          } finally {
            await message?.delete();
            await deleteTestActor(pc);
          }
        });
      });

      describe("the Damage card (Declaration and Reaction)", function () {
        useQuenchTimeout(this);

        const rolled = (total, naturalRoll, difficulty) => ({ total, naturalRoll, difficulty, formula: "1d20", breakdown: "", roll: null });
        const preset = { advantage: "normal", modifier: 0, checked: [], checkedDebuffs: null };
        let mob;
        let pc1;
        let pc2;
        let combat;
        beforeEach(async function () {
          // 0: Maul (3 damage) with a Debuff per trigger; 1: Web (no damage, Debuffs only).
          mob = await createTestMob("debuff-mob", {
            system: {
              attacks: [
                { name: "Maul", toHit: "16", damage: "3", damageType: "", range: "", effect: "" },
                { name: "Web", toHit: "16", damage: "", damageType: "", range: "", effect: "" },
              ],
              actionsPerRound: 6,
            },
          });
          for (const item of mobAttacksOf(mob)) await item.update({ "system.targetEffects": EFFECTS });
          pc1 = await createTestCharacter("debuff-pc1");
          pc2 = await createTestCharacter("debuff-pc2");
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
          await waitFor(() => game.messages.some((m) => m.getFlag("carl-rpg", "phaseNotice")?.combatId === combat.id),
            { message: "no round-start notice" });
          await combat.nextTurn();
          return reactionCardFor(combat);
        };
        const state = (card) => card.getFlag("carl-rpg", "reaction");
        const op = (card, name, data) => applyOp(card.id, name, data, game.user);
        const onlyHit = (card) => hitList(state(card))[0];
        const resolveAll = async (card) => {
          const damage = await postDamageCard(combat, state(card));
          const data = () => damage.getFlag("carl-rpg", "reactionDamage");
          for (const id of Object.keys(data().attacks)) await rollAttackOnCard(damage, id);
          await settle();
          return { damage, data };
        };

        it("the declared Attack keeps its Debuffs through to the Damage card", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          assert.lengthOf(state(card).attacks[onlyHit(card).attackId].targetEffects, 3);
          const damage = await postDamageCard(combat, state(card));
          const attack = Object.values(damage.getFlag("carl-rpg", "reactionDamage").attacks)[0];
          assert.lengthOf(attack.targetEffects, 3);
          await damage.delete();
        });

        it("not Evaded: every trigger lands with the damage", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          const { data } = await resolveAll(card);
          assert.includeMembers(keys(pc1), ["burned", "poisoned", "stunned"]);
          const row = Object.values(data().rows)[0];
          assert.lengthOf(row.result.debuffs, 3, "the row says what it gained");
        });

        it("a failed Evade lands by its Degree; a Major Fail adds the Major-Fail one", async function () {
          await declareOn(pc1);
          await declareOn(pc2);
          const card = await startReaction();
          const [h1, h2] = hitList(state(card));
          // pc1 fails by 6 (a plain fail); pc2 fails by 11 (Major Fail).
          await op(card, "evade", { uuid: pc1.uuid, checks: { [h1.id]: rolled(10, 6, 16) }, preset });
          await op(card, "evade", { uuid: pc2.uuid, checks: { [h2.id]: rolled(5, 2, 16) }, preset });
          await resolveAll(card);
          assert.include(keys(pc1), "burned");
          assert.notInclude(keys(pc1), "poisoned");
          assert.includeMembers(keys(pc2), ["burned", "poisoned"]);
          assert.notInclude(keys(pc2), "stunned");
        });

        it("a successful Evade: none", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "evade", { uuid: pc1.uuid, checks: { [onlyHit(card).id]: rolled(20, 12, 16) }, preset });
          await resolveAll(card);
          assert.lengthOf(keys(pc1), 0);
        });

        it("a Catcher below Rank 15 takes them: a Caught hit isn't Evaded", async function () {
          await createTestItem(pc2, "skill", "Catcher", { name: "Catcher", system: { rank: 10 } });
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: onlyHit(card).id });
          await resolveAll(card);
          assert.includeMembers(keys(pc2), ["burned", "poisoned", "stunned"]);
          assert.lengthOf(keys(pc1), 0, "it was Caught off them");
        });

        it("a Catcher at Rank 15 ignores them (p.187)", async function () {
          await createTestItem(pc2, "skill", "Catcher", { name: "Catcher", system: { rank: 15 } });
          await declareOn(pc1);
          const card = await startReaction();
          await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: onlyHit(card).id });
          const { data } = await resolveAll(card);
          assert.lengthOf(keys(pc2), 0);
          const row = Object.values(data().rows)[0];
          assert.isTrue(row.ignoreDebuffs);
          assert.isTrue(row.tags.some((t) => t.key === "CARLRPG.Resolve.CatcherNoDebuffs"), "the row says so");
        });

        it("an Attack with Debuffs and no damage gets Apply, and lands them", async function () {
          await declareOn(pc1, 1);
          const card = await startReaction();
          const damage = await postDamageCard(combat, state(card));
          const data = () => damage.getFlag("carl-rpg", "reactionDamage");
          const row = Object.values(data().rows)[0];
          assert.equal(row.status, "pending", "not \"no damage\": it has Debuffs to apply");
          assert.isTrue(await rollAttackOnCard(damage, row.attackId));
          await settle();
          assert.includeMembers(keys(pc1), ["burned", "poisoned", "stunned"]);
          const after = Object.values(data().rows)[0];
          assert.equal(after.result.final, 0, "no damage");
        });

        it("a Debuffs-only Attack nothing would land from has no Apply", async function () {
          await createTestItem(pc2, "skill", "Catcher", { name: "Catcher", system: { rank: 15 } });
          await declareOn(pc1, 1);
          const card = await startReaction();
          await op(card, "catch", { byUuid: pc2.uuid, byName: pc2.name, hitId: onlyHit(card).id });
          const damage = await postDamageCard(combat, state(card));
          const row = Object.values(damage.getFlag("carl-rpg", "reactionDamage").rows)[0];
          assert.equal(row.status, "noDamage");
          await damage.delete();
        });

        it("the card shows what will land, then what did", async function () {
          await declareOn(pc1);
          const card = await startReaction();
          const damage = await postDamageCard(combat, state(card));
          const draw = () => {
            const html = document.createElement("div");
            html.innerHTML = `<header class="card-header"><h3></h3></header>${damage.content}`;
            decorateDamageCard(damage, html);
            return html.querySelector(".carl-reaction-damage").textContent;
          };
          const burned = game.i18n.localize(CONFIG.CARLRPG.debuffs.burned.label);
          assert.include(draw(), game.i18n.format("CARLRPG.Resolve.WillGain", { debuffs: `${burned} ×1` }), "before: what will land");
          await rollAttackOnCard(damage, Object.keys(damage.getFlag("carl-rpg", "reactionDamage").attacks)[0]);
          await settle();
          assert.include(draw(), game.i18n.format("CARLRPG.Resolve.Gained", { debuffs: `${burned} ×1` }), "after: what did");
        });
      });
    },
    { displayName: "CarlRPG: Mob Attack Debuffs at Resolution" },
  );
}
