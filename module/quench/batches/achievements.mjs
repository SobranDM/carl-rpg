import {
  achievementBoxOf,
  achievementsOf,
  awardAchievement,
  awardedCopy,
  definitionOf,
  preparedBoxFor,
  revokeAchievement,
  setPreparedBoxFor,
} from "../../helpers/achievements.mjs";
import { rewardBox } from "../../helpers/reward-text.mjs";
import { openBox } from "../../helpers/boxes.mjs";
import { currentFloor } from "../../helpers/floor.mjs";
import AchievementSplash from "../../apps/achievement-splash.mjs";
import AchievementGrid from "../../apps/achievement-grid.mjs";
import {
  createTestCharacter,
  deleteTestActor,
  useQuenchTimeout,
  waitFor,
  withSetting,
} from "../helpers.mjs";
import { levelUpSoundsHere, playSound, SOUNDS, soundTiming } from "../../helpers/sounds.mjs";
import {
  achievementLibrary,
  createLibraryAchievement,
  deleteLibraryAchievement,
  ensureAchievementLibrary,
  updateLibraryAchievement,
} from "../../helpers/achievement-library.mjs";
import { pickerGroups } from "../../apps/actor-picker.mjs";

/**
 * Achievements (0.8.0 phase 4, docs/loot-and-achievements.md; p.21,
 * Appendix 3): definitions, awarding one (the copy, its loot box), taking it
 * back, the splash, the chat setting and the GM's grid.
 */
async function makeDefinition(system = {}, name = "Quench Button Masher") {
  // In the Achievements library, where the GM's window makes them.
  return createLibraryAchievement({
    name: `${name} ${foundry.utils.randomID()}`,
    system: {
      description: "<p>You pressed every button.</p>",
      reward: "You've received a Bronze Crafter's Box!",
      grade: "bronze",
      lootBox: true,
      ...system,
    },
  });
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.achievements",
    (context) => {
      const { describe, it, assert } = context;

      describe("The Reward line (helpers/reward-text.mjs)", function () {
        it("names a loot box, its tier and its title", function () {
          assert.deepEqual(rewardBox("You've received a Bronze Crafter's Box!"), {
            tier: "bronze",
            title: "Bronze Crafter's Box",
          });
          assert.deepEqual(rewardBox("You've received a Platinum Boss Box."), {
            tier: "platinum",
            title: "Platinum Boss Box",
          });
          assert.isNull(rewardBox("You've received a title: Button Lord."));
          assert.isNull(rewardBox(""));
        });
      });

      describe("Definitions", function () {
        useQuenchTimeout(this);

        it("its icon is its grade's, and follows a new grade", async function () {
          const def = await makeDefinition({ grade: "gold" });
          try {
            const tiers = CONFIG.CARLRPG.lootBoxTiers;
            assert.equal(def.img, tiers.gold.achievementImg);
            await updateLibraryAchievement(def, { "system.grade": "celestial" });
            assert.equal(def.img, tiers.celestial.achievementImg);
          } finally {
            await deleteLibraryAchievement(def);
          }
        });
      });

      describe("The Achievements library (ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("one world compendium, made once, hidden from players", async function () {
          const pack = await ensureAchievementLibrary();
          assert.exists(pack);
          assert.equal(pack.metadata.packageType, "world");
          assert.equal(pack.documentName, "Item");
          assert.strictEqual(await ensureAchievementLibrary(), pack, "not made twice");
          assert.strictEqual(achievementLibrary(), pack);
          assert.equal(pack.ownership.PLAYER, "NONE");
        });
      });

      describe("Awarding (GM)", function () {
        useQuenchTimeout(this, 30000);

        it("a copy on the crawler and a loot box from its Reward; not twice", async function () {
          const def = await makeDefinition();
          const actor = await createTestCharacter("achiever");
          try {
            const copy = await awardAchievement(def, actor);
            assert.exists(copy);
            assert.equal(definitionOf(copy), def.uuid);
            assert.equal(awardedCopy(actor, def.uuid)?.id, copy.id);
            assert.isFalse(copy.system.seen, "its player hasn't seen it yet");
            assert.isFalse(copy.system.rewarded, "its box isn't opened yet");
            assert.equal(copy.system.awardedFloor, currentFloor());
            const box = actor.items.find((i) => i.type === "box");
            assert.exists(box, "a loot box");
            assert.equal(box.name, "Bronze Crafter's Box");
            assert.equal(box.system.tier, "bronze");
            assert.equal(box.system.source.kind, "achievement");
            assert.equal(box.system.source.uuid, copy.uuid);

            assert.isNull(await awardAchievement(def, actor), "already has it");
            assert.lengthOf(achievementsOf(actor), 1);
            assert.lengthOf(
              actor.items.filter((i) => i.type === "box"),
              1,
            );
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("two awards at once (a double-click): awarded once, one box", async function () {
          const def = await makeDefinition();
          const actor = await createTestCharacter("double click");
          try {
            const copies = await Promise.all([
              awardAchievement(def, actor),
              awardAchievement(def, actor),
            ]);
            assert.lengthOf(copies.filter(Boolean), 1);
            assert.lengthOf(achievementsOf(actor), 1);
            assert.lengthOf(
              actor.items.filter((i) => i.type === "box"),
              1,
            );
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("dropped on a Character's sheet by the GM: awarded, not just copied", async function () {
          const def = await makeDefinition({ lootBox: false });
          const actor = await createTestCharacter("dropped");
          try {
            await actor.sheet._onDropItem(new DragEvent("drop"), def);
            const copy = awardedCopy(actor, def.uuid);
            assert.exists(copy, "awarded, with its definition");
            assert.isFalse(copy.system.seen);
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("Escape doesn't close the splash", async function () {
          const def = await makeDefinition({ lootBox: false });
          const actor = await createTestCharacter("escape");
          let app = null;
          try {
            const copy = await awardAchievement(def, actor);
            app = AchievementSplash.show(copy);
            await waitFor(() => app.rendered);
            await app.close({ closeKey: true });
            assert.isTrue(app.rendered, "still up");
            assert.isFalse(actor.items.get(copy.id).system.seen);
          } finally {
            await app?.close();
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("a box prepared for one crawler before the award: theirs holds it, another's is rolled", async function () {
          const def = await makeDefinition();
          const a = await createTestCharacter("prepared for");
          const b = await createTestCharacter("not prepared for");
          try {
            const draft = {
              tierKey: "bronze",
              gold: 7,
              entries: [
                {
                  kind: "text",
                  name: "Quench Prepared",
                  img: "icons/svg/item-bag.svg",
                  quantity: 1,
                },
              ],
            };
            await setPreparedBoxFor(a, def, draft);
            assert.exists(preparedBoxFor(a, def));
            assert.isNull(preparedBoxFor(b, def), "per crawler");

            const boxA = achievementBoxOf(await awardAchievement(def, a));
            assert.equal(boxA.system.contents.mode, "prepared");
            assert.equal(boxA.system.contents.gold, 7);
            assert.equal(boxA.system.contents.entries[0].name, "Quench Prepared");
            assert.isNull(preparedBoxFor(a, def), "used up by the award");

            const boxB = achievementBoxOf(await awardAchievement(def, b));
            assert.equal(boxB.system.contents.mode, "random");
          } finally {
            await deleteTestActor(a);
            await deleteTestActor(b);
            await deleteLibraryAchievement(def);
          }
        });

        it("one without a loot box: no box, and nothing left to reward", async function () {
          const def = await makeDefinition({ lootBox: false, reward: "A title: Button Lord" });
          const actor = await createTestCharacter("no box");
          try {
            const copy = await awardAchievement(def, actor);
            assert.isTrue(copy.system.rewarded);
            assert.isFalse(actor.items.some((i) => i.type === "box"));
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("opening its box marks it rewarded", async function () {
          const def = await makeDefinition();
          const actor = await createTestCharacter("rewarded");
          try {
            const copy = await awardAchievement(def, actor);
            const box = actor.items.find((i) => i.type === "box");
            assert.exists(await openBox(box), "the box tables are there");
            assert.isTrue(actor.items.get(copy.id).system.rewarded);
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("taking it back takes its unopened box too", async function () {
          const def = await makeDefinition();
          const actor = await createTestCharacter("revoked");
          try {
            const copy = await awardAchievement(def, actor);
            await revokeAchievement(copy);
            assert.isNull(awardedCopy(actor, def.uuid));
            assert.isFalse(actor.items.some((i) => i.type === "box"));
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("chat: none unless the setting is on, then a public card (ruled 2026-11-19)", async function () {
          const def = await makeDefinition({ lootBox: false });
          const actor = await createTestCharacter("chat");
          try {
            const before = game.messages.size;
            await withSetting("postAchievementsToChat", false, () => awardAchievement(def, actor));
            assert.equal(game.messages.size, before, "off: no card at all");
            await revokeAchievement(awardedCopy(actor, def.uuid));
            await withSetting("postAchievementsToChat", true, () => awardAchievement(def, actor));
            assert.equal(game.messages.size, before + 1);
            const card = game.messages.contents.at(-1);
            assert.isEmpty(card.whisper, "public");
            assert.include(card.content, def.name);
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });
      });

      describe("The splash (ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("isn't shown to the GM who awarded it", async function () {
          const def = await makeDefinition({ lootBox: false });
          const actor = await createTestCharacter("splash");
          try {
            const copy = await awardAchievement(def, actor);
            assert.isFalse(AchievementSplash.showsHere(copy));
            assert.isUndefined(foundry.applications.instances.get(`carl-achievement-${copy.id}`));
          } finally {
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("shows the achievement, and closing it marks it seen", async function () {
          const def = await makeDefinition({ lootBox: false, reward: "A title: Button Lord" });
          const actor = await createTestCharacter("splash close");
          let app = null;
          try {
            const copy = await awardAchievement(def, actor);
            app = AchievementSplash.show(copy);
            await waitFor(() => app.rendered);
            assert.include(app.element.textContent, def.name);
            assert.include(app.element.textContent, "A title: Button Lord");
            await app.close();
            await waitFor(() => actor.items.get(copy.id)?.system.seen === true);
          } finally {
            await app?.close();
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });
      });

      describe("The GM's grid", function () {
        useQuenchTimeout(this, 30000);

        it("a dimmed cell awards it; then it's lit", async function () {
          const def = await makeDefinition({ lootBox: false });
          const actor = await createTestCharacter("grid");
          const grid = AchievementGrid.open();
          try {
            await waitFor(() => grid.rendered);
            grid.showOffline = true;
            await grid.render();
            const cell = () =>
              grid.element.querySelector(
                `tr[data-uuid="${def.uuid}"] .carl-grid-cell[data-actor-id="${actor.id}"]`,
              );
            await waitFor(() => cell());
            assert.isTrue(cell().classList.contains("carl-grid-none"));
            cell().click();
            await waitFor(() => awardedCopy(actor, def.uuid));
            await waitFor(() => cell()?.classList.contains("carl-grid-rewarded"));
          } finally {
            await grid.close();
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });

        it("shows crawlers whose player is offline when no player is online, until the GM chooses", async function () {
          const grid = AchievementGrid.open();
          try {
            await waitFor(() => grid.rendered);
            const noneOnline = pickerGroups().active.length === 0;
            assert.equal((await grid._prepareContext({})).showOffline, noneOnline);
            grid.showOffline = false;
            assert.isFalse((await grid._prepareContext({})).showOffline, "the GM's choice stands");
          } finally {
            await grid.close();
          }
        });

        it("right-clicking a trophy prepares that crawler's loot box (ruled 2026-11-19)", async function () {
          const def = await makeDefinition();
          const actor = await createTestCharacter("right click");
          const grid = AchievementGrid.open();
          const forges = () =>
            [...foundry.applications.instances.values()].filter(
              (app) => app.constructor.name === "LootForge" && app.recipient === actor,
            );
          try {
            await waitFor(() => grid.rendered);
            grid.showOffline = true;
            await grid.render();
            const cell = () =>
              grid.element.querySelector(
                `tr[data-uuid="${def.uuid}"] .carl-grid-cell[data-actor-id="${actor.id}"]`,
              );
            await waitFor(() => cell());
            cell().dispatchEvent(
              new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
            );
            await waitFor(() => forges().length === 1, { timeout: 15000 });
            assert.isNull(awardedCopy(actor, def.uuid), "not awarded by it");
          } finally {
            for (const forge of forges()) await forge.close();
            await grid.close();
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });
      });

      describe("Sounds (ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("each sound's file is there", async function () {
          for (const [key, sound] of Object.entries(SOUNDS)) {
            const response = await fetch(sound.src, { method: "HEAD" });
            assert.isTrue(response.ok, `${key}: ${sound.src}`);
          }
        });

        it("a muted sound doesn't play", async function () {
          for (const [key, sound] of Object.entries(SOUNDS)) {
            await withSetting(sound.setting, true, () => {
              assert.isNull(playSound(key), key);
            });
          }
        });

        it("a sound already playing isn't started again (several Levels at once: one sound)", async function () {
          const helper = foundry.audio.AudioHelper;
          const real = helper.play;
          const guard = soundTiming.guardMs;
          const plays = [];
          // Count the plays instead of making noise: one fake sound, playing
          // until the test stops it.
          const fake = { playing: true };
          helper.play = (data) => {
            plays.push(data.src);
            return Promise.resolve(fake);
          };
          const tick = () => new Promise((r) => setTimeout(r, 10));
          try {
            await withSetting(SOUNDS.levelUp.setting, false, async () => {
              playSound("levelUp");
              await tick();
              playSound("levelUp");
              playSound("levelUp");
              assert.lengthOf(plays, 1, "one sound for three Level-ups");
              assert.isNotNull(playSound("achievement"), "another sound still plays");
              assert.lengthOf(plays, 2);
              await tick();
              // Over, and past the guard: it plays again.
              fake.playing = false;
              soundTiming.guardMs = 0;
              assert.isNotNull(playSound("levelUp"));
              assert.lengthOf(plays, 3);
            });
          } finally {
            fake.playing = false;
            helper.play = real;
            soundTiming.guardMs = guard;
          }
        });

        it("a Level gain tells every client (the GM hears none of the Level-up sound)", async function () {
          const actor = await createTestCharacter("level up");
          try {
            let options = null;
            const id = Hooks.on("updateActor", (a, changed, opts) => {
              if (a.id === actor.id) options = opts;
            });
            try {
              const level = actor.system.attributes.level.value;
              await actor.update({ "system.attributes.level.value": level + 2 });
            } finally {
              Hooks.off("updateActor", id);
            }
            assert.equal(options?.carlLevelDelta?.[actor.id], 2);
            assert.isFalse(levelUpSoundsHere(actor), "the GM's client");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Making and editing achievements in the window", function () {
        useQuenchTimeout(this, 30000);

        it("New Achievement makes one in the library and opens its editor; a field saves as it changes", async function () {
          const grid = AchievementGrid.open();
          let def = null;
          try {
            await waitFor(() => grid.rendered);
            grid.element.querySelector('[data-action="newAchievement"]').click();
            await waitFor(
              () => grid.editing && grid.element.querySelector(".carl-achievement-editor"),
            );
            def = await fromUuid(grid.editing);
            assert.exists(def);
            assert.equal(def.pack, achievementLibrary().collection, "in the library");
            const name = grid.element.querySelector('.carl-achievement-editor input[name="name"]');
            name.value = "Quench Edited Achievement";
            name.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => def.name === "Quench Edited Achievement");
            const box = grid.element.querySelector(
              '.carl-achievement-editor input[name="system.lootBox"]',
            );
            box.checked = true;
            box.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => def.system.lootBox === true);
          } finally {
            await grid.close();
            if (def) await deleteLibraryAchievement(await fromUuid(def.uuid));
          }
        });
      });

      describe("The Character's Details tab", function () {
        useQuenchTimeout(this);

        it("lists the crawler's achievements", async function () {
          const def = await makeDefinition({ lootBox: false });
          const actor = await createTestCharacter("details");
          const sheet = actor.sheet;
          try {
            const copy = await awardAchievement(def, actor);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.exists(
              sheet.element.querySelector(`.carl-achievement-row[data-item-id="${copy.id}"]`),
            );
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
            await deleteLibraryAchievement(def);
          }
        });
      });
    },
    { displayName: "CarlRPG: achievements (awarding, splash, grid)" },
  );
}
