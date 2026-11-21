import {
  boxesOf,
  boxView,
  clearBoxContents,
  giveBox,
  openBox,
  prepareBox,
} from "../../helpers/boxes.mjs";
import { BOSS_TIERS } from "../../helpers/floor.mjs";
import {
  createTestCharacter,
  createTestMob,
  deleteTestActor,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

/**
 * Loot boxes (0.8.0 phase 3, docs/loot-and-achievements.md): the Box item
 * a crawler carries unopened (pp.21-22), the GM's guards on it, what a
 * player is shown, and opening it. Needs the system's packs built (a random
 * box rolls the Roll Tables pack's box tables).
 */
const PLAYER = { isGM: false };
const goldOf = (actor) => actor.system.details.gold ?? 0;
const text = (name, quantity = 1) => ({
  kind: "text",
  name,
  img: "icons/svg/item-bag.svg",
  quantity,
});

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.boxes",
    (context) => {
      const { describe, it, assert } = context;

      describe("A crawler's boxes", function () {
        useQuenchTimeout(this);

        it("a given box: its title, tier art and source; Bronze before Gold", async function () {
          const actor = await createTestCharacter("box holder");
          try {
            const gold = await giveBox(actor, { tierKey: "gold", name: "Gold Crafter's Box" });
            const bronze = await giveBox(actor, { tierKey: "bronze" });
            assert.equal(gold.name, "Gold Crafter's Box");
            assert.equal(bronze.name, "Bronze Box");
            assert.equal(bronze.img, CONFIG.CARLRPG.lootBoxTiers.bronze.img);
            assert.equal(gold.system.source.kind, "gift");
            assert.equal(gold.system.contents.mode, "random");
            assert.deepEqual(
              boxesOf(actor).map((b) => b.id),
              [bronze.id, gold.id],
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a new tier brings its art", async function () {
          const actor = await createTestCharacter("box tier");
          try {
            const box = await giveBox(actor, { tierKey: "bronze" });
            await box.update({ "system.tier": "platinum" });
            assert.equal(box.img, CONFIG.CARLRPG.lootBoxTiers.platinum.img);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("only a Character gets a box", async function () {
          const mob = await createTestMob("no boxes");
          try {
            const created = await mob.createEmbeddedDocuments("Item", [
              { name: "Mob's Box", type: "box" },
            ]);
            assert.lengthOf(created, 0);
            assert.equal(mob.items.size, 0);
          } finally {
            await deleteTestActor(mob);
          }
        });

        it("a Boss's tier gives its Boss Box tier (p.22)", function () {
          assert.deepEqual(
            Object.fromEntries(Object.entries(BOSS_TIERS).map(([k, t]) => [k, t.box])),
            {
              neighborhood: "bronze",
              borough: "silver",
              city: "gold",
              province: "platinum",
              country: "legendary",
              floor: "celestial",
            },
          );
        });
      });

      describe("Players (ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("can't change or delete a box", async function () {
          const actor = await createTestCharacter("box guard");
          try {
            const box = await giveBox(actor, { tierKey: "silver" });
            assert.isFalse(await box._preUpdate({ name: "Mine now" }, {}, PLAYER));
            assert.isFalse(await box._preDelete({}, PLAYER));
            assert.notStrictEqual(
              await box._preUpdate({ name: "GM's edit" }, {}, game.user),
              false,
              "the GM can",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("see its art, title and tier - never its contents", async function () {
          const actor = await createTestCharacter("box view");
          try {
            const box = await giveBox(actor, { tierKey: "gold", name: "Secret Box" });
            await prepareBox(box, { tierKey: "gold", gold: 500, entries: [text("Quench Secret")] });
            const player = boxView(box, false);
            assert.equal(player.name, "Secret Box");
            assert.equal(player.img, box.img);
            assert.isNull(player.gm);
            assert.notInclude(JSON.stringify(player), "Quench Secret");
            assert.notInclude(JSON.stringify(player), "500");
            const gm = boxView(box, true);
            assert.include(gm.gm.contentsHTML, "Quench Secret");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Opening a box", function () {
        useQuenchTimeout(this, 60000);

        it("prepared: its items and gold to the crawler; the box is gone", async function () {
          const actor = await createTestCharacter("box opener");
          try {
            const before = goldOf(actor);
            const box = await giveBox(actor, { tierKey: "bronze" });
            await prepareBox(box, {
              tierKey: "bronze",
              gold: 40,
              entries: [text("Quench Prize", 2)],
            });
            const result = await openBox(box);
            assert.exists(result);
            assert.equal(result.boxName, "Bronze Box");
            assert.equal(result.gold, 40);
            assert.deepEqual(
              result.items.map((i) => [i.name, i.quantity]),
              [["Quench Prize", 2]],
            );
            assert.equal(goldOf(actor), before + 40, "all the gold to the crawler who opened it");
            assert.equal(actor.items.getName("Quench Prize").system.quantity, 2);
            assert.isUndefined(actor.items.get(box.id), "the box is deleted");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("twice at once: opened once", async function () {
          const actor = await createTestCharacter("box twice");
          try {
            const before = goldOf(actor);
            const box = await giveBox(actor, { tierKey: "bronze" });
            await prepareBox(box, { tierKey: "bronze", gold: 10, entries: [text("Quench Once")] });
            const results = await Promise.all([openBox(box), openBox(box)]);
            assert.lengthOf(results.filter(Boolean), 1);
            assert.equal(goldOf(actor), before + 10);
            assert.lengthOf(
              actor.items.filter((i) => i.name === "Quench Once"),
              1,
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("random: rolled for the crawler at its tier (Silver: gold and a magic item)", async function () {
          const actor = await createTestCharacter("box random");
          try {
            const before = goldOf(actor);
            const box = await giveBox(actor, { tierKey: "silver" });
            const result = await openBox(box);
            assert.exists(result, "the box tables are there");
            assert.isTrue(result.gold >= 100 && result.gold <= 1000, String(result.gold));
            assert.equal(goldOf(actor), before + result.gold);
            assert.isTrue(
              actor.items.some((i) => i.getFlag("carl-rpg", "magicDraft")),
              "a magic item from Silver up",
            );
            assert.isUndefined(actor.items.get(box.id));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("something prepared that no longer exists: nothing given, the box stays", async function () {
          const actor = await createTestCharacter("box missing");
          try {
            const before = goldOf(actor);
            const box = await giveBox(actor, { tierKey: "bronze" });
            await prepareBox(box, {
              tierKey: "bronze",
              gold: 25,
              entries: [
                text("Quench Kept"),
                { kind: "item", uuid: "Item.quenchNoSuchItem", name: "Gone", quantity: 1 },
              ],
            });
            assert.isNull(await openBox(box));
            assert.exists(actor.items.get(box.id));
            assert.equal(goldOf(actor), before);
            assert.isUndefined(actor.items.getName("Quench Kept"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("back to random clears what was prepared", async function () {
          const actor = await createTestCharacter("box clear");
          try {
            const box = await giveBox(actor, { tierKey: "bronze" });
            await prepareBox(box, { tierKey: "silver", gold: 5, entries: [text("Quench X")] });
            assert.equal(box.system.tier, "silver", "the prepared tier is the box's");
            await clearBoxContents(box);
            assert.equal(box.system.contents.mode, "random");
            assert.lengthOf(box.system.contents.entries, 0);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Sheets", function () {
        useQuenchTimeout(this);

        it("the Inventory's Show Loot Boxes: each box's art, its title as the tooltip", async function () {
          const actor = await createTestCharacter("box strip");
          const sheet = actor.sheet;
          try {
            const box = await giveBox(actor, { tierKey: "gold", name: "Gold Pet Box" });
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const chipOf = () =>
              sheet.element.querySelector(`.carl-box-chip[data-item-id="${box.id}"]`);
            assert.isNull(chipOf(), "behind the button until it's clicked");
            const toggle = sheet.element.querySelector('[data-action="toggleBoxes"]');
            assert.exists(toggle);
            assert.exists(toggle.closest("ol.items-list"), "in the list's own column");
            toggle.click();
            await waitFor(() => chipOf());
            const chip = chipOf();
            assert.equal(chip.dataset.tooltipText, "Gold Pet Box");
            assert.isNull(chip.getAttribute("title"));
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("the GM's Box sheet: prepare and open", async function () {
          const actor = await createTestCharacter("box sheet");
          let sheet = null;
          try {
            const box = await giveBox(actor, { tierKey: "silver" });
            sheet = box.sheet;
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.isNotNull(sheet.element.querySelector('[data-action="prepareContents"]'));
            assert.isNotNull(sheet.element.querySelector('[data-action="openBox"]'));
          } finally {
            await sheet?.close();
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: loot boxes (giving, hiding, opening)" },
  );
}
