import CarlDice from "../../dice/dice.mjs";
import { resolveEvadeDifficulty, canActOnUuidFlag } from "../../chat/evade-link-card.mjs";
import {
  isCardLocked,
  canActTaunt,
  tauntAttack,
  tauntRedirectNow,
} from "../../chat/taunt-card.mjs";
import { applyDamageToActor, canApplyDamage, onApplyDamage } from "../../chat/damage-card.mjs";
import { canApplyTargetEffects, onApplyTargetEffects } from "../../chat/target-effects-card.mjs";
import { canApplyHeal, healNow, onApplyHeal } from "../../chat/heal-card.mjs";
import {
  applyAllRows,
  applyRow,
  applyRowNow,
  decorateTargetRows,
} from "../../chat/attack-targets-card.mjs";
import { askTiming } from "../../helpers/chat-socket.mjs";
import { CARLRPG } from "../../helpers/config.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  PIN_D20_MID,
  pressDialog,
  settle,
  useQuenchTimeout,
  withDialog,
  withFakeTargets,
  withPinnedDice,
  withSetting,
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
          const result = resolveEvadeDifficulty({
            attackerType: "character",
            defenderType: "character",
            attackTotal: 18,
            targetDifficulty: 13,
          });
          assert.equal(result, 18);
        });

        it("any Mob on either side: the static-formula Difficulty applies unchanged", function () {
          assert.equal(
            resolveEvadeDifficulty({
              attackerType: "mob",
              defenderType: "character",
              attackTotal: 18,
              targetDifficulty: 13,
            }),
            13,
          );
          assert.equal(
            resolveEvadeDifficulty({
              attackerType: "character",
              defenderType: "mob",
              attackTotal: 18,
              targetDifficulty: 13,
            }),
            13,
          );
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
          const message = fakeMessage({
            targetUuids: [],
            debuffActorUuid: null,
            healActorUuid: null,
          });
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
          const target = await createTestCharacter("target", {
            system: { hb: { value: 10, max: 10 }, dr: 0 },
          });
          let message;
          try {
            // Untyped ("") damage - the same flag shape as an Amazing Success/
            // Evade Major-Fail +Floor bonus - Apply Damage's re-split
            // (splitDamageProportionally) keeps the "" key.
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: {
                "carl-rpg": {
                  targetUuids: [target.uuid],
                  damageByType: { "": 12 },
                  damageIsMagic: true,
                },
              },
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
              flags: {
                "carl-rpg": {
                  targetUuids: [target.uuid],
                  targetEffects: [
                    { debuffKey: "poisoned", stacks: 1, label: "", sourceLabel: "Test" },
                  ],
                },
              },
            });
            await onApplyTargetEffects(fakeEvent, message);
            await settle();
            assert.include(
              target.system.conditions.map((c) => c.key),
              "poisoned",
            );
            assert.isTrue(message.getFlag("carl-rpg", "targetEffectsApplied"));
          } finally {
            await deleteTestActor(target);
            if (message) await message.delete();
          }
        });
      });

      describe("Applied once: the row's current state is read just before applying", function () {
        useQuenchTimeout(this);

        const rowFor = (id, actor) => ({
          id,
          uuid: actor.uuid,
          name: actor.name,
          isCharacter: true,
          zone: "full",
          difficulty: 13,
          hit: true,
          amazing: false,
          freeEvade: false,
          freeUsed: false,
          evade: null,
          applied: false,
          replaced: false,
        });
        const attackCard = (slots, ...actors) =>
          ChatMessage.create({
            content: '<div class="carl-chat-card"></div>',
            flags: {
              "carl-rpg": {
                floor: 1,
                damageIsMagic: true,
                damageByType: { "": actors[0].system.hb.slotValue * slots },
                targetUuids: actors.map((a) => a.uuid),
                targetRows: Object.fromEntries(actors.map((a, i) => [`t${i}`, rowFor(`t${i}`, a)])),
              },
            },
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

        it("the digest line: the target, then damage less each reduction, named, and slots lost", async function () {
          const mob = await createTestMob("digest-math", {
            system: { dr: 1, resistances: { fire: "resist" } },
          });
          const bare = await createTestMob("digest-bare", { system: { dr: 0 } });
          try {
            const [line] = await applyDamageToActor(mob, { bludgeoning: 4, fire: 4 }, true);
            const div = document.createElement("div");
            div.innerHTML = line;
            assert.equal(div.querySelector(".carl-digest-name")?.textContent, mob.name);
            const sum = div.querySelector(".carl-digest-sum")?.textContent ?? "";
            assert.match(sum, /^8 - 1 \(DR\) - \d+ \(Fire Resisted\) = \d+ damage$/);
            const chip = div.querySelector(
              ".carl-digest-math > .carl-digest-cost .carl-status-chip",
            );
            assert.match(chip?.textContent ?? "", /^\d+ Slots?$/, "slots lost, as a chip, first");
            // Nothing taken off: just the damage.
            const [plain] = await applyDamageToActor(bare, { "": 1 }, true);
            div.innerHTML = plain;
            assert.equal(div.querySelector(".carl-digest-sum").textContent, "1 damage");
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(bare);
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
            const [linesA, linesB] = await Promise.all([
              applyRow(message, rows().t0),
              applyRow(message, rows().t1),
            ]);
            await settle();
            assert.isNotEmpty(linesA);
            assert.isNotEmpty(linesB);
            assert.deepEqual(rows().t0.digest, linesA, "A's digest is on its row");
            assert.deepEqual(rows().t1.digest, linesB, "B's digest is on its row");
            // Drawn for the GM from the rows.
            const html = document.createElement("div");
            html.innerHTML =
              '<div class="carl-chat-card"><div class="carl-target-rows"></div></div>';
            decorateTargetRows(message, html);
            assert.lengthOf(
              html.querySelectorAll(".carl-gm-digest li"),
              linesA.length + linesB.length,
              "both shown",
            );
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a Heal skips a recipient already applied on the card, and a second Apply heals no one", async function () {
          const a = await createTestCharacter("heal-once-a", {
            system: { hb: { value: 3, max: 10 } },
          });
          const b = await createTestCharacter("heal-once-b", {
            system: { hb: { value: 3, max: 10 } },
          });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: {
                "carl-rpg": {
                  healAmount: 5,
                  healRecipients: {
                    r0: { uuid: a.uuid, name: a.name },
                    r1: { uuid: b.uuid, name: b.name, applied: true },
                  },
                },
              },
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
            const [, relayed] = await Promise.all([
              applyRow(message, row),
              applyRowNow({ cardId: message.id, rowId: "t0" }, game.user),
            ]);
            await settle();
            assert.equal(a.system.hb.value, 10 - 2, "damaged once");
            assert.isTrue(message.getFlag("carl-rpg", "targetRows").t0.applied);
            assert.isFalse(
              (await applyRowNow({ cardId: message.id, rowId: "t0" }, game.user)).applied,
              "and refused after",
            );
            assert.isBoolean(relayed.applied);
          } finally {
            await message?.delete();
            await deleteTestActor(a);
          }
        });

        it("the GM's Heal and a player's at the same moment heal each recipient once", async function () {
          const a = await createTestCharacter("heal-race-a", {
            system: { hb: { value: 3, max: 10 } },
          });
          const b = await createTestCharacter("heal-race-b", {
            system: { hb: { value: 3, max: 10 } },
          });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: {
                "carl-rpg": {
                  healAmount: 5,
                  healRecipients: {
                    r0: { uuid: a.uuid, name: a.name },
                    r1: { uuid: b.uuid, name: b.name },
                  },
                },
              },
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
          const a = await createTestCharacter("no-answer-a", {
            system: { hb: { value: 3, max: 10 } },
          });
          let attack;
          let heal;
          const warned = [];
          const saved = {
            warn: ui.notifications.warn,
            emit: game.socket.emit,
            timeout: askTiming.timeoutMs,
          };
          const asIfGM = (gm) =>
            Object.defineProperty(game.users, "activeGM", { configurable: true, get: () => gm });
          try {
            attack = await attackCard(2, a);
            heal = await ChatMessage.create({
              content: "<div></div>",
              flags: {
                "carl-rpg": {
                  healAmount: 5,
                  healRecipients: { r0: { uuid: a.uuid, name: a.name } },
                },
              },
            });
            ui.notifications.warn = (text) => {
              warned.push(String(text));
            };
            // Another GM is active, and never answers.
            game.socket.emit = () => {};
            askTiming.timeoutMs = 50;
            asIfGM({ id: "quenchNoAnswer", isSelf: false });
            assert.deepEqual(
              await applyRow(attack, attack.getFlag("carl-rpg", "targetRows").t0),
              [],
            );
            await onApplyHeal(fakeEvent, heal);
            // No GM online at all.
            asIfGM(null);
            assert.deepEqual(
              await applyRow(attack, attack.getFlag("carl-rpg", "targetRows").t0),
              [],
            );
            delete game.users.activeGM;
            await settle();
            assert.equal(a.system.hb.value, 3, "neither damaged nor healed");
            assert.notOk(
              attack.getFlag("carl-rpg", "targetRows").t0.applied,
              "the row isn't marked",
            );
            assert.notOk(heal.getFlag("carl-rpg", "healRecipients").r0.applied, "nor the heal");
            const noAnswer = game.i18n.localize("CARLRPG.Chat.GMNoAnswer");
            assert.lengthOf(
              warned.filter((w) => w === noAnswer),
              2,
              "told the GM didn't answer, for each",
            );
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

        const bite = {
          name: "Bite",
          toHit: "14",
          damage: "3",
          damageType: "",
          range: "",
          effect: "",
        };
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
          card = await withFakeTargets([{ actor: wren }], () =>
            CarlDice.rollMobAttack(mob, 0, { skipDialog: true }),
          );
        });
        afterEach(async function () {
          await card?.delete();
          for (const actor of [mob, wren, chase]) await deleteTestActor(actor);
        });

        const rows = () => card.getFlag("carl-rpg", "targetRows");
        const asChase = () => ({ actor: chase, token: null });
        // A d20 pinned to 10 + Rank 10 against 10 + the Mob's Mod + Floor 1: a Success.
        const rolledToSucceed = (fn) =>
          withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, fn));

        it("only a Mob's Attack can be Taunted: a crawler's has no button and is refused", async function () {
          assert.include(card.content, "carl-taunt-attack", "the Mob's Attack has one");
          assert.isTrue(canActTaunt(card));
          const punch = await createTestItem(wren, "skill", "Punch", {
            // No weapon needed (weapons.mjs needsWeapon), so it's rolled as it is.
            system: { category: "attack", rank: 2, noWeapon: true, baseDamage: { dice: "1d4" } },
          });
          const own = await withFakeTargets([{ actor: mob }], () =>
            CarlDice.rollAttack(wren, punch, { skipDialog: true }),
          );
          try {
            assert.exists(own, "the crawler's Attack was rolled");
            assert.exists(own.getFlag("carl-rpg", "targetRows"), "a targeted Attack");
            assert.notInclude(own.content, "carl-taunt-attack", "no Taunt button");
            // A card posted before the fix still has the button: hidden, refused.
            assert.isFalse(canActTaunt(own));
            assert.isNull(await tauntAttack(own, { taunter: asChase(), skipDialog: true }));
            assert.notOk(own.getFlag("carl-rpg", "tauntedBy"));
          } finally {
            await own?.delete();
          }
        });

        it("succeeds: the Attack moves onto the taunter", async function () {
          assert.exists(rows()?.t0, "the Attack card has Wren's row");
          const result = await rolledToSucceed(() =>
            tauntAttack(card, { taunter: asChase(), skipDialog: true }),
          );
          assert.equal(result, "redirected");
          assert.isTrue(rows().t0.replaced);
          assert.equal(rows().t1?.uuid, chase.uuid);
          assert.deepEqual(card.getFlag("carl-rpg", "targetUuids"), [chase.uuid]);
        });

        it("a row applied while the Taunt dialog is open refuses the redirect; the roll stands", async function () {
          const result = await rolledToSucceed(() =>
            withDialog(
              () => tauntAttack(card, { taunter: asChase() }),
              async (dialog) => {
                // Wren fails to get out of the way and takes the hit meanwhile.
                await applyRow(card, rows().t0);
                pressDialog(dialog, "roll");
              },
              "carl-roll-dialog",
            ),
          );
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
              tauntRedirectNow(
                { cardId: card.id, taunterUuid: chase.uuid, success: true, seen },
                game.user,
              ),
              tauntRedirectNow(
                { cardId: card.id, taunterUuid: pip.uuid, success: true, seen },
                game.user,
              ),
            ]);
            assert.sameMembers(
              outcomes.map((o) => o?.outcome),
              ["redirected", "refused"],
            );
            const active = Object.values(rows()).filter((r) => !r.replaced);
            assert.lengthOf(active, 1, "one taunter row");
            assert.equal(active[0].uuid, chase.uuid, "the first one's");
          } finally {
            await deleteTestActor(pip);
          }
        });
      });

      describe("Degree tags on the status rows (2026-11-27)", function () {
        useQuenchTimeout(this);

        const mobRow = (id, actor, extra = {}) => ({
          id,
          uuid: actor.uuid,
          name: actor.name,
          isCharacter: false,
          isVehicle: false,
          zone: "full",
          difficulty: 11,
          hit: true,
          amazing: false,
          degree: "standardSuccess",
          natural: 15,
          freeEvade: false,
          freeUsed: false,
          evade: null,
          applied: false,
          replaced: false,
          ...extra,
        });
        const card = (flags) =>
          ChatMessage.create({
            content: '<div class="carl-chat-card"></div>',
            flags: { "carl-rpg": { floor: 3, isArea: false, ...flags } },
          });
        const draw = (message) => {
          const html = document.createElement("div");
          html.innerHTML =
            '<div class="carl-chat-card"><header class="carl-chat-header"></header><div class="carl-target-rows"></div></div>';
          decorateTargetRows(message, html);
          return html;
        };
        const rowEl = (html, id) => html.querySelector(`[data-row-id="${id}"]`);
        const tagOf = (html, id) =>
          rowEl(html, id)?.querySelector(".carl-status-chips .carl-degree-tag");
        const short = (degree) => game.i18n.localize(`CARLRPG.DegreeTag.Short.${degree}`);

        it("a crawler's Amazing Success on a Mob: a gold Amazing tag under the chip, not a word on the sub-line", async function () {
          const rat = await createTestMob("degree-rat");
          const hound = await createTestMob("degree-hound");
          let message;
          try {
            message = await card({
              attackerType: "character",
              attackTotal: 21,
              naturalRoll: 15,
              targetRows: {
                t0: mobRow("t0", rat, { amazing: true, degree: "amazingSuccess" }),
                t1: mobRow("t1", hound, { difficulty: 23, hit: false, degree: "nearMissFail" }),
              },
            });
            const html = draw(message);
            const tag = tagOf(html, "t0");
            assert.exists(tag, "a tag stacked with the chip");
            assert.equal(tag.textContent, short("amazingSuccess"));
            assert.equal(tag.dataset.tone, "great");
            assert.exists(tag.querySelector("i.fas"), "an icon with the word, never colour alone");
            assert.include(
              tag.dataset.tooltipText,
              game.i18n.localize("CARLRPG.Degree.AmazingSuccess"),
            );
            assert.notInclude(
              rowEl(html, "t0").querySelector(".carl-status-what").textContent,
              game.i18n.localize("CARLRPG.Degree.AmazingSuccess"),
              "the sub-line word moved into the tag",
            );
            const near = tagOf(html, "t1");
            assert.equal(near?.textContent, short("nearMissFail"), "a Missed row says how close");
            assert.equal(near.dataset.tone, "near");
          } finally {
            await message?.delete();
            await deleteTestActor(rat);
            await deleteTestActor(hound);
          }
        });

        it("a Major Fail Evade on a Mob's Attack: a Major Fail tag, still shown under a Shield Block that worked", async function () {
          const wren = await createTestCharacter("degree-wren");
          const chase = await createTestCharacter("degree-chase");
          const check = (kind, natural, total, degree, success) => ({
            kind,
            natural,
            base: total,
            total,
            difficulty: 16,
            degree,
            success,
            breakdown: "",
            roll: null,
            interventions: [],
            aiRerolled: null,
            actorUuid: null,
          });
          const crawlerRow = (id, actor, checks, summary) => ({
            ...mobRow(id, actor, {
              isCharacter: true,
              difficulty: 16,
              degree: null,
              natural: null,
            }),
            checks,
            ...summary,
          });
          let message;
          try {
            const failed = check("evade", 3, 5, "majorFail", false);
            const blocked = {
              ...check("block", 14, 18, "standardSuccess", true),
              shieldName: "Bin Lid",
              rank: 1,
            };
            const failedSummary = { evade: { degree: "majorFail", success: false } };
            message = await card({
              attackerType: "mob",
              attackTotal: 16,
              targetRows: {
                t0: crawlerRow("t0", wren, { evade: failed }, failedSummary),
                t1: crawlerRow(
                  "t1",
                  chase,
                  { evade: failed, block: blocked },
                  { ...failedSummary, block: { degree: "standardSuccess", success: true } },
                ),
              },
            });
            const html = draw(message);
            for (const id of ["t0", "t1"]) {
              const tag = tagOf(html, id);
              assert.equal(
                tag?.textContent,
                short("majorFail"),
                `${id}: the Evade that adds damage`,
              );
              assert.equal(tag.dataset.tone, "major");
              assert.exists(
                rowEl(html, id).querySelector(".carl-status-chips .carl-status-chip"),
                "the status chip is still there, above it",
              );
            }
          } finally {
            await message?.delete();
            await deleteTestActor(wren);
            await deleteTestActor(chase);
          }
        });

        it("an Area Attack's rows show its one roll: the first target's number and Degree on every row", async function () {
          const rat = await createTestMob("degree-area-rat");
          const hound = await createTestMob("degree-area-hound");
          let message;
          try {
            message = await card({
              attackerType: "character",
              isArea: true,
              attackTotal: 21,
              naturalRoll: 15,
              targetDifficulty: 11,
              targetRows: {
                t0: mobRow("t0", rat, { amazing: true, degree: "amazingSuccess" }),
                // Against its own Difficulty it would be a Near Miss; the shared roll hit.
                t1: mobRow("t1", hound, { difficulty: 23, amazing: true, degree: "nearMissFail" }),
              },
            });
            const html = draw(message);
            assert.equal(tagOf(html, "t1")?.textContent, short("amazingSuccess"));
            const num = rowEl(html, "t1").querySelector(".carl-status-num").textContent;
            assert.include(num, "21");
            assert.include(num, "11", "against the first target's Difficulty");
            assert.notInclude(num, "23");
          } finally {
            await message?.delete();
            await deleteTestActor(rat);
            await deleteTestActor(hound);
          }
        });

        it("a crawler's Attack at several Mobs has no Degree in its header; at one, it keeps it", async function () {
          const actor = await createTestCharacter("degree-dax");
          const rat = await createTestMob("degree-head-rat", {
            system: { stats: { dex: { value: 3 } } },
          });
          const hound = await createTestMob("degree-head-hound");
          const messages = [];
          try {
            const skill = await createTestItem(actor, "skill", "Attack Skill", {
              name: "Wrench Work",
              system: { category: "attack", isHandToHand: true, rank: 15, governingStat: "" },
            });
            await settle();
            const roll = (targets) =>
              withSetting("currentFloor", 1, () =>
                withPinnedDice(PIN_D20_MID, () =>
                  withFakeTargets(targets, () =>
                    CarlDice.rollAttack(actor, skill, { skipDialog: true }),
                  ),
                ),
              );
            const header = (message) => {
              const div = document.createElement("div");
              div.innerHTML = message.content;
              return div.querySelector(".carl-chat-header");
            };
            const labels = Object.values(CARLRPG.degreesOfSuccess).map((k) =>
              game.i18n.localize(k),
            );

            const several = await roll([{ actor: rat }, { actor: hound }]);
            messages.push(several);
            assert.exists(several, "the Attack was rolled");
            assert.notOk(several.getFlag("carl-rpg", "isArea"), "not an Area Attack");
            const head = header(several);
            for (const label of labels) assert.notInclude(head.textContent, label);
            assert.notExists(head.querySelector(".carl-badge"), "no Degree badge");

            const one = await roll([{ actor: rat }]);
            messages.push(one);
            assert.isTrue(
              labels.some((label) => header(one).textContent.includes(label)),
              "one target: its Degree in the header",
            );
          } finally {
            for (const m of messages) await m?.delete();
            await deleteTestActor(actor);
            await deleteTestActor(rat);
            await deleteTestActor(hound);
          }
        });
      });
    },
    { displayName: "CarlRPG: chat-card gate/apply functions" },
  );
}
