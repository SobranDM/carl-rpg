import {
  autofillMagicDraft,
  buildMagicItemData,
  generateLoot,
  lootItemData,
  lootTable,
  statBonus,
} from "../../helpers/loot.mjs";
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
