/**
 * Day and night (helpers/day-night.mjs; ruled 2026-11-27): the GM's toggle,
 * a Lajabless's Stats and Spell costs, a Night Elf's Hide in Shadows and a
 * Gobblin' Hog's Mods.
 */
import {
  TIME_OF_DAY,
  clampManaToMax,
  dayNightAdvantage,
  isNight,
} from "../../helpers/day-night.mjs";
import { effectiveManaCost } from "../../helpers/mana-cost.mjs";
import { getStatMod } from "../../helpers/rules.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  settle,
  useQuenchTimeout,
  withSetting,
} from "../helpers.mjs";

/** A crawler of this Race (by the Race item's name), Str 8 and Int 6. */
async function crawlerOf(raceName) {
  const actor = await createTestCharacter(`day-night ${raceName}`, {
    system: { stats: { str: { value: 8 }, int: { value: 6 } } },
  });
  const race = await createTestItem(actor, "race", raceName, { name: raceName });
  await actor.update({ "system.race": race.id });
  return actor;
}

const atNight = (fn) => withSetting(TIME_OF_DAY, "night", fn);
const byDay = (fn) => withSetting(TIME_OF_DAY, "day", fn);

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.day-night",
    (context) => {
      const { describe, it, assert } = context;

      describe("Day and night (ruled 2026-11-27)", function () {
        useQuenchTimeout(this, 30000);

        it("the GM's toggle is a world setting, day unless set", async function () {
          await byDay(async () => assert.isFalse(isNight()));
          await atNight(async () => assert.isTrue(isNight()));
        });

        it("Lajabless: by day +5 Int and Strength halved; by night (Strength + 5) doubled", async function () {
          const actor = await crawlerOf("Lajabless");
          try {
            await byDay(async () => {
              await settle();
              assert.equal(actor.system.stats.int.effective, 11, "6 + 5");
              assert.equal(actor.system.stats.str.effective, 4, "8 halved");
              assert.equal(actor.system.mana.max, 11, "Max Mana follows the Int");
            });
            await atNight(async () => {
              await settle();
              assert.equal(actor.system.stats.str.effective, 26, "(8 + 5) x 2");
              assert.equal(actor.system.stats.int.effective, 6, "no +5 Int at night");
              assert.equal(actor.system.stats.str.mod, getStatMod(26));
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Lajabless (Primal) counts too; another Race doesn't change", async function () {
          const primal = await crawlerOf("Lajabless (Primal)");
          const human = await crawlerOf("Human");
          try {
            await atNight(async () => {
              await settle();
              assert.isAbove(primal.system.stats.str.effective, 8, "doubled");
              assert.equal(human.system.stats.str.effective, 8);
            });
          } finally {
            await deleteTestActor(primal);
            await deleteTestActor(human);
          }
        });

        it("Lajabless Spells: half the Mana by day, double by night, rounded up, at least 1", async function () {
          const actor = await crawlerOf("Lajabless");
          try {
            const spell = await createTestItem(actor, "spell", "spark", {
              system: { manaCost: 3 },
            });
            await byDay(async () => {
              assert.equal(effectiveManaCost(spell, actor), 2, "3 halved, rounded up");
              assert.equal(effectiveManaCost(spell, actor, 1), 1, "never below 1");
              assert.equal(effectiveManaCost(spell, actor, 0), 0, "a free Spell stays free");
            });
            await atNight(async () => {
              assert.equal(effectiveManaCost(spell, actor), 6, "3 doubled");
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("at nightfall a Lajabless's Mana comes down to its new Max", async function () {
          const actor = await crawlerOf("Lajabless");
          try {
            await byDay(async () => {
              await settle();
              await actor.update({ "system.mana.value": actor.system.mana.max });
              assert.equal(actor.system.mana.value, 11);
            });
            await atNight(async () => {
              await settle();
              await clampManaToMax();
              assert.equal(actor.system.mana.value, actor.system.mana.max);
              assert.equal(actor.system.mana.max, 6);
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Night Elf's Hide in Shadows has Advantage at night only", async function () {
          const actor = await crawlerOf("Elf (Night)");
          try {
            const hide = await createTestItem(actor, "skill", "Hide in Shadows", {
              name: "Hide in Shadows",
            });
            const climb = await createTestItem(actor, "skill", "Climbing", { name: "Climbing" });
            await byDay(async () => assert.isFalse(dayNightAdvantage(actor, hide)));
            await atNight(async () => {
              assert.isTrue(dayNightAdvantage(actor, hide));
              assert.isFalse(dayNightAdvantage(actor, climb), "only Hide in Shadows");
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Gobblin' Hog's Int and Dex Mods swap at night, and its Surprise and Evade with them", async function () {
          const hog = await createTestMob("Gobblin' Hog", {
            system: { stats: { int: { value: 1 }, dex: { value: 12 } } },
          });
          try {
            let day;
            await byDay(async () => {
              await settle();
              day = {
                int: hog.system.stats.int.mod,
                dex: hog.system.stats.dex.mod,
                evade: hog.system.evadeBase,
                surprise: hog.system.surpriseBase,
              };
            });
            assert.notEqual(day.int, day.dex, "different Mods to swap");
            await atNight(async () => {
              await settle();
              assert.equal(hog.system.stats.int.mod, day.dex);
              assert.equal(hog.system.stats.dex.mod, day.int);
              assert.equal(hog.system.evadeBase, day.surprise, "Evade takes the old Surprise");
              assert.equal(hog.system.surpriseBase, day.evade);
            });
          } finally {
            await deleteTestActor(hog);
          }
        });
      });
    },
    { displayName: "CarlRPG: Day and Night" },
  );
}
