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

        const plainDialog = (buttons) => () => showCarlDialog({ title: "buttons", content: "<p>x</p>", classes: ["carl-test-dialog"], buttons });

        it("Cancel resolves null", async function () {
          const result = await withDialog(plainDialog([{ action: "go", label: "Go", callback: () => 1 }, cancelButton()]),
            (dialog) => press(dialog, "cancel"), "carl-test-dialog");
          assert.isNull(result);
        });

        it("a callback that returns nothing resolves null, not its action", async function () {
          const result = await withDialog(plainDialog([{ action: "read", label: "Read", callback: () => null }]),
            (dialog) => press(dialog, "read"), "carl-test-dialog");
          assert.isNull(result);
        });

        it("a falsy answer (0) and a button with no callback still come through", async function () {
          const zero = await withDialog(plainDialog([{ action: "first", label: "First", callback: () => 0 }]),
            (dialog) => press(dialog, "first"), "carl-test-dialog");
          assert.strictEqual(zero, 0);
          const bare = await withDialog(plainDialog([{ action: "self", label: "Self" }]),
            (dialog) => press(dialog, "self"), "carl-test-dialog");
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
            const result = await withDialog(() => CarlDice.rollSkillCheck(actor, skill), (dialog) => press(dialog, "cancel"));
            assert.isNull(result, "cancelled");
            await settle(100);
            assert.equal(game.messages.size, before, "no card posted");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Skill Check card shows the Difficulty it was rolled against", async function () {
          const actor = await createTestCharacter("difficulty");
          let message;
          try {
            const skill = await createTestItem(actor, "skill", "climb", { system: { rank: 2 } });
            message = await withDialog(() => CarlDice.rollSkillCheck(actor, skill), (dialog) => {
              dialog.element.querySelector('input[name="difficulty"]').value = "17";
              press(dialog, "roll");
            });
            assert.exists(message);
            assert.include(message.content, game.i18n.format("CARLRPG.Roll.VsDifficulty", { difficulty: 17 }));
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });

        it("has no Roll label, a help icon citing p.59, formula-free presets, and room for its labels", async function () {
          const difficultyPresets = buildDifficultyPresets({
            floor: 3, selected: "unopposed", opposed: { name: "Mordecai", stat: "DEX", mod: 2 },
          });
          await withDialog(() => promptRollOptions({ title: "layout", difficultyPresets }), (dialog) => {
            const el = dialog.element;
            assert.isNull(el.querySelector(".carl-dialog-roll-mode > label"), "no Roll label");
            assert.lengthOf(el.querySelectorAll('.carl-dialog-roll-mode input[name="advantage"]'), 3);
            const help = el.querySelector(".carl-dialog-help");
            assert.include(help?.dataset.tooltipHtml ?? "", "p.59");
            assert.equal(help?.getAttribute("tabindex"), "0", "reachable from the keyboard");
            assert.include(help?.getAttribute("aria-label") ?? "", "10 + 2 x Floor", "the formulas, without hovering");
            const labels = [...el.querySelectorAll('select[name="difficultyPreset"] option')].map((o) => o.textContent);
            assert.include(labels, game.i18n.format("CARLRPG.Dialog.Preset.Unopposed", { value: 16 }));
            assert.include(labels, game.i18n.format("CARLRPG.Dialog.Preset.Stat", { value: 13 }));
            assert.include(labels, game.i18n.format("CARLRPG.Dialog.Preset.Opposed", { name: "Mordecai", stat: "DEX", value: 15 }));
            assert.isTrue(labels.every((l) => !l.includes("Floor") && !l.includes("Mod")), "no formulas");
            assert.isAtLeast(dialog.position.width, 480);
            press(dialog, "cancel");
          });
        });

        it("offers Damage Effects as radios, None by default", async function () {
          const damageEffectChoices = [{ id: "smush", name: "Smush", rank: 2 }, { id: "choke", name: "Choke Out", rank: 1 }];
          const start = () => promptRollOptions({ title: "effects", showDifficulty: false, damageEffectChoices });

          const none = await withDialog(start, (dialog) => {
            assert.isNull(dialog.element.querySelector('select[name="damageEffectId"]'), "not a dropdown");
            const radios = [...dialog.element.querySelectorAll('input[type="radio"][name="damageEffectId"]')];
            assert.lengthOf(radios, 3);
            assert.equal(radios.find((r) => r.checked)?.value, "", "None");
            press(dialog, "roll");
          });
          assert.isNull(none?.damageEffectId);

          const choke = await withDialog(start, (dialog) => {
            dialog.element.querySelector('input[name="damageEffectId"][value="choke"]').checked = true;
            press(dialog, "roll");
          });
          assert.equal(choke?.damageEffectId, "choke");
        });

        it("an emptied Difficulty box means no Difficulty, not 0", async function () {
          const result = await withDialog(() => promptRollOptions({ title: "empty", difficulty: 12 }), (dialog) => {
            dialog.element.querySelector('input[name="difficulty"]').value = "";
            press(dialog, "roll");
          });
          assert.isNull(result.difficulty);
        });

        it("checkSubtitle adds the Difficulty only when there is one", function () {
          const success = game.i18n.localize(CONFIG.CARLRPG.degreesOfSuccess.standardSuccess);
          assert.equal(checkSubtitle("standardSuccess", null), success);
          assert.equal(checkSubtitle("standardSuccess", Number.NaN), success, "a bad flag value");
          assert.include(checkSubtitle("standardSuccess", 12), game.i18n.format("CARLRPG.Roll.VsDifficulty", { difficulty: 12 }));
        });
      });
    },
    { displayName: "CarlRPG: Roll Dialog" },
  );
}
