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

        it("rolls a whole box per crawler: its items in the box, its gold on the box (pp.216-219)", async function () {
          useQuenchTimeout(this, 60000);
          const box = await createTestLootBox({ tier: "gold", crawlers: 2 });
          try {
            const created = await generateLootBoxItems(box);
            assert.isAtLeast(created.length, 4, "a magic item and 1d2 consumables each");
            for (const item of box.items) {
              assert.equal(item.type, "item");
              assert.equal(item.getFlag("carl-rpg", "lootTier"), "gold");
            }
            const magic = box.items.filter((i) => i.getFlag("carl-rpg", "magicDraft"));
            assert.lengthOf(magic, 2, "one magic item per crawler");
            for (const item of magic) assert.include(item.system.description, "<ul>");
            assert.isTrue(
              box.system.gold >= 2000 && box.system.gold <= 12000,
              String(box.system.gold),
            );
          } finally {
            await deleteTestActor(box);
          }
        });

        it("Bronze: gold and mundane things, no magic item", async function () {
          useQuenchTimeout(this, 60000);
          const box = await createTestLootBox({ tier: "bronze" });
          try {
            await generateLootBoxItems(box);
            assert.isAbove(box.items.size, 0);
            assert.isFalse(box.items.some((i) => i.getFlag("carl-rpg", "magicDraft")));
            assert.isTrue(box.system.gold >= 1 && box.system.gold <= 10, String(box.system.gold));
          } finally {
            await deleteTestActor(box);
          }
        });

        it("reroll rewrites a magic item at the box's current tier, keeping the Item; a plain item isn't rerolled", async function () {
          useQuenchTimeout(this, 60000);
          const box = await createTestLootBox({ tier: "silver" });
          try {
            await generateLootBoxItems(box);
            const item = box.items.find((i) => i.getFlag("carl-rpg", "magicDraft"));
            const plain = box.items.find((i) => !i.getFlag("carl-rpg", "magicDraft"));
            await box.update({ "system.tier": "gold" });
            await rerollLootItem(item);
            assert.equal(box.items.get(item.id).getFlag("carl-rpg", "lootTier"), "gold");
            assert.equal(box.items.get(item.id).getFlag("carl-rpg", "magicDraft").tierKey, "gold");
            if (plain) assert.isNull(await rerollLootItem(plain));
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

        it("a taken item arrives unequipped (in no doll slot, it'd still give its bonuses)", async function () {
          const box = await createTestLootBox();
          const actor = await createTestCharacter("looter");
          try {
            const item = await createTestItem(box, "item", "worn loot", {
              system: {
                equipped: true,
                slots: ["head"],
                changes: [{ targetType: "resource", target: "dr", mode: "add", value: "2" }],
              },
            });
            assert.isTrue(item.system.equipped, "test setup: equipped in the box");
            await takeLootItem(item, actor);
            await waitFor(() => actor.items.getName(item.name));
            assert.isFalse(actor.items.getName(item.name).system.equipped);
            assert.equal(actor.system.drEffective, 0);
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
            assert.isNotNull(sheet.element.querySelector('input[name="system.gold"]'));
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
