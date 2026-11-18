import {
  backgroundTableMisses,
  buildCrawlerForgeActorData,
  foldCrawlerForgeEvents,
  importCrawlerForgeCrawler,
} from "../../helpers/crawlerforge-import.mjs";
import { TIERS } from "../../pdf-import/compendium-match.mjs";
import { deleteTestActor, settle, useQuenchTimeout } from "../helpers.mjs";

// CrawlerForge's sample export (Marigold "Mags" Pruitt, `sample: true`),
// including two retracted hotlist.set events - see
// module/helpers/crawlerforge-import.mjs.
const FIXTURE_PATH = "systems/carl-rpg/module/quench/fixtures/crawlerforge-mags.json";

async function loadFixture() {
  const response = await fetch(foundry.utils.getRoute(FIXTURE_PATH));
  return response.json();
}

/** A CrawlerForge Skill/Spell entry the way an export carries it. */
function cfSkill(name, rank, definition) {
  return {
    name,
    rank,
    definition: {
      id: name.toLowerCase().replace(/\W+/g, "-"),
      name,
      crawlerforge: true,
      passive: false,
      checkType: "unopposed",
      upgrades: {},
      advancement: { byUse: true },
      limited: false,
      ...definition,
    },
  };
}

const cfItem = (name, extra = {}) => ({
  id: `test-item-${name.toLowerCase().replace(/\W+/g, "-")}`,
  name, quantity: 1, notes: "", slot: null, equipped: false, effects: [], ...extra,
});

/**
 * A made-up export shaped like a real one (an event log; full definitions):
 * two Skills/Spells our compendium has, three CrawlerForge inventions (a
 * Skill, an Attack, a Spell), our Race "Human" by name, an invented Class
 * granting a Skill the export doesn't list, gear to match and place, and
 * one book and one made-up background line.
 */
function testExport() {
  // Events in this order: fold sorts them by time, as text.
  let eventCount = 0;
  const cfEvent = (type, payload) => ({
    id: `test-event-${++eventCount}`,
    type,
    occurredAt: `2026-11-18T07:31:${String(10 + eventCount).padStart(2, "0")}.000Z`,
    payload,
  });
  const crawler = {
    name: "TestCrawler CF",
    pronouns: "they/them",
    crawlerNumber: 600001,
    floor: 3,
    level: 5,
    unenhanced: { str: 4, int: 6, con: 3, dex: 4, cha: 5 },
    aiFavor: 1,
    size: { name: "Medium", value: 4 },
    species: "human",
    pastTrauma: "I was abused by someone I trusted.",
    looseEnds: "Loose End Test",
    regrets: "Regret Test",
    campaign: "Test Campaign",
    skills: [
      cfSkill("Unarmed Combat", 3, {
        category: "attack", stat: "str", checkType: "evade",
        attack: { type: "melee", weaponCategory: "handToHand", baseDamage: { dice: "1d4", damageType: "bludgeoning" } },
      }),
      cfSkill("Heal", 1, {
        category: "spell", stat: "int", passive: true, interrupt: true, checkType: "none",
        spell: { type: "passive", manaCost: "2", heal: { target: "self", amount: "2" } },
      }),
      cfSkill("Handgun", 2, {
        category: "attack", stat: "dex", checkType: "evade",
        attack: { type: "ranged", weaponCategory: "ranged", baseDamage: { dice: "1d8", damageType: "piercing" } },
      }),
      cfSkill("Test Tinker", 2, {
        category: "utility", stat: "int", description: "Made-up utility Skill.",
        upgrades: { rank5: "Tinkers faster." },
      }),
      cfSkill("Test Pistol", 3, {
        category: "attack", stat: "dex", checkType: "evade", description: "Made-up attack Skill.",
        upgrades: { rank5: "+1d4 base damage.", rank10: "Add 1 Rank damage die." },
        upgradeRiders: { rank5: [{ type: "baseDice", dice: "1d4" }], rank10: [{ type: "rankDamageDie", rankOf: "attack" }] },
        attack: { type: "ranged", weaponCategory: "ranged", range: "60 ft", baseDamage: { dice: "1d8", damageType: "piercing" } },
      }),
      cfSkill("Test Greatclub", 1, {
        category: "attack", stat: "str", checkType: "evade", description: "Made-up two-handed weapon Skill.",
        attack: { type: "melee", weaponCategory: "bashing", baseDamage: { dice: "1d10", damageType: "bludgeoning" } },
      }),
      cfSkill("Test Zap", 2, {
        category: "spell", stat: "int", checkType: "evade", description: "Made-up attack Spell.",
        upgrades: { rank5: "+1d6 base damage." },
        upgradeRiders: { rank5: [{ type: "baseDice", dice: "1d6" }] },
        attack: { type: "ranged", range: "30 ft", baseDamage: { dice: "1d6", damageType: "fire" } },
        spell: { type: "attack", manaCost: "3", range: "30 ft", duration: "1 minute", cooldown: "1 round" },
      }),
    ],
    race: { definition: { id: "human", name: "Human", crawlerforge: true, description: "CrawlerForge's Human.", build: { benefits: [] } } },
    class: {
      definition: {
        id: "test-class", name: "Test Class", crawlerforge: true, description: "Made-up Class.", classTypes: ["rogue"],
        build: {
          benefits: [
            { id: "g", text: "+2 Test Granted Skill", effects: [{ type: "skill", skill: { kind: "named", name: "Test Granted Skill" }, ranks: 2 }] },
            { id: "m", text: "Membership in the Test Club", effects: [{ type: "membership", club: "Test Club" }] },
          ],
        },
      },
    },
  };
  const items = [
    cfItem("Standard Mana Potion", { quantity: 5, notes: "From choosing a Spell as your starting attack." }),
    cfItem("Plain Clothes", { slot: "torso", equipped: true }),
    cfItem("Clothes"),
    cfItem("Handgun", { slot: "hand", equipped: true }),
    cfItem("Test Shield", { slot: "offhand", equipped: true, effects: [{ type: "dr", amount: 1 }] }),
    cfItem("Test Greatclub", { slot: "hands", equipped: true }),
    cfItem("Test Helmet", { slot: "head", equipped: true }),
    cfItem("Test Hat", { slot: "head", equipped: true }),
    cfItem("Test Banner", { slot: "hands" }),
    cfItem("Standard Test Lamp"),
    cfItem("Test Ring", { slot: "accessory", equipped: true, effects: [{ type: "stat", stat: "dex", amount: 1 }, { type: "membership", club: "Ring Club" }] }),
  ];
  return {
    schemaVersion: 1,
    kind: "crawler",
    crawlerId: "test-crawler",
    events: [
      cfEvent("crawler.created", crawler),
      ...items.map((item) => cfEvent("item.added", item)),
      cfEvent("hotlist.set", { entries: ["Handgun", "Standard Mana Potion", "Test Helmet", "Heal"] }),
    ],
  };
}

/** Compendium candidates as importer.mjs matchCandidates gives them, without the world. */
const testCandidates = () => [
  { name: "Unarmed Combat", type: "skill", tier: TIERS.system, order: 0, source: "carl-rpg.skills-and-spells", ref: "uc" },
  { name: "Handgun", type: "skill", tier: TIERS.system, order: 0, source: "carl-rpg.skills-and-spells", ref: "hg-skill" },
  { name: "Heal", type: "spell", tier: TIERS.system, order: 0, source: "carl-rpg.skills-and-spells", ref: "heal" },
  { name: "Mana Potion", type: "item", tier: TIERS.system, order: 1, source: "carl-rpg.consumables", consumable: true, ref: "mana" },
  { name: "Plain Clothes", type: "item", tier: TIERS.system, order: 2, source: "carl-rpg.gear", ref: "clothes" },
  { name: "Handgun", type: "item", tier: TIERS.system, order: 2, source: "carl-rpg.gear", weaponSkill: "Handgun", ref: "hg-gear" },
  { name: "Test Tinker", type: "skill", tier: TIERS.other, source: "some-module.pack", ref: "never" },
  { name: "Test Lamp", type: "item", tier: TIERS.system, order: 2, source: "carl-rpg.gear", ref: "lamp" },
];
const testRaceClass = () => [
  { name: "Human (Primal)", type: "race", system: { changes: [] } },
  {
    name: "Human", type: "race",
    system: {
      changes: ["str", "dex", "con", "int", "cha"].map((stat) => ({ id: "", targetType: "stat", target: stat, mode: "add", value: "2", conditions: [] })),
    },
  },
];

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.crawlerforge-import",
    (context) => {
      const { describe, it, assert } = context;

      describe("foldCrawlerForgeEvents", function () {
        it("drops retracted events and keeps the last surviving hotlist.set", async function () {
          const state = foldCrawlerForgeEvents(await loadFixture());
          assert.deepEqual(state.hotlist, ["Rebar Club", "Duct Tape Greaves", "Duct Tape Greaves"]);
          assert.equal(state.items.length, 4);
          assert.equal(state.gold, 140);
          assert.isEmpty(state.warnings);
        });

        it("warns on an unknown event type instead of failing", async function () {
          const json = await loadFixture();
          json.events.push({
            id: "x",
            type: "mystery.thing",
            occurredAt: "2027-01-01T00:00:00.000Z",
            payload: {},
          });
          const state = foldCrawlerForgeEvents(json);
          assert.lengthOf(state.warnings, 1);
          assert.include(state.warnings[0], "mystery.thing");
        });

        it("rejects a file that is not a crawler export", function () {
          assert.throws(() => foldCrawlerForgeEvents({ kind: "party", events: [] }));
          assert.throws(() =>
            foldCrawlerForgeEvents({ kind: "crawler", schemaVersion: 2, events: [] }),
          );
        });
      });

      describe("buildCrawlerForgeActorData", function () {
        it("maps header, stats, story, and plans the gear by item", async function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(await loadFixture()));
          const system = data.actor.system;
          assert.equal(data.actor.name, 'Marigold "Mags" Pruitt');
          assert.equal(system.attributes.level.value, 8);
          assert.equal(system.stats.dex.value, 6);
          assert.equal(system.bankedStatPoints, 3);
          assert.equal(system.details.crawlerNumber, "1204553");
          assert.equal(system.details.size, 2);
          assert.include(system.story, "brass floor lamp");
          // Slots are filled after creation, by item - never by name.
          assert.deepEqual(system.gearSlots, {});
          assert.deepEqual(system.accessories, []);
          const plan = Object.fromEntries(data.placements.map((p) => [p.name, p]));
          assert.equal(plan["Rebar Club"].slotKey, "mainHand");
          assert.equal(plan["Duct Tape Greaves"].slotKey, "legs");
          assert.equal(plan["Gutter Ring"].slotType, "accessory");
          const rebar = data.items.find((i) => i.name === "Rebar Club");
          assert.equal(rebar.weapon?.skill, "Rebar Club", "named like its Attack Skill: a weapon for it");
        });

        it("pre-marks every Race/Class grant as baked", async function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(await loadFixture()));
          for (const item of [data.race, data.class]) {
            // Grants are Stat and Skill Rank changes (race-class-grants.mjs); DR and the rest are live bonuses.
            const ids = item.system.changes.filter((c) => ["stat", "skillRank"].includes(c.targetType)).map((c) => c.id);
            assert.isNotEmpty(ids);
            assert.deepEqual(item.flags["carl-rpg"].bakedGrantIds, ids);
          }
        });

        it("copies compendium Skills/Spells at the export's Rank and flags the invented ones", function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(testExport()), {
            candidates: testCandidates(), raceClass: testRaceClass(),
          });
          const byName = Object.fromEntries(data.skills.map((s) => [s.name, s]));
          assert.deepEqual(byName["Unarmed Combat"].copy, { ref: "uc", rank: 3 });
          assert.deepEqual(byName.Heal.copy, { ref: "heal", rank: 1 });
          assert.equal(byName.Handgun.copy.ref, "hg-skill");

          // A lower-tier source (a module) still counts as a match.
          assert.equal(byName["Test Tinker"].copy?.ref, "never");

          const zap = byName["Test Zap"].data;
          assert.equal(zap.type, "spell");
          assert.isTrue(zap.flags["carl-rpg"].crawlerforge.notInRulebook);
          assert.equal(zap.system.manaCost, 3);
          assert.equal(zap.system.range, "30 ft");
          assert.equal(zap.system.duration, "1 minute");
          assert.equal(zap.system.cooldown, "1 round");
          assert.include(zap.system.castingKeywords, "attack");
          assert.deepEqual(zap.system.baseDamage, { dice: "1d6", stat: "int", damageType: "fire" });
          assert.equal(zap.system.upgrades[0].changes[0].value, "1d6");

          const pistol = byName["Test Pistol"].data;
          assert.equal(pistol.type, "skill");
          assert.equal(pistol.system.category, "attack");
          assert.equal(pistol.system.attackType, "ranged");
          assert.equal(pistol.system.range, "60 ft");
          assert.equal(pistol.system.baseDamage.dice, "1d8");
          assert.equal(pistol.system.baseDamage.stat, "", "ranged: DEX to hit, not to damage");
          const rank10 = pistol.system.upgrades.find((u) => u.rankThreshold === 10);
          assert.equal(rank10.changes[0].damageDiceKind, "rankDie");
          assert.isTrue(pistol.flags["carl-rpg"].crawlerforge.notInRulebook);

          assert.sameMembers(data.report.invented.map((e) => e.name), ["Test Pistol", "Test Greatclub", "Test Zap", "Test Class"]);
          assert.include(data.report.weaponsWithoutItem, "Test Pistol", "an Attack Skill with no weapon in the export");
        });

        it("grants: one Skill whatever its punctuation, stacked grants capped at 10, a granted Attack Skill's weapon checked", function () {
          const state = foldCrawlerForgeEvents(testExport());
          state.crawler.skills.push(cfSkill("Hand to Hand Combat", 2, { category: "utility", stat: "str" }));
          const grant = (target, value) => ({ id: "", targetType: "skillRank", target, mode: "add", value: String(value), conditions: [] });
          const raceClass = testRaceClass().map((rc) => (rc.name !== "Human" ? rc : {
            ...rc,
            system: { changes: [...rc.system.changes, grant("Hand-to-Hand Combat", 3), grant("Test Stack", 6), grant("Test Stack", 6), grant("Longsword", 2)] },
          }));
          const candidates = [
            ...testCandidates(),
            { name: "Longsword", type: "skill", tier: TIERS.system, order: 0, source: "carl-rpg.skills-and-spells", category: "attack", ref: "ls" },
          ];
          const data = buildCrawlerForgeActorData(state, { candidates, raceClass });
          const names = data.skills.map((s) => s.name);
          assert.lengthOf(names.filter((n) => /^hand.to.hand combat$/i.test(n)), 1, "the listed Skill isn't made again from the grant");
          assert.equal(data.skills.find((s) => s.name === "Test Stack")?.data.system.rank, 10, "6, then +6 up to 10 (p.127)");
          assert.equal(data.skills.find((s) => s.name === "Longsword")?.copy.rank, 2);
          assert.include(data.report.weaponsWithoutItem, "Longsword", "a granted Attack Skill with no weapon is reported");
        });

        it("a compendium copy keeps a fallback of its own type, from the export", function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(testExport()), {
            candidates: testCandidates(), raceClass: testRaceClass(),
          });
          const heal = data.skills.find((s) => s.name === "Heal");
          assert.equal(heal.fallback?.type, "spell", "a Spell stays a Spell if its copy can't be read");
          assert.isTrue(heal.fallback.flags["carl-rpg"].crawlerforge.notInRulebook);
          assert.equal(data.skills.find((s) => s.name === "Unarmed Combat").fallback?.type, "skill");
        });

        it("takes our Race by exact name, pre-baked, and reads species as the kind of crawler", function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(testExport()), { raceClass: testRaceClass() });
          assert.equal(data.race.name, "Human", "not Human (Primal)");
          const ids = data.race.system.changes.map((c) => c.id);
          assert.lengthOf(ids, 5);
          assert.isTrue(ids.every(Boolean), "blank compendium ids given real ones");
          assert.deepEqual(data.race.flags["carl-rpg"].bakedGrantIds, ids);
          assert.notOk(data.race.flags["carl-rpg"].crawlerforge.notInRulebook);
          assert.equal(data.class.name, "Test Class");
          assert.isTrue(data.class.flags["carl-rpg"].crawlerforge.notInRulebook);
          assert.equal(data.chargenKind, "human");
          // The Class's Skill the export doesn't list is made at its Rank.
          const granted = data.skills.find((s) => s.name === "Test Granted Skill");
          assert.equal(granted?.data.system.rank, 2);
          assert.deepInclude(data.report.unmappedEffects, { owner: "Test Class", text: "Membership in the Test Club" });
        });

        it("matches gear by name only, reports near-misses, and arms weapons", function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(testExport()), { candidates: testCandidates() });
          const byName = Object.fromEntries(data.items.map((i) => [i.name, i]));
          assert.equal(byName["Standard Mana Potion"].copy.ref, "mana", "the book's Standard Mana Potion is our Mana Potion");
          assert.equal(byName["Plain Clothes"].copy.ref, "clothes");
          assert.exists(byName.Clothes.data, "Clothes isn't Plain Clothes");
          assert.deepInclude(data.report.nearMisses, { name: "Clothes", candidates: ["Plain Clothes"] });
          assert.deepEqual(byName.Handgun.weapon, { skill: "Handgun", twoHanded: false });
          assert.deepEqual(byName["Test Greatclub"].weapon, { skill: "Test Greatclub", twoHanded: true });
          assert.deepEqual(byName["Test Banner"].data.system.slots, ["held"]);
          assert.isTrue(byName["Test Banner"].data.system.twoHanded);
          assert.exists(byName["Standard Test Lamp"].data, "the Standard alias is for consumables only");
          assert.lengthOf(byName["Test Ring"].data.system.changes, 1);
          assert.deepInclude(data.report.unmappedEffects, { owner: "Test Ring", text: "membership: Ring Club" });
        });

        it("checks background text against the book's tables", function () {
          const tables = {
            pastTrauma: ["I was abused by someone I trusted."],
            looseEnds: ["I never finished high school or my college degree."],
            regrets: [],
          };
          const crawler = foldCrawlerForgeEvents(testExport()).crawler;
          assert.deepEqual(backgroundTableMisses(crawler, tables), [{ field: "looseEnds", text: "Loose End Test" }]);
          // Without its full stop it's still the book's entry.
          assert.deepEqual(
            backgroundTableMisses({ ...crawler, pastTrauma: "I was abused by someone I trusted" }, tables),
            [{ field: "looseEnds", text: "Loose End Test" }],
          );
        });
      });

      describe("importCrawlerForgeCrawler", function () {
        useQuenchTimeout(this);

        it("creates a Character without double-baking Race/Class grants", async function () {
          const actor = await importCrawlerForgeCrawler(await loadFixture());
          try {
            // Give any (wrongly) triggered _onCreate bake time to land before asserting it didn't.
            await settle(300);
            const system = actor.system;
            assert.equal(system.stats.str.value, 2);
            assert.equal(system.stats.dex.value, 6);
            assert.equal(system.stats.cha.value, 5);
            assert.equal(system.stats.dex.effective, 7, "Gutter Ring +1 DEX is a live gear bonus");
            assert.equal(system.stats.str.effective, 3, "Rebar Club +1 STR is a live gear bonus");
            assert.equal(system.drEffective, 2, "Duct Tape Greaves +1 and the Class's +1 DR");
            assert.equal(system.resistancesEffective.necrotic, "vulnerable");

            assert.equal(system.raceItem?.name, "Gutter Sprite");
            assert.equal(system.classItem?.name, "Dumpster Sommelier");
            assert.deepEqual(system.classItem.system.classTypes, ["Bard", "Rogue"]);

            const skills = actor.items.filter((i) => i.type === "skill");
            // The export's 5, plus the 5 its Race/Class grant that it doesn't list.
            assert.lengthOf(skills, 10);
            assert.equal(skills.find((s) => s.name === "Scavenge").system.rank, 3);
            assert.equal(skills.find((s) => s.name === "Parkour")?.system.rank, 2);
            assert.equal(
              skills.find((s) => s.name === "Sidestep").system.advancementGate,
              "passive-until-5",
            );

            const rebar = skills.find((s) => s.name === "Rebar Club");
            assert.equal(rebar.system.category, "attack");
            assert.equal(rebar.system.baseDamage.dice, "1d8");
            const rank5 = rebar.system.upgrades.find((u) => u.rankThreshold === 5);
            assert.equal(rank5.changes[0].value, "1d4");
            assert.equal(rank5.changes[0].damageDiceKind, "base");
            const rank10 = rebar.system.upgrades.find((u) => u.rankThreshold === 10);
            assert.equal(rank10.targetEffects[0].debuffKey, "staggered");
            assert.isTrue(rank10.targetEffects[0].amazingSuccessOnly);

            const gearItem = (name) =>
              actor.items.find((i) => i.type === "item" && i.name === name);
            assert.equal(gearItem("Rebar Club").system.weaponSkill, "Rebar Club");
            assert.equal(system.gearSlots.mainHand, gearItem("Rebar Club").id);
            assert.equal(system.gearSlots.legs, gearItem("Duct Tape Greaves").id);
            assert.deepEqual(system.accessories, [gearItem("Gutter Ring").id]);
            // Worn gear is never in the Hotlist (p.98).
            for (const id of system.hotlist) assert.notInclude([...Object.values(system.gearSlots), ...system.accessories], id || "-");

            assert.equal(system.details.gold, 140);
            assert.notExists(actor.items.find((i) => i.name === "Gold"));
            assert.equal(
              actor.items.find((i) => i.name === "Emergency Biscuit")?.system.quantity,
              2,
            );
          } finally {
            await deleteTestActor(actor);
            await deleteReports();
          }
        });

        it("imports a made-up export: compendium copies, flagged inventions, gear placed, a GM report", async function () {
          const actor = await importCrawlerForgeCrawler(testExport());
          try {
            await settle(300);
            const system = actor.system;
            const named = (type, name) => actor.items.find((i) => i.type === type && i.name === name);
            const fromPack = (item, pack) => String(item?._stats?.compendiumSource ?? "").startsWith(`Compendium.carl-rpg.${pack}.`);

            // Compendium copies at the export's Rank.
            const unarmed = named("skill", "Unarmed Combat");
            assert.equal(unarmed?.system.rank, 3);
            assert.isTrue(fromPack(unarmed, "skills-and-spells"));
            assert.notOk(unarmed.getFlag("carl-rpg", "crawlerforge")?.notInRulebook);
            const heal = named("spell", "Heal");
            assert.equal(heal?.system.rank, 1);
            assert.isTrue(fromPack(heal, "skills-and-spells"));

            // Inventions, typed and flagged.
            const zap = named("spell", "Test Zap");
            assert.exists(zap, "a category-spell entry is a Spell");
            assert.isTrue(zap.getFlag("carl-rpg", "crawlerforge")?.notInRulebook);
            assert.equal(zap.system.manaCost, 3);
            assert.equal(zap.system.cooldown, "1 round");
            const pistol = named("skill", "Test Pistol");
            assert.equal(pistol?.system.category, "attack");
            assert.isTrue(pistol.getFlag("carl-rpg", "crawlerforge")?.notInRulebook);
            assert.equal(named("skill", "Test Granted Skill")?.system.rank, 2);

            // Our Race by name, its +2s already in the exported Stats.
            assert.equal(system.raceItem?.name, "Human");
            assert.isTrue(fromPack(system.raceItem, "classes-and-races"));
            assert.equal(system.stats.str.value, 4, "the Race's +2 isn't baked again");
            assert.equal(system.classItem?.name, "Test Class");
            assert.equal(actor.getFlag("carl-rpg", "chargen")?.kind, "human");

            // Background text as written.
            assert.include(system.story, "I was abused by someone I trusted.");
            assert.include(system.story, "Loose End Test");

            // Consumables and gear from the compendiums.
            const potion = named("item", "Standard Mana Potion");
            assert.isTrue(fromPack(potion, "consumables"));
            assert.equal(potion.system.consumable.kind, "potion");
            assert.equal(potion.system.quantity, 5);
            const clothes = named("item", "Plain Clothes");
            assert.isTrue(fromPack(clothes, "gear"));
            assert.isFalse(fromPack(named("item", "Clothes"), "gear"), "not matched to Plain Clothes");

            // The weapon: its Weapon Skill and the Gear item for it.
            const handgun = named("item", "Handgun");
            assert.equal(handgun.system.weaponSkill, "Handgun");
            assert.isTrue(fromPack(handgun, "gear"));

            // Placement by the doll's rules.
            assert.equal(system.gearSlots.mainHand, handgun.id);
            assert.equal(system.gearSlots.offHand, named("item", "Test Shield").id);
            assert.equal(system.gearSlots.torso, clothes.id);
            assert.equal(system.gearSlots.head, named("item", "Test Helmet").id);
            assert.deepEqual(system.accessories, [named("item", "Test Ring").id]);
            assert.equal(system.stats.dex.effective, 5, "Test Ring +1 DEX");
            const greatclub = named("item", "Test Greatclub");
            const hat = named("item", "Test Hat");
            assert.equal(greatclub.system.weaponSkill, "Test Greatclub");
            assert.isTrue(greatclub.system.twoHanded, "CrawlerForge's \"hands\" slot");
            assert.isFalse(greatclub.system.equipped, "two-handed, with both hands full");
            assert.isFalse(hat.system.equipped, "the head is taken");
            assert.notInclude(Object.values(system.gearSlots), greatclub.id);

            // The Hotlist: worn gear out, the potion and Heal in.
            const worn = [...Object.values(system.gearSlots), ...system.accessories].filter(Boolean);
            for (const id of system.hotlist) assert.notInclude(worn, id || "-");
            assert.include(system.hotlist, potion.id);
            assert.include(system.hotlist, heal.id);

            // One GM whisper summing it up.
            const reports = game.messages.filter((m) => m.getFlag("carl-rpg", "kind") === "crawlerforgeReport" && m.speaker?.actor === actor.id);
            assert.lengthOf(reports, 1);
            const [report] = reports;
            assert.sameMembers(report.whisper, game.users.filter((u) => u.isGM).map((u) => u.id));
            for (const text of ["Test Zap", "Test Pistol", "Test Class", "Test Greatclub", "Test Hat", "Plain Clothes", "Loose End Test", "Ring Club"]) {
              assert.include(report.content, text);
            }
            assert.notInclude(report.content, "I was abused by someone I trusted.", "a book table entry isn't reported");
          } finally {
            await deleteTestActor(actor);
            await deleteReports();
          }
        });

        it("hotlists the unworn one of two same-named items, and reports an Accessory worn elsewhere", async function () {
          const exported = testExport();
          // Only the crawler; then our own items and Hotlist.
          exported.events = exported.events.filter((e) => e.type === "crawler.created");
          const add = (type, payload, second) => exported.events.push({
            id: `test-event-extra-${second}`, type, occurredAt: `2026-11-18T07:32:${String(second).padStart(2, "0")}.000Z`, payload,
          });
          add("item.added", cfItem("Test Dagger", { id: "test-dagger-worn", slot: "hand", equipped: true }), 10);
          add("item.added", cfItem("Test Dagger", { id: "test-dagger-spare" }), 11);
          // A Gear compendium Torch is held, not an Accessory: it goes in a free hand.
          add("item.added", cfItem("Torch", { slot: "accessory", equipped: true }), 12);
          add("hotlist.set", { entries: ["Test Dagger"] }, 13);
          const actor = await importCrawlerForgeCrawler(exported);
          try {
            await settle(300);
            const daggers = actor.items.filter((i) => i.name === "Test Dagger");
            assert.lengthOf(daggers, 2);
            const worn = daggers.find((d) => d.getFlag("carl-rpg", "crawlerforge")?.id === "test-dagger-worn");
            const spare = daggers.find((d) => d.getFlag("carl-rpg", "crawlerforge")?.id === "test-dagger-spare");
            assert.equal(actor.system.gearSlots.mainHand, worn.id);
            assert.equal(actor.system.hotlist[0], spare.id, "the unworn Test Dagger is hotlisted");
            const torch = actor.items.find((i) => i.name === "Torch");
            assert.equal(actor.system.gearSlots.offHand, torch.id, "placed in the free hand");
            const [report] = game.messages.filter((m) => m.getFlag("carl-rpg", "kind") === "crawlerforgeReport" && m.speaker?.actor === actor.id);
            assert.include(report?.content ?? "", "Torch: worn in", "the move is reported");
          } finally {
            await deleteTestActor(actor);
            await deleteReports();
          }
        });
      });
    },
    { displayName: "CarlRPG: CrawlerForge Import" },
  );
}

/** The GM reports the imports above whispered. */
async function deleteReports() {
  const ids = game.messages.filter((m) => m.getFlag("carl-rpg", "kind") === "crawlerforgeReport").map((m) => m.id);
  if (ids.length) await ChatMessage.implementation.deleteDocuments(ids);
}
