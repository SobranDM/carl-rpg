import {
  buildOpposedChoice,
  opposedFieldsHtml,
  opposedNote,
  readOpposed,
} from "../../dice/opposed.mjs";
import { promptRollOptions } from "../../dice/roll-prompt.mjs";
import { opposedStatOf } from "../../pdf-import/parse-spells.mjs";
import { opposedDifficulty } from "../../helpers/rules.mjs";
import { currentFloor } from "../../helpers/floor.mjs";
import { pressDialog, useQuenchTimeout, withDialog } from "../helpers.mjs";

/**
 * Opposed Checks (0.8.0, ruled 2026-11-20; p.59): "10 + antagonist's
 * relevant Stat Mod + Floor Number", on any Skill or Stat Check and the
 * Party Skill Check; the compendium Skills the book calls Opposed know their
 * Stat. Needs the system's packs built for the compendium test.
 */
const BASE = { value: 13, label: "Unopposed: 13" };

/** A choice with made-up opponents (no tokens needed). */
function fakeChoice(overrides = {}) {
  return {
    opponents: [
      {
        id: "a",
        name: "Goblin",
        mods: { str: 1, dex: 2, con: 0, int: 3, cha: -1 },
        targeted: true,
      },
      {
        id: "b",
        name: "Troll",
        mods: { str: 5, dex: 0, con: 4, int: -2, cha: 0 },
        targeted: false,
      },
      { id: "other", name: "A number", mods: null, targeted: false },
    ],
    selected: "a",
    statKey: "int",
    follow: false,
    floor: currentFloor(),
    opposed: false,
    base: BASE,
    difficulty: BASE.value,
    label: BASE.label,
    ...overrides,
  };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.opposed",
    (context) => {
      const { describe, it, assert } = context;

      describe("Reading who opposed it", function () {
        it("a Stat of a creature, a number, or not Opposed", function () {
          const choice = fakeChoice();
          assert.deepEqual(
            readOpposed({ opposed: true, opposedBy: "b", opposedStat: "str" }, choice),
            {
              name: "Troll",
              statKey: "str",
              mod: 5,
            },
          );
          assert.deepEqual(
            readOpposed({ opposed: true, opposedBy: "other", opposedNumber: 4 }, choice),
            {
              name: null,
              statKey: null,
              mod: 4,
            },
          );
          assert.isNull(readOpposed({ opposed: false, opposedBy: "a" }, choice));
          assert.isNull(readOpposed({ opposed: true, opposedBy: "a" }, null));
        });

        it("the card's note names them and their Mod", function () {
          assert.include(opposedNote({ name: "Goblin", statKey: "int", mod: 3 }), "Goblin");
          assert.include(opposedNote({ name: "Goblin", statKey: "int", mod: 3 }), "+3");
          assert.include(opposedNote({ name: null, statKey: null, mod: -1 }), "-1");
          assert.equal(opposedNote(null), "");
        });

        it("a Spell's or Skill's text: 'Int-Opposed', even split across a line", function () {
          assert.equal(opposedStatOf("Make an Int-Opposed Spell Check vs. foes"), "int");
          assert.equal(opposedStatOf("make a Cha-Op posed Skill Check"), "cha");
          assert.equal(opposedStatOf("Make an Unopposed Skill Check."), "");
        });
      });

      describe("Nothing targeted", function () {
        it("Opposed is offered, unticked, on the roll's own Difficulty", function () {
          const choice = buildOpposedChoice({ statKey: "dex", base: BASE });
          if (game.user.targets.size) this.skip();
          assert.isFalse(choice.opposed);
          assert.equal(choice.difficulty, BASE.value);
          assert.equal(choice.statKey, "dex");
          assert.exists(
            choice.opponents.find((o) => o.id === "other"),
            "a number is always offered",
          );
          assert.include(opposedFieldsHtml(choice), 'name="opposed"');
        });
      });

      describe("The roll dialog", function () {
        useQuenchTimeout(this);

        it("ticking Opposed and picking an opponent and Stat sets the Difficulty; unticking puts it back", async function () {
          const floor = currentFloor();
          const result = await withDialog(
            () =>
              promptRollOptions({
                title: "Quench Opposed",
                difficulty: BASE.value,
                showDifficulty: true,
                opposedChoice: fakeChoice(),
              }),
            async (dialog) => {
              const root = dialog.element;
              const field = (name) => root.querySelector(`[name="${name}"]`);
              const difficulty = field("difficulty");
              const set = (name, value) => {
                const el = field(name);
                if (el.type === "checkbox") el.checked = value;
                else el.value = value;
                el.dispatchEvent(
                  new Event(el.type === "number" ? "input" : "change", { bubbles: true }),
                );
              };
              assert.equal(Number(difficulty.value), BASE.value);
              set("opposed", true);
              assert.equal(Number(difficulty.value), opposedDifficulty(3, floor), "Goblin's INT");
              set("opposedBy", "b");
              set("opposedStat", "str");
              assert.equal(Number(difficulty.value), opposedDifficulty(5, floor), "Troll's STR");
              set("opposedBy", "other");
              set("opposedNumber", 2);
              assert.equal(Number(difficulty.value), opposedDifficulty(2, floor), "a number");
              set("opposed", false);
              assert.equal(Number(difficulty.value), BASE.value, "back to the roll's own");
              set("opposed", true);
              set("opposedBy", "b");
              set("opposedStat", "con");
              pressDialog(dialog, "roll");
            },
            "carl-roll-dialog",
          );
          assert.equal(result.difficulty, opposedDifficulty(4, floor));
          assert.deepEqual(result.opposed, { name: "Troll", statKey: "con", mod: 4 });
        });
      });

      describe("The compendium's Opposed Skills (ruled 2026-11-20)", function () {
        useQuenchTimeout(this);

        it("the Skills and Spells the book calls Opposed know their Stat", async function () {
          const pack = game.packs.get("carl-rpg.skills-and-spells");
          assert.exists(pack, "run npm run build:packs with the world closed");
          const index = await pack.getIndex({ fields: ["system.opposedStat"] });
          const stat = (name) => index.find((e) => e.name === name)?.system?.opposedStat;
          for (const [name, key] of [
            ["Stealth", "int"],
            ["Intimidate", "cha"],
            ["Detect Lies", "cha"],
            ["Escape Artist", "str"],
            ["Wrasslin'", "str"],
            ["Taunt", "int"],
            ["Turn Undead", "cha"],
          ]) {
            assert.equal(stat(name), key, name);
          }
          assert.notOk(stat("Lockpicking"), "only sometimes Opposed: left Unopposed");
          assert.notOk(stat("Climbing"), "an Unopposed Skill");
        });
      });
    },
    { displayName: "CarlRPG: Opposed Checks" },
  );
}
