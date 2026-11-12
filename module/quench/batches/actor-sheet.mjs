import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  settle,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

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
    },
    { displayName: "CarlRPG: Actor Sheet" },
  );
}
