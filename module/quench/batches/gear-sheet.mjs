import CarlDice from "../../dice/dice.mjs";
import { attackTargetEffects, debuffLandsOn } from "../../helpers/modifiers.mjs";
import { applyRow, buildAttackTargetsFooter } from "../../chat/attack-targets-card.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { placeInHotlist } from "../../helpers/hotlist.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  settle,
  useQuenchTimeout,
  waitFor,
  withFakeTargets,
  withPinnedDice,
  PIN_D20_MID,
} from "../helpers.mjs";

/**
 * Gear (docs/skill-item-sheets.md, phase 2): On-hit Debuffs on gear, held or
 * worn, optionally "Only with" listed Attack Skills; each target's own
 * Amazing Success; the Attack card naming each Debuff's source; and the
 * one-page gear sheet.
 */

const worldItem = (label, data = {}) =>
  Item.create({ name: `Quench ${label} ${foundry.utils.randomID()}`, type: "item", ...data });

async function openSheet(item) {
  const sheet = item.sheet;
  await sheet.render({ force: true });
  await waitFor(() => sheet.rendered);
  return sheet;
}

async function rerendered(sheet, check, message) {
  await waitFor(() => sheet.rendered && check(sheet.element), { message });
}

const entry = (te) => ({
  id: foundry.utils.randomID(),
  stacks: 1,
  critOnly: false,
  amazingSuccessOnly: false,
  label: "",
  skills: [],
  ...te,
});
const gearOf = (name, equipped, targetEffects) => ({
  type: "item",
  name,
  system: { equipped, targetEffects },
});
const skillOf = (name, targetEffects = []) => ({
  type: "skill",
  name,
  system: { rank: 1, targetEffects, upgrades: [] },
});

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.gear-sheet",
    (context) => {
      const { describe, it, assert } = context;

      describe("what an Attack carries", function () {
        it("held or worn gear's Debuffs come with any Attack; unequipped gear's don't", function () {
          const actor = {
            items: [
              gearOf("Smoking Ring", true, [entry({ debuffKey: "burned" })]),
              gearOf("Packed Ring", false, [entry({ debuffKey: "poisoned" })]),
            ],
          };
          const found = attackTargetEffects(actor, skillOf("Pugilism"), {
            isCrit: false,
            isAmazingSuccess: false,
          });
          assert.deepEqual(
            found.map((t) => t.debuffKey),
            ["burned"],
          );
          assert.equal(found[0].sourceLabel, "Smoking Ring");
        });

        it('"Only with" limits an entry to its listed Attack Skills, by name in any case', function () {
          const actor = {
            items: [
              gearOf("Blazing Longsword", true, [
                entry({ debuffKey: "burned", skills: ["longsword"] }),
              ]),
            ],
          };
          assert.lengthOf(
            attackTargetEffects(actor, skillOf("Longsword"), { isAmazingSuccess: false }),
            1,
          );
          assert.lengthOf(
            attackTargetEffects(actor, skillOf("Dagger"), { isAmazingSuccess: false }),
            0,
          );
        });

        it('"With any Hand-to-Hand Attack" fits any Skill with the Hand-to-Hand box, homebrew included - not a Longsword', function () {
          const actor = {
            items: [
              gearOf("Brass Knuckles", true, [entry({ debuffKey: "woozy", handToHandOnly: true })]),
            ],
          };
          const elbow = {
            ...skillOf("Flying Elbow"),
            system: { ...skillOf("Flying Elbow").system, isHandToHand: true },
          };
          assert.deepEqual(
            attackTargetEffects(actor, elbow, { isAmazingSuccess: false }).map((t) => t.debuffKey),
            ["woozy"],
            "a homebrew hand-to-hand Skill",
          );
          assert.lengthOf(
            attackTargetEffects(actor, skillOf("Longsword"), { isAmazingSuccess: false }),
            0,
            "a Weapon Skill",
          );
          assert.lengthOf(
            attackTargetEffects(actor, skillOf("Pugilism"), { isAmazingSuccess: false }),
            0,
            "a book name without the box doesn't count",
          );
          // With Skills named too, either fits.
          const both = {
            items: [
              gearOf("Spiked Club", true, [
                entry({ debuffKey: "woozy", handToHandOnly: true, skills: ["Club"] }),
              ]),
            ],
          };
          assert.lengthOf(
            attackTargetEffects(both, skillOf("Club"), { isAmazingSuccess: false }),
            1,
            "a listed Skill",
          );
          assert.lengthOf(
            attackTargetEffects(both, elbow, { isAmazingSuccess: false }),
            1,
            "any hand-to-hand one",
          );
          assert.lengthOf(
            attackTargetEffects(both, skillOf("Longsword"), { isAmazingSuccess: false }),
            0,
          );
        });

        it("the Skill's, its Damage Effect's and gear's together", function () {
          const actor = { items: [gearOf("Ring", true, [entry({ debuffKey: "burned" })])] };
          const found = attackTargetEffects(
            actor,
            skillOf("Pugilism", [entry({ debuffKey: "staggered" })]),
            {
              damageEffectItem: skillOf("Venom Strike", [entry({ debuffKey: "poisoned" })]),
              isAmazingSuccess: false,
            },
          );
          assert.deepEqual(
            found.map((t) => t.debuffKey),
            ["staggered", "poisoned", "burned"],
          );
        });

        it("an Amazing-Success-only entry: decided now, or kept for each target", function () {
          const actor = {
            items: [
              gearOf("Blade", true, [entry({ debuffKey: "burned", amazingSuccessOnly: true })]),
            ],
          };
          const skill = skillOf("Longsword");
          assert.lengthOf(attackTargetEffects(actor, skill, { isAmazingSuccess: false }), 0);
          assert.lengthOf(attackTargetEffects(actor, skill, { isAmazingSuccess: true }), 1);
          const kept = attackTargetEffects(actor, skill, { isAmazingSuccess: null });
          assert.lengthOf(kept, 1);
          assert.isTrue(kept[0].amazingSuccessOnly);
          assert.isTrue(debuffLandsOn(kept[0], { amazing: true }));
          assert.isFalse(debuffLandsOn(kept[0], { amazing: false }));
          assert.isTrue(debuffLandsOn({ amazingSuccessOnly: false }, { amazing: false }));
        });

        it("a Critical-Hit-only entry needs a natural 20", function () {
          const actor = {
            items: [gearOf("Blade", true, [entry({ debuffKey: "stunned", critOnly: true })])],
          };
          assert.lengthOf(
            attackTargetEffects(actor, skillOf("Longsword"), {
              isCrit: false,
              isAmazingSuccess: null,
            }),
            0,
          );
          assert.lengthOf(
            attackTargetEffects(actor, skillOf("Longsword"), {
              isCrit: true,
              isAmazingSuccess: null,
            }),
            1,
          );
        });
      });

      describe("on the Attack card", function () {
        useQuenchTimeout(this);

        it("an equipped item's Debuff rides a rolled Attack; an unequipped one's doesn't", async function () {
          const actor = await createTestCharacter("gear debuff");
          const target = await createTestMob("gear debuff target");
          try {
            const skill = await createTestItem(actor, "skill", "Gear Debuff Punch", {
              name: "Gear Debuff Punch",
              system: {
                category: "attack",
                isHandToHand: true,
                rank: 1,
                governingStat: "",
                baseDamage: { dice: "1d4", stat: "", damageType: "" },
              },
            });
            await createTestItem(actor, "item", "Smoking Ring", {
              name: "Smoking Ring",
              system: { equipped: true, targetEffects: [{ debuffKey: "burned" }] },
            });
            await createTestItem(actor, "item", "Packed Ring", {
              name: "Packed Ring",
              system: { equipped: false, targetEffects: [{ debuffKey: "poisoned" }] },
            });
            await createTestItem(actor, "item", "Dagger Charm", {
              name: "Dagger Charm",
              system: {
                equipped: true,
                targetEffects: [{ debuffKey: "staggered", skills: ["Dagger"] }],
              },
            });
            await settle();
            const message = await withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: target }], () =>
                CarlDice.rollAttack(actor, skill, { skipDialog: true }),
              ),
            );
            const effects = message.getFlag("carl-rpg", "targetEffects") ?? [];
            assert.deepEqual(
              effects.map((t) => t.debuffKey),
              ["burned"],
            );
            assert.equal(effects[0].sourceLabel, "Smoking Ring");
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(target);
          }
        });

        /** A Longsword Attack with a Blazing Longsword: in hand, or in the Hotlist. */
        async function weaponAttack(place) {
          const actor = await createTestCharacter(`weapon ${place}`);
          const target = await createTestMob(`weapon ${place} target`);
          try {
            const skill = await createTestItem(actor, "skill", "Longsword", {
              name: "Longsword",
              system: {
                category: "attack",
                rank: 1,
                governingStat: "",
                baseDamage: { dice: "1d4", stat: "", damageType: "" },
              },
            });
            const sword = await createTestItem(actor, "item", "Blazing Longsword", {
              name: "Blazing Longsword",
              system: {
                weaponSkill: "Longsword",
                targetEffects: [
                  { debuffKey: "burned", amazingSuccessOnly: true, skills: ["Longsword"] },
                ],
              },
            });
            if (place === "hand")
              await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, sword);
            else await placeInHotlist(actor, 0, sword);
            await settle();
            const message = await withPinnedDice(PIN_D20_MID, () =>
              withFakeTargets([{ actor: target }], () =>
                CarlDice.rollAttack(actor, skill, { skipDialog: true }),
              ),
            );
            assert.exists(message, "the Attack was made");
            assert.isTrue(actor.items.get(sword.id).system.equipped, "the sword is in hand");
            const effects = message.getFlag("carl-rpg", "targetEffects") ?? [];
            const burned = effects.find((t) => t.debuffKey === "burned");
            assert.exists(burned, "the sword's Debuff is on the card");
            assert.equal(burned.sourceLabel, "Blazing Longsword");
            assert.isTrue(burned.amazingSuccessOnly, "kept for each target to decide");
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(target);
          }
        }

        it("a weapon in hand gives its Debuff to an Attack with its Skill", async function () {
          await weaponAttack("hand");
        });

        it("a weapon drawn from the Hotlist for the Attack gives its Debuff too", async function () {
          await weaponAttack("hotlist");
        });

        it("each Debuff is named, with its source, and marked if only on an Amazing Success", function () {
          const html = buildAttackTargetsFooter({
            targetEffects: [
              {
                debuffKey: "burned",
                stacks: 1,
                label: "",
                sourceLabel: "Blazing Longsword",
                amazingSuccessOnly: true,
              },
            ],
          });
          const pill = new DOMParser()
            .parseFromString(html, "text/html")
            .querySelector(".carl-target-effect-pill");
          const text = pill.textContent;
          assert.include(
            text,
            game.i18n.localize(CONFIG.CARLRPG.debuffs.burned.label),
            "named, though its label is blank",
          );
          assert.include(text, "Blazing Longsword");
          assert.include(text, game.i18n.localize("CARLRPG.OnHitDebuff.OnAmazing"));
          assert.isFalse(pill.classList.contains("is-dim"));
        });

        it("dimmed when the Attack had targets and was an Amazing Success against none", function () {
          const te = {
            debuffKey: "burned",
            stacks: 1,
            label: "",
            sourceLabel: "Blade",
            amazingSuccessOnly: true,
          };
          const pill = (args) =>
            new DOMParser()
              .parseFromString(buildAttackTargetsFooter(args), "text/html")
              .querySelector(".carl-target-effect-pill");
          assert.isTrue(
            pill({ targetEffects: [te], noAmazing: true }).classList.contains("is-dim"),
          );
          assert.isFalse(
            pill({
              targetEffects: [{ ...te, amazingSuccessOnly: false }],
              noAmazing: true,
            }).classList.contains("is-dim"),
            "an any-hit Debuff isn't",
          );
        });

        it("an Amazing-Success-only Debuff lands only on targets the Attack Amazingly Succeeded against", async function () {
          const amazed = await createTestCharacter("amazed");
          const plain = await createTestCharacter("plain hit");
          let message;
          try {
            const rowFor = (id, actor, amazing) => ({
              id,
              uuid: actor.uuid,
              name: actor.name,
              isCharacter: true,
              zone: "full",
              difficulty: 13,
              hit: true,
              amazing,
              freeEvade: false,
              freeUsed: false,
              evade: null,
              applied: false,
              replaced: false,
            });
            message = await ChatMessage.create({
              content: '<div class="carl-chat-card"></div>',
              flags: {
                "carl-rpg": {
                  isArea: false,
                  floor: 1,
                  damageIsMagic: true,
                  damageByType: { fire: 1 },
                  targetEffects: [
                    {
                      id: "as",
                      debuffKey: "burned",
                      stacks: 1,
                      label: "",
                      sourceLabel: "Blade",
                      amazingSuccessOnly: true,
                    },
                    {
                      id: "any",
                      debuffKey: "staggered",
                      stacks: 1,
                      label: "",
                      sourceLabel: "Blade",
                      amazingSuccessOnly: false,
                    },
                  ],
                  targetUuids: [amazed.uuid, plain.uuid],
                  targetRows: { t0: rowFor("t0", amazed, true), t1: rowFor("t1", plain, false) },
                },
              },
            });
            const rows = () => message.getFlag("carl-rpg", "targetRows");
            await applyRow(message, rows().t0);
            await applyRow(message, rows().t1);
            await settle();
            const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);
            assert.includeMembers(keys(amazed), ["burned", "staggered"]);
            assert.include(keys(plain), "staggered");
            assert.notInclude(keys(plain), "burned");
          } finally {
            await message?.delete();
            await deleteTestActor(amazed);
            await deleteTestActor(plain);
          }
        });
      });

      describe("the gear sheet", function () {
        useQuenchTimeout(this);

        it("a Description being typed in has room, on gear, consumables and Spells (ruled 2026-11-21)", async function () {
          const potion = await worldItem("roomy potion", {
            system: { consumable: { kind: "potion", heal: { slots: 4 } } },
          });
          const spell = await Item.create({
            name: `Quench roomy spell ${foundry.utils.randomID()}`,
            type: "spell",
          });
          try {
            for (const item of [potion, spell]) {
              const sheet = await openSheet(item);
              const editor = sheet.element.querySelector(
                '.carl-item-page > prose-mirror[name="system.description"]',
              );
              assert.exists(editor, `${item.type}: its Description`);
              // Foundry marks an editor open for typing "active".
              editor.classList.add("active");
              assert.isAtLeast(
                parseFloat(getComputedStyle(editor).minHeight),
                200,
                `${item.type}: room while typing`,
              );
              editor.classList.remove("active");
              assert.isBelow(
                parseFloat(getComputedStyle(editor).minHeight),
                200,
                `${item.type}: compact while reading`,
              );
              await sheet.close();
            }
          } finally {
            await potion.delete();
            await spell.delete();
          }
        });

        it("one page: the Description first, then what it is; nothing optional until added", async function () {
          const item = await worldItem("plain");
          try {
            const sheet = await openSheet(item);
            const page = sheet.element.querySelector(".carl-single-page .carl-gear-sheet");
            assert.exists(page);
            assert.equal(page.firstElementChild.tagName, "PROSE-MIRROR");
            assert.notExists(page.querySelector(".carl-changes"));
            assert.notExists(page.querySelector(".carl-gear-debuffs"));
            assert.notExists(page.querySelector(".carl-consumable"));
            const adds = page.querySelectorAll(":scope > .carl-add-bar button");
            assert.lengthOf(adds, 3, "Bonuses, On-hit Debuffs, Consumable use");
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("the header's chips say what it is", async function () {
          const item = await worldItem("chips", {
            system: { weaponSkill: "Longsword", equipped: true, quantity: 2 },
          });
          try {
            const sheet = await openSheet(item);
            const chips = [...sheet.element.querySelectorAll(".sheet-header .carl-row-chip")].map(
              (c) => c.textContent.trim(),
            );
            assert.include(
              chips,
              game.i18n.format("CARLRPG.ItemSheet.WeaponChip", { skill: "Longsword" }),
            );
            assert.include(chips, game.i18n.localize("CARLRPG.Item.Equipped"));
            assert.include(chips, "×2");
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a gear Debuff's With any Hand-to-Hand Attack box is drawn ticked, and its row says so", async function () {
          const item = await worldItem("knuckles", {
            system: { targetEffects: [entry({ debuffKey: "woozy", handToHandOnly: true })] },
          });
          try {
            const sheet = await openSheet(item);
            await rerendered(
              sheet,
              (el) => el.querySelector(".carl-gear-debuffs .carl-target-effect-row"),
              "the section never drew",
            );
            const row = sheet.element.querySelector(".carl-gear-debuffs .carl-target-effect-row");
            const box = row.querySelector('input[name="system.targetEffects.0.handToHandOnly"]');
            assert.exists(box);
            assert.isTrue(box.checked);
            assert.include(
              row.querySelector("summary").textContent,
              game.i18n.localize("CARLRPG.OnHitDebuff.OnlyHandToHand"),
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a weapon's new Debuff starts Only with its Weapon Skill, on an Amazing Success", async function () {
          const item = await worldItem("weapon", { system: { weaponSkill: "Longsword" } });
          try {
            const sheet = await openSheet(item);
            sheet.element.querySelector('.carl-add-bar [data-path="system.targetEffects"]').click();
            await waitFor(() => item.system.targetEffects.length === 1, {
              message: "no Debuff added",
            });
            const te = item.system.targetEffects[0];
            assert.deepEqual(te.skills, ["Longsword"]);
            assert.isTrue(te.amazingSuccessOnly);
            await rerendered(
              sheet,
              (el) => el.querySelector(".carl-gear-debuffs .carl-target-effect-row"),
              "the section never drew",
            );
            const row = sheet.element.querySelector(".carl-gear-debuffs .carl-target-effect-row");
            assert.isTrue(row.open, "a new row opens");
            assert.equal(
              row.querySelector(".carl-row-chip").textContent.trim(),
              game.i18n.localize("CARLRPG.OnHitDebuff.Trigger.amazing"),
            );
            assert.lengthOf(row.querySelectorAll(".carl-only-with-pill"), 1);
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("Only with: a Skill typed in is added; a pill's × removes it; other edits keep them", async function () {
          const item = await worldItem("only with", {
            system: { targetEffects: [{ debuffKey: "burned", skills: ["Longsword"] }] },
          });
          try {
            const sheet = await openSheet(item);
            const add = sheet.element.querySelector("input.carl-only-with-add");
            add.value = "Dagger";
            add.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.targetEffects[0].skills.length === 2, {
              message: "the Skill was never added",
            });
            assert.deepEqual(item.system.targetEffects[0].skills, ["Longsword", "Dagger"]);

            await rerendered(
              sheet,
              (el) => el.querySelectorAll(".carl-only-with-pill").length === 2,
              "the pill never drew",
            );
            const label = sheet.element.querySelector('input[name="system.targetEffects.0.label"]');
            label.value = "Smoulders";
            label.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.targetEffects[0].label === "Smoulders", {
              message: "the edit never saved",
            });
            assert.deepEqual(
              item.system.targetEffects[0].skills,
              ["Longsword", "Dagger"],
              "kept through the edit",
            );

            await rerendered(
              sheet,
              (el) => el.querySelectorAll(".carl-only-with-pill").length === 2,
              "the pills are gone",
            );
            sheet.element
              .querySelector('.carl-only-with-pill [data-action="deleteArrayItem"]')
              .click();
            await waitFor(() => item.system.targetEffects[0].skills.length === 1, {
              message: "the Skill was never removed",
            });
            assert.deepEqual(item.system.targetEffects[0].skills, ["Dagger"]);
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("a consumable shows only the parts it uses; Cures are pills", async function () {
          const item = await worldItem("potion", {
            system: { consumable: { kind: "potion", heal: { slots: 4 } } },
          });
          try {
            const sheet = await openSheet(item);
            const section = () => sheet.element.querySelector(".carl-consumable");
            assert.exists(section(), "a Kind shows the section");
            assert.exists(section().querySelector(".carl-consumable-heal"));
            assert.notExists(section().querySelector(".carl-consumable-mana"));
            assert.notExists(section().querySelector(".carl-consumable-cures"));

            section().querySelector('[data-reveal="c-cures"]').click();
            await rerendered(
              sheet,
              () => section()?.querySelector(".carl-cure-picker"),
              "Cures never showed",
            );
            const picker = section().querySelector(".carl-cure-picker");
            picker.value = "poisoned";
            picker.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.system.consumable.cures.includes("poisoned"), {
              message: "the Cure was never added",
            });
            await rerendered(
              sheet,
              () => section()?.querySelector('[data-action="removeCure"][data-key="poisoned"]'),
              "no pill",
            );
            section().querySelector('[data-action="removeCure"][data-key="poisoned"]').click();
            await waitFor(() => !item.system.consumable.cures.length, {
              message: "the Cure was never removed",
            });
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it('"+ Consumable use" shows the section before a Kind is picked', async function () {
          const item = await worldItem("reveal");
          try {
            const sheet = await openSheet(item);
            sheet.element.querySelector('.carl-add-bar [data-reveal="consumable"]').click();
            await rerendered(
              sheet,
              (el) => el.querySelector(".carl-consumable"),
              "the section never showed",
            );
            await sheet.close();
          } finally {
            await item.delete();
          }
        });
      });
    },
    { displayName: "Carl RPG: Gear - On-hit Debuffs and the gear sheet" },
  );
}
