import { CarlRPGActorSheet } from "../../sheets/actor-sheet.mjs";
import { refreshTimedSheets } from "../../helpers/expiry.mjs";
import { BOON_HOURS, boonAvailable, deityTithe, describeDeity, receiveBoon } from "../../helpers/worship.mjs";
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

      describe("the clock redraws only the Conditions tab", function () {
        useQuenchTimeout(this);

        // The clock moves every combat round; a full render would throw away
        // text being typed elsewhere on the sheet.
        it("a sheet showing a timed entry redraws just its conditions part", async function () {
          const actor = await createTestCharacter();
          const sheet = actor.sheet;
          const calls = [];
          try {
            await actor.update({ "system.conditions": [{
              key: "custom", label: "Iron Skin", stacks: 1, remaining: null, source: "Iron Skin Potion",
              expiresAt: game.time.worldTime + 3600,
            }] });
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const render = sheet.render;
            sheet.render = function (options) {
              calls.push(options);
              return render.call(this, options);
            };
            refreshTimedSheets();
            assert.lengthOf(calls, 1);
            assert.deepEqual(calls[0]?.parts, ["conditions"]);
          } finally {
            delete sheet.render;
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

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
            // Enough rows (~31px each) that the Inventory tab overflows the 750px window.
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

      describe("Combat tab", function () {
        useQuenchTimeout(this);

        it("a Character opens on Combat: the Attack! button, Stats and the ten-slot Hotlist; Skills (and Spells) have their own tab", async function () {
          const actor = await createTestCharacter("combat tab");
          const sheet = actor.sheet;
          try {
            await createTestItem(actor, "skill", "sneak", { system: { category: "utility" } });
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const tabs = [...sheet.element.querySelectorAll("nav [data-tab]")].map((el) => el.dataset.tab);
            assert.deepEqual(tabs.slice(0, 3), ["abilities", "skills", "items"]);
            assert.include(sheet.element.querySelector('nav [data-tab="abilities"]').textContent, game.i18n.localize("CARLRPG.Tab.Combat"));
            const combat = sheet.element.querySelector('section.tab[data-tab="abilities"]');
            assert.exists(combat.querySelector(".carl-stats-column"));
            assert.equal(combat.querySelectorAll(".carl-hotlist-row").length, 10);
            const empties = combat.querySelectorAll('.carl-hotlist-row [data-action="pickHotlist"]');
            assert.lengthOf(empties, 10, "every empty slot is clickable");
            assert.include(empties[0].textContent, game.i18n.localize("CARLRPG.Hotlist.Empty"));
            const header = [...sheet.element.querySelectorAll(".carl-name-row .resource-label")].map((el) => el.textContent.trim());
            assert.deepEqual(header, [game.i18n.localize("CARLRPG.Actor.Race"), game.i18n.localize("CARLRPG.Actor.Class")], "Race before Class");
            assert.exists(combat.querySelector('.carl-stats-column [data-action="chooseAttack"]'), "the Attack! button");
            assert.notExists(combat.querySelector(".carl-combat-attacks"), "no Attacks list");
            const skillsTab = sheet.element.querySelector('section.tab[data-tab="skills"]');
            assert.exists(skillsTab.querySelector(".carl-skills-list"));
            assert.notExists(combat.querySelector(".carl-gear-grid"), "the Equipment Doll isn't on the Combat tab");
            assert.exists(sheet.element.querySelector('section.tab[data-tab="items"] .carl-gear-grid'), "it's on the Inventory tab");
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

      describe("Details tab", function () {
        useQuenchTimeout(this);

        it("a Character's Description slot is its Details tab: the Crawler section, Tier, Size and rich text boxes", async function () {
          const actor = await createTestCharacter("details", { system: { permanentPotions: { stat: 1, skill: 2 } } });
          const sheet = actor.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const nav = sheet.element.querySelector('nav [data-tab="description"]');
            assert.include(nav.textContent, game.i18n.localize("CARLRPG.Tab.Details"));
            const tab = sheet.element.querySelector('section.tab[data-tab="description"]');
            // Pronouns and Crawler# moved here from the header - one input each.
            // Pronouns, Crawler#, Size and Popularity moved here from the header - one input each.
            for (const name of ["system.details.pronouns", "system.details.crawlerNumber", "system.details.size", "system.details.popularity"]) {
              assert.exists(tab.querySelector(`.carl-crawler-box [name="${name}"]`), name);
              assert.lengthOf(sheet.element.querySelectorAll(`[name="${name}"]`), 1, `${name} only once on the sheet`);
            }
            const potions = tab.querySelector(".carl-potions-used");
            assert.exists(potions, "Potions used");
            if (game.user.isGM) {
              assert.equal(potions.querySelector('input[name="system.permanentPotions.stat"]').value, "1");
              assert.equal(potions.querySelector('input[name="system.permanentPotions.skill"]').value, "2");
            }
            assert.include(potions.querySelector(".carl-potions-heading").textContent, game.i18n.localize("CARLRPG.Actor.PotionsUsed"));
            const limits = [...potions.querySelectorAll("input.carl-potion-limit")];
            assert.lengthOf(limits, 2, "Stat and Skill, each out of its limit");
            assert.isTrue(limits.every((i) => i.disabled && i.value === "2"), "the limit can't be edited");
            assert.exists(tab.querySelector('input[name="system.personalSpace.tier"]'));
            assert.exists(tab.querySelector('input[name="system.personalSpace.size"]'));
            for (const name of ["personalSpace.notes", "sponsors", "clubs", "importantKills", "story", "biography"]) {
              assert.exists(tab.querySelector(`prose-mirror[name="system.${name}"]`), name);
            }
            assert.notExists(tab.querySelector('[name^="system.deity"]'), "the Deity is on the Benefits tab");
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

      describe("Character tabs, header and Defenses", function () {
        useQuenchTimeout(this);

        const openSheet = async (actor) => {
          const sheet = actor.sheet;
          await sheet.render({ force: true });
          await waitFor(() => sheet.rendered);
          return sheet;
        };

        it("a Character has no Defenses tab and its Boons tab is labelled Benefits; a Mob has Boons and no Defenses tab", async function () {
          const actor = await createTestCharacter("tabs");
          const mob = await createTestMob("tabs");
          try {
            const sheet = await openSheet(actor);
            const tabs = [...sheet.element.querySelectorAll("nav [data-tab]")].map((el) => el.dataset.tab);
            assert.notInclude(tabs, "defenses");
            assert.notExists(sheet.element.querySelector('section.tab[data-tab="defenses"]'));
            assert.include(sheet.element.querySelector('nav [data-tab="features"]').textContent, game.i18n.localize("CARLRPG.Tab.Benefits"));
            await sheet.close();

            // A Mob's tabs are the Character's (docs/mob-sheet.md): its DR and
            // Resistances are on the Combat tab, and it never rolls an Evade.
            const mobSheet = await openSheet(mob);
            const mobTabs = [...mobSheet.element.querySelectorAll("nav [data-tab]")].map((el) => el.dataset.tab);
            assert.deepEqual(mobTabs, ["abilities", "skills", "items", "features", "conditions", "description"]);
            assert.include(mobSheet.element.querySelector('nav [data-tab="features"]').textContent, game.i18n.localize("CARLRPG.Tab.Boons"));
            assert.exists(mobSheet.element.querySelector(".carl-mob-defenses"), "the Combat tab's Defenses");
            assert.notExists(mobSheet.element.querySelector('.carl-stats-column [data-action="rollEvade"]'), "no Evade roll");
            await mobSheet.close();
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(mob);
          }
        });

        it("Evade +N, DR, Move, Step and Resistances are a row above the Hotlist, not in the Stats column", async function () {
          const actor = await createTestCharacter("defenses", {
            system: { stats: { dex: { value: 14 } }, details: { move: 25, step: 5 } },
          });
          try {
            await createTestItem(actor, "race", "armored", { system: { changes: [{ targetType: "resource", target: "dr", mode: "add", value: "2" }] } });
            const sheet = await openSheet(actor);
            const combat = sheet.element.querySelector('section.tab[data-tab="abilities"]');
            const column = combat.querySelector(".carl-stats-column");
            const expected = actor.system.stats.dex.mod + (actor.system.bonuses?.evadeBonus ?? 0);
            assert.notExists(column.querySelector('[data-action="rollEvade"]'), "Evade left the Stats column");
            assert.notExists(column.querySelector('[name="system.dr"]'), "no longer in the Stats column");

            const row = combat.querySelector(".carl-abilities-main .carl-combat-defenses");
            assert.exists(row);
            const evade = row.querySelector('.carl-defenses-row > [data-action="rollEvade"]');
            assert.exists(evade);
            assert.strictEqual(row.querySelector(".carl-defenses-row").firstElementChild, evade, "Evade comes first");
            assert.equal(Number(evade.querySelector(".carl-evade-total").textContent.trim()), expected);
            assert.strictEqual(combat.querySelector(".carl-abilities-main").firstElementChild, row, "first in the main column");
            assert.isTrue(!!(row.compareDocumentPosition(combat.querySelector(".carl-hotlist")) & Node.DOCUMENT_POSITION_FOLLOWING), "above the Hotlist");
            assert.notExists(row.querySelector('input[name="system.dr"]'), "a crawler's base DR is locked at 0");
            assert.equal(row.querySelector(".carl-dr-value").textContent.trim(), "2", "DR from the Race only");
            assert.equal(row.querySelector('input[name="system.details.move"]').value, "25");
            assert.equal(row.querySelector('input[name="system.details.step"]').value, "5");
            assert.exists(row.querySelector('[data-action="showResistances"]'));
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the Resistances dialog lists each granted state and its source, read-only", async function () {
          const actor = await createTestCharacter("resist dialog");
          try {
            const charm = await createTestItem(actor, "feature", "fire charm", {
              system: { changes: [{ targetType: "resistance", target: "fire", mode: "add", value: "immune" }] },
            });
            const sheet = await openSheet(actor);
            assert.include(
              sheet.element.querySelector(".carl-resistances-summary").textContent,
              game.i18n.format("CARLRPG.Actor.ResistSummary.immune", { n: 1 }),
            );
            sheet.element.querySelector('[data-action="showResistances"]').click();
            let dialog;
            await waitFor(() => (dialog = document.querySelector(".carl-resistances-dialog")), { message: "dialog never opened" });
            assert.notExists(dialog.querySelector("select, input"), "nothing to edit");
            const rows = [...dialog.querySelectorAll(".carl-resistance-table tbody tr")];
            assert.lengthOf(rows, 1, "only the states that aren't None");
            assert.include(rows[0].textContent, game.i18n.localize(CONFIG.CARLRPG.damageTypes.fire));
            assert.include(rows[0].textContent, game.i18n.localize(CONFIG.CARLRPG.resistanceStates.immune));
            assert.include(rows[0].textContent, charm.name, "its source");
            assert.notExists(dialog.querySelector('button[data-action="save"]'));
            dialog.querySelector('button[data-action="close"]').click();
            await waitFor(() => !document.querySelector(".carl-resistances-dialog"), { message: "dialog never closed" });
            assert.equal(actor.system.resistances.fire, "none", "the base is untouched");
            await sheet.close();
          } finally {
            document.querySelector(".carl-resistances-dialog")?.remove();
            await deleteTestActor(actor);
          }
        });

        it("the header: Level then AI Favor under the portrait, Race, Class, HB and an editable Mana bar - no Floor", async function () {
          const actor = await createTestCharacter("header", { system: { attributes: { level: { value: 7 } }, details: { aiFavor: 2, gold: 40 } } });
          try {
            const sheet = await openSheet(actor);
            const header = sheet.element.querySelector(".sheet-header");
            const portrait = header.querySelector(".carl-portrait-column .carl-portrait-stats");
            const names = [...portrait.querySelectorAll("input")].map((el) => el.name);
            assert.deepEqual(names, ["system.attributes.level.value", "system.details.aiFavor"], "Level, then AI Favor");
            assert.equal(portrait.querySelector('[name="system.attributes.level.value"]').value, "7");

            const mana = header.querySelector(".carl-mana-resource");
            assert.exists(mana);
            assert.exists(mana.querySelector('input[name="system.mana.value"]'));
            assert.include(mana.textContent, `/ ${actor.system.mana.max}`);
            assert.lengthOf(sheet.element.querySelectorAll('[name="system.mana.value"]'), 1, "one Mana input on the form");

            for (const name of ["system.details.size", "system.details.popularity", "system.details.gold",
              "system.details.pronouns", "system.details.crawlerNumber"]) {
              assert.notExists(header.querySelector(`[name="${name}"]`), `${name} left the header`);
            }
            assert.notExists(header.querySelector("#carl-floor-display"), "no Floor");
            assert.notInclude(header.textContent, game.i18n.localize("CARLRPG.Actor.Floor"));
            assert.notExists(header.querySelector(".carl-details-row"), "the second header row is gone");
            for (const name of ["system.attributes.level.value", "system.details.aiFavor", "system.details.gold"]) {
              assert.lengthOf(sheet.element.querySelectorAll(`[name="${name}"]`), 1, `${name} only once on the sheet`);
            }

            const gold = sheet.element.querySelector('section.tab[data-tab="items"] .carl-inventory-bar input[name="system.details.gold"]');
            assert.exists(gold, "Gold is on the Inventory tab");
            assert.equal(gold.value, "40");
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the Spells section shows only when the crawler has a Spell", async function () {
          const actor = await createTestCharacter("no spells");
          try {
            const sheet = await openSheet(actor);
            const skillsTab = () => sheet.element.querySelector('section.tab[data-tab="skills"]');
            assert.notExists(skillsTab().querySelector('[data-section-id="spells"]'));
            assert.exists(skillsTab().querySelector('[data-section-id="skills"] .carl-drawer-add-spell[data-type="spell"]'), "+ Spell link");

            await createTestItem(actor, "spell", "magic missile");
            await waitFor(() => skillsTab()?.querySelector('[data-section-id="spells"]'), { message: "Spells section never appeared" });
            assert.notExists(skillsTab().querySelector(".carl-drawer-add-spell"));
            assert.notExists(skillsTab().querySelector('[data-section-id="spells"] input[name="system.mana.value"]'), "Mana is read-only there");
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Benefits tab", function () {
        useQuenchTimeout(this);

        it("shows the Race's benefits text, the Deity block and tiered benefits (unreached ones dimmed)", async function () {
          const actor = await createTestCharacter("benefits", {
            system: { deity: { name: "Apito", tier: "acolyte", worshipDays: 3, penitence: 1 } },
          });
          try {
            const race = await createTestItem(actor, "race", "elf", { system: { description: "<ul><li>Pointy ears</li></ul>" } });
            await actor.update({ "system.race": race.id });
            const acolyte = await createTestItem(actor, "feature", "acolyte perk", { system: { tier: "acolyte" } });
            const zealot = await createTestItem(actor, "feature", "zealot perk", { system: { tier: "zealot" } });
            const title = await createTestItem(actor, "feature", "title");
            const sheet = actor.sheet;
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const tab = sheet.element.querySelector('section.tab[data-tab="features"]');
            const panel = tab.querySelector(`.carl-benefit-panel[data-item-id="${race.id}"]`);
            assert.exists(panel);
            assert.include(panel.textContent, "Pointy ears");
            assert.exists(panel.querySelector(".carl-benefit-active"));

            const deity = tab.querySelector(".carl-deity");
            assert.equal(deity.querySelector('input[name="system.deity.name"]').value, "Apito");
            assert.equal(deityTithe(actor.system.deity), 10, "5% doubled by penance");
            assert.include(deity.querySelector(".carl-deity-tithe").textContent, "10%");
            assert.include(deity.querySelector(".carl-deity-next").textContent, "2");
            assert.exists(deity.querySelector(`.carl-deity-benefits [data-item-id="${acolyte.id}"]:not(.carl-benefit-unreached)`));
            assert.exists(deity.querySelector(`.carl-deity-benefits [data-item-id="${zealot.id}"].carl-benefit-unreached`));
            assert.exists(tab.querySelector(`.carl-perks [data-item-id="${title.id}"]`), "untiered features list below");
            assert.notExists(deity.querySelector(`[data-item-id="${title.id}"]`));
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Boon is due from the fifth day until received, and only with a Tier and worship not suspended", function () {
          const deity = (data) => ({ tier: "acolyte", worshipDays: 5, missedOfferings: 0, penitence: 0, shunned: false, fallen: false, ...data });
          assert.isTrue(describeDeity(deity({ worshipDays: 5 })).boonDue);
          assert.isTrue(describeDeity(deity({ worshipDays: 7 })).boonDue, "still due past five");
          assert.isFalse(describeDeity(deity({ worshipDays: 4 })).boonDue);
          assert.equal(describeDeity(deity({ worshipDays: 3 })).daysToNextBoon, 2);
          assert.isTrue(boonAvailable(deity()));
          assert.isFalse(boonAvailable(deity({ worshipDays: 4 })));
          assert.isFalse(boonAvailable(deity({ tier: "" })), "not worshipping");
          assert.isFalse(boonAvailable(deity({ fallen: true })));
          assert.isFalse(boonAvailable(deity({ missedOfferings: 1 })));
        });

        it("recording a missed offering breaks the streak; taking it back doesn't", async function () {
          const actor = await createTestCharacter("missed", { system: { deity: { name: "Apito", tier: "acolyte", worshipDays: 4 } } });
          const sheet = actor.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            sheet.changeTab("features", "primary");
            sheet.element.querySelector('.carl-missed-pip[data-value="1"]').click();
            await waitFor(() => actor.system.deity.missedOfferings === 1, { message: "miss never recorded" });
            assert.equal(actor.system.deity.worshipDays, 0);
            await actor.update({ "system.deity.worshipDays": 2 });
            await waitFor(() => sheet.element.querySelector('.carl-missed-pip[data-value="1"].filled'));
            sheet.element.querySelector('.carl-missed-pip[data-value="1"]').click();
            await waitFor(() => actor.system.deity.missedOfferings === 0, { message: "miss never taken back" });
            assert.equal(actor.system.deity.worshipDays, 2);
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("Receive a Boon adds a 30-hour Buff from the deity and takes five days off the count", async function () {
          const pack = game.packs.get(`${game.system.id}.roll-tables`);
          const index = await pack?.getIndex();
          if (!index?.find((e) => e.name === "Boons")) this.skip();
          const actor = await createTestCharacter("boon", { system: { deity: { name: "Apito", tier: "acolyte", worshipDays: 7 } } });
          const before = new Set(game.messages.map((m) => m.id));
          try {
            const result = await receiveBoon(actor);
            assert.exists(result);
            const buff = actor.system.conditions.find((c) => c.key === "custom" && c.source === "Apito");
            assert.exists(buff);
            assert.equal(buff.label, result.name);
            assert.approximately(buff.expiresAt, game.time.worldTime + BOON_HOURS * 3600, 1);
            assert.equal(actor.system.deity.worshipDays, 2, "days past five carry over");
          } finally {
            for (const message of game.messages.filter((m) => !before.has(m.id))) await message.delete();
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

        it("a sidebar Item dropped on a Hotlist slot lands in the Inventory, not the slot (click a slot to fill it)", async function () {
          const actor = await createTestCharacter("hotlist");
          const source = await worldItem("potion");
          try {
            const sheet = await openSheet(actor);
            const { dispatches, result } = await dropOn(sheet, hotlistSlot(sheet, 0), source.toDragData());
            assert.equal(dispatches, 1);
            assert.equal(actor.items.filter((i) => i.name === source.name).length, 1);
            assert.notInclude(actor.system.hotlist, result.id);
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await source.delete();
          }
        });

        it("dropping an owned Item on a Hotlist slot does nothing", async function () {
          const actor = await createTestCharacter("own slot");
          try {
            const item = await createTestItem(actor, "item", "owned");
            const sheet = await openSheet(actor);
            const { dispatches } = await dropOn(sheet, hotlistSlot(sheet, 1), item.toDragData());
            assert.equal(dispatches, 1);
            assert.equal(actor.items.size, 1, "no copy");
            assert.notInclude(actor.system.hotlist, item.id);
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
      describe("a cleared number input keeps the stored value", function () {
        useQuenchTimeout(this);

        // A blank Level used to save as 1, so typing 20 back banked 57 Stat
        // Points and wiped the grind hours (CarlRPGActor#_preUpdate).
        it("a blank Level keeps 20, and retyping 20 levels up nothing", async function () {
          const actor = await createTestCharacter("blank level", {
            system: { attributes: { level: { value: 20 } }, bankedStatPoints: 0, grindLevelHours: 5 },
          });
          const sheet = actor.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const level = () => sheet.element.querySelector('input[name="system.attributes.level.value"]');
            level().value = "";
            await sheet.submit();
            assert.equal(actor.system.attributes.level.value, 20, "the blank didn't save");
            assert.equal(level().value, "20", "the input shows the stored Level again");

            level().value = "20";
            await sheet.submit();
            assert.equal(actor.system.bankedStatPoints, 0, "no Stat Points banked");
            assert.equal(actor.system.grindLevelHours, 5, "the grind hours kept");

            level().value = "1";
            await sheet.submit();
            assert.equal(actor.system.attributes.level.value, 1, "typing 1 still saves 1");
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

      describe("the active Race and Class", function () {
        useQuenchTimeout(this);

        const openSheet = async (actor) => {
          const sheet = actor.sheet;
          await sheet.render({ force: true });
          await waitFor(() => sheet.rendered);
          return sheet;
        };
        const worldItem = (type, label) =>
          Item.create({ name: `Quench ${label} ${foundry.utils.randomID()}`, type });
        const active = (actor, key) => actor.items.get(actor.system[key])?.name;

        it("deleting the active Class clears it, and the next Class dropped is active", async function () {
          const actor = await createTestCharacter("class swap");
          const first = await worldItem("class", "first");
          const second = await worldItem("class", "second");
          try {
            const sheet = await openSheet(actor);
            await dropOn(sheet, sheet.element, first.toDragData());
            await waitFor(() => active(actor, "class") === first.name, { message: "the first Class never became active" });
            await actor.items.get(actor.system.class).delete();
            await waitFor(() => actor.system.class === "", { message: "the deleted Class stayed active" });
            await dropOn(sheet, sheet.element, second.toDragData());
            await waitFor(() => active(actor, "class") === second.name, { message: "the new Class never became active" });
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await first.delete();
            await second.delete();
          }
        });

        it("a Race id whose item is gone counts as none on a drop", async function () {
          const actor = await createTestCharacter("dangling race");
          const race = await worldItem("race", "dropped");
          try {
            await actor.update({ "system.race": foundry.utils.randomID() });
            const sheet = await openSheet(actor);
            await dropOn(sheet, sheet.element, race.toDragData());
            await waitFor(() => active(actor, "race") === race.name, { message: "the dropped Race never became active" });
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
            await race.delete();
          }
        });
      });

      describe("Skill and Spell drawers enrich their descriptions", function () {
        useQuenchTimeout(this);

        it("a Mob Skill's open drawer hides a GM Secret from a non-owner and draws an @UUID link", async function () {
          const mob = await createTestMob("drawer");
          const sheet = mob.sheet;
          let skill;
          try {
            skill = await createTestItem(mob, "skill", "drawer", {
              system: {
                detailsExpanded: true,
                description: `<p>Everyone sees this.</p><section class="secret" id="secret-quench"><p>GM only</p></section>`
                  + `<p>@UUID[${mob.uuid}]{The Mob}</p>`,
              },
            });
            const drawer = () => sheet.element
              .querySelector(`li.item[data-item-id="${skill.id}"] + li.carl-nested-drawer .carl-skill-description`);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.exists(drawer()?.querySelector("section.secret"), "the owner sees the Secret");
            assert.exists(drawer()?.querySelector("a.content-link"), "the link is drawn");

            Object.defineProperty(skill, "isOwner", { get: () => false, configurable: true });
            await sheet.render();
            assert.include(drawer()?.textContent ?? "", "Everyone sees this.");
            assert.notExists(drawer()?.querySelector("section.secret"), "no Secret for a non-owner");
            assert.notInclude(drawer()?.textContent ?? "", "GM only");
            assert.exists(drawer()?.querySelector("a.content-link"), "the link is drawn for a non-owner too");
            assert.notInclude(drawer()?.textContent ?? "", "@UUID");
          } finally {
            if (skill) delete skill.isOwner;
            await sheet.close();
            await deleteTestActor(mob);
          }
        });
      });
    },
    { displayName: "CarlRPG: Actor Sheet" },
  );
}
