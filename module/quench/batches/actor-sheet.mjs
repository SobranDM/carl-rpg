import { CarlRPGActorSheet } from "../../sheets/actor-sheet.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  dropOnSheet as dropOn,
  makeDragEvent,
  settle,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

async function createTestLootBox(system = {}) {
  return Actor.create({
    name: `Quench loot box ${foundry.utils.randomID()}`,
    type: "lootBox",
    system,
  });
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.actor-sheet",
    (context) => {
      const { describe, it, assert } = context;

      describe("re-render keeps the active tab's scroll position", function () {
        useQuenchTimeout(this);

        it("renders the active tab part with the active class", async function () {
          const actor = await createTestCharacter();
          const sheet = actor.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            sheet.changeTab("description", "primary");
            await sheet.render({ parts: ["description"] });
            const section = sheet.element.querySelector('section.tab[data-tab="description"]');
            assert.isTrue(section.classList.contains("active"));
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("editing the actor does not jump the Inventory tab back to the top", async function () {
          const actor = await createTestCharacter();
          const sheet = actor.sheet;
          try {
            // Enough rows that the Inventory tab overflows the 680px window.
            for (let i = 0; i < 25; i++) await createTestItem(actor, "item", `scroll ${i}`);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            sheet.changeTab("items", "primary");
            await settle(50);

            const before = sheet.element.querySelector('section.tab[data-tab="items"]');
            assert.isAbove(
              before.scrollHeight,
              before.clientHeight,
              "Inventory tab must overflow for this test to mean anything",
            );
            before.scrollTop = 150;

            await actor.update({ "system.biography": `scroll ${foundry.utils.randomID()}` });
            await waitFor(
              () => sheet.element.querySelector('section.tab[data-tab="items"]') !== before,
              {
                message: "sheet never re-rendered the Inventory part",
              },
            );
            await settle(50);

            const after = sheet.element.querySelector('section.tab[data-tab="items"]');
            assert.equal(after.scrollTop, 150);
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

      describe("column header sort", function () {
        useQuenchTimeout(this);

        const skillRanks = (sheet) =>
          Array.from(
            sheet.element.querySelectorAll(".carl-skills-list > li.item[data-item-id]"),
            (li) => sheet.actor.items.get(li.dataset.itemId).system.rank,
          );

        it("clicking a header sorts asc, then desc, then back to the default order", async function () {
          const actor = await createTestCharacter();
          const sheet = actor.sheet;
          try {
            for (const rank of [3, 10, 1]) {
              await createTestItem(actor, "skill", `rank ${rank}`, { system: { rank } });
            }
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const defaultOrder = skillRanks(sheet);

            const clickRank = async () => {
              const before = sheet.element.querySelector(".carl-skills-list");
              sheet.element
                .querySelector('.carl-sort-header[data-list="skills"][data-sort-key="rank"]')
                .click();
              await waitFor(() => sheet.element.querySelector(".carl-skills-list") !== before);
            };

            await clickRank();
            assert.deepEqual(skillRanks(sheet), [1, 3, 10]);
            await clickRank();
            assert.deepEqual(skillRanks(sheet), [10, 3, 1]);
            await clickRank();
            assert.deepEqual(skillRanks(sheet), defaultOrder);
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

      describe("drag and drop on ActorSheetV2", function () {
        useQuenchTimeout(this);

        /** Render an actor's sheet and wait until it's on screen. */
        const openSheet = async (actor) => {
          const sheet = actor.sheet;
          await sheet.render({ force: true });
          await waitFor(() => sheet.rendered);
          return sheet;
        };

        const worldItem = (label, data = {}) =>
          Item.create({ name: `Quench ${label} ${foundry.utils.randomID()}`, type: "item", ...data });

        const hotlistSlot = (sheet, index = 0) =>
          sheet.element.querySelector(`[data-slot-type="hotlist"][data-slot-key="${index}"]`);

        const inventoryRow = (sheet, itemId) =>
          sheet.element.querySelector(`section.tab[data-tab="items"] li.item[data-item-id="${itemId}"]`);

        it("Characters, Mobs and Loot Boxes all use core ActorSheetV2", async function () {
          const crawler = await createTestCharacter("v2");
          const mob = await createTestMob("v2");
          const box = await createTestLootBox();
          try {
            for (const actor of [crawler, mob, box]) {
              assert.instanceOf(actor.sheet, foundry.applications.sheets.ActorSheetV2, actor.type);
            }
            assert.instanceOf(crawler.sheet, CarlRPGActorSheet);
            assert.instanceOf(mob.sheet, CarlRPGActorSheet);
          } finally {
            await deleteTestActor(crawler);
            await deleteTestActor(mob);
            await deleteTestActor(box);
          }
        });

        it("the header offers Prototype Token on Characters, Mobs and Loot Boxes", async function () {
          const crawler = await createTestCharacter("header");
          const mob = await createTestMob("header");
          const box = await createTestLootBox();
          try {
            for (const actor of [crawler, mob, box]) {
              const sheet = await openSheet(actor);
              const actions = sheet._getHeaderControls().map((c) => c.action);
              assert.include(actions, "configurePrototypeToken", actor.type);
              assert.notInclude(actions, "configureToken", `${actor.type}: a world actor has no placed Token`);
              await sheet.close();
            }
          } finally {
            await deleteTestActor(crawler);
            await deleteTestActor(mob);
            await deleteTestActor(box);
          }
        });

        it("the Prototype Token control opens the prototype token config", async function () {
          const actor = await createTestCharacter("prototype");
          let config;
          try {
            const sheet = await openSheet(actor);
            sheet.options.actions.configurePrototypeToken.call(sheet, new PointerEvent("click"));
            await waitFor(() => {
              config = [...foundry.applications.instances.values()].find(
                (app) => app instanceof CONFIG.Token.prototypeSheetClass && app.actor === actor,
              );
              return config?.rendered;
            }, { message: "the prototype token config never opened" });
            await sheet.close();
          } finally {
            await config?.close();
            await deleteTestActor(actor);
          }
        });

        it("binds one DragDrop handler, on rows with an item id", async function () {
          const actor = await createTestCharacter("bind");
          try {
            const item = await createTestItem(actor, "item", "row");
            const sheet = await openSheet(actor);
            assert.equal(sheet._dragDrop.dragSelector, "[data-item-id]");
            assert.strictEqual(sheet._dragDrop, sheet._dragDrop, "one cached handler");
            assert.equal(inventoryRow(sheet, item.id).getAttribute("draggable"), "true");
            assert.isFunction(sheet.element.ondrop);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("dragging an inventory row carries that Item's drag data", async function () {
          const actor = await createTestCharacter("drag");
          try {
            const item = await createTestItem(actor, "item", "dragged");
            const sheet = await openSheet(actor);
            const event = makeDragEvent("dragstart");
            inventoryRow(sheet, item.id).dispatchEvent(event);
            const data = JSON.parse(event.dataTransfer.getData("text/plain"));
            assert.deepEqual(data, item.toDragData());
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("dropping a sidebar Item creates exactly one copy", async function () {
          const actor = await createTestCharacter("drop");
          const source = await worldItem("sidebar");
          try {
            const sheet = await openSheet(actor);
            const { dispatches, result } = await dropOn(sheet, sheet.element, source.toDragData());
            assert.equal(dispatches, 1, "handled once");
            assert.equal(actor.items.filter((i) => i.name === source.name).length, 1);
            assert.equal(result?.parent, actor);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await source.delete();
          }
        });

        it("dropping a sidebar Item on a Hotlist slot creates it and fills the slot", async function () {
          const actor = await createTestCharacter("hotlist");
          const source = await worldItem("potion");
          try {
            const sheet = await openSheet(actor);
            const { dispatches, result } = await dropOn(sheet, hotlistSlot(sheet, 0), source.toDragData());
            assert.equal(dispatches, 1);
            assert.equal(actor.items.filter((i) => i.name === source.name).length, 1);
            assert.equal(actor.system.hotlist[0], result.id);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await source.delete();
          }
        });

        it("dropping an owned Item on a Hotlist slot fills it without copying", async function () {
          const actor = await createTestCharacter("own slot");
          try {
            const item = await createTestItem(actor, "item", "owned");
            const sheet = await openSheet(actor);
            const { dispatches } = await dropOn(sheet, hotlistSlot(sheet, 1), item.toDragData());
            assert.equal(dispatches, 1);
            assert.equal(actor.items.size, 1, "no copy");
            assert.equal(actor.system.hotlist[1], item.id);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("dropping an owned Item anywhere else does nothing (core would re-sort)", async function () {
          const actor = await createTestCharacter("own elsewhere");
          try {
            const first = await createTestItem(actor, "item", "first", { sort: 100 });
            const second = await createTestItem(actor, "item", "second", { sort: 200 });
            const sheet = await openSheet(actor);
            const { dispatches, result } = await dropOn(sheet, inventoryRow(sheet, first.id), second.toDragData());
            assert.equal(dispatches, 1);
            assert.isNull(result);
            assert.equal(actor.items.size, 2, "no copy");
            assert.equal(actor.items.get(first.id).sort, 100);
            assert.equal(actor.items.get(second.id).sort, 200);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a row dragged off one crawler's sheet drops onto another's as one copy", async function () {
          const giver = await createTestCharacter("giver");
          const taker = await createTestCharacter("taker");
          try {
            const item = await createTestItem(giver, "item", "handed over");
            const giverSheet = await openSheet(giver);
            const takerSheet = await openSheet(taker);
            const start = makeDragEvent("dragstart");
            inventoryRow(giverSheet, item.id).dispatchEvent(start);
            const data = JSON.parse(start.dataTransfer.getData("text/plain"));
            const { dispatches } = await dropOn(takerSheet, takerSheet.element, data);
            assert.equal(dispatches, 1);
            assert.equal(taker.items.filter((i) => i.name === item.name).length, 1);
            assert.exists(giver.items.get(item.id), "the giver keeps theirs");
            await giverSheet.close();
            await takerSheet.close();
          } finally {
            await deleteTestActor(giver);
            await deleteTestActor(taker);
          }
        });

        it("dropping a Loot Box item moves it out of the box", async function () {
          const actor = await createTestCharacter("looter");
          const box = await createTestLootBox();
          try {
            const loot = await createTestItem(box, "item", "loot");
            const sheet = await openSheet(actor);
            const { dispatches } = await dropOn(sheet, sheet.element, loot.toDragData());
            assert.equal(dispatches, 1);
            await waitFor(() => actor.items.getName(loot.name));
            await settle(100);
            assert.equal(actor.items.filter((i) => i.name === loot.name).length, 1);
            assert.equal(box.items.size, 0);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(box);
          }
        });

        it("the Loot Box sheet drags its cards and takes one copy of a dropped Item", async function () {
          const box = await createTestLootBox();
          const source = await worldItem("stock");
          try {
            const loot = await createTestItem(box, "item", "card");
            const sheet = await openSheet(box);
            const start = makeDragEvent("dragstart");
            sheet.element.querySelector(`.carl-loot-card[data-item-id="${loot.id}"]`).dispatchEvent(start);
            assert.deepEqual(JSON.parse(start.dataTransfer.getData("text/plain")), loot.toDragData());

            const { dispatches } = await dropOn(sheet, sheet.element, source.toDragData());
            assert.equal(dispatches, 1);
            assert.equal(box.items.filter((i) => i.name === source.name).length, 1);

            const own = await dropOn(sheet, sheet.element, loot.toDragData());
            assert.isNull(own.result, "its own card is ignored");
            assert.equal(box.items.size, 2);
            await sheet.close();
          } finally {
            await deleteTestActor(box);
            await source.delete();
          }
        });

        it("a dropped ActiveEffect is ignored", async function () {
          const actor = await createTestCharacter("effect");
          const source = await worldItem("effect carrier", {
            effects: [{ name: "Quench effect", img: "icons/svg/aura.svg" }],
          });
          try {
            const effect = source.effects.contents[0];
            assert.exists(effect, "test setup: the Item carries an effect");
            const sheet = await openSheet(actor);
            const { dispatches, result } = await dropOn(sheet, sheet.element, effect.toDragData());
            assert.equal(dispatches, 1);
            assert.isNull(result);
            assert.equal(actor.effects.size, 0);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await source.delete();
          }
        });

        it("a dropActorSheetData hook returning false blocks the drop", async function () {
          const actor = await createTestCharacter("hooked");
          const source = await worldItem("blocked");
          const hookId = Hooks.on("dropActorSheetData", (target) => (target === actor ? false : undefined));
          try {
            const sheet = await openSheet(actor);
            const { dispatches } = await dropOn(sheet, sheet.element, source.toDragData(), { expectDispatch: false });
            assert.equal(dispatches, 0);
            assert.equal(actor.items.size, 0);
            await sheet.close();
          } finally {
            Hooks.off("dropActorSheetData", hookId);
            await deleteTestActor(actor);
            await source.delete();
          }
        });
      });
    },
    { displayName: "CarlRPG: Actor Sheet" },
  );
}
