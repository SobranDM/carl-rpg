import { collectItemTargetEffects } from "../../helpers/modifiers.mjs";
import { changeSummary, debuffSummary, debuffTrigger } from "../../helpers/sheet-rows.mjs";
import { mergeSubmitted } from "../../helpers/form-arrays.mjs";
import { settle, useQuenchTimeout, waitFor } from "../helpers.mjs";

/**
 * Crawler Skills and the Skill sheet (docs/skill-item-sheets.md, phase 1):
 * On-hit Debuffs at any Rank, the compact Bonus / Debuff rows, and the
 * Skill / Spell / Damage Effect sheet's grouped Main tab, Upgrades overview
 * and Upgrade cards.
 */

const worldItem = (type, label, data = {}) =>
  Item.create({ name: `Quench ${label} ${foundry.utils.randomID()}`, type, ...data });

async function openSheet(item) {
  const sheet = item.sheet;
  await sheet.render({ force: true });
  await waitFor(() => sheet.rendered);
  return sheet;
}

/** Wait for the sheet to redraw after an update (its element is replaced part by part). */
async function rerendered(sheet, check, message) {
  await waitFor(() => sheet.rendered && check(sheet.element), { message });
}

const base = (te) => ({
  id: foundry.utils.randomID(),
  stacks: 1,
  critOnly: false,
  amazingSuccessOnly: false,
  label: "",
  ...te,
});

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.skill-sheet",
    (context) => {
      const { describe, it, assert } = context;

      describe("On-hit Debuffs at any Rank", function () {
        useQuenchTimeout(this);

        it("a base Debuff lands at Rank 0, named for the item alone", function () {
          const item = {
            name: "Iron Punch",
            system: { rank: 0, targetEffects: [base({ debuffKey: "poisoned" })], upgrades: [] },
          };
          const found = collectItemTargetEffects(item);
          assert.lengthOf(found, 1);
          assert.equal(found[0].debuffKey, "poisoned");
          assert.equal(found[0].sourceLabel, "Iron Punch");
        });

        it("base entries keep their Critical Hit / Amazing Success flags", function () {
          const item = {
            name: "Blade",
            system: {
              rank: 1,
              targetEffects: [
                base({ debuffKey: "stunned", critOnly: true }),
                base({ debuffKey: "burned", amazingSuccessOnly: true }),
              ],
              upgrades: [],
            },
          };
          assert.lengthOf(collectItemTargetEffects(item), 0);
          assert.deepEqual(
            collectItemTargetEffects(item, { isCrit: true }).map((t) => t.debuffKey),
            ["stunned"],
          );
          assert.deepEqual(
            collectItemTargetEffects(item, { isAmazingSuccess: true }).map((t) => t.debuffKey),
            ["burned"],
          );
        });

        it("base and unlocked tiers together; a locked tier still adds nothing", function () {
          const item = {
            name: "Blade",
            system: {
              rank: 7,
              targetEffects: [base({ debuffKey: "poisoned" })],
              upgrades: [
                { rankThreshold: 5, targetEffects: [base({ debuffKey: "staggered" })] },
                { rankThreshold: 10, targetEffects: [base({ debuffKey: "stunned" })] },
              ],
            },
          };
          const found = collectItemTargetEffects(item);
          assert.deepEqual(
            found.map((t) => t.debuffKey),
            ["poisoned", "staggered"],
          );
          assert.equal(found[1].sourceLabel, "Blade (Rank 5)");
        });

        it("a Skill's schema keeps a base Debuff list", async function () {
          const item = await worldItem("skill", "schema", {
            system: { targetEffects: [{ debuffKey: "poisoned" }] },
          });
          try {
            assert.lengthOf(item.system.targetEffects, 1);
            assert.equal(item.system.targetEffects[0].stacks, 1);
            assert.isString(item.system.targetEffects[0].id);
          } finally {
            await item.delete();
          }
        });
      });

      describe("compact row summaries", function () {
        it("a Bonus sums up what it touches and by how much", function () {
          const stat = changeSummary({
            targetType: "stat",
            target: "dex",
            mode: "add",
            value: "2",
            conditions: [],
          });
          assert.equal(stat.what, game.i18n.localize("CARLRPG.Stat.Dex.abbr"));
          assert.equal(stat.value, "+2");
          const resist = changeSummary({
            targetType: "resistance",
            target: "fire",
            mode: "override",
            value: "resist",
          });
          assert.equal(resist.value, game.i18n.localize("CARLRPG.Bonus.Resist.resist"));
          const gated = changeSummary({
            targetType: "skillRank",
            target: "Longsword",
            mode: "add",
            value: "1",
            levelGate: 3,
            conditions: [{ label: "Attacking from behind?" }],
          });
          assert.equal(gated.what, "Longsword");
          assert.isTrue(gated.notes.some((n) => n.includes("Attacking from behind?")));
          assert.isTrue(gated.notes.some((n) => n.includes("3")));
          assert.equal(
            changeSummary({ targetType: "stat", target: "", mode: "add", value: "1" }).what,
            game.i18n.localize("CARLRPG.Bonus.NotSet"),
          );
        });

        it('a Debuff\'s chip spells out when it lands, never "AS"', function () {
          assert.equal(
            debuffTrigger({}).label,
            game.i18n.localize("CARLRPG.OnHitDebuff.Trigger.hit"),
          );
          assert.equal(debuffTrigger({ critOnly: true }).label, "Critical Hit");
          assert.equal(debuffTrigger({ amazingSuccessOnly: true }).label, "Amazing Success");
          for (const te of [
            {},
            { critOnly: true },
            { amazingSuccessOnly: true },
            { critOnly: true, amazingSuccessOnly: true },
          ]) {
            assert.notMatch(debuffTrigger(te).label, /\bAS\b/);
          }
          const s = debuffSummary({ debuffKey: "burned", stacks: 3, label: "Smoulders" });
          assert.include(s.what, "×3");
          assert.include(s.notes, "Smoulders");
        });
      });

      describe("the Skill sheet", function () {
        useQuenchTimeout(this);

        it("the Main tab starts with the Description, then grouped sections", async function () {
          const item = await worldItem("skill", "main", {
            system: { category: "attack", rank: 7 },
          });
          try {
            const sheet = await openSheet(item);
            const page = sheet.element.querySelector('.tab[data-tab="main"] .carl-item-page');
            assert.exists(page);
            assert.equal(
              page.firstElementChild.tagName,
              "PROSE-MIRROR",
              "the Description comes first",
            );
            const titles = [
              ...page.querySelectorAll(":scope > .carl-item-group > .carl-item-group-title"),
            ].map((el) => el.firstChild.textContent.trim());
            const g = (k) => game.i18n.localize(`CARLRPG.ItemSheet.Group.${k}`);
            assert.deepEqual(titles, [
              g("About"),
              g("Advancement"),
              g("Rolling"),
              g("Bonuses"),
              g("Damage"),
              g("Debuffs"),
              g("Upgrades"),
            ]);
            assert.exists(page.querySelector(".carl-base-debuffs .carl-target-effects-editor"));
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a Utility Skill shows Healing and no Debuffs", async function () {
          const item = await worldItem("skill", "utility", { system: { category: "utility" } });
          try {
            const sheet = await openSheet(item);
            assert.exists(sheet.element.querySelector(".carl-base-heal"));
            assert.notExists(sheet.element.querySelector(".carl-base-debuffs"));
            assert.notExists(sheet.element.querySelector(".carl-base-damage"));
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("the header's chips sum the Skill up", async function () {
          const item = await worldItem("skill", "chips", {
            system: {
              category: "attack",
              attackType: "melee",
              rank: 7,
              governingStat: "dex",
              marked: true,
            },
          });
          try {
            const sheet = await openSheet(item);
            const chips = [...sheet.element.querySelectorAll(".sheet-header .carl-row-chip")].map(
              (c) => c.textContent.trim(),
            );
            assert.include(chips, game.i18n.localize("CARLRPG.SkillCategory.Attack"));
            assert.include(chips, game.i18n.format("CARLRPG.ItemSheet.RankChip", { n: 7 }));
            assert.include(chips, game.i18n.localize("CARLRPG.Stat.Dex.abbr"));
            assert.include(chips, game.i18n.localize("CARLRPG.Ranked.Marked"));
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("the Upgrades overview says what's unlocked and opens its tab", async function () {
          const item = await worldItem("skill", "overview", {
            system: {
              category: "attack",
              rank: 7,
              upgrades: [
                { rankThreshold: 5, description: "Swings land harder.\nMore text." },
                { rankThreshold: 10, description: "" },
              ],
            },
          });
          try {
            const sheet = await openSheet(item);
            const rows = [
              ...sheet.element.querySelectorAll(".carl-upgrades-overview .carl-tier-link"),
            ];
            assert.lengthOf(rows, 3);
            assert.equal(
              rows[0].querySelector(".carl-row-chip").dataset.tone,
              "good",
              "Rank 5 is unlocked at Rank 7",
            );
            assert.equal(
              rows[1].querySelector(".carl-row-chip").dataset.tone,
              "muted",
              "Rank 10 is locked",
            );
            assert.equal(
              rows[0].querySelector(".carl-tier-link-summary").textContent.trim(),
              "Swings land harder.",
            );
            assert.equal(
              rows[1].querySelector(".carl-tier-link-summary").textContent.trim(),
              game.i18n.localize("CARLRPG.ItemSheet.EmptyUpgrade"),
            );
            assert.equal(
              rows[2].querySelector(".carl-tier-link-summary").textContent.trim(),
              game.i18n.localize("CARLRPG.ItemSheet.NoUpgrade"),
            );
            // The tab bar's lock icons say the same.
            assert.exists(
              sheet.element.querySelector('nav.tabs [data-tab="rank5"] i.fa-lock-open'),
            );
            assert.exists(sheet.element.querySelector('nav.tabs [data-tab="rank10"] i.fa-lock'));
            rows[0].click();
            await waitFor(() => sheet.tabGroups.primary === "rank5", {
              message: "the row never opened its tab",
            });
            assert.isTrue(
              sheet.element.querySelector('.tab[data-tab="rank5"]').classList.contains("active"),
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("an Upgrade card shows only the parts it uses, with the rest in its add bar", async function () {
          const item = await worldItem("skill", "tier", {
            system: { category: "attack", rank: 2, upgrades: [{ rankThreshold: 5 }] },
          });
          try {
            const sheet = await openSheet(item);
            const card = () =>
              sheet.element.querySelector('.tab[data-tab="rank5"] .carl-tier-card');
            assert.exists(card());
            assert.equal(
              card().querySelector(".carl-row-chip").dataset.tone,
              "muted",
              "locked at Rank 2",
            );
            assert.notExists(card().querySelector(".carl-changes-editor"));
            assert.notExists(card().querySelector(".carl-target-effects-editor"));
            assert.notExists(card().querySelector(".carl-upgrade-heal"));
            assert.notExists(card().querySelector(".carl-upgrade-damage-split"));

            // + Bonus: a Bonus row appears, open to fill in.
            card().querySelector('.carl-add-bar [data-path$=".changes"]').click();
            await waitFor(() => item.system.upgrades[0].changes.length === 1, {
              message: "no Bonus added",
            });
            await rerendered(
              sheet,
              () => card()?.querySelector(".carl-change-row"),
              "the Bonus row never drew",
            );
            assert.isTrue(card().querySelector(".carl-change-row").open, "a new row opens");

            // + Healing: shown though empty.
            card().querySelector('.carl-add-bar [data-reveal^="heal-"]').click();
            await rerendered(
              sheet,
              () => card()?.querySelector(".carl-upgrade-heal"),
              "Healing never showed",
            );
            assert.notExists(
              card().querySelector('.carl-add-bar [data-reveal^="heal-"]'),
              "its add button goes",
            );

            // + Vehicle (a Skill's driving perks): shown though empty, saved.
            assert.notExists(card().querySelector(".carl-upgrade-vehicle"));
            card().querySelector('.carl-add-bar [data-reveal^="vehicle-"]').click();
            await rerendered(
              sheet,
              () => card()?.querySelector(".carl-upgrade-vehicle"),
              "Vehicle never showed",
            );
            assert.notExists(
              card().querySelector('.carl-add-bar [data-reveal^="vehicle-"]'),
              "its add button goes",
            );
            const attackOk = card().querySelector(
              '.carl-upgrade-vehicle input[name="system.upgrades.0.vehicleAttackOk"]',
            );
            attackOk.checked = true;
            attackOk.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.upgrades[0].vehicleAttackOk === true, {
              message: "the Vehicle box never saved",
            });

            // + Damage type: one blank pick, stored.
            card().querySelector('.carl-add-bar [data-action="addDamageType"]').click();
            await waitFor(() => item.system.upgrades[0].damageTypes.length === 1, {
              message: "no damage type added",
            });
            await rerendered(
              sheet,
              () => card()?.querySelector(".carl-upgrade-damage-split select"),
              "the damage type never drew",
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a Spell's Main tab sets its Shield slots, and its Upgrade card adds them from the add bar", async function () {
          const item = await worldItem("spell", "shield", {
            system: { rank: 2, isToggled: true, upgrades: [{ rankThreshold: 5 }] },
          });
          try {
            const sheet = await openSheet(item);
            const main = sheet.element.querySelector(
              '.tab[data-tab="main"] input[name="system.shieldSlots"]',
            );
            assert.exists(main, "Shield slots on the Main tab");
            main.value = "4";
            main.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.shieldSlots === 4, {
              message: "Shield slots never saved",
            });

            const card = () =>
              sheet.element.querySelector('.tab[data-tab="rank5"] .carl-tier-card');
            await rerendered(sheet, () => card(), "the Upgrade card never drew");
            assert.notExists(card().querySelector(".carl-upgrade-shield"), "not until added");
            card().querySelector('.carl-add-bar [data-reveal^="shield-"]').click();
            await rerendered(
              sheet,
              () => card()?.querySelector(".carl-upgrade-shield"),
              "Shield slots never showed",
            );
            const tier = card().querySelector(
              '.carl-upgrade-shield input[name="system.upgrades.0.shieldSlots"]',
            );
            tier.value = "6";
            tier.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.upgrades[0].shieldSlots === 6, {
              message: "the tier's Shield slots never saved",
            });
            await rerendered(
              sheet,
              () => card()?.querySelector(".carl-upgrade-shield"),
              "the part went after saving",
            );
            assert.notExists(
              card().querySelector('.carl-add-bar [data-reveal^="shield-"]'),
              "its add button goes",
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a Skill's Upgrade card offers no Shield slots; an Attack's offers Armor-Piercing", async function () {
          const item = await worldItem("skill", "ap", {
            system: { category: "attack", rank: 2, upgrades: [{ rankThreshold: 5 }] },
          });
          try {
            const sheet = await openSheet(item);
            const card = sheet.element.querySelector('.tab[data-tab="rank5"] .carl-tier-card');
            assert.notExists(card.querySelector('[data-reveal^="shield-"]'));
            assert.exists(card.querySelector('input[name="system.upgrades.0.armorPiercing"]'));
            assert.exists(
              sheet.element.querySelector('.carl-base-damage input[name="system.armorPiercing"]'),
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a healing Spell's Healing says who it heals", async function () {
          const item = await worldItem("spell", "heals", {
            system: { castingKeywords: ["heal"], range: "30 feet" },
          });
          try {
            const sheet = await openSheet(item);
            const select = sheet.element.querySelector(
              '.carl-base-heal select[name="system.heals"]',
            );
            assert.exists(select);
            assert.sameMembers(
              [...select.options].map((o) => o.value),
              ["", "self", "others", "pets", "anyone"],
            );
            assert.exists(
              sheet.element.querySelector('.carl-base-heal input[name="system.healToFull"]'),
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("an open row stays open through the re-render an edit causes", async function () {
          const item = await worldItem("skill", "open", {
            system: { category: "attack", targetEffects: [{ debuffKey: "poisoned" }] },
          });
          try {
            const sheet = await openSheet(item);
            const row = () =>
              sheet.element.querySelector(".carl-base-debuffs .carl-target-effect-row");
            assert.isFalse(row().open, "an existing row starts closed");
            row().open = true;
            await waitFor(() => row().open);
            await settle(); // the toggle event that records it
            const stacks = row().querySelector('input[name="system.targetEffects.0.stacks"]');
            stacks.value = "3";
            stacks.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.targetEffects[0].stacks === 3, {
              message: "the edit never saved",
            });
            await rerendered(
              sheet,
              () => row()?.querySelector(".carl-edit-row-what b")?.textContent.includes("×3"),
              "the summary never updated",
            );
            assert.isTrue(row().open, "still open");
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a row's id survives a sheet edit", async function () {
          const item = await worldItem("skill", "ids", {
            system: { category: "attack", targetEffects: [{ debuffKey: "poisoned" }] },
          });
          try {
            const id = item.system.targetEffects[0].id;
            const sheet = await openSheet(item);
            const label = sheet.element.querySelector('input[name="system.targetEffects.0.label"]');
            label.value = "Venom";
            label.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.targetEffects[0].label === "Venom", {
              message: "the edit never saved",
            });
            assert.equal(item.system.targetEffects[0].id, id);
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a Feature's Bonuses use the same compact rows, and an edit saves", async function () {
          const item = await worldItem("feature", "bonus rows", {
            system: { changes: [{ targetType: "stat", target: "dex", mode: "add", value: "1" }] },
          });
          try {
            const sheet = await openSheet(item);
            sheet.changeTab("attributes", "primary");
            const row = () => sheet.element.querySelector(".carl-changes-editor .carl-change-row");
            assert.exists(row());
            assert.equal(row().querySelector(".carl-edit-row-value").textContent.trim(), "+1");
            const value = row().querySelector('input[name="system.changes.0.value"]');
            value.value = "2";
            value.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.changes[0].value === "2", {
              message: "the edit never saved",
            });
            await rerendered(
              sheet,
              () => row()?.querySelector(".carl-edit-row-value")?.textContent.trim() === "+2",
              "the summary never updated",
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a Passive Spell's Main tab shows and edits its base Bonuses, and still has Healing", async function () {
          const item = await worldItem("spell", "passive bonus", {
            system: {
              castingKeywords: ["passive"],
              changes: [{ targetType: "resource", target: "dr", mode: "add", value: "2" }],
            },
          });
          try {
            const sheet = await openSheet(item);
            const bonuses = () =>
              sheet.element.querySelector('.tab[data-tab="main"] .carl-base-bonuses');
            const row = () => bonuses()?.querySelector(".carl-change-row");
            assert.exists(row(), "the +2 DR is shown");
            assert.equal(row().querySelector(".carl-edit-row-value").textContent.trim(), "+2");
            assert.exists(sheet.element.querySelector(".carl-base-heal"), "Healing stays");
            const value = row().querySelector('input[name="system.changes.0.value"]');
            value.value = "3";
            value.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.changes[0]?.value === "3", {
              message: "the edit never saved",
            });
            await rerendered(
              sheet,
              () => row()?.querySelector(".carl-edit-row-value")?.textContent.trim() === "+3",
              "the summary never updated",
            );
            assert.notExists(
              sheet.element.querySelector(".carl-damage-effect-bonus-hint"),
              "the Damage Effect hint is for Damage Effects",
            );
            // Its own Add link, for another Bonus.
            assert.exists(
              bonuses().querySelector('[data-action="addArrayItem"][data-path="system.changes"]'),
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a Damage Effect's Main tab says only a Bonus to its own damage counts", async function () {
          const item = await worldItem("damageEffect", "bonus hint");
          try {
            const sheet = await openSheet(item);
            assert.exists(
              sheet.element.querySelector(".carl-base-bonuses .carl-damage-effect-bonus-hint"),
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("the form merges what it submits onto the stored arrays", function () {
          const stored = {
            upgrades: [
              {
                id: "u1",
                description: "a",
                shieldSlots: 3,
                damageTypes: ["fire", ""],
                changes: [
                  { id: "c1", value: "1", conditions: [{ id: "k1", label: "x", default: false }] },
                ],
              },
            ],
            castingKeywords: ["attack", "area"],
          };
          const out = mergeSubmitted(stored, {
            upgrades: {
              0: {
                description: "A",
                damageTypes: { 0: "cold" },
                changes: { 0: { value: "2", conditions: { 0: { label: "y" } } } },
              },
            },
            castingKeywords: ["attack"],
          });
          const tier = out.upgrades[0];
          assert.equal(tier.description, "A");
          assert.equal(tier.shieldSlots, 3, "a field with no input is kept");
          assert.deepEqual(tier.damageTypes, ["cold", ""], "an entry not submitted is kept");
          assert.equal(tier.changes[0].value, "2");
          assert.equal(tier.changes[0].conditions[0].id, "k1", "nested entries keep theirs");
          assert.equal(tier.changes[0].conditions[0].label, "y");
          assert.deepEqual(out.castingKeywords, ["attack"], "a multi-select replaces its list");
        });

        it("editing an Upgrade keeps its Shield slots and its Bonus conditions' ids", async function () {
          const item = await worldItem("skill", "keeps", {
            system: {
              category: "attack",
              rank: 5,
              upgrades: [
                {
                  rankThreshold: 5,
                  description: "old",
                  shieldSlots: 3,
                  changes: [
                    {
                      targetType: "stat",
                      target: "dex",
                      mode: "add",
                      value: "1",
                      conditions: [{ label: "Flanking?" }],
                    },
                  ],
                },
              ],
            },
          });
          try {
            const conditionId = item.system.upgrades[0].changes[0].conditions[0].id;
            const sheet = await openSheet(item);
            const text = sheet.element.querySelector(
              'textarea[name="system.upgrades.0.description"]',
            );
            text.value = "new";
            text.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.upgrades[0].description === "new", {
              message: "the edit never saved",
            });
            assert.equal(item.system.upgrades[0].shieldSlots, 3, "Shield slots kept");
            assert.equal(
              item.system.upgrades[0].changes[0].conditions[0].id,
              conditionId,
              "condition id kept",
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("Spells and Damage Effects share the Main tab's sections", async function () {
          for (const type of ["spell", "damageEffect"]) {
            const item = await worldItem(type, `shared ${type}`);
            try {
              const sheet = await openSheet(item);
              const page = sheet.element.querySelector('.tab[data-tab="main"] .carl-item-page');
              assert.equal(
                page.firstElementChild.tagName,
                "PROSE-MIRROR",
                `${type}: the Description first`,
              );
              assert.exists(
                page.querySelector(".carl-upgrades-overview"),
                `${type}: the Upgrades overview`,
              );
              await sheet.close();
            } finally {
              await item.delete();
            }
          }
        });
      });
    },
    { displayName: "Carl RPG: Skills - On-hit Debuffs and the Skill sheet" },
  );
}
