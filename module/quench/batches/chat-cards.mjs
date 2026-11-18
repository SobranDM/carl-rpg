import CarlDice from "../../dice/dice.mjs";
import { resolveEvadeDifficulty, canActOnUuidFlag } from "../../chat/evade-link-card.mjs";
import { isCardLocked, canActTaunt, tauntAttack, tauntRedirectNow } from "../../chat/taunt-card.mjs";
import { canApplyDamage, onApplyDamage } from "../../chat/damage-card.mjs";
import { canApplyTargetEffects, onApplyTargetEffects } from "../../chat/target-effects-card.mjs";
import { canApplyHeal, healNow, onApplyHeal } from "../../chat/heal-card.mjs";
import { applyAllRows, applyRow, applyRowNow, decorateTargetRows } from "../../chat/attack-targets-card.mjs";
import { askTiming } from "../../helpers/chat-socket.mjs";
import {
  createTestCharacter, createTestItem, createTestMob, deleteTestActor, PIN_D20_MID, pressDialog, settle, useQuenchTimeout, withDialog,
  withFakeTargets, withPinnedDice, withSetting,
} from "../helpers.mjs";

const fakeEvent = { preventDefault() {} };

function fakeMessage(flags = {}) {
  return { getFlag: (ns, key) => flags[key] };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.chat-cards",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("resolveEvadeDifficulty (Considerate Play/PvP, p.87)", function () {
        useQuenchTimeout(this);

        it("Character vs. Character: the attacker's own rolled total becomes the Difficulty", function () {
          const result = resolveEvadeDifficulty({ attackerType: "character", defenderType: "character", attackTotal: 18, targetDifficulty: 13 });
          assert.equal(result, 18);
        });

        it("any Mob on either side: the static-formula Difficulty applies unchanged", function () {
          assert.equal(resolveEvadeDifficulty({ attackerType: "mob", defenderType: "character", attackTotal: 18, targetDifficulty: 13 }), 13);
          assert.equal(resolveEvadeDifficulty({ attackerType: "character", defenderType: "mob", attackTotal: 18, targetDifficulty: 13 }), 13);
        });
      });

      describe("isCardLocked (Taunt)", function () {
        useQuenchTimeout(this);

        it("is locked once damage/target-effects/evade has already resolved the card", function () {
          assert.isTrue(isCardLocked(fakeMessage({ damageApplied: true })));
          assert.isTrue(isCardLocked(fakeMessage({ evadeRolled: true })));
        });

        it("is unlocked with none of those flags set", function () {
          assert.isFalse(isCardLocked(fakeMessage({})));
        });
      });

      describe("visibility gates (GM-always-true short circuit)", function () {
        useQuenchTimeout(this);

        it("canActOnUuidFlag / canApplyDamage / canApplyTargetEffects / canApplyHeal / canActTaunt all permit the GM", function () {
          const message = fakeMessage({ targetUuids: [], debuffActorUuid: null, healActorUuid: null });
          assert.isTrue(canActOnUuidFlag(message, "targetUuids"));
          assert.isTrue(canApplyDamage(message));
          assert.isTrue(canApplyTargetEffects(message));
          assert.isTrue(canApplyHeal(message));
          assert.isTrue(canActTaunt());
        });
      });

      describe("onApplyDamage / onApplyTargetEffects / onApplyHeal (DOM-free - a fake event object suffices)", function () {
        useQuenchTimeout(this);

        it("onApplyDamage reduces HB by the pipeline's whole-slot result and flags damageApplied", async function () {
          const target = await createTestCharacter("target", { system: { hb: { value: 10, max: 10 }, dr: 0 } });
          let message;
          try {
            // Untyped ("") damage - the same flag shape as an Amazing Success/
            // Evade Major-Fail +Floor bonus - Apply Damage's re-split
            // (splitDamageProportionally) keeps the "" key.
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { targetUuids: [target.uuid], damageByType: { "": 12 }, damageIsMagic: true } },
            });
            await onApplyDamage(fakeEvent, message);
            await settle();
            assert.isBelow(target.system.hb.value, 10);
            assert.isTrue(message.getFlag("carl-rpg", "damageApplied"));
          } finally {
            await deleteTestActor(target);
            if (message) await message.delete();
          }
        });

        it("onApplyTargetEffects writes the snapshotted Debuff onto every snapshotted target", async function () {
          const target = await createTestCharacter("target");
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { targetUuids: [target.uuid], targetEffects: [{ debuffKey: "poisoned", stacks: 1, label: "", sourceLabel: "Test" }] } },
            });
            await onApplyTargetEffects(fakeEvent, message);
            await settle();
            assert.include(target.system.conditions.map((c) => c.key), "poisoned");
            assert.isTrue(message.getFlag("carl-rpg", "targetEffectsApplied"));
          } finally {
            await deleteTestActor(target);
            if (message) await message.delete();
          }
        });

        it("onApplyHeal restores HB up to effectiveMax and flags healApplied", async function () {
          const actor = await createTestCharacter("healed", { system: { hb: { value: 3, max: 10 } } });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { healActorUuid: actor.uuid, healAmount: 5 } },
            });
            await onApplyHeal(fakeEvent, message);
            await settle();
            assert.equal(actor.system.hb.value, 8);
            assert.isTrue(message.getFlag("carl-rpg", "healApplied"));
          } finally {
            await deleteTestActor(actor);
            if (message) await message.delete();
          }
        });
      });

      describe("Applied once: the row's current state is read just before applying", function () {
        useQuenchTimeout(this);

        const rowFor = (id, actor) => ({
          id, uuid: actor.uuid, name: actor.name, isCharacter: true, zone: "full", difficulty: 13,
          hit: true, amazing: false, freeEvade: false, freeUsed: false, evade: null, applied: false, replaced: false,
        });
        const attackCard = (slots, ...actors) => ChatMessage.create({
          content: '<div class="carl-chat-card"></div>',
          flags: { "carl-rpg": {
            floor: 1, damageIsMagic: true, damageByType: { "": actors[0].system.hb.slotValue * slots },
            targetUuids: actors.map((a) => a.uuid),
            targetRows: Object.fromEntries(actors.map((a, i) => [`t${i}`, rowFor(`t${i}`, a)])),
          } },
        });

        it("Apply All skips a row applied after it started (a player's own Apply) - no double damage", async function () {
          const a = await createTestCharacter("apply-all-a");
          const b = await createTestCharacter("apply-all-b");
          let message;
          try {
            message = await attackCard(2, a, b);
            const startB = b.system.hb.value;
            // A's damage lands; before Apply All reaches B, B's owner applies
            // B's row - the card now says so.
            let fired = false;
            const update = a.update;
            a.update = async function (...args) {
              const result = await update.apply(this, args);
              if (!fired) {
                fired = true;
                await message.update({ "flags.carl-rpg.targetRows.t1.applied": true });
              }
              return result;
            };
            try {
              await applyAllRows(message);
            } finally {
              delete a.update;
            }
            await settle();
            assert.isTrue(fired, "B's row was marked applied mid-way");
            assert.equal(a.system.hb.value, 10 - 2, "A was applied");
            assert.equal(b.system.hb.value, startB, "B's row wasn't applied again by Apply All");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a row already applied isn't applied again - by a second click, or one already under way", async function () {
          const a = await createTestCharacter("apply-twice-a");
          const b = await createTestCharacter("apply-twice-b");
          let message;
          try {
            message = await attackCard(2, a, b);
            const rows = () => message.getFlag("carl-rpg", "targetRows");
            // Two clicks on A's row at once on this client: the second sees the first's mark.
            await Promise.all([applyRow(message, rows().t0), applyRow(message, rows().t0)]);
            // B's row, already applied on the card (someone else's Apply that has arrived).
            const startB = b.system.hb.value;
            await message.update({ "flags.carl-rpg.targetRows.t1.applied": true });
            await applyRow(message, { id: "t1" });
            await applyAllRows(message);
            await settle();
            assert.equal(a.system.hb.value, 10 - 2, "A was applied once");
            assert.equal(b.system.hb.value, startB, "B's applied row wasn't applied again");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("two rows applied at once both keep their GM digest (kept per row, not in the content)", async function () {
          const a = await createTestCharacter("digest-a");
          const b = await createTestCharacter("digest-b");
          let message;
          try {
            message = await attackCard(2, a, b);
            const rows = () => message.getFlag("carl-rpg", "targetRows");
            // Two Applies at once (two players' clicks, each on their own row).
            const [linesA, linesB] = await Promise.all([applyRow(message, rows().t0), applyRow(message, rows().t1)]);
            await settle();
            assert.isNotEmpty(linesA);
            assert.isNotEmpty(linesB);
            assert.deepEqual(rows().t0.digest, linesA, "A's digest is on its row");
            assert.deepEqual(rows().t1.digest, linesB, "B's digest is on its row");
            // Drawn for the GM from the rows.
            const html = document.createElement("div");
            html.innerHTML = '<div class="carl-chat-card"><div class="carl-target-rows"></div></div>';
            decorateTargetRows(message, html);
            assert.lengthOf(html.querySelectorAll(".carl-gm-digest li"), linesA.length + linesB.length, "both shown");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a Heal skips a recipient already applied on the card, and a second Apply heals no one", async function () {
          const a = await createTestCharacter("heal-once-a", { system: { hb: { value: 3, max: 10 } } });
          const b = await createTestCharacter("heal-once-b", { system: { hb: { value: 3, max: 10 } } });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { healAmount: 5, healRecipients: {
                r0: { uuid: a.uuid, name: a.name }, r1: { uuid: b.uuid, name: b.name, applied: true },
              } } },
            });
            await onApplyHeal(fakeEvent, message);
            await onApplyHeal(fakeEvent, message);
            await settle();
            assert.equal(a.system.hb.value, 8, "A healed once");
            assert.equal(b.system.hb.value, 3, "B's row was already applied (by B's owner)");
            assert.isTrue(message.getFlag("carl-rpg", "healApplied"), "both rows are applied");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a row's own Apply and a player's relayed one at the same moment apply it once", async function () {
          const a = await createTestCharacter("apply-race-a");
          let message;
          try {
            message = await attackCard(2, a);
            const row = message.getFlag("carl-rpg", "targetRows").t0;
            // This client's Apply, and a player's arriving at the GM's client.
            const [, relayed] = await Promise.all([applyRow(message, row), applyRowNow({ cardId: message.id, rowId: "t0" }, game.user)]);
            await settle();
            assert.equal(a.system.hb.value, 10 - 2, "damaged once");
            assert.isTrue(message.getFlag("carl-rpg", "targetRows").t0.applied);
            assert.isFalse((await applyRowNow({ cardId: message.id, rowId: "t0" }, game.user)).applied, "and refused after");
            assert.isBoolean(relayed.applied);
          } finally {
            await message?.delete();
            await deleteTestActor(a);
          }
        });

        it("the GM's Heal and a player's at the same moment heal each recipient once", async function () {
          const a = await createTestCharacter("heal-race-a", { system: { hb: { value: 3, max: 10 } } });
          const b = await createTestCharacter("heal-race-b", { system: { hb: { value: 3, max: 10 } } });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { healAmount: 5, healRecipients: { r0: { uuid: a.uuid, name: a.name }, r1: { uuid: b.uuid, name: b.name } } } },
            });
            // The GM clicks Apply (it reads both rows as unapplied); a
            // player's Apply for both reaches the GM's client at once.
            await Promise.all([
              onApplyHeal(fakeEvent, message),
              healNow({ cardId: message.id, rowIds: ["r0", "r1"] }, game.user),
            ]);
            await settle();
            assert.equal(a.system.hb.value, 8, "A healed once");
            assert.equal(b.system.hb.value, 8, "B healed once");
            assert.isTrue(message.getFlag("carl-rpg", "healApplied"));
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("no GM answering (or none online): nothing is applied or healed, and the asker is warned", async function () {
          const a = await createTestCharacter("no-answer-a", { system: { hb: { value: 3, max: 10 } } });
          let attack;
          let heal;
          const warned = [];
          const saved = { warn: ui.notifications.warn, emit: game.socket.emit, timeout: askTiming.timeoutMs };
          const asIfGM = (gm) => Object.defineProperty(game.users, "activeGM", { configurable: true, get: () => gm });
          try {
            attack = await attackCard(2, a);
            heal = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { healAmount: 5, healRecipients: { r0: { uuid: a.uuid, name: a.name } } } },
            });
            ui.notifications.warn = (text) => { warned.push(String(text)); };
            // Another GM is active, and never answers.
            game.socket.emit = () => {};
            askTiming.timeoutMs = 50;
            asIfGM({ id: "quenchNoAnswer", isSelf: false });
            assert.deepEqual(await applyRow(attack, attack.getFlag("carl-rpg", "targetRows").t0), []);
            await onApplyHeal(fakeEvent, heal);
            // No GM online at all.
            asIfGM(null);
            assert.deepEqual(await applyRow(attack, attack.getFlag("carl-rpg", "targetRows").t0), []);
            delete game.users.activeGM;
            await settle();
            assert.equal(a.system.hb.value, 3, "neither damaged nor healed");
            assert.notOk(attack.getFlag("carl-rpg", "targetRows").t0.applied, "the row isn't marked");
            assert.notOk(heal.getFlag("carl-rpg", "healRecipients").r0.applied, "nor the heal");
            const noAnswer = game.i18n.localize("CARLRPG.Chat.GMNoAnswer");
            assert.lengthOf(warned.filter((w) => w === noAnswer), 2, "told the GM didn't answer, for each");
            assert.include(warned, game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
          } finally {
            delete game.users.activeGM;
            ui.notifications.warn = saved.warn;
            game.socket.emit = saved.emit;
            askTiming.timeoutMs = saved.timeout;
            await attack?.delete();
            await heal?.delete();
            await deleteTestActor(a);
          }
        });
      });

      describe("Taunt from an Attack card (taunt-card.mjs)", function () {
        useQuenchTimeout(this);

        const bite = { name: "Bite", toHit: "14", damage: "3", damageType: "", range: "", effect: "" };
        let mob;
        let wren;
        let chase;
        let card;
        beforeEach(async function () {
          mob = await createTestMob("taunt-mob", { system: { attacks: [bite] } });
          wren = await createTestCharacter("taunt-wren");
          chase = await createTestCharacter("taunt-chase");
          // Named exactly "Taunt": tauntAttack finds the Skill by name.
          await createTestItem(chase, "skill", "Taunt", { name: "Taunt", system: { rank: 10 } });
          card = await withFakeTargets([{ actor: wren }], () => CarlDice.rollMobAttack(mob, 0, { skipDialog: true }));
        });
        afterEach(async function () {
          await card?.delete();
          for (const actor of [mob, wren, chase]) await deleteTestActor(actor);
        });

        const rows = () => card.getFlag("carl-rpg", "targetRows");
        const asChase = () => ({ actor: chase, token: null });
        // A d20 pinned to 10 + Rank 10 against 10 + the Mob's Mod + Floor 1: a Success.
        const rolledToSucceed = (fn) => withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, fn));

        it("succeeds: the Attack moves onto the taunter", async function () {
          assert.exists(rows()?.t0, "the Attack card has Wren's row");
          const result = await rolledToSucceed(() => tauntAttack(card, { taunter: asChase(), skipDialog: true }));
          assert.equal(result, "redirected");
          assert.isTrue(rows().t0.replaced);
          assert.equal(rows().t1?.uuid, chase.uuid);
          assert.deepEqual(card.getFlag("carl-rpg", "targetUuids"), [chase.uuid]);
        });

        it("a row applied while the Taunt dialog is open refuses the redirect; the roll stands", async function () {
          const result = await rolledToSucceed(() => withDialog(
            () => tauntAttack(card, { taunter: asChase() }),
            async (dialog) => {
              // Wren fails to get out of the way and takes the hit meanwhile.
              await applyRow(card, rows().t0);
              pressDialog(dialog, "roll");
            },
            "carl-roll-dialog",
          ));
          assert.isTrue(rows().t0.applied, "Wren took the hit");
          assert.equal(result, "refused");
          assert.notOk(rows().t0.replaced, "Wren's applied row stays");
          assert.notExists(rows().t1, "no taunter row");
          assert.deepEqual(card.getFlag("carl-rpg", "targetUuids"), [wren.uuid]);
          assert.equal(card.getFlag("carl-rpg", "tauntedBy"), chase.uuid, "the Taunt was made");
        });

        it("two Taunts landing at once: one takes the Attack, with its own row id", async function () {
          const pip = await createTestCharacter("taunt-pip");
          try {
            const seen = ["t0"];
            const outcomes = await Promise.all([
              tauntRedirectNow({ cardId: card.id, taunterUuid: chase.uuid, success: true, seen }, game.user),
              tauntRedirectNow({ cardId: card.id, taunterUuid: pip.uuid, success: true, seen }, game.user),
            ]);
            assert.sameMembers(outcomes.map((o) => o?.outcome), ["redirected", "refused"]);
            const active = Object.values(rows()).filter((r) => !r.replaced);
            assert.lengthOf(active, 1, "one taunter row");
            assert.equal(active[0].uuid, chase.uuid, "the first one's");
          } finally {
            await deleteTestActor(pip);
          }
        });
      });
    },
    { displayName: "CarlRPG: chat-card gate/apply functions" },
  );
}
