import { generateLootBoxItems, rerollLootItem, takeLootItem } from "../../helpers/loot-box.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
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
    "carl-rpg.loot-box",
    (context) => {
      const { describe, it, assert } = context;

      describe("Loot Box actor", function () {
        useQuenchTimeout(this);

        it("lets every player see the box and links its token", async function () {
          const box = await createTestLootBox();
          try {
            assert.equal(box.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
            assert.isTrue(box.prototypeToken.actorLink);
            assert.equal(box.system.tier, "bronze");
          } finally {
            await deleteTestActor(box);
          }
        });

        it("generates one item per crawler at the box's tier", async function () {
          const box = await createTestLootBox({ tier: "gold", crawlers: 3 });
          try {
            const created = await generateLootBoxItems(box);
            assert.lengthOf(created, 3);
            for (const item of box.items) {
              assert.equal(item.type, "item");
              assert.equal(item.getFlag("carl-rpg", "lootTier"), "gold");
              assert.match(item.name, /^Gold /);
              assert.include(item.system.description, "<ol>");
            }
          } finally {
            await deleteTestActor(box);
          }
        });

        it("rolls a mundane item for Bronze", async function () {
          const box = await createTestLootBox({ tier: "bronze" });
          try {
            const [item] = await generateLootBoxItems(box);
            assert.equal(item.name, "Bronze Mundane Item");
          } finally {
            await deleteTestActor(box);
          }
        });

        it("reroll keeps the item but rewrites it at the box's current tier", async function () {
          const box = await createTestLootBox({ tier: "bronze" });
          try {
            const [item] = await generateLootBoxItems(box);
            await box.update({ "system.tier": "silver" });
            await rerollLootItem(item);
            assert.equal(box.items.size, 1);
            assert.equal(box.items.get(item.id).getFlag("carl-rpg", "lootTier"), "silver");
          } finally {
            await deleteTestActor(box);
          }
        });

        it("taking an item moves it from the box to the character", async function () {
          const box = await createTestLootBox();
          const actor = await createTestCharacter("looter");
          try {
            const item = await createTestItem(box, "item", "edited loot", {
              system: { description: "<p>GM rebalanced this</p>" },
            });
            await takeLootItem(item, actor);
            await waitFor(() => actor.items.getName(item.name));
            assert.equal(box.items.size, 0);
            assert.equal(
              actor.items.getName(item.name).system.description,
              "<p>GM rebalanced this</p>",
            );
          } finally {
            await deleteTestActor(box);
            await deleteTestActor(actor);
          }
        });

        it("renders the sheet with a Generate button for the GM", async function () {
          const box = await createTestLootBox();
          const sheet = box.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.isNotNull(sheet.element.querySelector('[data-action="generateLoot"]'));
            assert.isNotNull(sheet.element.querySelector('select[name="system.tier"]'));
          } finally {
            await sheet.close();
            await deleteTestActor(box);
          }
        });
      });
    },
    { displayName: "CarlRPG: Loot Box" },
  );
}
