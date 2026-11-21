import {
  autofillMagicDraft,
  boxTable,
  buildMagicItemData,
  enchantmentLine,
  generateLoot,
  generateMagicDraft,
  grantLoot,
  lootItemData,
  lootTable,
  magicItemUpdate,
  rerollEnchantment,
  statBonus,
  uniqueMultiplier,
} from "../../helpers/loot.mjs";
import LootForge from "../../apps/loot-forge.mjs";
import {
  enchantmentKind,
  itemTypeKind,
  lootRowQuantity,
  lootRowSpecial,
} from "../../helpers/enchantments.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";
import { useConsumable } from "../../helpers/consumables.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";

/**
 * The loot generator (0.8.0, docs/loot-and-achievements.md; Loot,
 * pp.215-220): the per-tier box recipes and tables, magic item drafts and
 * the Item data they make. Needs the system's packs built
 * (npm run build:packs) - the box tables live in the Roll Tables pack.
 */
const TIERS = ["bronze", "silver", "gold", "platinum", "legendary", "celestial"];
const KINDS = ["item", "spellScroll", "spellbook", "text", "magic"];

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.loot-generator",
    (context) => {
      const { describe, it, assert } = context;

      describe("Reading table rows (helpers/enchantments.mjs)", function () {
        it("a row's quantity", function () {
          assert.deepEqual(lootRowQuantity("Torch ×10"), { name: "Torch", quantity: "10" });
          assert.deepEqual(lootRowQuantity("Torch x10"), { name: "Torch", quantity: "10" });
          assert.deepEqual(lootRowQuantity("Bandages (1d6)"), {
            name: "Bandages",
            quantity: "1d6",
          });
          assert.deepEqual(lootRowQuantity("Crawler Biscuits (100)"), {
            name: "Crawler Biscuits",
            quantity: "100",
          });
          assert.deepEqual(lootRowQuantity("Rope (50 feet)"), {
            name: "Rope (50 feet)",
            quantity: "1",
          });
        });
        it("rows that roll something", function () {
          assert.equal(lootRowSpecial("Spell Scroll"), "spellScroll");
          assert.equal(lootRowSpecial("Rare Spell Scroll"), "spellScroll");
          assert.equal(lootRowSpecial("Magic Tome"), "spellbook");
          assert.equal(lootRowSpecial("Rare Spellbook"), "spellbook");
          assert.equal(lootRowSpecial("Magic Item"), "magicItem");
          assert.isNull(lootRowSpecial("Healing Potion"));
        });
        it("Tables 38-41's results by kind", function () {
          assert.equal(enchantmentKind("+X Stat Bonus"), "stat");
          assert.equal(enchantmentKind("+X Skill Bonus"), "skill");
          assert.equal(enchantmentKind("A Buff (not Skill or Stat bonuses)"), "buff");
          assert.equal(
            enchantmentKind("A Passive Skill at Rank equal to the Floor"),
            "passiveSkill",
          );
          assert.equal(enchantmentKind("Resistance to an uncommon damage type"), "resistance");
          assert.equal(enchantmentKind("+1 Damage Resistance"), "dr");
          assert.equal(
            enchantmentKind("External Buff of either Recovery or Restore once per Floor"),
            "externalBuff",
          );
          assert.equal(enchantmentKind("Inherent Spell* (no Mana cost)"), "inherentSpell");
          assert.equal(enchantmentKind("Glows faintly"), "text");
          assert.equal(itemTypeKind("Enchanted Clothing"), "clothing");
          assert.equal(
            itemTypeKind("Enchanted Accessory (Jewel, Belt, Patch, Tattoo, etc.)"),
            "accessory",
          );
          assert.equal(itemTypeKind("Enchanted Mundane Item or Weapon"), "mundane");
        });
      });

      describe("A percentage Stat's line (p.220)", function () {
        it("says the number and the percentage it came from", function () {
          const dex = game.i18n.localize(CONFIG.CARLRPG.stats.dex);
          const line = enchantmentLine({ kind: "stat", target: "dex", value: 4, percent: 10 });
          assert.include(line, `+4 ${dex}`);
          assert.include(line, "10%");
          assert.notInclude(
            enchantmentLine({ kind: "stat", target: "dex", value: 3, percent: null }),
            "%",
          );
        });
      });

      describe("Something Unique (p.220)", function () {
        it("is worth the roll it came up on and every roll it stopped", function () {
          assert.equal(
            uniqueMultiplier(3, 1),
            3,
            "first of a Platinum item's three: x3 (the book's example)",
          );
          assert.equal(uniqueMultiplier(2, 1), 2, "two rolls left: x2");
          assert.equal(uniqueMultiplier(2, 2), 1, "the last roll: x1");
          assert.equal(uniqueMultiplier(1, 1), 1, "an item's only roll: x1");
        });
      });

      describe("+X Stat (p.220)", function () {
        it("a number in the tier's range, or a percentage of the recipient's Stat, rounded down", function () {
          const tiers = CONFIG.CARLRPG.lootBoxTiers;
          assert.deepEqual(statBonus(tiers.silver.statX, null, "dex"), { value: 2, percent: null });
          for (let i = 0; i < 20; i++) {
            const { value } = statBonus(tiers.gold.statX, null, "dex");
            assert.isTrue(value >= 3 && value <= 5, String(value));
          }
          const strong = { system: { stats: { dex: { value: 130 } } } };
          const weak = { system: { stats: { dex: { value: 12 } } } };
          assert.deepEqual(statBonus(tiers.platinum.statX, strong, "dex"), {
            value: 6,
            percent: 5,
          });
          assert.deepEqual(
            statBonus(tiers.platinum.statX, weak, "dex"),
            { value: 4, percent: 5 },
            "never under +4",
          );
          // The least rises with the tier (ruled 2026-11-19).
          assert.deepEqual(statBonus(tiers.legendary.statX, weak, "dex"), {
            value: 5,
            percent: 10,
          });
          assert.deepEqual(statBonus(tiers.celestial.statX, weak, "dex"), {
            value: 6,
            percent: 20,
          });
          assert.deepEqual(statBonus(tiers.legendary.statX, strong, "dex"), {
            value: 13,
            percent: 10,
          });
          assert.deepEqual(
            statBonus(tiers.legendary.statX, null, "dex"),
            { value: null, percent: 10 },
            "no recipient: stays a percentage",
          );
        });
      });

      describe("Box contents (pp.216-219)", function () {
        useQuenchTimeout(this, 60000);

        it("every tier's tables are there", async function () {
          for (const tierKey of TIERS) {
            const tier = CONFIG.CARLRPG.lootBoxTiers[tierKey];
            const name = tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
            assert.exists(await lootTable(`${name} Box: Consumables`), `${name} Box: Consumables`);
            if (tier.mundane)
              assert.exists(await lootTable(`${name} Box: Mundane`), `${name} Box: Mundane`);
            if (tier.weakMagicChance)
              assert.exists(await lootTable(`${name} Box: Weak Magic`), `${name} Box: Weak Magic`);
          }
        });

        it("gold by the tier's formula, a magic item from Silver up, and every entry makes an item", async function () {
          for (const tierKey of TIERS) {
            const loot = await generateLoot(tierKey, { floor: 3 });
            assert.exists(loot, tierKey);
            const gold = {
              bronze: [1, 10],
              silver: [100, 1000],
              gold: [1000, 6000],
              platinum: [2000, 12000],
              legendary: [10000, 100000],
              celestial: [0, 0],
            }[tierKey];
            assert.isTrue(
              loot.gold >= gold[0] && loot.gold <= gold[1],
              `${tierKey} gold ${loot.gold}`,
            );
            for (const entry of loot.entries)
              assert.include(KINDS, entry.kind, `${tierKey}: ${entry.kind}`);
            const magic = loot.entries.filter((e) => e.kind === "magic");
            assert.equal(magic.length, tierKey === "bronze" ? 0 : 1, `${tierKey} magic items`);
            const data = await lootItemData(loot);
            assert.equal(
              data.length,
              loot.entries.length,
              `${tierKey}: every entry resolves to an item`,
            );
            for (const item of data) assert.equal(item.type, "item");
          }
        });

        it("a world copy of a table wins, and a row's quantity is read", async function () {
          const [table] = await RollTable.createDocuments([
            {
              name: "Bronze Box: Mundane",
              formula: "1d1",
              results: [{ type: "text", name: "Quench Thing ×3", range: [1, 1], weight: 1 }],
            },
          ]);
          try {
            const loot = await generateLoot("bronze");
            const thing = loot.entries.find((e) => e.name === "Quench Thing");
            assert.exists(thing, "the world's row was drawn");
            assert.equal(thing.kind, "text");
            assert.equal(thing.quantity, 3);
          } finally {
            await table.delete();
          }
        });
      });

      describe("Box tables: the world's, then the world's compendiums', then the system's (ruled 2026-11-20)", function () {
        useQuenchTimeout(this, 60000);

        it("a world compendium's copy beats the system's; the world's own beats both", async function () {
          const name = "Bronze Box: Mundane";
          if (game.tables.getName(name)) this.skip(); // the GM's own table would win either way
          const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
            type: "RollTable",
            label: "Quench Box Tables",
            name: `quench-box-tables-${foundry.utils.randomID().toLowerCase()}`,
          });
          let world = null;
          try {
            await RollTable.implementation.create(
              {
                name,
                formula: "1d1",
                results: [{ type: "text", name: "Quench Pack Thing ×2", range: [1, 1], weight: 1 }],
              },
              { pack: pack.collection },
            );
            assert.equal((await boxTable(name))?.pack, pack.collection, "the world compendium's");
            const loot = await generateLoot("bronze");
            const thing = loot.entries.find((e) => e.name === "Quench Pack Thing");
            assert.exists(thing, "drawn from it");
            assert.equal(thing.quantity, 2);

            [world] = await RollTable.createDocuments([
              {
                name,
                formula: "1d1",
                results: [{ type: "text", name: "Quench World Thing", range: [1, 1], weight: 1 }],
              },
            ]);
            assert.equal((await boxTable(name))?.id, world.id, "the world's own first");
          } finally {
            await world?.delete();
            await pack.deleteCompendium();
          }
        });

        it("with neither, the system's", async function () {
          const name = "Silver Box: Consumables";
          if (game.tables.getName(name)) this.skip();
          const table = await boxTable(name);
          assert.exists(table);
          assert.isTrue(
            table.pack === "carl-rpg.roll-tables" ||
              game.packs.get(table.pack)?.metadata.packageType === "world",
          );
        });

        it("the magic item's tables (the book's) aren't looked for in world compendiums", async function () {
          // lootTable: the world's, then the system's - unchanged.
          const table = await lootTable("Item Type");
          assert.exists(table);
          if (table.pack) assert.equal(table.pack, "carl-rpg.roll-tables");
        });
      });

      describe("Magic items (pp.219-220)", function () {
        useQuenchTimeout(this);

        it("auto-fill: a Skill the recipient owns, different Stats for a repeat, an uncommon damage type", async function () {
          const actor = await createTestCharacter("loot recipient");
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", {
              system: { rank: 2, category: "utility" },
            });
            const draft = await autofillMagicDraft(
              {
                kind: "magic",
                tierKey: "gold",
                itemType: "clothing",
                typeLabel: "Enchanted Clothing",
                name: "",
                slots: [],
                accessoryKind: "",
                enchantments: [
                  { kind: "stat", text: "+X Stat Bonus" },
                  { kind: "stat", text: "+X Stat Bonus" },
                  { kind: "skill", text: "+X Skill Bonus" },
                  { kind: "resistance", text: "Resistance to an uncommon damage type" },
                ],
              },
              { recipient: actor, floor: 4 },
            );
            const [a, b, s, r] = draft.enchantments;
            assert.notEqual(a.target, b.target, "a repeated Stat goes to another Stat");
            assert.equal(s.target, skill.name);
            assert.isTrue(s.value >= 1 && s.value <= 3);
            assert.include(CONFIG.CARLRPG.uncommonDamageTypes, r.target);
            assert.isNotEmpty(draft.name);
            assert.lengthOf(draft.slots, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("buildMagicItemData: Bonuses for a Stat, a Skill, a Resistance and DR; the rest described", function () {
          const data = buildMagicItemData({
            kind: "magic",
            tierKey: "gold",
            itemType: "accessory",
            typeLabel: "Enchanted Accessory",
            name: "Ring of Tests",
            slots: ["accessory"],
            accessoryKind: "",
            enchantments: [
              { kind: "stat", target: "dex", value: 3 },
              { kind: "skill", target: "Running", value: 2 },
              { kind: "resistance", target: "fire" },
              { kind: "dr", value: 1 },
              { kind: "buff", text: "A Buff (not Skill or Stat bonuses)" },
            ],
          });
          const by = (type) => data.system.changes.filter((c) => c.targetType === type);
          assert.equal(by("stat")[0].target, "dex");
          assert.equal(by("stat")[0].value, "3");
          assert.equal(by("skillRank")[0].target, "Running");
          assert.equal(by("resistance")[0].value, "resist");
          assert.equal(by("resource")[0].target, "dr");
          assert.lengthOf(data.system.changes, 4);
          assert.equal(
            (data.system.description.match(/<li>/g) ?? []).length,
            5,
            "every enchantment described",
          );
          assert.deepEqual(data.system.slots, ["accessory"]);
          assert.equal(
            data.flags["carl-rpg"].magicDraft.name,
            "Ring of Tests",
            "the draft rides along for the Forge",
          );
        });
      });

      describe("Handing loot out (the Loot Forge's Give, Create in World, Reforge)", function () {
        useQuenchTimeout(this, 60000);

        it("grantLoot: the items on the character, the gold added to theirs", async function () {
          const actor = await createTestCharacter("loot taker");
          try {
            const before = actor.system.details.gold ?? 0;
            const { items, gold } = await grantLoot(
              {
                tierKey: "bronze",
                gold: 7,
                entries: [
                  {
                    kind: "text",
                    name: "Quench Coupon",
                    img: "icons/svg/item-bag.svg",
                    quantity: 2,
                  },
                ],
              },
              actor,
            );
            assert.lengthOf(items, 1);
            assert.equal(actor.items.getName("Quench Coupon").system.quantity, 2);
            assert.equal(gold, 7);
            assert.equal(actor.system.details.gold, before + 7);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("one effect rerolled: the others are kept", async function () {
          const draft = await generateMagicDraft("legendary", { floor: 3 });
          assert.exists(draft, "the magic item tables are there");
          const kept = foundry.utils.deepClone(draft.enchantments.slice(1));
          await rerollEnchantment(draft, 0, { floor: 3 });
          assert.isNotEmpty(draft.enchantments[0].kind);
          assert.deepEqual(
            draft.enchantments.slice(1).map((e) => e.text),
            kept.map((e) => e.text),
          );
        });

        it("Reforge: saving rewrites the item's name and Bonuses, and keeps its image", async function () {
          const actor = await createTestCharacter("reforge");
          let forge = null;
          try {
            const data = buildMagicItemData({
              kind: "magic",
              tierKey: "gold",
              itemType: "accessory",
              typeLabel: "Enchanted Accessory",
              name: "Ring of Before",
              slots: ["accessory"],
              accessoryKind: "",
              enchantments: [{ kind: "stat", target: "dex", value: 3 }],
            });
            const [item] = await actor.createEmbeddedDocuments("Item", [
              { ...data, img: "icons/svg/sun.svg" },
            ]);
            forge = await LootForge.reforge(item);
            assert.exists(forge, "a GM can reforge a rolled magic item");
            const entry = forge.draft.entries[0];
            entry.name = "Ring of After";
            entry.enchantments[0].target = "str";
            entry.enchantments[0].value = 4;
            forge.element.querySelector('[data-action="save"]').click();
            await waitFor(() => actor.items.get(item.id)?.name === "Ring of After");
            const after = actor.items.get(item.id);
            assert.equal(after.img, "icons/svg/sun.svg");
            assert.lengthOf(after.system.changes, 1);
            assert.equal(after.system.changes[0].target, "str");
            assert.equal(after.system.changes[0].value, "4");
            assert.equal(after.getFlag("carl-rpg", "magicDraft").name, "Ring of After");
          } finally {
            await forge?.close();
            await deleteTestActor(actor);
          }
        });

        it("a magic weapon: its Weapon Skill set, and Held", function () {
          const data = buildMagicItemData({
            kind: "magic",
            tierKey: "silver",
            itemType: "mundane",
            typeLabel: "Enchanted Mundane Item or Weapon",
            name: "Tire Iron of the Sweaty Goblin",
            slots: ["accessory"],
            accessoryKind: "",
            weaponSkill: "Club",
            enchantments: [{ kind: "dr", value: 1 }],
          });
          assert.equal(data.system.weaponSkill, "Club");
          assert.deepEqual(data.system.slots, ["held"]);
        });

        it("magicItemUpdate drops the old draft's enchantments", function () {
          const update = magicItemUpdate({
            kind: "magic",
            tierKey: "silver",
            itemType: "mundane",
            typeLabel: "x",
            name: "Stick",
            slots: ["held"],
            accessoryKind: "",
            enchantments: [{ kind: "dr", value: 1 }],
          });
          assert.equal(update.name, "Stick");
          assert.lengthOf(update["system.changes"], 1);
          assert.deepEqual(update["system.slots"], ["held"]);
        });

        it("the Forge draws a rolled box: a row per entry, its gold", async function () {
          const draft = await generateLoot("silver", { floor: 2 });
          const forge = await LootForge.open({ draft });
          try {
            assert.lengthOf(
              forge.element.querySelectorAll(".carl-forge-entry"),
              draft.entries.length,
            );
            assert.equal(
              Number(forge.element.querySelector('input[name="gold"]').value),
              draft.gold,
            );
            assert.isNotNull(forge.element.querySelector('[data-action="save"]'));
            assert.isNull(
              forge.element.querySelector('[name="recipientId"]'),
              "the caller picks who it's for",
            );
          } finally {
            await forge.close();
          }
        });
      });

      describe("The Loot Forge's form", function () {
        useQuenchTimeout(this, 30000);

        /** Set a field in the Forge and fire its change, as a GM's edit would. */
        const edit = (forge, name, value) => {
          const el = forge.element.querySelector(`[name="${name}"]`);
          assert.exists(el, name);
          el.value = value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const magicDraft = (enchantments) => ({
          tierKey: "legendary",
          gold: 0,
          entries: [
            {
              kind: "magic",
              tierKey: "legendary",
              itemType: "accessory",
              typeLabel: "Enchanted Accessory",
              name: "Ring of Forms",
              slots: ["accessory"],
              accessoryKind: "",
              enchantments,
            },
          ],
        });

        it("an edited X and a picked Stat land in the draft", async function () {
          const forge = await LootForge.open({
            draft: magicDraft([{ kind: "stat", target: "dex", value: 3, percent: null }]),
          });
          try {
            edit(forge, "entries.0.enchantments.0.value", "7");
            await waitFor(() => forge.draft.entries[0].enchantments[0].value === 7);
            // A select redraws the window: wait for the new one before the
            // next edit, or it lands on a field that's being replaced.
            const select = '[name="entries.0.enchantments.0.target"]';
            const before = forge.element.querySelector(select);
            edit(forge, "entries.0.enchantments.0.target", "con");
            await waitFor(() => forge.draft.entries[0].enchantments[0].target === "con");
            await waitFor(() => {
              const now = forge.element.querySelector(select);
              return now && now !== before && now.value === "con";
            });
            edit(forge, "gold", "250");
            await waitFor(() => forge.draft.gold === 250);
          } finally {
            await forge.close();
          }
        });
      });

      describe("Mending all Injuries (Heal Severe Injury Potion, p.218; ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("a potion that mends all ends every Injury, Long-Term ones too", async function () {
          const actor = await createTestCharacter("mend all", { system: { hb: { value: 1 } } });
          try {
            for (const key of ["minorInjury", "majorInjury", "longTermMinorInjury", "blinded"]) {
              await addConditionToActor(actor, key);
            }
            const potion = await createTestItem(actor, "item", "severe", {
              system: {
                quantity: 1,
                consumable: { kind: "potion", heal: { slots: 9, mend: "all" } },
              },
            });
            await useConsumable(actor, potion, { skipDialog: true });
            const keys = actor.system.conditions.map((c) => c.key);
            assert.notInclude(keys, "minorInjury");
            assert.notInclude(keys, "majorInjury");
            assert.notInclude(keys, "longTermMinorInjury");
            assert.include(keys, "blinded", "other Debuffs stay");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: the loot generator (box contents, magic items)" },
  );
}
