import {
  hotlistCandidates, hotlistRows, isInHotlist, outsideHotlist, placeInHotlist, promptHotlistPick,
  toggleHotlist, useHotlistSlot,
} from "../../helpers/hotlist.mjs";
import CarlDice from "../../dice/dice.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { isInCombat } from "../../helpers/actions.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  deleteTestCombat,
  dropOnSheet,
  openDialog,
  pressDialog,
  settle,
  useQuenchTimeout,
  waitFor,
  withDialog,
} from "../helpers.mjs";

/** A started combat with this actor in it. */
async function startedCombat(actor) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id }]);
  await combat.startCombat();
  return combat;
}

/** A rendered sheet's Equipment Doll slot ("gear"/"head", "accessory"/"0"). */
function dollSlot(sheet, type, key) {
  return sheet.element.querySelector(`.carl-equip-panel [data-slot-type="${type}"][data-slot-key="${key}"]`);
}

/** Drop an owned item onto a doll slot, as dragging its inventory row would. */
async function dropOnDoll(sheet, type, key, item) {
  await waitFor(() => dollSlot(sheet, type, key), { message: `no ${type} slot ${key}` });
  await dropOnSheet(sheet, dollSlot(sheet, type, key), item.toDragData());
}

/** Run `fn`, returning the chat messages it posted (then deleting them). */
async function postedBy(fn) {
  const made = [];
  const hook = Hooks.on("createChatMessage", (message) => made.push(message));
  let result;
  try {
    result = await fn();
    await settle(150);
  } finally {
    Hooks.off("createChatMessage", hook);
  }
  const contents = made.map((m) => m.content);
  for (const message of made) await message.delete().catch(() => null);
  return { result, contents };
}

const isRetrieveCard = (html) => html.includes(" Retrieves ");
const isReadyCard = (html) => html.includes(game.i18n.localize("CARLRPG.Hotlist.ReadyRule"))
  || html.includes(game.i18n.localize("CARLRPG.Hotlist.ReadyFreeRule"));

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.hotlist",
    (context) => {
      const { describe, it, assert } = context;

      describe("Filling the Hotlist (p.98)", function () {
        useQuenchTimeout(this);

        it("offers Spells, consumables with some left, and unworn gear - nothing already in it", async function () {
          const actor = await createTestCharacter("offers");
          try {
            const spell = await createTestItem(actor, "spell", "spark", { system: { rank: 2 } });
            const potion = await createTestItem(actor, "item", "potion", { system: { quantity: 1, consumable: { kind: "potion" } } });
            await createTestItem(actor, "item", "empty flask", { system: { quantity: 0, consumable: { kind: "potion" } } });
            const club = await createTestItem(actor, "item", "club");
            const helm = await createTestItem(actor, "item", "helm");
            const rope = await createTestItem(actor, "item", "rope");
            await createTestItem(actor, "skill", "climb", { system: { rank: 3 } });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            await placeInHotlist(actor, 0, rope);

            const offered = hotlistCandidates(actor);
            const ids = offered.flatMap((g) => g.entries.map((e) => e.id));
            assert.sameMembers(ids, [spell.id, potion.id, club.id]);
            assert.deepEqual(offered.map((g) => g.key), ["spells", "consumables", "gear"]);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the star fills the first empty slot, takes it out again, and a full Hotlist refuses", async function () {
          const actor = await createTestCharacter("pins");
          try {
            const items = [];
            for (let i = 0; i < 11; i++) items.push(await createTestItem(actor, "item", `pin ${i}`));
            assert.isTrue(await toggleHotlist(actor, items[0]));
            assert.equal(actor.system.hotlist[0], items[0].id);
            assert.isTrue(isInHotlist(actor, items[0]));
            assert.isTrue(await toggleHotlist(actor, items[0]));
            assert.isFalse(isInHotlist(actor, items[0]));

            for (let i = 0; i < 10; i++) await toggleHotlist(actor, items[i]);
            assert.equal(hotlistRows(actor).filter((r) => !r.empty).length, 10);
            assert.isFalse(await toggleHotlist(actor, items[10]), "full");
            assert.isFalse(isInHotlist(actor, items[10]));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("refuses worn gear, and moves an item rather than copying it", async function () {
          const actor = await createTestCharacter("place");
          try {
            const helm = await createTestItem(actor, "item", "helm");
            const club = await createTestItem(actor, "item", "club");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, helm);
            assert.isFalse(await placeInHotlist(actor, 0, helm), "worn");
            assert.isFalse(isInHotlist(actor, helm));
            // A worn consumable too.
            const charm = await createTestItem(actor, "item", "charm", { system: { equipped: true, consumable: { kind: "other" } } });
            assert.isFalse(await placeInHotlist(actor, 1, charm), "a worn consumable");

            await placeInHotlist(actor, 2, club);
            await placeInHotlist(actor, 5, club);
            assert.equal(actor.system.hotlist[5], club.id);
            assert.equal(actor.system.hotlist.filter((id) => id === club.id).length, 1, "in one slot only");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("in a fight, filling a slot posts a Retrieve card; outside one it's silent", async function () {
          const actor = await createTestCharacter("retrieve");
          let combat;
          try {
            const club = await createTestItem(actor, "item", "club");
            const pipe = await createTestItem(actor, "item", "pipe");
            const calm = await postedBy(() => placeInHotlist(actor, 0, club));
            assert.isFalse(calm.contents.some(isRetrieveCard), "outside a fight");

            combat = await startedCombat(actor);
            const fight = await postedBy(() => placeInHotlist(actor, 1, pipe));
            assert.isTrue(fight.contents.some(isRetrieveCard), "the Retrieve Action");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("wearing a Hotlist item takes it out of the Hotlist", async function () {
          const actor = await createTestCharacter("wear");
          try {
            const club = await createTestItem(actor, "item", "club");
            await placeInHotlist(actor, 3, club);
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            assert.isFalse(isInHotlist(actor, club));
            assert.isTrue(hotlistRows(actor)[3].empty);

            // The Item sheet's Equipped box (a bare update) too - already
            // done when the update returns.
            const cloak = await createTestItem(actor, "item", "cloak");
            await placeInHotlist(actor, 5, cloak);
            await cloak.update({ "system.equipped": true });
            assert.isFalse(isInHotlist(actor, cloak), "an equipped item stayed in the Hotlist");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("clicking an empty slot opens the picker; the filter narrows it, and one click on an entry fills that slot", async function () {
          const actor = await createTestCharacter("picker");
          const sheet = actor.sheet;
          try {
            await createTestItem(actor, "item", "aaa potion", { system: { quantity: 2, consumable: { kind: "potion" } } });
            const rope = await createTestItem(actor, "item", "zzz rope");
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const empty = sheet.element.querySelector('[data-slot-key="4"] [data-action="pickHotlist"]');
            assert.include(empty.textContent, game.i18n.localize("CARLRPG.Hotlist.Empty"));
            empty.click();
            const dialog = await openDialog("carl-hotlist-pick-dialog");
            try {
              const potionRadio = dialog.element.querySelector('input[name="pick"]:not([value="' + rope.id + '"])');
              potionRadio.checked = true;
              const filter = dialog.element.querySelector("[data-carl-pick-filter]");
              filter.value = "rope";
              filter.dispatchEvent(new Event("input"));
              const shown = [...dialog.element.querySelectorAll(".carl-hotlist-pick-entry")].filter((e) => e.offsetParent !== null);
              assert.lengthOf(shown, 1, "only the rope matches");
              assert.isFalse(potionRadio.checked, "a hidden entry isn't left picked");
              assert.equal(shown[0].querySelector("input").value, rope.id);
              // A mouse click (detail 1) picks at once.
              shown[0].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
            } catch (err) {
              await dialog.close();
              throw err;
            }
            await waitFor(() => actor.system.hotlist[4] === rope.id, { message: "the slot never filled" });
            assert.lengthOf(actor.system.hotlist.filter(Boolean), 1, "only the rope went in");
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("the picker's Add takes the checked entry, and with none checked adds nothing", async function () {
          const actor = await createTestCharacter("add");
          try {
            const club = await createTestItem(actor, "item", "club");
            const nothing = await withDialog(() => promptHotlistPick(actor, 0), (d) => pressDialog(d, "add"), "carl-hotlist-pick-dialog");
            assert.isFalse(nothing, "a lone, unchecked entry isn't picked");
            assert.isFalse(isInHotlist(actor, club));
            await withDialog(() => promptHotlistPick(actor, 0), (d) => {
              d.element.querySelector(`input[name="pick"][value="${club.id}"]`).checked = true;
              pressDialog(d, "add");
            }, "carl-hotlist-pick-dialog");
            assert.equal(actor.system.hotlist[0], club.id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the picker won't overwrite a slot that filled while it was open", async function () {
          const actor = await createTestCharacter("taken");
          try {
            const club = await createTestItem(actor, "item", "club");
            const pipe = await createTestItem(actor, "item", "pipe");
            const placed = await withDialog(() => promptHotlistPick(actor, 2), async (d) => {
              await placeInHotlist(actor, 2, pipe);
              d.element.querySelector(`input[name="pick"][value="${club.id}"]`).checked = true;
              pressDialog(d, "add");
            }, "carl-hotlist-pick-dialog");
            assert.isFalse(placed);
            assert.equal(actor.system.hotlist[2], pipe.id, "the pipe stays");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Using a Hotlist slot", function () {
        useQuenchTimeout(this);

        it("each row knows what a click does: Cast a Spell, Use a consumable, Ready gear", async function () {
          const actor = await createTestCharacter("rows");
          try {
            const spell = await createTestItem(actor, "spell", "missile", { system: { manaCost: 4, rank: 3 } });
            const potion = await createTestItem(actor, "item", "potion", { system: { quantity: 2, consumable: { kind: "potion" } } });
            const club = await createTestItem(actor, "item", "club");
            for (const [i, item] of [spell, potion, club].entries()) await placeInHotlist(actor, i, item);
            const [s, p, c] = hotlistRows(actor);
            assert.include(s, { kind: "spell", action: "Cast", manaCost: 4, rank: 3 });
            assert.include(p, { kind: "consumable", action: "Use", quantity: 2 });
            assert.include(c, { kind: "gear", action: "Ready", inHand: false });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Ready leaves the slot empty when the old Main Hand item is still worn (older data, both hands)", async function () {
          const actor = await createTestCharacter("both hands");
          try {
            const staff = await createTestItem(actor, "item", "staff");
            const pipe = await createTestItem(actor, "item", "pipe");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, staff);
            await actor.update({ "system.gearSlots.offHand": staff.id });
            await placeInHotlist(actor, 0, pipe);
            await useHotlistSlot(actor, 0);
            assert.equal(actor.system.gearSlots.mainHand, pipe.id);
            assert.equal(actor.system.gearSlots.offHand, staff.id, "still in the Off Hand");
            assert.equal(actor.system.hotlist[0], "", "a worn item doesn't go in the Hotlist");
            assert.isTrue(actor.items.get(staff.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("outside a fight, Ready swaps a Hotlist item with the Main Hand, with no card", async function () {
          const actor = await createTestCharacter("ready");
          try {
            const club = await createTestItem(actor, "item", "club");
            const pipe = await createTestItem(actor, "item", "pipe");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            await placeInHotlist(actor, 0, pipe);
            const { contents } = await postedBy(() => useHotlistSlot(actor, 0));
            assert.equal(actor.system.gearSlots.mainHand, pipe.id);
            assert.equal(actor.system.hotlist[0], club.id, "the club takes the pipe's slot");
            assert.isTrue(actor.items.get(pipe.id).system.equipped);
            assert.isFalse(actor.items.get(club.id).system.equipped);
            assert.lengthOf(contents, 0);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a consumable asks first: Cancel keeps it, Use spends one", async function () {
          const actor = await createTestCharacter("use", { system: { hb: { value: 5 } } });
          try {
            const potion = await createTestItem(actor, "item", "potion", {
              system: { quantity: 2, consumable: { kind: "potion", heal: { slots: 2 } } },
            });
            await placeInHotlist(actor, 0, potion);
            await withDialog(() => useHotlistSlot(actor, 0), (d) => pressDialog(d, "cancel"), "carl-consumable-confirm");
            assert.equal(actor.items.get(potion.id).system.quantity, 2, "kept");
            await postedBy(() => withDialog(() => useHotlistSlot(actor, 0), (d) => pressDialog(d, "use"), "carl-consumable-confirm"));
            assert.equal(actor.items.get(potion.id).system.quantity, 1, "used once");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("in a fight, a Spell or consumable must be in the Hotlist (p.86)", async function () {
          const actor = await createTestCharacter("caster");
          let combat;
          try {
            const spell = await createTestItem(actor, "spell", "spark", { system: { rank: 1 } });
            const scroll = await createTestItem(actor, "item", "scroll", { system: { consumable: { kind: "scroll" } } });
            const potion = await createTestItem(actor, "item", "potion", { system: { consumable: { kind: "potion" } } });
            assert.isFalse(outsideHotlist(actor, spell), "outside a fight, anything goes");
            combat = await startedCombat(actor);
            assert.isTrue(isInCombat(actor));
            for (const item of [spell, scroll, potion]) assert.isTrue(outsideHotlist(actor, item), item.name);
            assert.isNull(await spell.roll(), "refused, without rolling");
            const de = await createTestItem(actor, "damageEffect", "zap", { system: { rank: 1, parentSkills: [spell.name] } });
            assert.isNull(await CarlDice.rollDamageEffect(actor, de), "nor through its Damage Effect");
            // With a Skill parent too, the Spell isn't offered: the Skill's Attack opens straight away.
            const punch = await createTestItem(actor, "skill", "punch", { system: { category: "attack", rank: 1, isHandToHand: true } });
            const both = await createTestItem(actor, "damageEffect", "jolt", { system: { rank: 1, parentSkills: [spell.name, punch.name] } });
            await withDialog(() => CarlDice.rollDamageEffect(actor, both), (d) => pressDialog(d, "cancel"), "carl-roll-dialog");
            await postedBy(() => placeInHotlist(actor, 0, spell));
            assert.isFalse(outsideHotlist(actor, spell), "in the Hotlist: castable");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("in a fight, gear asks how: Swap (an Action) readies it with a Ready card and no Retrieve card", async function () {
          const actor = await createTestCharacter("swap");
          let combat;
          try {
            const club = await createTestItem(actor, "item", "club");
            const pipe = await createTestItem(actor, "item", "pipe");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            await placeInHotlist(actor, 0, pipe);
            combat = await startedCombat(actor);
            const { contents } = await postedBy(() => withDialog(() => useHotlistSlot(actor, 0),
              (d) => pressDialog(d, "swap"), "carl-hotlist-swap-dialog"));
            assert.equal(actor.system.gearSlots.mainHand, pipe.id);
            assert.equal(actor.system.hotlist[0], club.id);
            assert.isTrue(contents.some(isReadyCard), "a Ready card");
            assert.isFalse(contents.some(isRetrieveCard), "a swap isn't a Retrieve");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("Swap and Attack swaps back when the Attack is cancelled; a second click meanwhile is ignored", async function () {
          const actor = await createTestCharacter("swing");
          let combat;
          try {
            const skill = await createTestItem(actor, "skill", "clubbing", { system: { category: "attack", rank: 2 } });
            const club = await createTestItem(actor, "item", "club", { system: { weaponSkill: skill.name } });
            const pipe = await createTestItem(actor, "item", "pipe", { system: { weaponSkill: skill.name } });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            await placeInHotlist(actor, 0, pipe);
            combat = await startedCombat(actor);

            const { result } = await postedBy(async () => {
              const pending = useHotlistSlot(actor, 0);
              const swap = await openDialog("carl-hotlist-swap-dialog");
              pressDialog(swap, `attack-${skill.id}`);
              const roll = await openDialog("carl-roll-dialog");
              try {
                assert.equal(actor.system.gearSlots.mainHand, pipe.id, "swapped before the Attack rolls");
                assert.isNull(await useHotlistSlot(actor, 0), "one swap at a time");
                // The club took the pipe's slot: the star would take it out.
                assert.isFalse(await toggleHotlist(actor, club), "nor the star");
                assert.equal(actor.system.hotlist[0], club.id);
                // Nor a drop on a gear slot, or the Item sheet's Equipped box.
                await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, club);
                assert.equal(actor.system.gearSlots.offHand, "", "the equip helpers are locked");
                await club.update({ "system.equipped": true });
                assert.isFalse(actor.items.get(club.id).system.equipped, "so is the Equipped box");
              } finally {
                pressDialog(roll, "cancel");
              }
              return pending;
            });
            assert.isNull(result);
            assert.equal(actor.system.gearSlots.mainHand, club.id, "swapped back");
            assert.equal(actor.system.hotlist[0], pipe.id);
            assert.isTrue(actor.items.get(club.id).system.equipped);
            assert.isFalse(actor.items.get(pipe.id).system.equipped);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("a cancelled Swap and Attack puts back an item that was in both hands (older data)", async function () {
          const actor = await createTestCharacter("both undo");
          let combat;
          try {
            const skill = await createTestItem(actor, "skill", "staffing", { system: { category: "attack", rank: 2 } });
            const staff = await createTestItem(actor, "item", "staff", { system: { weaponSkill: skill.name } });
            const pipe = await createTestItem(actor, "item", "pipe", { system: { weaponSkill: skill.name } });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, staff);
            await actor.update({ "system.gearSlots.offHand": staff.id });
            await placeInHotlist(actor, 0, pipe);
            combat = await startedCombat(actor);

            await postedBy(async () => {
              const pending = useHotlistSlot(actor, 0);
              pressDialog(await openDialog("carl-hotlist-swap-dialog"), `attack-${skill.id}`);
              pressDialog(await openDialog("carl-roll-dialog"), "cancel");
              return pending;
            });
            assert.equal(actor.system.gearSlots.mainHand, staff.id);
            assert.equal(actor.system.gearSlots.offHand, staff.id, "the Off Hand kept it too");
            assert.equal(actor.system.hotlist[0], pipe.id);
            assert.isFalse(actor.items.get(pipe.id).system.equipped);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("the swap dialog offers the Combat tab's Attacks - not an outranked Unarmed Combat", async function () {
          const actor = await createTestCharacter("swap list");
          let combat;
          try {
            const unarmed = await createTestItem(actor, "skill", "Unarmed Combat", {
              name: "Unarmed Combat", system: { category: "attack", rank: 1, isHandToHand: true, noDamageEffects: true },
            });
            const pugilism = await createTestItem(actor, "skill", "Pugilism", {
              name: "Pugilism", system: { category: "attack", rank: 3, isHandToHand: true },
            });
            const pipe = await createTestItem(actor, "item", "pipe");
            await placeInHotlist(actor, 0, pipe);
            combat = await startedCombat(actor);
            await withDialog(() => useHotlistSlot(actor, 0), (d) => {
              assert.exists(d.element.querySelector(`button[data-action="attack-${pugilism.id}"]`));
              assert.notExists(d.element.querySelector(`button[data-action="attack-${unarmed.id}"]`));
              pressDialog(d, "cancel");
            }, "carl-hotlist-swap-dialog");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("a cancelled Swap and Attack that can't be undone stands as the Action, with its card", async function () {
          const actor = await createTestCharacter("stuck");
          let combat;
          try {
            const skill = await createTestItem(actor, "skill", "clubbing", { system: { category: "attack", rank: 2 } });
            const club = await createTestItem(actor, "item", "club", { system: { weaponSkill: skill.name } });
            const pipe = await createTestItem(actor, "item", "pipe", { system: { weaponSkill: skill.name } });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            await placeInHotlist(actor, 0, pipe);
            combat = await startedCombat(actor);

            const { contents } = await postedBy(async () => {
              const pending = useHotlistSlot(actor, 0);
              const swap = await openDialog("carl-hotlist-swap-dialog");
              pressDialog(swap, `attack-${skill.id}`);
              const roll = await openDialog("carl-roll-dialog");
              // Something else (another client, a macro) empties the slot meanwhile.
              await actor.update({ "system.hotlist": ["", "", "", "", "", "", "", "", "", ""] });
              pressDialog(roll, "cancel");
              return pending;
            });
            assert.equal(actor.system.gearSlots.mainHand, pipe.id, "the swap stands");
            assert.isTrue(contents.some(isReadyCard), "and is on record");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });
      });

      describe("Inventory Equipment Doll", function () {
        useQuenchTimeout(this);

        it("stays its own width: a long item name in a slot is cut off, not allowed to widen the doll", async function () {
          const actor = await createTestCharacter("doll width");
          const sheet = actor.sheet;
          try {
            const coat = await createTestItem(actor, "item", "coat", {
              name: "Apparel appropriate for your location's climate and an orange safety jacket",
            });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, coat);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            sheet.changeTab("items", "primary");
            await settle(100);
            const panel = sheet.element.querySelector(".carl-equip-panel");
            const slot = sheet.element.querySelector('.carl-equip-panel [data-slot-key="mainHand"]');
            assert.isAtMost(panel.getBoundingClientRect().width, 241, "the doll keeps its 240px");
            assert.isAtMost(slot.getBoundingClientRect().height, 90, "and its slots stay small squares");
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("a drop wears gear in a slot, another moves it, the Accessories slot takes it, (x) takes it off; worn gear lists first", async function () {
          const actor = await createTestCharacter("slots");
          const sheet = actor.sheet;
          try {
            await createTestItem(actor, "item", "aaa first by name");
            const helm = await createTestItem(actor, "item", "zzz helm");
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.notExists(sheet.element.querySelector("select.carl-slot-select"), "the Slot column is gone");

            await dropOnDoll(sheet, "gear", "head", helm);
            await waitFor(() => actor.system.gearSlots.head === helm.id, { message: "never worn" });
            assert.isTrue(actor.items.get(helm.id).system.equipped);
            assert.equal(actor.items.size, 2, "worn, not copied");
            await waitFor(() => sheet.element.querySelector('section[data-tab="items"] li.item[data-item-id]')?.dataset.itemId === helm.id,
              { message: "worn gear should list first" });
            await waitFor(() => dollSlot(sheet, "gear", "head")?.classList.contains("filled"), { message: "the doll never showed it" });

            await dropOnDoll(sheet, "gear", "torso", helm);
            await waitFor(() => actor.system.gearSlots.torso === helm.id);
            assert.equal(actor.system.gearSlots.head, "", "moved, not copied");

            await dropOnDoll(sheet, "accessory", "0", helm);
            await waitFor(() => actor.system.accessories.includes(helm.id));
            assert.equal(actor.system.gearSlots.torso, "");

            await waitFor(() => dollSlot(sheet, "accessory", "0")?.querySelector(".carl-slot-clear"), { message: "no (x)" });
            dollSlot(sheet, "accessory", "0").querySelector(".carl-slot-clear").click();
            await waitFor(() => !actor.items.get(helm.id).system.equipped, { message: "never taken off" });
            assert.notInclude(actor.system.accessories, helm.id);
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("the Equipped box wears gear with no slot: out of the Hotlist, star hidden", async function () {
          const actor = await createTestCharacter("worn");
          const sheet = actor.sheet;
          try {
            const cloak = await createTestItem(actor, "item", "cloak");
            await placeInHotlist(actor, 0, cloak);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            sheet.element.querySelector(`li.item[data-item-id="${cloak.id}"] .carl-equip-toggle`).click();
            await waitFor(() => !isInHotlist(actor, cloak), { message: "still in the Hotlist" });
            assert.isTrue(actor.items.get(cloak.id).system.equipped);
            await waitFor(() => !sheet.element.querySelector(`li.item[data-item-id="${cloak.id}"] .carl-hotlist-pin`),
              { message: "worn gear shouldn't offer the star" });
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: Hotlist" },
  );
}
