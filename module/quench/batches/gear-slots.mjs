/**
 * Where gear is worn (docs/gear-slots.md; Gear Slots, p.98-99): the gear
 * helper (module/helpers/gear.mjs), the Equipment Doll's rules
 * (equip-slots.mjs), DR per slot type (p.225), the gear sheet's "Worn on",
 * and the 0.7.0 migration.
 */
import {
  fitsSlot, guessGearSlots, isShield, isTwoHanded, parseGearSlotLine, slotsFromName, slotsOf,
} from "../../helpers/gear.mjs";
import { assignItemToSlot, clearSlot } from "../../helpers/equip-slots.mjs";
import { placeInHotlist, swapForAttack } from "../../helpers/hotlist.mjs";
import { attackReadiness } from "../../helpers/weapons.mjs";
import { announceRemovedGear, gearSlotUpdate, inferActorGear, unequipMisfits, whisperUnplacedGear } from "../../helpers/migration.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestPet,
  deleteTestActor,
  dropOnSheet,
  makeDragEvent,
  settle,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

const change = (target, value) => ({ targetType: "resource", target, mode: "add", value: String(value) });
/** Gear with these slots (the test fixture's default is every slot). */
const gearOn = (actor, label, slots, system = {}) =>
  createTestItem(actor, "item", label, { name: label, system: { slots, ...system } });

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.gear-slots",
    (context) => {
      const { describe, it, assert } = context;

      describe("what gear is and where it goes", function () {
        it("its slots; a weapon is always Held; a consumable never worn", function () {
          const item = (system) => ({ type: "item", system: { slots: [], ...system } });
          assert.deepEqual(slotsOf(item({ slots: ["head"] })), ["head"]);
          assert.sameMembers(slotsOf(item({ slots: ["accessory"], weaponSkill: "Dagger" })), ["accessory", "held"]);
          assert.deepEqual(slotsOf(item({ slots: ["head"], consumable: { kind: "potion" } })), []);
          assert.deepEqual(slotsOf({ type: "skill", system: {} }), []);
          assert.isTrue(fitsSlot(item({ slots: ["held"] }), { slotType: "gear", slotKey: "offHand" }), "either hand");
          assert.isFalse(fitsSlot(item({ slots: ["head"] }), { slotType: "gear", slotKey: "feet" }));
          assert.isTrue(fitsSlot(item({ slots: ["head"] }), { slotType: "gear", slotKey: "mainHand" }), "anything can be held");
          assert.isTrue(fitsSlot(item({ slots: [] }), { slotType: "gear", slotKey: "offHand" }), "even with no slot");
          assert.isTrue(fitsSlot(item({ slots: ["accessory", "head"] }), { slotType: "accessory", slotKey: "3" }));
          assert.isTrue(isTwoHanded(item({ slots: ["held"], twoHanded: true })));
          assert.isFalse(isTwoHanded(item({ slots: ["torso"], twoHanded: true })), "only Held gear");
        });

        it("reads the book's \"Gear Slot:\" line", function () {
          assert.deepEqual(parseGearSlotLine("Head").slots, ["head"]);
          assert.sameMembers(parseGearSlotLine("Accessory or Head").slots, ["accessory", "head"]);
          assert.deepEqual(parseGearSlotLine("Hands/Holding").slots, ["held"]);
          const two = parseGearSlotLine("Hand/Holding (requires two hands)");
          assert.deepEqual(two.slots, ["held"]);
          assert.isTrue(two.twoHanded);
          assert.sameMembers(parseGearSlotLine("Any").slots, Object.keys(CONFIG.CARLRPG.wearSlots));
          assert.isNull(parseGearSlotLine("Whatever you like"));
        });

        it("guesses from a name's head noun", function () {
          assert.deepEqual(slotsFromName("Gauntlets of Ogre Power").slots, ["gloves"]);
          assert.deepEqual(slotsFromName("Boots of Speed").slots, ["feet"]);
          assert.deepEqual(slotsFromName("Ring Mail Shirt").slots, ["torso"]);
          const belt = slotsFromName("Leather Belt");
          assert.deepEqual(belt.slots, ["accessory"]);
          assert.equal(belt.accessoryKind, "belt");
          assert.equal(slotsFromName("Moth-Eaten Cloak").accessoryKind, "cape");
          assert.isNull(slotsFromName("Mysterious Thing"));
        });

        it("guesses in order: the \"Gear Slot:\" line, the name, a Weapon Skill, where it's worn", function () {
          const item = (name, system = {}) => ({ type: "item", name, system: { slots: [], description: "", ...system } });
          assert.equal(guessGearSlots(item("Fancy Hat", { description: "<p><strong>Gear Slot:</strong> Accessory</p>" })).from, "line");
          assert.deepEqual(guessGearSlots(item("Fancy Hat")).slots, ["head"]);
          assert.deepEqual(guessGearSlots(item("Old Thing", { weaponSkill: "Club" })).slots, ["held"]);
          assert.deepEqual(guessGearSlots(item("Old Thing"), { wornIn: "arms" }).slots, ["arms"]);
          assert.isNull(guessGearSlots(item("Old Thing")));
          assert.isTrue(guessGearSlots(item("Big Axe", { weaponSkill: "Axe", description: "<p>Limitation: Two-Handed</p>" })).twoHanded);
          assert.isNull(guessGearSlots(item("Potion of Hats", { consumable: { kind: "potion" } })), "consumables aren't worn");
        });
      });

      describe("the Equipment Doll", function () {
        useQuenchTimeout(this);

        it("refuses a slot the item isn't worn in, and gear with no slot", async function () {
          const actor = await createTestCharacter("doll fit");
          try {
            const helm = await gearOn(actor, "Iron Helm", ["head"]);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "feet" }, helm);
            assert.equal(actor.system.gearSlots.feet, "", "not on the feet");
            assert.isFalse(actor.items.get(helm.id).system.equipped);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            assert.equal(actor.system.gearSlots.head, helm.id);

            const thing = await gearOn(actor, "Thing", []);
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "0" }, thing);
            assert.notInclude(actor.system.accessories, thing.id);
            await thing.update({ "system.equipped": true });
            assert.isFalse(actor.items.get(thing.id).system.equipped, "the Equipped box refuses it too");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("anything can be held in a hand, but gives bonuses there only if it's Held", async function () {
          const actor = await createTestCharacter("held");
          try {
            const helm = await gearOn(actor, "Iron Helm", ["head"], { changes: [change("dr", 2)] });
            const rope = await gearOn(actor, "Rope", [], { changes: [change("dr", 1)] });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, helm);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, rope);
            assert.equal(actor.system.gearSlots.mainHand, helm.id, "a helmet can be held");
            assert.equal(actor.system.gearSlots.offHand, rope.id, "so can gear with no slot");
            assert.isTrue(actor.items.get(rope.id).system.equipped);
            assert.equal(actor.system.drEffective, 0, "but neither protects from a hand");

            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            assert.equal(actor.system.drEffective, 2, "worn on the head, it does");
            await rope.update({ "system.slots": ["held"] });
            assert.equal(actor.system.drEffective, 3, "marked Held, the rope's counts in a hand");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a two-handed item takes both hands, and comes off when a hand is used", async function () {
          const actor = await createTestCharacter("two hands");
          try {
            const shield = await gearOn(actor, "Buckler", ["held"]);
            const sword = await gearOn(actor, "Greatsword", ["held"], { twoHanded: true });
            const dagger = await gearOn(actor, "Dagger", ["held"]);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, shield);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, sword);
            assert.equal(actor.system.gearSlots.mainHand, sword.id);
            assert.equal(actor.system.gearSlots.offHand, sword.id, "both hands");
            assert.isFalse(actor.items.get(shield.id).system.equipped, "the shield came off");

            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, dagger);
            assert.equal(actor.system.gearSlots.offHand, dagger.id);
            assert.equal(actor.system.gearSlots.mainHand, "", "the two-handed one left both hands");
            assert.isFalse(actor.items.get(sword.id).system.equipped);

            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, sword);
            await clearSlot(actor, { slotType: "gear", slotKey: "offHand" });
            assert.equal(actor.system.gearSlots.mainHand, "", "clearing one hand frees both");
            assert.isFalse(actor.items.get(sword.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the Equipped box on a Character takes the first free slot, or is refused", async function () {
          const actor = await createTestCharacter("box");
          try {
            const helm = await gearOn(actor, "Iron Helm", ["head"]);
            const spare = await gearOn(actor, "Spare Helm", ["head"]);
            await helm.update({ "system.equipped": true });
            assert.equal(actor.system.gearSlots.head, helm.id, "in its slot");
            await spare.update({ "system.equipped": true });
            assert.isFalse(actor.items.get(spare.id).system.equipped, "no second helmet");
            assert.equal(actor.system.gearSlots.head, helm.id);

            await helm.update({ "system.equipped": false });
            assert.equal(actor.system.gearSlots.head, "", "unticked: out of its slot");

            const sword = await gearOn(actor, "Greatsword", ["held"], { twoHanded: true });
            const torch = await gearOn(actor, "Torch", ["held"]);
            await torch.update({ "system.equipped": true });
            assert.equal(actor.system.gearSlots.mainHand, torch.id);
            await sword.update({ "system.equipped": true });
            assert.isFalse(actor.items.get(sword.id).system.equipped, "two-handed needs both hands free");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a slot holding a deleted item's id counts as free", async function () {
          const actor = await createTestCharacter("dangling");
          try {
            const helm = await gearOn(actor, "Iron Helm", ["head"]);
            await actor.update({ "system.gearSlots.head": "abcdefghijklmnop" });
            await helm.update({ "system.equipped": true });
            assert.equal(actor.system.gearSlots.head, helm.id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("changing where worn gear goes takes it off what it no longer fits", async function () {
          const actor = await createTestCharacter("refit");
          try {
            const helm = await gearOn(actor, "Iron Helm", ["head"]);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            await helm.update({ "system.slots": ["torso"] });
            assert.equal(actor.system.gearSlots.head, "", "off the head");
            assert.isFalse(actor.items.get(helm.id).system.equipped);

            const shield = await gearOn(actor, "Buckler", ["held"]);
            const sword = await gearOn(actor, "Longsword", ["held"]);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, shield);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, sword);
            await sword.update({ "system.twoHanded": true });
            assert.equal(actor.system.gearSlots.mainHand, "", "two-handed with the other hand full: off");
            assert.equal(actor.system.gearSlots.offHand, shield.id);
            assert.isFalse(actor.items.get(sword.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a consumable is never equipped", async function () {
          const actor = await createTestCharacter("potion");
          try {
            const potion = await createTestItem(actor, "item", "Potion", { system: { consumable: { kind: "potion" } } });
            await potion.update({ "system.equipped": true });
            assert.isFalse(actor.items.get(potion.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a potion dropped on the Main Hand is refused and stays in the Hotlist", async function () {
          const actor = await createTestCharacter("potion hand");
          try {
            const potion = await createTestItem(actor, "item", "Potion", { system: { consumable: { kind: "potion" } } });
            assert.isFalse(fitsSlot(potion, { slotType: "gear", slotKey: "mainHand" }), "not even in a hand");
            await placeInHotlist(actor, 0, potion);
            assert.equal(actor.system.hotlist[0], potion.id, "test setup: in the Hotlist");
            const sheet = actor.sheet;
            await sheet.render({ force: true });
            const hand = () => sheet.element?.querySelector('.carl-equip-panel [data-slot-type="gear"][data-slot-key="mainHand"]');
            await waitFor(hand, { message: "no Main Hand slot" });
            await dropOnSheet(sheet, hand(), potion.toDragData());
            assert.equal(actor.system.gearSlots.mainHand, "", "not in the hand");
            assert.isFalse(actor.items.get(potion.id).system.equipped);
            assert.equal(actor.system.hotlist[0], potion.id, "still in the Hotlist");
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("equipped gear dragged from another actor arrives unequipped, and gives nothing", async function () {
          const giver = await createTestCharacter("helm giver");
          const taker = await createTestCharacter("helm taker");
          try {
            const theirs = await gearOn(giver, "Great Helm", ["head"], { changes: [change("dr", 3)] });
            await assignItemToSlot(giver, { slotType: "gear", slotKey: "head" }, theirs);
            assert.isTrue(giver.items.get(theirs.id).system.equipped, "test setup: worn by the giver");
            const mine = await gearOn(taker, "Iron Helm", ["head"], { changes: [change("dr", 1)] });
            await assignItemToSlot(taker, { slotType: "gear", slotKey: "head" }, mine);
            assert.equal(taker.system.drEffective, 1, "test setup");
            const sheet = taker.sheet;
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            await dropOnSheet(sheet, sheet.element, giver.items.get(theirs.id).toDragData());
            const copy = taker.items.find((i) => i.name === "Great Helm");
            assert.exists(copy, "the copy arrived");
            assert.isFalse(copy.system.equipped, "in no slot: not equipped");
            assert.equal(taker.system.gearSlots.head, mine.id, "the doll still shows the taker's own");
            assert.equal(taker.system.drEffective, 1, "only the helmet on the head counts");
            await sheet.close();
          } finally {
            await deleteTestActor(giver);
            await deleteTestActor(taker);
          }
        });

        it("a two-handed weapon about to be drawn empties the Off Hand for the Attack choice", async function () {
          const actor = await createTestCharacter("readiness");
          try {
            const knives = await createTestItem(actor, "skill", "Knives", { name: "Knives", system: { category: "attack", rank: 1 } });
            const dagger = await gearOn(actor, "Dagger", ["held"], { weaponSkill: "Knives" });
            const sword = await gearOn(actor, "Greatsword", ["held"], { twoHanded: true, weaponSkill: "Longsword" });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, dagger);
            assert.isTrue(attackReadiness(actor, knives).ready, "the dagger's in hand");
            assert.isFalse(attackReadiness(actor, knives, { mainHand: sword }).ready, "not once the greatsword takes both hands");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Pet's Equipped box still just equips (it has no doll)", async function () {
          const pet = await createTestPet("box pet");
          try {
            const collar = await gearOn(pet, "Collar", ["head"]);
            await collar.update({ "system.equipped": true });
            assert.isTrue(pet.items.get(collar.id).system.equipped);
          } finally {
            await deleteTestActor(pet);
          }
        });

        it("a cancelled two-handed Hotlist swap gives the Off Hand back", async function () {
          const actor = await createTestCharacter("swap back");
          try {
            const shield = await gearOn(actor, "Buckler", ["held"]);
            const sword = await gearOn(actor, "Greatsword", ["held"], { twoHanded: true, weaponSkill: "Longsword" });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, shield);
            await placeInHotlist(actor, 0, sword);
            const result = await swapForAttack(actor, { index: 0, item: sword }, async () => null);
            assert.isNull(result, "the Attack was cancelled");
            assert.equal(actor.system.gearSlots.offHand, shield.id, "the shield is back");
            assert.isTrue(actor.items.get(shield.id).system.equipped);
            assert.equal(actor.system.gearSlots.mainHand, "");
            assert.equal(actor.system.hotlist[0], sword.id, "the sword is back in the Hotlist");
            assert.isFalse(actor.items.get(sword.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("one Belt and one Cape at most; replacing the Belt in its slot is fine", async function () {
          const actor = await createTestCharacter("belts");
          try {
            const belt = await gearOn(actor, "Belt A", ["accessory"], { accessoryKind: "belt" });
            const belt2 = await gearOn(actor, "Belt B", ["accessory"], { accessoryKind: "belt" });
            const cape = await gearOn(actor, "Cape", ["accessory"], { accessoryKind: "cape" });
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "0" }, belt);
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "1" }, belt2);
            assert.notInclude(actor.system.accessories, belt2.id, "a second Belt is refused");
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "1" }, cape);
            assert.include(actor.system.accessories, cape.id, "a Cape is fine");
            await assignItemToSlot(actor, { slotType: "accessory", slotKey: "0" }, belt2);
            assert.include(actor.system.accessories, belt2.id, "in the first Belt's own slot");
            assert.notInclude(actor.system.accessories, belt.id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("both hands are one slot type for DR: two shields, the better counts", async function () {
          const actor = await createTestCharacter("shields");
          try {
            const a = await gearOn(actor, "Big Shield", ["held"], { changes: [change("dr", 2)] });
            const b = await gearOn(actor, "Small Shield", ["held"], { changes: [change("dr", 1)] });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, a);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, b);
            assert.equal(actor.system.drEffective, 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("dragging gear lights the slots it fits", async function () {
          const actor = await createTestCharacter("drag");
          try {
            const boots = await gearOn(actor, "Boots", ["feet"]);
            const sheet = actor.sheet;
            await sheet.render({ force: true });
            await waitFor(() => sheet.element?.querySelector(`.carl-equip-panel`) && sheet.element.querySelector(`[data-item-id="${boots.id}"]`),
              { message: "no doll or row" });
            const row = sheet.element.querySelector(`section[data-tab="items"] [data-item-id="${boots.id}"]`)
              ?? sheet.element.querySelector(`[data-item-id="${boots.id}"]`);
            row.dispatchEvent(makeDragEvent("dragstart"));
            const panel = sheet.element.querySelector(".carl-equip-panel");
            assert.isTrue(panel.classList.contains("is-dragging"));
            assert.isTrue(panel.querySelector('[data-slot-type="gear"][data-slot-key="feet"]').classList.contains("is-fit"));
            assert.isFalse(panel.querySelector('[data-slot-type="gear"][data-slot-key="head"]').classList.contains("is-fit"));
            assert.isTrue(panel.querySelector('[data-slot-type="gear"][data-slot-key="mainHand"]').classList.contains("is-fit"), "a hand holds anything");
            document.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
            assert.isFalse(panel.classList.contains("is-dragging"), "cleared when the drag ends");
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("the gear sheet's Worn on", function () {
        useQuenchTimeout(this);

        it("pills set the slots; Held shows Two-handed; a weapon is always Held", async function () {
          const item = await Item.create({ name: `Quench worn ${foundry.utils.randomID()}`, type: "item" });
          try {
            const sheet = item.sheet;
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered && sheet.element.querySelector(".carl-worn-on"), { message: "no Worn on" });
            assert.exists(sheet.element.querySelector(".carl-worn-on .carl-hint"), "says it can't be worn yet");
            sheet.element.querySelector('[data-action="toggleWornSlot"][data-slot="held"]').click();
            await waitFor(() => item.system.slots.includes("held"), { message: "Held never set" });
            await waitFor(() => sheet.element.querySelector('input[name="system.twoHanded"]'), { message: "no Two-handed" });

            await item.update({ "system.weaponSkill": "Club", "system.slots": [] });
            await waitFor(() => sheet.element.querySelector('[data-slot="held"]')?.disabled, { message: "Held isn't locked on" });
            assert.isTrue(sheet.element.querySelector('[data-slot="held"]').classList.contains("is-on"));
            await sheet.close();
          } finally {
            await item.delete();
          }
        });
      });

      describe("the 0.7.0 gear slots migration", function () {
        useQuenchTimeout(this);

        it("guesses slots first, then takes off what doesn't fit", async function () {
          const actor = await createTestCharacter("migrate gear");
          try {
            const gauntlets = await gearOn(actor, "Iron Gauntlets", [], { equipped: true });
            const trinket = await gearOn(actor, "Odd Trinket", [], { equipped: true });
            const mystery = await gearOn(actor, "Mystery Box", [], { equipped: true });
            const torch = await gearOn(actor, "Lit Torch", [], { equipped: true });
            const club = await gearOn(actor, "Old Club", [], { equipped: true, weaponSkill: "Club" });
            // Worn as before 0.7.0: anything anywhere.
            await actor.update({
              "system.gearSlots.head": gauntlets.id,
              "system.gearSlots.mainHand": club.id,
              "system.gearSlots.offHand": torch.id,
              "system.accessories": [trinket.id],
            });

            const first = await inferActorGear(actor);
            assert.deepEqual(actor.items.get(gauntlets.id).system.slots, ["gloves"], "by name");
            assert.deepEqual(actor.items.get(trinket.id).system.slots, ["accessory"], "where it's worn");
            assert.deepEqual(actor.items.get(club.id).system.slots, ["held"], "a weapon");
            assert.include(first.unplaced.map((i) => i.name), mystery.name, "nothing tells");

            const off = await unequipMisfits(actor);
            assert.sameMembers(off, [gauntlets.name, mystery.name]);
            assert.equal(actor.system.gearSlots.head, "", "gauntlets off the head");
            assert.isFalse(actor.items.get(gauntlets.id).system.equipped);
            assert.isFalse(actor.items.get(mystery.id).system.equipped, "no slot: off");
            assert.include(actor.system.accessories, trinket.id, "the trinket stays");
            assert.equal(actor.system.gearSlots.mainHand, club.id, "the club stays");
            assert.isTrue(actor.items.get(club.id).system.equipped);
            assert.equal(actor.system.gearSlots.offHand, torch.id, "anything held stays held");
            assert.isTrue(actor.items.get(torch.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the removed-gear card names each creature and its gear, by type, to the GM", async function () {
          const message = await announceRemovedGear([
            { type: "character", name: "Carl", items: ["Iron Gauntlets"] },
            { type: "mob", name: "Ghoul", items: ["Rusty Helm", "Boots"] },
          ]);
          try {
            const text = message.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
            for (const name of ["Carl", "Iron Gauntlets", "Ghoul", "Rusty Helm", "Boots",
              game.i18n.localize("TYPES.Actor.character"), game.i18n.localize("TYPES.Actor.mob")]) {
              assert.include(text, name);
            }
            assert.isTrue(message.whisper.length > 0, "whispered to the GM");
          } finally {
            await message.delete();
          }
        });

        it("the GM's list names each item with no slot and who has it", async function () {
          const message = await whisperUnplacedGear(new Map([
            ["Carl", [{ name: "Snack Bar", takenOff: false }, { name: "Mystery Box", takenOff: true }]],
            ["Items directory", [{ name: "Odd Rock", takenOff: false }]],
          ]));
          try {
            const text = message.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
            for (const name of ["Carl", "Snack Bar", "Mystery Box", "Items directory", "Odd Rock"]) assert.include(text, name);
            assert.include(text, `Mystery Box (${game.i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.TakenOff")})`);
            assert.notInclude(text, `Snack Bar (${game.i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.TakenOff")})`);
            assert.isTrue(message.whisper.length > 0, "the GM's");
          } finally {
            await message.delete();
          }
        });

        it("a Character's gear equipped without a doll slot goes in a free one, or comes off", async function () {
          const actor = await createTestCharacter("migrate box");
          try {
            const helm = await gearOn(actor, "Iron Helm", ["head"]);
            const hat = await gearOn(actor, "Silly Hat", ["head"], { equipped: true });
            const boots = await gearOn(actor, "Boots", ["feet"], { equipped: true });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            const off = await unequipMisfits(actor);
            assert.deepEqual(off, [hat.name], "Head was taken");
            assert.isFalse(actor.items.get(hat.id).system.equipped);
            assert.equal(actor.system.gearSlots.feet, boots.id, "the boots went on the feet");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a \"Gear Slot:\" line wins over the name", async function () {
          const actor = await createTestCharacter("migrate line");
          try {
            const hat = await gearOn(actor, "Fancy Hat", [], { description: "<p><strong>Gear Slot:</strong> Accessory or Head</p>" });
            const update = gearSlotUpdate(hat);
            assert.sameMembers(update["system.slots"], ["accessory", "head"]);
            assert.isNull(gearSlotUpdate(await gearOn(actor, "Set", ["torso"])), "gear with slots is left alone");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("the Gear compendium (needs `npm run build:packs`)", function () {
        useQuenchTimeout(this);
        const GEAR = "carl-rpg.gear";
        const SKILLS = "carl-rpg.skills-and-spells";
        const docs = async (id) => (await game.packs.get(id)?.getDocuments()) ?? [];

        it("has a basic weapon for each Weapon Skill, linked to it, Two-Handed as the Skill says", async function () {
          const gear = await docs(GEAR);
          const skills = new Map((await docs(SKILLS)).map((s) => [s.name, s]));
          assert.isAbove(gear.length, 0, "the pack is built");
          const weapons = gear.filter((g) => g.system.weaponSkill);
          for (const name of ["Club", "Warhammer", "Axe", "Dagger", "Longsword", "Rapier", "Bow", "Crossbow", "Handgun",
            "Javelin", "Shotgun", "Shuriken", "Slingshot", "Lance", "Polearm", "Quarterstaff"]) {
            const w = weapons.find((g) => g.name === name);
            assert.exists(w, name);
            const skill = skills.get(w.system.weaponSkill);
            assert.exists(skill, `${name}'s Skill is in the compendium`);
            const twoHands = /requires two hands/i.test(skill.system.limitations ?? "");
            assert.equal(w.system.twoHanded, twoHands, `${name} Two-Handed as its Skill says`);
            assert.include(slotsOf(w), "held");
          }
        });

        it("a sword and an axe each come one- and two-handed, on the same Skill", async function () {
          const gear = await docs(GEAR);
          const by = (n) => gear.find((g) => g.name === n);
          assert.include(by("Longsword").system, { weaponSkill: "Longsword", twoHanded: false });
          assert.include(by("Greatsword").system, { weaponSkill: "Longsword", twoHanded: true });
          assert.include(by("Axe").system, { weaponSkill: "Axe", twoHanded: false });
          assert.include(by("Greataxe").system, { weaponSkill: "Axe", twoHanded: true });
        });

        it("the mundane shield is a held Shield with +1 DR; the armor fits its slot", async function () {
          const gear = await docs(GEAR);
          const by = (n) => gear.find((g) => g.name === n);
          const lid = by("Trash-Can Lid Shield");
          assert.isTrue(isShield(lid));
          assert.include(slotsOf(lid), "held");
          assert.equal(lid.system.changes.find((c) => c.target === "dr")?.value, "1");
          assert.deepEqual(slotsOf(by("Heavy Winter Coat")), ["torso"]);
          assert.deepEqual(slotsOf(by("Hockey Pads")), ["legs"]);
          for (const name of ["Torch", "Lantern", "Rope", "Lighter", "Crawler Biscuits", "Plain Clothes"]) assert.exists(by(name), name);
        });
      });
    },
    { displayName: "CarlRPG: Gear slots" },
  );
}
