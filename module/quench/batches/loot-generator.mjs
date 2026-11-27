import {
  autofillMagicDraft,
  baseOfDraft,
  boxTable,
  boxTableFor,
  boxTableNames,
  buildMagicItemData,
  enchantmentLine,
  generateLoot,
  generateMagicDraft,
  grantLoot,
  lootItemData,
  lootTable,
  magicItemUpdate,
  magicSummaryHtml,
  ownDescription,
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
import { boxTheme } from "../../helpers/reward-text.mjs";
import { giveBox, openBox } from "../../helpers/boxes.mjs";
import { attackReadiness, isWeaponFor } from "../../helpers/weapons.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";

/**
 * The loot generator (0.8.0, docs/loot-and-achievements.md; Loot,
 * pp.215-220): the per-tier box recipes and tables, magic item drafts and
 * the Item data they make. Needs the system's packs built
 * (npm run build:packs) - the box tables live in the Roll Tables pack.
 */
const TIERS = ["bronze", "silver", "gold", "platinum", "legendary", "celestial"];
const KINDS = ["item", "spellScroll", "spellbook", "text", "magic"];

/**
 * Run `fn` with a tier's recipe changed (CONFIG.CARLRPG.lootBoxTiers), then
 * put it back - so a test can pin the weak magic chance.
 * @param {string} tierKey
 * @param {object} patch
 * @param {() => Promise<any>} fn
 */
async function withRecipe(tierKey, patch, fn) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[tierKey];
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, tier[k]]));
  Object.assign(tier, patch);
  try {
    return await fn();
  } finally {
    Object.assign(tier, saved);
  }
}

/**
 * Run `fn` with world Roll Tables made for it - each `{name, rows}`, a row
 * a text row's name or `{name, description}` or `{name, documentUuid}` -
 * then delete them. Null (fn not run) when the world already has a table
 * of one of those names: that's the GM's, and it would win.
 * @param {{name: string, rows: (string|object)[]}[]} specs
 * @param {(tables: RollTable[]) => Promise<any>} fn
 */
async function withWorldTables(specs, fn) {
  if (specs.some((t) => game.tables.getName(t.name))) return null;
  const tables = await RollTable.createDocuments(
    specs.map(({ name, rows }) => ({
      name,
      formula: `1d${rows.length}`,
      results: rows.map((row, i) => {
        const r = typeof row === "string" ? { name: row } : row;
        return {
          type: r.documentUuid ? "document" : "text",
          name: r.name,
          description: r.description ?? "",
          documentUuid: r.documentUuid ?? null,
          range: [i + 1, i + 1],
          weight: 1,
        };
      }),
    })),
  );
  try {
    return (await fn(tables)) ?? true;
  } finally {
    await RollTable.deleteDocuments(tables.map((t) => t.id));
  }
}

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
            const loot = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
              generateLoot("bronze"),
            );
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
          // The GM's own copy - in the world or a world compendium - would win.
          if ((await boxTable(name))?.pack !== "carl-rpg.roll-tables") this.skip();
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
            const loot = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
              generateLoot("bronze"),
            );
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
          // The GM's own copy - in the world or a world compendium - would win.
          if (game.tables.getName(name)) this.skip();
          for (const pack of game.packs) {
            if (pack.documentName !== "RollTable" || pack.metadata.packageType !== "world")
              continue;
            if ((await pack.getIndex()).find((e) => e.name === name)) this.skip();
          }
          const table = await boxTable(name);
          assert.exists(table);
          assert.equal(table.pack, "carl-rpg.roll-tables");
        });

        it("the magic item's tables (the book's) aren't looked for in world compendiums", async function () {
          const name = "Item Type";
          // The GM's own copy in the world would win; one in a world compendium already
          // would make boxTable's check below meaningless.
          if (game.tables.getName(name)) this.skip();
          if ((await boxTable(name))?.pack !== "carl-rpg.roll-tables") this.skip();
          const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
            type: "RollTable",
            label: "Quench Magic Tables",
            name: `quench-magic-tables-${foundry.utils.randomID().toLowerCase()}`,
          });
          try {
            await RollTable.implementation.create(
              {
                name,
                formula: "1d1",
                results: [{ type: "text", name: "Quench Pack Type", range: [1, 1], weight: 1 }],
              },
              { pack: pack.collection },
            );
            assert.equal(
              (await boxTable(name))?.pack,
              pack.collection,
              "test setup: a box table lookup would find the compendium copy",
            );
            const table = await lootTable(name);
            assert.exists(table);
            assert.equal(table.pack, "carl-rpg.roll-tables", "the system's, not the compendium's");
          } finally {
            await pack.deleteCompendium();
          }
        });
      });

      describe("The book's shape and themed boxes (ruled 2026-11-27)", function () {
        useQuenchTimeout(this, 60000);
        const named = (loot, name) => loot.entries.filter((e) => e.name === name);

        it("the recipe: one item, a consumable or two", function () {
          const tiers = CONFIG.CARLRPG.lootBoxTiers;
          assert.equal(tiers.bronze.mundane, 1, "Bronze's item is mundane");
          assert.equal(tiers.bronze.magicItems, 0);
          assert.isAbove(tiers.bronze.weakMagicChance, 0);
          for (const tierKey of TIERS.slice(1)) {
            assert.equal(tiers[tierKey].mundane, 0, `${tierKey}: no mundane item`);
            assert.equal(tiers[tierKey].magicItems, 1, `${tierKey}: one magic item`);
          }
          for (const tierKey of TIERS) assert.equal(tiers[tierKey].consumables, "1d2", tierKey);
        });

        it("entries per box: Bronze its item and 1-2 consumables; Silver up a magic item and 1-2, no mundane", async function () {
          const ran = await withWorldTables(
            [
              { name: "Bronze Box: Mundane", rows: ["Quench Widget"] },
              { name: "Bronze Box: Consumables", rows: ["Quench Tonic"] },
              { name: "Silver Box: Mundane", rows: ["Quench Silver Widget"] },
            ],
            async () => {
              for (let i = 0; i < 4; i++) {
                const bronze = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
                  generateLoot("bronze"),
                );
                assert.lengthOf(named(bronze, "Quench Widget"), 1, "one mundane item");
                const tonics = named(bronze, "Quench Tonic").length;
                assert.isTrue(tonics >= 1 && tonics <= 2, `${tonics} consumables`);
                assert.lengthOf(bronze.entries, 1 + tonics);
              }
              for (const tierKey of TIERS.slice(1)) {
                const loot = await generateLoot(tierKey, { floor: 3 });
                const magic = loot.entries.filter((e) => e.kind === "magic").length;
                const rest = loot.entries.length - magic;
                assert.equal(magic, 1, `${tierKey}: one magic item`);
                assert.isTrue(rest >= 1 && rest <= 2, `${tierKey}: ${rest} consumables`);
                assert.lengthOf(named(loot, "Quench Silver Widget"), 0, `${tierKey}: no mundane`);
              }
            },
          );
          if (!ran) this.skip();
        });

        it("Bronze's weak magic item replaces its mundane item, not added to it", async function () {
          const ran = await withWorldTables(
            [
              { name: "Bronze Box: Mundane", rows: ["Quench Widget"] },
              { name: "Bronze Box: Weak Magic", rows: ["Quench Shimmer"] },
              { name: "Bronze Box: Consumables", rows: ["Quench Tonic"] },
            ],
            async () => {
              for (let i = 0; i < 3; i++) {
                const loot = await withRecipe("bronze", { weakMagicChance: 1 }, () =>
                  generateLoot("bronze"),
                );
                assert.lengthOf(named(loot, "Quench Shimmer"), 1, "the weak magic item");
                assert.lengthOf(named(loot, "Quench Widget"), 0, "instead of the mundane one");
                assert.lengthOf(loot.entries, 1 + named(loot, "Quench Tonic").length);
              }
            },
          );
          if (!ran) this.skip();
        });

        it("a box's theme comes from its title", function () {
          assert.equal(boxTheme("Bronze Quenchling Box"), "Quenchling");
          assert.equal(boxTheme("Gold quenchmaker’s box"), "Quenchmaker's");
          assert.equal(boxTheme("Platinum Lucky Quench Box"), "Lucky Quench");
          assert.equal(boxTheme("You've received a Silver Quenchling Box!"), "Quenchling");
          assert.equal(boxTheme("Quenchling Box"), "Quenchling", "no tier: a short title");
          assert.equal(boxTheme("Silver Box"), "");
          assert.equal(boxTheme(""), "");
          assert.deepEqual(boxTableNames("gold", "Quenchmaker", "Mundane"), [
            "Gold Quenchmaker Box: Mundane",
            "Gold Quenchmaker's Box: Mundane",
            "Quenchmaker Box: Mundane",
            "Quenchmaker's Box: Mundane",
            "Gold Box: Mundane",
          ]);
          assert.deepEqual(boxTableNames("bronze", "", "Consumables"), ["Bronze Box: Consumables"]);
        });

        it("a themed box draws from its theme's table, else the tier's; a tier's themed table first", async function () {
          const ran = await withWorldTables(
            [
              { name: "Quenchling Box: Mundane", rows: ["Quench Themed Thing"] },
              { name: "Bronze Box: Consumables", rows: ["Quench Tonic"] },
            ],
            async () => {
              const loot = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
                generateLoot("bronze", { theme: "Quenchling" }),
              );
              assert.equal(loot.theme, "Quenchling");
              assert.lengthOf(named(loot, "Quench Themed Thing"), 1, "the theme's table");
              assert.isAbove(
                named(loot, "Quench Tonic").length,
                0,
                "no themed Consumables table: the tier's",
              );
              const none = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
                generateLoot("bronze", { theme: "Quenchnobody" }),
              );
              assert.lengthOf(named(none, "Quench Themed Thing"), 0, "an unknown theme: generic");
              await withWorldTables(
                [{ name: "Bronze Quenchling Box: Mundane", rows: ["Quench Bronze Thing"] }],
                async () => {
                  const tiered = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
                    generateLoot("bronze", { theme: "Quenchling" }),
                  );
                  assert.lengthOf(named(tiered, "Quench Bronze Thing"), 1, "the tier's own first");
                },
              );
            },
          );
          if (!ran) this.skip();
        });

        it("a Weapon Box's magic item is a weapon from its table, enchanted on Table 39 (ruled 2026-11-27)", async function () {
          const loot = await generateLoot("gold", { theme: "Weapon" });
          const magic = loot.entries.filter((e) => e.kind === "magic");
          assert.isNotEmpty(magic, "Gold gives a magic item");
          for (const item of magic) {
            assert.isNotEmpty(item.weaponSkill, `${item.name}: a weapon`);
            assert.isNotEmpty(item.base?.name, `${item.name}: built on one`);
            assert.include(item.name, item.base.name, "named for its weapon");
            assert.deepEqual(item.slots, ["held"]);
            assert.equal(item.typeLabel, "Enchanted Mundane Item or Weapon");
          }
          // Rerolled in the Forge, it stays that weapon.
          const again = await generateMagicDraft("gold", { base: baseOfDraft(magic[0]) });
          assert.equal(again.base.name, magic[0].base.name);
          assert.equal(again.weaponSkill, magic[0].weaponSkill);
        });

        it("opening a box reads the theme from its title", async function () {
          const actor = await createTestCharacter("themed box");
          try {
            const ran = await withWorldTables(
              [{ name: "Quenchling Box: Mundane", rows: ["Quench Themed Thing"] }],
              async () => {
                const box = await giveBox(actor, {
                  tierKey: "bronze",
                  name: "Bronze Quenchling Box",
                });
                await withRecipe("bronze", { weakMagicChance: 0 }, () => openBox(box));
                assert.exists(actor.items.getName("Quench Themed Thing"));
              },
            );
            if (!ran) this.skip();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a text row becomes a simple item, with the row's quantity and description", async function () {
          const ran = await withWorldTables(
            [
              {
                name: "Bronze Box: Mundane",
                rows: [{ name: "Quench Gizmo ×2", description: "<p>Quench words.</p>" }],
              },
            ],
            async () => {
              const loot = await withRecipe("bronze", { weakMagicChance: 0 }, () =>
                generateLoot("bronze"),
              );
              const [entry] = named(loot, "Quench Gizmo");
              assert.exists(entry);
              assert.equal(entry.kind, "text");
              const [data] = await lootItemData({ entries: [entry] });
              assert.equal(data.type, "item");
              assert.equal(data.name, "Quench Gizmo");
              assert.equal(data.system.quantity, 2);
              assert.include(data.system.description, "Quench words.");
            },
          );
          if (!ran) this.skip();
        });

        it("a funny weapon row arrives as a weapon its Skill can attack with", async function () {
          const actor = await createTestCharacter("funny weapon");
          let spatula = null;
          try {
            // createTestItem decorates the name: the weapon names the Skill as made.
            const club = await createTestItem(actor, "skill", "Club", {
              system: { category: "attack", rank: 1 },
            });
            [spatula] = await Item.createDocuments([
              {
                name: "Quench Spatula",
                type: "item",
                system: { weaponSkill: club.name, slots: ["held"], twoHanded: false },
              },
            ]);
            const ran = await withWorldTables(
              [
                {
                  name: "Quenchling Box: Mundane",
                  rows: [{ name: "Quench Spatula", documentUuid: spatula.uuid }],
                },
              ],
              async () => {
                const box = await giveBox(actor, {
                  tierKey: "bronze",
                  name: "Bronze Quenchling Box",
                });
                await withRecipe("bronze", { weakMagicChance: 0 }, () => openBox(box));
                const weapon = actor.items.getName("Quench Spatula");
                assert.exists(weapon);
                assert.isTrue(isWeaponFor(weapon, club));
                assert.deepEqual(weapon.system.slots, ["held"]);
                const ready = attackReadiness(actor, club, { mainHand: weapon });
                assert.isTrue(ready.ready);
                assert.equal(ready.weapon, weapon);
              },
            );
            if (!ran) this.skip();
          } finally {
            await deleteTestActor(actor);
            await spatula?.delete();
          }
        });

        it("the system's themed tables (packs rebuilt): Goblin and Weapon", async function () {
          const goblin = await boxTableFor("bronze", "Goblin", "Consumables");
          const weapons = await boxTableFor("bronze", "Weapon", "Mundane");
          if (goblin?.name !== "Goblin Box: Consumables" || weapons?.name !== "Weapon Box: Mundane")
            this.skip();
          for (const result of weapons.results) {
            const item = await fromUuid(result.documentUuid);
            assert.exists(item, result.name);
            assert.isNotEmpty(item.system.weaponSkill, `${item.name}: a Weapon Skill`);
            assert.include(item.system.slots, "held", item.name);
          }
          const consumables = await boxTableFor("silver", "Weapon", "Consumables");
          assert.equal(consumables?.name, "Silver Box: Consumables", "no themed table: the tier's");
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
            forge.element.querySelector('[data-action="saveForge"]').click();
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
            assert.isNotNull(forge.element.querySelector('[data-action="saveForge"]'));
            assert.isNull(
              forge.element.querySelector('[name="recipientId"]'),
              "the caller picks who it's for",
            );
          } finally {
            await forge.close();
          }
        });

        it("saving a description keeps the Forge open and shows the new text", async function () {
          const saved = [];
          const forge = await LootForge.open({
            draft: {
              tierKey: "gold",
              entries: [{ kind: "magic", tierKey: "gold", name: "Test Trinket", enchantments: [] }],
            },
            onSave: async (d) => saved.push(d),
          });
          try {
            const pm = forge.element.querySelector(".carl-forge-description prose-mirror");
            assert.exists(pm);
            pm.querySelector("button.toggle").click();
            const saveButton = () => pm.querySelector('menu button[data-action="save"]');
            await waitFor(() => saveButton() && pm.querySelector(".ProseMirror"));
            pm.querySelector(".ProseMirror").innerHTML = "<p>Glows faintly.</p>";
            await new Promise((r) => setTimeout(r, 100));
            saveButton().click();
            const shown = () =>
              forge.element.querySelector(".carl-forge-description .editor-content")?.textContent ??
              "";
            await waitFor(() => shown().includes("Glows faintly."));
            assert.isTrue(forge.rendered, "the Forge is still open");
            assert.lengthOf(saved, 0, "the Forge itself wasn't saved");
            assert.equal(forge.draft.entries[0].description, "<p>Glows faintly.</p>");
          } finally {
            await forge.close();
          }
        });

        it("closing saves what changed, and nothing if nothing did", async function () {
          const open = async (saved) =>
            LootForge.open({
              draft: await generateLoot("silver", { floor: 2 }),
              onSave: async (d) => saved.push(d),
            });

          const untouched = [];
          await (await open(untouched)).close();
          assert.lengthOf(untouched, 0, "only looked at: not saved");

          const changed = [];
          const forge = await open(changed);
          const gold = forge.element.querySelector('input[name="gold"]');
          gold.value = "4321";
          await forge.close();
          assert.lengthOf(changed, 1, "saved once, on closing");
          assert.equal(changed[0].gold, 4321, "with what was typed");

          const viaSave = [];
          const saver = await open(viaSave);
          saver.element.querySelector('input[name="gold"]').value = "7";
          saver.element.querySelector('[data-action="saveForge"]').click();
          await waitFor(() => !saver.rendered);
          assert.lengthOf(viaSave, 1, "Save, then closing, saves once");
        });

        it("a Description opened but not typed in isn't a change; a failed save still closes", async function () {
          const draft = () => ({
            tierKey: "gold",
            entries: [{ kind: "magic", tierKey: "gold", name: "Test Trinket", enchantments: [] }],
          });
          const saved = [];
          const looked = await LootForge.open({
            draft: draft(),
            onSave: async (d) => saved.push(d),
          });
          const pm = looked.element.querySelector(".carl-forge-description prose-mirror");
          pm.querySelector("button.toggle").click();
          await waitFor(() => pm.classList.contains("active"));
          await looked.close();
          assert.lengthOf(saved, 0, "an empty editor opened and closed: not saved");

          const failing = await LootForge.open({
            draft: draft(),
            onSave: async () => {
              throw new Error("the box is gone");
            },
          });
          failing.element.querySelector(".carl-forge-name").value = "Renamed";
          await failing.close();
          assert.isFalse(failing.rendered, "the window closes anyway");
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

      describe("A magic item's description, image and weapon parts (ruled 2026-11-21)", function () {
        useQuenchTimeout(this, 30000);

        const weaponDraft = (more = {}) => ({
          kind: "magic",
          tierKey: "silver",
          itemType: "mundane",
          typeLabel: "Enchanted Mundane Item or Weapon",
          name: "Quench Cleaver",
          slots: ["held"],
          accessoryKind: "",
          weaponSkill: "Axe",
          enchantments: [{ kind: "dr", value: 1 }],
          ...more,
        });
        const DEBUFF = "blinded";
        const debuff = {
          id: "quenchdebuff0001",
          debuffKey: DEBUFF,
          stacks: 2,
          critOnly: false,
          amazingSuccessOnly: false,
          label: "",
        };

        it("the GM's words, then the enchantments; its image; a weapon's parts", function () {
          const data = buildMagicItemData(
            weaponDraft({
              description: "<p>Quench: it hums.</p>",
              img: "icons/svg/sword.svg",
              twoHanded: true,
              armorPiercing: true,
              targetEffects: [debuff],
            }),
          );
          const desc = data.system.description;
          assert.isTrue(desc.startsWith("<p>Quench: it hums.</p>"), "the GM's words first");
          assert.include(desc, 'class="carl-magic-enchantments"', "then the enchantments");
          assert.equal(data.img, "icons/svg/sword.svg");
          assert.isTrue(data.system.twoHanded);
          assert.isTrue(data.system.armorPiercing);
          assert.equal(data.system.targetEffects[0].debuffKey, DEBUFF);
        });

        it("not a weapon: no Two-Handed, Armor-Piercing or Debuffs, whatever the draft held", function () {
          const data = buildMagicItemData(
            weaponDraft({
              weaponSkill: "",
              slots: ["head"],
              twoHanded: true,
              armorPiercing: true,
              targetEffects: [debuff],
            }),
          );
          assert.isFalse(data.system.twoHanded);
          assert.isFalse(data.system.armorPiercing);
          assert.lengthOf(data.system.targetEffects, 0);
          assert.equal(data.img, "icons/svg/item-bag.svg", "no image: the bag");
        });

        it("the GM's own words are told from the enchantments again, even edited around", function () {
          const draft = weaponDraft();
          const summary = magicSummaryHtml(draft);
          assert.equal(ownDescription(`<p>Mine.</p>${summary}`, draft), "<p>Mine.</p>");
          assert.equal(
            ownDescription(`<p>Mine.</p>${summary}<p>Added on the sheet.</p>`, draft),
            "<p>Mine.</p><p>Added on the sheet.</p>",
          );
          assert.equal(ownDescription(summary, draft), "", "none of its own");
          // Made before 0.8.3: the same summary without its classes - and
          // as the text editor rewrites it once edited (each line its own
          // paragraph).
          const legacy = summary.replace(/ class="[^"]*"/g, "");
          assert.equal(ownDescription(`<p>Old.</p>${legacy}`, draft), "<p>Old.</p>");
          const rewritten = legacy.replace(/<li>(.*?)<\/li>/g, "<li><p>$1</p></li>");
          assert.equal(ownDescription(`<p>Old.</p>${rewritten}`, draft), "<p>Old.</p>");
        });

        it("Reforge leaves alone what a non-weapon's sheet set; a cleared image is the bag", function () {
          const ring = weaponDraft({ weaponSkill: "", slots: ["accessory"] });
          const update = magicItemUpdate(ring);
          assert.notProperty(update, "system.targetEffects", "its sheet's Debuffs stay");
          assert.notProperty(update, "system.twoHanded");
          assert.notProperty(update, "img", "no image in the draft: kept");
          assert.equal(magicItemUpdate({ ...ring, img: "" }).img, "icons/svg/item-bag.svg");
          const weapon = magicItemUpdate(weaponDraft({ targetEffects: [debuff] }));
          assert.equal(
            weapon["system.targetEffects"][0].debuffKey,
            DEBUFF,
            "a weapon's are written",
          );
          const stored = buildMagicItemData(ring).flags["carl-rpg"].magicDraft;
          assert.deepEqual(stored.targetEffects, [], "every key stored, for a later merge");
          assert.equal(stored.description, "");
        });

        it("rerolling the item keeps the GM's words and image", async function () {
          const forge = await LootForge.open({
            draft: {
              tierKey: "silver",
              gold: 0,
              entries: [weaponDraft({ description: "<p>Mine.</p>", img: "icons/svg/sword.svg" })],
            },
          });
          try {
            const before = forge.draft.entries[0];
            forge.element.querySelector('[data-action="rerollEntry"]').click();
            await waitFor(() => forge.draft.entries[0] !== before);
            assert.equal(forge.draft.entries[0].description, "<p>Mine.</p>");
            assert.equal(forge.draft.entries[0].img, "icons/svg/sword.svg");
          } finally {
            await forge.close();
          }
        });

        it("a weapon's parts show only once it has a Weapon Skill; a Debuff is added and removed", async function () {
          const forge = await LootForge.open({
            draft: {
              tierKey: "silver",
              gold: 0,
              entries: [weaponDraft({ weaponSkill: "", slots: [] })],
            },
          });
          try {
            const q = (sel) => forge.element.querySelector(sel);
            assert.isNull(q('[name="entries.0.twoHanded"]'), "not a weapon: hidden");
            const skill = q('[name="entries.0.weaponSkill"]');
            skill.value = "Axe";
            skill.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => !!q('[name="entries.0.twoHanded"]'));
            q('.carl-forge-debuffs [data-action="addArrayItem"]').click();
            await waitFor(() => forge.draft.entries[0].targetEffects?.length === 1);
            const added = forge.draft.entries[0].targetEffects[0];
            assert.deepEqual(added.skills, ["Axe"], "only with this weapon, as the sheet's");
            assert.isTrue(added.amazingSuccessOnly);
            await waitFor(() => q(`details[data-row-key="${added.id}"]`)?.open === true);
            await waitFor(() => !!q('[name="entries.0.targetEffects.0.debuffKey"]'));
            const pick = q('[name="entries.0.targetEffects.0.debuffKey"]');
            pick.value = DEBUFF;
            pick.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => forge.draft.entries[0].targetEffects[0].debuffKey === DEBUFF);
            await waitFor(() => !!q('.carl-forge-debuffs [data-action="deleteArrayItem"]'));
            q('.carl-forge-debuffs [data-action="deleteArrayItem"]').click();
            await waitFor(() => forge.draft.entries[0].targetEffects.length === 0);
          } finally {
            await forge.close();
          }
        });

        it("Reforge starts from the item as it is now, and saves its new parts", async function () {
          const actor = await createTestCharacter("reforge parts");
          let forge = null;
          try {
            const data = buildMagicItemData(weaponDraft({ description: "<p>Mine.</p>" }));
            const [item] = await actor.createEmbeddedDocuments("Item", [data]);
            // Edited on its sheet since: a new image and a word added.
            await item.update({
              img: "icons/svg/sun.svg",
              "system.description": `${item.system.description}<p>Added.</p>`,
            });
            forge = await LootForge.reforge(item);
            const entry = forge.draft.entries[0];
            assert.equal(entry.img, "icons/svg/sun.svg");
            assert.equal(entry.description, "<p>Mine.</p><p>Added.</p>");
            entry.twoHanded = true;
            entry.targetEffects = [debuff];
            forge.element.querySelector('[data-action="saveForge"]').click();
            await waitFor(() => actor.items.get(item.id)?.system.twoHanded === true);
            const after = actor.items.get(item.id);
            assert.equal(after.img, "icons/svg/sun.svg");
            assert.equal(after.system.targetEffects[0].debuffKey, DEBUFF);
            assert.isTrue(after.system.description.startsWith("<p>Mine.</p><p>Added.</p>"));
            assert.lengthOf(
              after.system.description.match(/carl-magic-enchantments/g) ?? [],
              1,
              "the enchantments listed once",
            );
          } finally {
            await forge?.close();
            await deleteTestActor(actor);
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
