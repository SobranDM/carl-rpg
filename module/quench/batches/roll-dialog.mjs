import CarlDice, { checkSubtitle } from "../../dice/dice.mjs";
import { promptRollOptions } from "../../dice/roll-prompt.mjs";
import { cancelButton, showCarlDialog } from "../../apps/carl-dialog.mjs";
import { buildDifficultyPresets } from "../../helpers/rules.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  pressDialog as press,
  settle,
  useQuenchTimeout,
  withDialog as withAnyDialog,
} from "../helpers.mjs";

const ROLL = "carl-roll-dialog";
/** The roll dialog, unless another class is named. */
const withDialog = (start, fn, cssClass = ROLL) => withAnyDialog(start, fn, cssClass);

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.roll-dialog",
    (context) => {
      const { describe, it, assert } = context;

      describe("System dialogs", function () {
        useQuenchTimeout(this);

        const plainDialog = (buttons) => () =>
          showCarlDialog({
            title: "buttons",
            content: "<p>x</p>",
            classes: ["carl-test-dialog"],
            buttons,
          });

        it("Cancel resolves null", async function () {
          const result = await withDialog(
            plainDialog([{ action: "go", label: "Go", callback: () => 1 }, cancelButton()]),
            (dialog) => press(dialog, "cancel"),
            "carl-test-dialog",
          );
          assert.isNull(result);
        });

        it("a callback that returns nothing resolves null, not its action", async function () {
          const result = await withDialog(
            plainDialog([{ action: "read", label: "Read", callback: () => null }]),
            (dialog) => press(dialog, "read"),
            "carl-test-dialog",
          );
          assert.isNull(result);
        });

        it("a falsy answer (0) and a button with no callback still come through", async function () {
          const zero = await withDialog(
            plainDialog([{ action: "first", label: "First", callback: () => 0 }]),
            (dialog) => press(dialog, "first"),
            "carl-test-dialog",
          );
          assert.strictEqual(zero, 0);
          const bare = await withDialog(
            plainDialog([{ action: "self", label: "Self" }]),
            (dialog) => press(dialog, "self"),
            "carl-test-dialog",
          );
          assert.equal(bare, "self");
        });
      });

      describe("The roll dialog", function () {
        useQuenchTimeout(this);

        it("Cancel rolls nothing", async function () {
          const actor = await createTestCharacter("cancel");
          try {
            const skill = await createTestItem(actor, "skill", "climb", { system: { rank: 2 } });
            const before = game.messages.size;
            const result = await withDialog(
              () => CarlDice.rollSkillCheck(actor, skill),
              (dialog) => press(dialog, "cancel"),
            );
            assert.isNull(result, "cancelled");
            await settle(100);
            assert.equal(game.messages.size, before, "no card posted");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a combat roll's Difficulty is locked, and its Modifier reaches every Check after it (ruled 2026-11-27)", async function () {
          const actor = await createTestCharacter("combat modifier");
          try {
            const first = await withDialog(
              () => CarlDice.rollEvadeCheck(actor, { difficulty: 15, post: false }),
              (dialog) => {
                const difficulty = dialog.element.querySelector('input[name="difficulty"]');
                assert.isTrue(difficulty.disabled, "the rules' Difficulty, locked");
                dialog.element.querySelector('input[name="modifier"]').value = "3";
                press(dialog, "roll");
              },
            );
            assert.equal(first.options.modifier, 3);
            assert.equal(first.options.difficulty, 15, "the given Difficulty stands");
            // The next Attack's Check, as the Reaction card rolls it: the same
            // choices, its own Difficulty.
            const { difficulty: _first, ...preset } = first.options;
            const second = await CarlDice.rollEvadeCheck(actor, {
              difficulty: 18,
              post: false,
              isAction: false,
              preset,
            });
            assert.equal(second.options.modifier, 3);
            assert.equal(second.options.difficulty, 18);
            assert.equal(
              second.total - second.naturalRoll,
              first.total - first.naturalRoll,
              "the same +3 on both",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("with no Difficulty given, a combat roll's stays open to type in", async function () {
          const actor = await createTestCharacter("combat open");
          try {
            await withDialog(
              () => CarlDice.rollEvadeCheck(actor, { post: false }),
              (dialog) => {
                const difficulty = dialog.element.querySelector('input[name="difficulty"]');
                assert.isFalse(difficulty.disabled);
                press(dialog, "cancel");
              },
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Skill Check card shows the Difficulty it was rolled against", async function () {
          const actor = await createTestCharacter("difficulty");
          let message;
          try {
            const skill = await createTestItem(actor, "skill", "climb", { system: { rank: 2 } });
            message = await withDialog(
              () => CarlDice.rollSkillCheck(actor, skill),
              (dialog) => {
                dialog.element.querySelector('input[name="difficulty"]').value = "17";
                press(dialog, "roll");
              },
            );
            assert.exists(message);
            assert.include(
              message.content,
              game.i18n.format("CARLRPG.Roll.VsDifficulty", { difficulty: 17 }),
            );
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });

        it("has no Roll label, no preset dropdown or modifier, a help icon citing p.59, and the Difficulty's source as a hint", async function () {
          const difficultyPresets = buildDifficultyPresets({
            floor: 3,
            selected: "unopposed",
            opposed: { name: "Mordecai", stat: "DEX", mod: 2 },
          });
          await withDialog(
            () => promptRollOptions({ title: "layout", difficultyPresets }),
            (dialog) => {
              const el = dialog.element;
              assert.equal(
                el.querySelector(".carl-dialog-roll-mode > label")?.textContent.trim(),
                game.i18n.localize("CARLRPG.Dialog.Advantage"),
                "labeled Advantage",
              );
              const advantage = el.querySelector('.carl-dialog-roll-mode select[name="advantage"]');
              assert.deepEqual(
                [...advantage.options].map((o) => o.value),
                ["normal", "advantage", "disadvantage"],
                "a dropdown",
              );
              assert.equal(advantage.value, "normal");
              const help = el.querySelector(".carl-dialog-help");
              assert.include(help?.dataset.tooltipHtml ?? "", "p.59");
              assert.equal(help?.getAttribute("tabindex"), "0", "reachable from the keyboard");
              assert.include(
                help?.getAttribute("aria-label") ?? "",
                "10 + 2 x Floor",
                "the formulas, without hovering",
              );
              assert.isNull(
                el.querySelector('select[name="difficultyPreset"]'),
                "no Difficulty type dropdown",
              );
              assert.isNull(
                el.querySelector('input[name="modifier"]'),
                "no situational modifier (ruled 2026-11-18)",
              );
              assert.equal(
                el.querySelector(".carl-dialog-difficulty-basis")?.textContent.trim(),
                game.i18n.format("CARLRPG.Dialog.Preset.Unopposed", { value: 16 }),
                "the hint names the formula used",
              );
              assert.isAtLeast(dialog.position.width, 480);
              press(dialog, "cancel");
            },
          );
        });

        it("offers Damage Effects as radios, None by default", async function () {
          const damageEffectChoices = [
            { id: "smush", name: "Smush", rank: 2 },
            { id: "choke", name: "Choke Out", rank: 1 },
          ];
          const start = () =>
            promptRollOptions({ title: "effects", showDifficulty: false, damageEffectChoices });

          const none = await withDialog(start, (dialog) => {
            assert.isNull(
              dialog.element.querySelector('select[name="damageEffectId"]'),
              "not a dropdown",
            );
            const radios = [
              ...dialog.element.querySelectorAll('input[type="radio"][name="damageEffectId"]'),
            ];
            assert.lengthOf(radios, 3);
            assert.equal(radios.find((r) => r.checked)?.value, "", "None");
            press(dialog, "roll");
          });
          assert.isNull(none?.damageEffectId);

          const choke = await withDialog(start, (dialog) => {
            dialog.element.querySelector('input[name="damageEffectId"][value="choke"]').checked =
              true;
            press(dialog, "roll");
          });
          assert.equal(choke?.damageEffectId, "choke");
        });

        it("an emptied Difficulty box means no Difficulty, not 0", async function () {
          const result = await withDialog(
            () => promptRollOptions({ title: "empty", difficulty: 12 }),
            (dialog) => {
              dialog.element.querySelector('input[name="difficulty"]').value = "";
              press(dialog, "roll");
            },
          );
          assert.isNull(result.difficulty);
        });

        it("checkSubtitle adds the Difficulty only when there is one", function () {
          const success = game.i18n.localize(CONFIG.CARLRPG.degreesOfSuccess.standardSuccess);
          assert.equal(checkSubtitle("standardSuccess", null), success);
          assert.equal(checkSubtitle("standardSuccess", Number.NaN), success, "a bad flag value");
          assert.include(
            checkSubtitle("standardSuccess", 12),
            game.i18n.format("CARLRPG.Roll.VsDifficulty", { difficulty: 12 }),
          );
        });
      });
    },
    { displayName: "CarlRPG: Roll Dialog" },
  );
}
