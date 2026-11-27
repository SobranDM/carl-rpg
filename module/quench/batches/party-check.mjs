/**
 * Rolls (docs/rules-fixes.md E): Party Skill Checks from the GM Toolbox
 * (p.59 - module/chat/party-check-card.mjs) and the roll dialog's Off-Stat
 * Stat dropdown (p.58 - module/dice/roll-prompt.mjs).
 */
import CarlDice from "../../dice/dice.mjs";
import {
  buildStatChoice,
  chosenStat,
  offStatNote,
  promptRollOptions,
} from "../../dice/roll-prompt.mjs";
import {
  applyPartyOp,
  canRollRow,
  gradePartyRoll,
  offStatLabel,
  partyTally,
  postPartyCheck,
  rollPartyRow,
} from "../../chat/party-check-card.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  PIN_D20_MID,
  pressDialog,
  useQuenchTimeout,
  waitFor,
  withDialog,
  withPinnedDice,
} from "../helpers.mjs";

const ROLL = "carl-roll-dialog";
const rolled = (success) => ({ check: { success } });

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.party-check",
    (context) => {
      const { describe, it, assert } = context;

      describe("Off-Stat (p.58)", function () {
        useQuenchTimeout(this);

        it("the Stat dropdown picks the Skill's own Stat; a Skill with none offers None", function () {
          const con = buildStatChoice("con");
          assert.equal(con.selected, "con");
          assert.equal(con.options.find((o) => o.selected)?.key, "con");
          assert.sameMembers(
            con.options.map((o) => o.key),
            Object.keys(CONFIG.CARLRPG.stats),
          );
          const none = buildStatChoice("");
          assert.equal(none.options[0].key, "", "None first");
          assert.isTrue(none.options[0].selected);
        });

        it("the roll uses the picked Stat, else the Skill's; the card names a change", function () {
          assert.equal(chosenStat({ statKey: "int" }, "con"), "int");
          assert.equal(chosenStat({}, "con"), "con", "no dialog: the Skill's own");
          assert.equal(offStatNote("con", "con"), "");
          const abbr = (k) => game.i18n.localize(CONFIG.CARLRPG.statAbbreviations[k]);
          assert.include(
            offStatNote("int", "con"),
            foundry.utils.escapeHTML(
              game.i18n.format("CARLRPG.Dialog.OffStatNote", {
                stat: abbr("int"),
                governing: abbr("con"),
              }),
            ),
          );
        });

        it("the dialog returns the Stat picked", async function () {
          const result = await withDialog(
            () => promptRollOptions({ title: "stat", statChoice: buildStatChoice("con") }),
            (dialog) => {
              const select = dialog.element.querySelector('select[name="stat"]');
              assert.exists(select, "a Stat dropdown");
              assert.equal(select.value, "con", "the Skill's own, picked");
              select.value = "int";
              pressDialog(dialog, "roll");
            },
            ROLL,
          );
          assert.equal(result.statKey, "int");
        });

        it("a Skill Check rolled with another Stat says so on its card", async function () {
          const actor = await createTestCharacter("offstat");
          let message;
          try {
            const skill = await createTestItem(actor, "skill", "Survival", {
              system: { rank: 2, governingStat: "con" },
            });
            message = await withDialog(
              () => CarlDice.rollSkillCheck(actor, skill),
              (dialog) => {
                dialog.element.querySelector('select[name="stat"]').value = "int";
                pressDialog(dialog, "roll");
              },
              ROLL,
            );
            assert.exists(message);
            assert.include(message.content, "carl-off-stat-note");
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });
      });

      describe("the tally (p.59)", function () {
        it("half or more succeed: the party succeeds", function () {
          const state = (rows, closed = false) => ({
            closed,
            rows: Object.fromEntries(rows.map((r, i) => [`c${i}`, r])),
          });
          assert.equal(
            partyTally(state([rolled(true), rolled(false)])).outcome,
            "succeeds",
            "1 of 2 is half",
          );
          assert.equal(
            partyTally(state([rolled(true), rolled(false), rolled(false)])).outcome,
            "fails",
          );
          assert.isNull(
            partyTally(state([rolled(true), { check: null }])).outcome,
            "still waiting",
          );
          const closed = partyTally(
            state([rolled(true), rolled(false), { check: null }, { check: null }], true),
          );
          assert.equal(closed.outcome, "succeeds", "closed: only those who rolled count");
          assert.equal(closed.rolled, 2);
          assert.equal(partyTally(state([{ check: null }], true)).outcome, "none");
        });

        it("grades against the card's Difficulty", function () {
          assert.isTrue(gradePartyRoll({ total: 15, naturalRoll: 8 }, 15).success);
          assert.isFalse(gradePartyRoll({ total: 14, naturalRoll: 8 }, 15).success);
          assert.isTrue(gradePartyRoll({ total: 3, naturalRoll: 20 }, 15).success, "a Natural 20");
          assert.isFalse(gradePartyRoll({ total: 30, naturalRoll: 1 }, 15).success, "a Natural 1");
        });
      });

      describe("the card (GM side)", function () {
        useQuenchTimeout(this);

        it("records each roll once, graded by the card; Close settles it and refuses later rolls", async function () {
          const a = await createTestCharacter("party a");
          const b = await createTestCharacter("party b");
          let message;
          try {
            message = await postPartyCheck({
              skill: `Quench nothing ${foundry.utils.randomID()}`,
              difficulty: 12,
              actors: [a, b],
            });
            assert.exists(message);
            const state = () => message.getFlag("carl-rpg", "partyCheck");
            assert.deepEqual(Object.keys(state().rows), ["c0", "c1"]);
            assert.deepEqual(
              state().rows.c0,
              { uuid: a.uuid, name: a.name, check: null },
              "one row per crawler, unrolled",
            );
            assert.isFalse(state().closed);

            assert.isTrue(
              await applyPartyOp(
                message.id,
                "roll",
                { rowId: "c0", check: { total: 13, naturalRoll: 9 } },
                game.user,
              ),
            );
            assert.isTrue(state().rows.c0.check.success, "13 vs 12");
            assert.isFalse(
              await applyPartyOp(
                message.id,
                "roll",
                { rowId: "c0", check: { total: 2, naturalRoll: 1 } },
                game.user,
              ),
              "already rolled",
            );
            assert.isTrue(state().rows.c0.check.success);

            assert.isTrue(await applyPartyOp(message.id, "close", {}, game.user));
            assert.isTrue(state().closed);
            assert.isFalse(
              await applyPartyOp(
                message.id,
                "roll",
                { rowId: "c1", check: { total: 20, naturalRoll: 10 } },
                game.user,
              ),
              "closed",
            );
            assert.equal(partyTally(state()).outcome, "succeeds");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("names an Off-Stat roll on its row (the Stat is recorded with the roll)", async function () {
          assert.equal(offStatLabel("con", "con"), "", "the Skill's own Stat: no label");
          assert.equal(offStatLabel("", "con"), "", "a card from before rows recorded the Stat");
          assert.include(offStatLabel("int", "con"), "INT");
          assert.include(offStatLabel("int", "con"), "CON");
          assert.include(
            offStatLabel("int", ""),
            "INT",
            "a Skill in no compendium: names the Stat used",
          );

          const a = await createTestCharacter("off-stat");
          let message;
          try {
            message = await postPartyCheck({
              skill: `Quench nothing ${foundry.utils.randomID()}`,
              difficulty: 12,
              actors: [a],
            });
            await message.update({ "flags.carl-rpg.partyCheck.stat": "con" });
            assert.isTrue(
              await applyPartyOp(
                message.id,
                "roll",
                { rowId: "c0", check: { total: 13, naturalRoll: 9, stat: "int" } },
                game.user,
              ),
            );
            assert.equal(
              message.getFlag("carl-rpg", "partyCheck").rows.c0.check.stat,
              "int",
              "stored with the roll",
            );
            const label = offStatLabel("int", "con");
            const drawn = () =>
              [...document.querySelectorAll(`[data-message-id="${message.id}"]`)].map(
                (el) => el.textContent,
              );
            await waitFor(() => drawn().length, { message: "the card was never drawn" });
            await waitFor(() => drawn().some((text) => text.includes(label)), {
              message: "the Off-Stat label never showed on the row",
            });
          } finally {
            await message?.delete();
            await deleteTestActor(a);
          }
        });

        it("a crawler without the Skill makes the Stat Check with Disadvantage", async function () {
          const a = await createTestCharacter("untrained");
          let message;
          try {
            const itemsBefore = a.items.size;
            message = await postPartyCheck({
              skill: `Quench nothing ${foundry.utils.randomID()}`,
              difficulty: 5,
              actors: [a],
            });
            const row = message.getFlag("carl-rpg", "partyCheck").rows.c0;
            assert.isTrue(canRollRow(row), "the GM rolls for a crawler no logged-in player owns");
            await withPinnedDice(PIN_D20_MID, () =>
              withDialog(
                () => rollPartyRow(message, "c0"),
                (dialog) => pressDialog(dialog, "roll"),
                ROLL,
              ),
            );
            const check = message.getFlag("carl-rpg", "partyCheck").rows.c0.check;
            assert.exists(check);
            assert.isFalse(check.trained);
            assert.include(check.formula ?? "", "kl", "Disadvantage");
            assert.equal(a.items.size, itemsBefore, "nothing created on the crawler");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
          }
        });

        it("a crawler with the Skill rolls it", async function () {
          const a = await createTestCharacter("trained");
          let message;
          try {
            const skill = await createTestItem(a, "skill", "Climbing", {
              system: { rank: 3, governingStat: "str" },
            });
            message = await postPartyCheck({ skill: skill.name, difficulty: 5, actors: [a] });
            await withPinnedDice(PIN_D20_MID, () =>
              withDialog(
                () => rollPartyRow(message, "c0"),
                (dialog) => pressDialog(dialog, "roll"),
                ROLL,
              ),
            );
            const check = message.getFlag("carl-rpg", "partyCheck").rows.c0.check;
            assert.isTrue(check.trained);
            assert.equal(check.formula, "1d20");
            assert.isTrue(a.items.get(skill.id).system.marked, "marked for Advancement");
          } finally {
            await message?.delete();
            await deleteTestActor(a);
          }
        });
      });
    },
    { displayName: "CarlRPG: Party Checks and Off-Stat" },
  );
}
