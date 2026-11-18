/**
 * A Mob's Attacks as items (module/data/mob-attack.mjs, module/helpers/
 * mob-attacks.mjs; docs/mob-sheet.md): the item, the conversion of the old
 * printed-text list (at creation and by the 0.7.0 migration), Attacks by id
 * and by place, and the sheets.
 */
import CarlDice from "../../dice/dice.mjs";
import {
  attackKind, convertLegacyAttacks, mobAttackData, mobAttacksOf, resolveMobAttack,
} from "../../helpers/mob-attacks.mjs";
import { convertTokenAttacks } from "../../helpers/migration.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  settle,
  useQuenchTimeout,
  waitFor,
  withFakeTargets,
  withSetting,
} from "../helpers.mjs";

/** An old-style list, as Mobs carried before 0.7.0. */
const LIST = [
  { name: "Bite", toHit: "14+F", damage: "1d6+3", damageType: "piercing", range: "5ft range", effect: "On an Evade Major Fail or worse, the target is Poisoned." },
  { name: "Bile Spray", toHit: "12+F", damage: "2d6", damageType: "acid", range: "20ft Cone", effect: "" },
];

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.mob-attacks",
    (context) => {
      const { describe, it, assert, beforeEach, afterEach } = context;

      describe("The Mob Attack item", function () {
        useQuenchTimeout(this);
        let made = [];
        afterEach(async function () {
          for (const a of made) await deleteTestActor(a);
          made = [];
        });

        it("starts empty, with Debuffs that land on a hit unless told otherwise", async function () {
          const mob = await createTestMob("item-defaults");
          made.push(mob);
          const [item] = await mob.createEmbeddedDocuments("Item", [{ name: "Claw", type: "mobAttack" }]);
          assert.equal(item.system.toHit, "");
          assert.isFalse(item.system.isArea);
          await item.update({ "system.targetEffects": [{ debuffKey: "poisoned" }] });
          assert.equal(item.system.targetEffects[0].trigger, "hit");
          assert.equal(item.system.targetEffects[0].stacks, 1);
        });

        it("reads as a roll does: no Splash without Area, Debuffs without a key dropped", async function () {
          const mob = await createTestMob("item-data");
          made.push(mob);
          const [item] = await mob.createEmbeddedDocuments("Item", [{
            name: "Spit", type: "mobAttack",
            system: {
              toHit: "13+F", damage: "1d8+3", damageType: "fire", range: "30ft range", splash: true,
              description: "<p>The target is <strong>Burned</strong>.</p>",
              targetEffects: [{ debuffKey: "burned", trigger: "majorFail" }, { debuffKey: "" }],
            },
          }]);
          const data = mobAttackData(item);
          assert.isFalse(data.splash, "Splash only counts on an Area Attack");
          assert.equal(data.effect, "The target is Burned.", "the printed effect as text");
          assert.lengthOf(data.targetEffects, 1);
          assert.equal(data.targetEffects[0].trigger, "majorFail");
          assert.equal(data.targetEffects[0].sourceLabel, "Spit");
        });

        it("kinds: Area when marked, Melee within 5 ft, Ranged beyond", function () {
          assert.equal(attackKind({ range: "5ft range" }), "melee");
          assert.equal(attackKind({ range: "" }), "melee");
          assert.equal(attackKind({ range: "Melee" }), "melee");
          assert.equal(attackKind({ range: "10ft reach" }), "melee");
          assert.equal(attackKind({ range: "30ft range" }), "ranged");
          assert.equal(attackKind({ range: "10ft" }), "ranged");
          assert.equal(attackKind({ range: "20ft Cone", isArea: true }), "area");
        });
      });

      describe("Converting the old list", function () {
        useQuenchTimeout(this);
        let made = [];
        afterEach(async function () {
          for (const a of made) await deleteTestActor(a);
          made = [];
        });

        it("a Mob created with a list gets its Attacks as items, in order, and no list", async function () {
          const mob = await createTestMob("convert-create", { system: { attacks: LIST } });
          made.push(mob);
          const attacks = mobAttacksOf(mob);
          assert.deepEqual(attacks.map((a) => a.name), ["Bite", "Bile Spray"]);
          assert.lengthOf(mob.system.attacks, 0);
          assert.equal(attacks[0].system.toHit, "14+F");
          assert.equal(attacks[0].system.damageType, "piercing");
          assert.include(attacks[0].system.description, "Poisoned", "the effect is its description");
          assert.isFalse(attacks[0].system.isArea);
          assert.isTrue(attacks[1].system.isArea, "\"20ft Cone\" reads as an Area Attack");
          assert.equal(attacks[1].getFlag("carl-rpg", "legacyAttack"), 1);
        });

        it("converting again makes nothing twice", async function () {
          const mob = await createTestMob("convert-again");
          made.push(mob);
          // A list written after creation (as older data was).
          await mob.update({ "system.attacks": LIST });
          assert.equal(await convertLegacyAttacks(mob), 2);
          assert.lengthOf(mobAttacksOf(mob), 2);
          // Half done (the list put back), then run again: only what's missing.
          await mob.update({ "system.attacks": LIST });
          assert.equal(await convertLegacyAttacks(mob), 0);
          assert.lengthOf(mobAttacksOf(mob), 2);
          assert.lengthOf(mob.system.attacks, 0);
        });

        it("a token with its own list gets its own Attacks in place of its Mob's", async function () {
          // (The migration runs convertLegacyAttacks on each world Mob, then
          // this on each token - tested directly, so the test doesn't walk
          // the whole world.)
          const mob = await createTestMob("migrate", { system: { attacks: LIST } });
          made.push(mob);
          const scene = await Scene.create({ name: `Quench mob-attacks ${foundry.utils.randomID()}` });
          try {
            const [token] = await scene.createEmbeddedDocuments("Token", [{ actorId: mob.id, actorLink: false, name: "Ghoul 2" }]);
            assert.deepEqual(mobAttacksOf(token.actor).map((a) => a.name), ["Bite", "Bile Spray"], "inherited from its Mob");
            assert.equal(await convertTokenAttacks(token), 0, "no list of its own: nothing to do");

            await token.actor.update({ "system.attacks": [{ name: "Gnaw", toHit: "10", damage: "1d4", damageType: "", range: "", effect: "" }] });
            assert.equal(await convertTokenAttacks(token), 1);
            assert.deepEqual(mobAttacksOf(token.actor).map((a) => a.name), ["Gnaw"], "the token's own, in place of its Mob's");
            assert.lengthOf(token.actor.system.attacks, 0);
            assert.deepEqual(mobAttacksOf(mob).map((a) => a.name), ["Bite", "Bile Spray"], "the Mob is untouched");
          } finally {
            await scene.delete();
          }
        });
      });

      describe("Making an Attack, and the sheets", function () {
        useQuenchTimeout(this);
        let made = [];
        afterEach(async function () {
          for (const a of made) await deleteTestActor(a);
          made = [];
        });

        it("an Attack is found by its id or its place, and posts its card", async function () {
          const mob = await createTestMob("roll", { system: { attacks: LIST } });
          const pc = await createTestCharacter("roll-target");
          made.push(mob, pc);
          const bite = mobAttacksOf(mob)[0];
          assert.equal(resolveMobAttack(mob, bite.id), bite);
          assert.equal(resolveMobAttack(mob, 1), mobAttacksOf(mob)[1]);
          assert.isNull(resolveMobAttack(mob, "nope"));
          const card = await withFakeTargets([{ actor: pc }], () => CarlDice.rollMobAttack(mob, bite.id, { skipDialog: true }));
          assert.exists(card);
          assert.include(card.flavor || card.content, "Bite");
          assert.exists(card.getFlag("carl-rpg", "targetRows").t0, "a row for the target");
          await card.delete();
        });

        it("the Mob sheet lists its Attacks as rows with the Attack button", async function () {
          const mob = await createTestMob("sheet", { system: { attacks: LIST } });
          made.push(mob);
          await mob.sheet.render({ force: true });
          try {
            await waitFor(() => mob.sheet.element?.querySelector(".carl-mob-attack"), { message: "no Attack rows" });
            const rows = mob.sheet.element.querySelectorAll(".carl-mob-attack");
            assert.lengthOf(rows, 2);
            assert.equal(rows[0].dataset.itemId, mobAttacksOf(mob)[0].id);
            assert.exists(rows[0].querySelector('[data-action="rollMobAttack"] .fa-crosshairs'), "the crosshairs, not a d20");
            assert.equal(rows[1].querySelector(".carl-mob-attack-kind").dataset.kind, "area");
          } finally {
            await mob.sheet.close();
          }
        });

        it("the Mob Attack sheet is one page, with its Debuffs and description", async function () {
          const mob = await createTestMob("item-sheet", { system: { attacks: LIST } });
          made.push(mob);
          const bite = mobAttacksOf(mob)[0];
          await bite.sheet.render({ force: true });
          try {
            await waitFor(() => bite.sheet.element?.querySelector(".carl-mob-attack-sheet"), { message: "no Mob Attack sheet" });
            const el = bite.sheet.element;
            assert.notExists(el.querySelector("nav.tabs"), "no tabs");
            assert.isNotNull(el.querySelector(".carl-mob-attack-sheet").offsetParent, "the page is shown, not a hidden tab");
            assert.exists(el.querySelector('input[name="system.toHit"]'));
            assert.exists(el.querySelector('[data-path="system.targetEffects"]'), "the Debuff list");
            assert.exists(el.querySelector('prose-mirror[name="system.description"]'));
          } finally {
            await bite.sheet.close();
            await settle();
          }
        });
      });

      // docs/mob-sheet.md, phase 3: the Character sheet's shape.
      describe("The Mob sheet", function () {
        useQuenchTimeout(this);
        let mob;
        beforeEach(async function () {
          mob = await createTestMob("mob-sheet", { system: { attacks: LIST, level: 6 } });
        });
        afterEach(async function () {
          if (mob?.sheet?.rendered) await mob.sheet.close();
          await deleteTestActor(mob);
        });

        const open = async () => {
          const sheet = mob.sheet;
          await sheet.render({ force: true });
          await waitFor(() => sheet.rendered && sheet.element.querySelector(".carl-mob-defenses"), { message: "no Combat tab" });
          return sheet;
        };
        const rerendered = (sheet, check, message) => waitFor(() => sheet.rendered && check(sheet.element), { message });

        it("tabs: Combat, Inventory, Boons, Debuffs, Notes - no Skills tab", async function () {
          const sheet = await open();
          const labels = [...sheet.element.querySelectorAll("nav [data-tab]")].map((el) => el.textContent.trim());
          assert.deepEqual(labels, ["Combat", "Inventory", "Boons", "Debuffs", "Notes"].map((k) => game.i18n.localize(`CARLRPG.Tab.${k}`)));
        });

        it("the header: Level and Elite under the portrait; Tier, Size and Type by the name; no Floor or Actions", async function () {
          const sheet = await open();
          const header = sheet.element.querySelector(".sheet-header");
          const portrait = header.querySelector(".carl-portrait-column");
          assert.exists(portrait.querySelector('input[name="system.level"]'));
          assert.exists(portrait.querySelector('input[name="system.isElite"]'));
          for (const name of ["system.mobTier", "system.size", "system.creatureType"]) {
            assert.exists(header.querySelector(`.carl-name-row [name="${name}"]`), name);
          }
          assert.notExists(header.querySelector(".carl-floor-readonly"), "no Floor");
          assert.notExists(header.querySelector('[name="system.actionsPerRound"]'), "Actions moved to Defenses");
        });

        it("Defenses: Surprise and Evade as \"+F\" and today's value; DR, Move and Actions edit", async function () {
          await withSetting("currentFloor", 3, async () => {
            const sheet = await open();
            const defenses = sheet.element.querySelector(".carl-mob-defenses");
            const text = defenses.textContent.replace(/\s+/g, " ");
            assert.include(text, `${mob.system.surpriseBase}+F (${mob.system.surpriseBase + 3})`);
            assert.include(text, `${mob.system.evadeBase}+F (${mob.system.evadeBase + 3})`);
            assert.lengthOf(sheet.element.querySelectorAll('[name="system.dr"]'), 1, "one DR input on the sheet");

            const dr = defenses.querySelector('input[name="system.dr"]');
            dr.value = "4";
            dr.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => mob.system.dr === 4, { message: "DR never saved" });

            await rerendered(sheet, (el) => el.querySelector('.carl-mob-defenses input[name="system.actionsPerRound"]'), "no Actions");
            const actions = sheet.element.querySelector('.carl-mob-defenses input[name="system.actionsPerRound"]');
            actions.value = "3";
            actions.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => mob.system.actionsPerRound === 3, { message: "Actions never saved" });
          });
        });

        it("the Resistances button opens their grid to edit, and it stays open through an edit", async function () {
          const sheet = await open();
          assert.notExists(sheet.element.querySelector(".carl-mob-resistances"), "closed at first");
          sheet.element.querySelector('[data-action="toggleMobResistances"]').click();
          await rerendered(sheet, (el) => el.querySelector('.carl-mob-resistances select[name="system.resistances.fire"]'), "the grid never opened");
          const fire = sheet.element.querySelector('select[name="system.resistances.fire"]');
          fire.value = "resist";
          fire.dispatchEvent(new Event("change", { bubbles: true }));
          await waitFor(() => mob.system.resistances.fire === "resist", { message: "the Resistance never saved" });
          await rerendered(sheet, (el) => el.querySelector('select[name="system.resistances.fire"]')?.value === "resist", "the grid closed");
          sheet.element.querySelector('[data-action="toggleMobResistances"]').click();
          await rerendered(sheet, (el) => !el.querySelector(".carl-mob-resistances"), "the grid never closed");
        });

        it("Size is Table 9's value (p.92): old text is read as it, and the header picks it from a list", async function () {
          const Mob = CONFIG.Actor.dataModels.mob;
          const read = (size) => Mob.migrateData({ size }).size;
          assert.equal(read("Large (5)"), 5);
          assert.equal(read("huge"), 6);
          assert.equal(read("Small (2) to Huge (6)"), 2, "a range: its first");
          assert.isNull(read("Unchanged, but size changes when shifting"), "names none");
          assert.isNull(read(""));
          assert.equal(read(7), 7, "already a value");

          const old = await createTestMob("old-size", { system: { size: "Colossal (7)" } });
          try {
            assert.equal(old.system.size, 7, "a Mob made with text gets the value");
          } finally {
            await deleteTestActor(old);
          }

          const sheet = await open();
          const select = sheet.element.querySelector('.sheet-header select[name="system.size"]');
          assert.exists(select, "a dropdown");
          assert.lengthOf(select.options, Object.keys(CONFIG.CARLRPG.sizes).length + 1, "Table 9's eight, and none");
          select.value = "5";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await waitFor(() => mob.system.size === 5, { message: "Size never saved" });
        });

        it("no Evade roll; the Attacks' heading counts its Area ones; Spells and Mana on the Combat tab", async function () {
          const sheet = await open();
          assert.notExists(sheet.element.querySelector('[data-action="rollEvade"]'), "Mobs never roll (p.267)");
          assert.equal(sheet.element.querySelector(".carl-mob-attacks-count").textContent.trim(),
            game.i18n.format("CARLRPG.MobAttack.CountWithArea", { n: 2, area: 1 }));
          const combat = sheet.element.querySelector('section.tab[data-tab="abilities"]');
          assert.exists(combat.querySelector('[data-section-id="spells"]'), "a Spells section");
          assert.exists(combat.querySelector('input[name="system.mana.value"]'), "its Mana is edited there");
          assert.notExists(sheet.element.querySelector('section.tab[data-tab="skills"]'), "no Skills tab");
          assert.notExists(combat.querySelector(".carl-skills-list"), "no Skills section while it has none");
        });

        it("a Spell shows on the Combat tab; a Skill it owns anyway shows there too", async function () {
          const spell = await createTestItem(mob, "spell", "Bolt", { name: "Bolt", system: { rank: 1 } });
          const skill = await createTestItem(mob, "skill", "Sneak", { name: "Sneak" });
          const sheet = await open();
          const combat = sheet.element.querySelector('section.tab[data-tab="abilities"]');
          assert.exists(combat.querySelector(`[data-item-id="${spell.id}"]`), "the Spell");
          assert.exists(combat.querySelector(`[data-item-id="${skill.id}"]`), "the Skill isn't hidden");
        });
      });
    },
    { displayName: "CarlRPG: Mob Attacks as items" },
  );
}
