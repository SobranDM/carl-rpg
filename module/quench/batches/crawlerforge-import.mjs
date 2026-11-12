import {
  buildCrawlerForgeActorData,
  foldCrawlerForgeEvents,
  importCrawlerForgeCrawler,
} from "../../helpers/crawlerforge-import.mjs";
import { deleteTestActor, settle, useQuenchTimeout } from "../helpers.mjs";

// Real CrawlerForge export (Marigold "Mags" Pruitt), including two retracted
// hotlist.set events - see module/helpers/crawlerforge-import.mjs.
const FIXTURE_PATH = "systems/carl-rpg/module/quench/fixtures/crawlerforge-mags.json";

async function loadFixture() {
  const response = await fetch(foundry.utils.getRoute(FIXTURE_PATH));
  return response.json();
}

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
        it("maps header, stats, story, and gear slots", async function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(await loadFixture()));
          const system = data.actor.system;
          assert.equal(data.actor.name, 'Marigold "Mags" Pruitt');
          assert.equal(system.attributes.level.value, 8);
          assert.equal(system.stats.dex.value, 6);
          assert.equal(system.bankedStatPoints, 3);
          assert.equal(system.details.crawlerNumber, "1204553");
          assert.equal(system.details.size, 2);
          assert.equal(system.gearSlots.mainHand, "Rebar Club");
          assert.equal(system.gearSlots.legs, "Duct Tape Greaves");
          assert.deepEqual(system.accessories, ["Gutter Ring"]);
          assert.include(system.story.looseEnds, "brass floor lamp");
        });

        it("pre-marks every Race/Class grant as baked", async function () {
          const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(await loadFixture()));
          for (const item of [data.race, data.class]) {
            const ids = item.system.changes.map((c) => c.id);
            assert.isNotEmpty(ids);
            assert.deepEqual(item.flags["carl-rpg"].bakedGrantIds, ids);
          }
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
            assert.lengthOf(skills, 5);
            assert.equal(skills.find((s) => s.name === "Scavenge").system.rank, 3);
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
            assert.equal(system.gearSlots.mainHand, gearItem("Rebar Club").id);
            assert.equal(system.gearSlots.legs, gearItem("Duct Tape Greaves").id);
            assert.deepEqual(system.accessories, [gearItem("Gutter Ring").id]);

            assert.equal(system.details.gold, 140);
            assert.notExists(actor.items.find((i) => i.name === "Gold"));
            assert.equal(
              actor.items.find((i) => i.name === "Emergency Biscuit")?.system.quantity,
              2,
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: CrawlerForge Import" },
  );
}
