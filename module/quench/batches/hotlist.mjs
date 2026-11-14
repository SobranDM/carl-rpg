import {
  hotlistRows, inRunningFight, isInHotlist, spellOutsideHotlist, toggleHotlist, useHotlistSlot,
} from "../../helpers/hotlist.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  deleteTestCombat,
  settle,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

/** A started combat with this actor in it. */
async function startedCombat(actor) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id }]);
  await combat.startCombat();
  return combat;
}

/** Pick a value in a rendered sheet's Slot select for an item, as a user would. */
async function pickSlot(sheet, item, value) {
  const select = sheet.element.querySelector(`select.carl-slot-select[data-slot-for="${item.id}"]`);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(150);
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.hotlist",
    (context) => {
      const { describe, it, assert } = context;

      describe("The Hotlist (p.98)", function () {
        useQuenchTimeout(this);

        it("pinning fills the first empty slot, unpinning empties it, and a full Hotlist refuses", async function () {
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

        it("each row knows its action: Cast a Spell, Use a consumable, Ready gear (or In hand)", async function () {
          const actor = await createTestCharacter("rows");
          try {
            const spell = await createTestItem(actor, "spell", "missile", { system: { manaCost: 4, rank: 3 } });
            const potion = await createTestItem(actor, "item", "potion", { system: { quantity: 2, consumable: { kind: "potion" } } });
            const club = await createTestItem(actor, "item", "club");
            for (const item of [spell, potion, club]) await toggleHotlist(actor, item);
            const [s, p, c] = hotlistRows(actor);
            assert.include(s, { kind: "spell", action: "Cast", manaCost: 4, rank: 3 });
            assert.include(p, { kind: "consumable", action: "Use", quantity: 2 });
            assert.include(c, { kind: "gear", action: "Ready", inHand: false });
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            assert.include(hotlistRows(actor)[2], { inHand: true, action: null });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Ready swaps a Hotlist item with whatever is in the Main Hand", async function () {
          const actor = await createTestCharacter("ready");
          try {
            const club = await createTestItem(actor, "item", "club");
            const pipe = await createTestItem(actor, "item", "pipe");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, club);
            await toggleHotlist(actor, pipe);
            await useHotlistSlot(actor, 0);
            assert.equal(actor.system.gearSlots.mainHand, pipe.id);
            assert.equal(actor.system.hotlist[0], club.id, "the club takes the pipe's slot");
            assert.isTrue(actor.items.get(pipe.id).system.equipped);
            assert.isFalse(actor.items.get(club.id).system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Use spends a consumable from its slot", async function () {
          const actor = await createTestCharacter("use", { system: { hb: { value: 5 } } });
          try {
            const potion = await createTestItem(actor, "item", "potion", {
              system: { quantity: 2, consumable: { kind: "potion", heal: { slots: 2 } } },
            });
            await toggleHotlist(actor, potion);
            await useHotlistSlot(actor, 0, { skipDialog: true });
            await waitFor(() => actor.items.get(potion.id)?.system.quantity === 1, { message: "the potion wasn't used" });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("in a fight, a Spell or scroll must be in the Hotlist to be cast (p.86)", async function () {
          const actor = await createTestCharacter("caster");
          let combat;
          try {
            const spell = await createTestItem(actor, "spell", "spark");
            const scroll = await createTestItem(actor, "item", "scroll", { system: { consumable: { kind: "scroll" } } });
            assert.isFalse(spellOutsideHotlist(actor, spell), "outside a fight, anything goes");
            combat = await startedCombat(actor);
            assert.isTrue(inRunningFight(actor));
            assert.isTrue(spellOutsideHotlist(actor, spell));
            assert.isTrue(spellOutsideHotlist(actor, scroll));
            assert.isNull(await spell.roll(), "refused, without rolling");
            await toggleHotlist(actor, spell);
            assert.isFalse(spellOutsideHotlist(actor, spell), "pinned: castable");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });
      });

      describe("Inventory Slot column", function () {
        useQuenchTimeout(this);

        it("wears an item in a gear slot, moves it, makes it an Accessory, and takes it off; worn gear lists first", async function () {
          const actor = await createTestCharacter("slots");
          const sheet = actor.sheet;
          try {
            await createTestItem(actor, "item", "aaa first by name");
            const helm = await createTestItem(actor, "item", "zzz helm");
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);

            await pickSlot(sheet, helm, "head");
            await waitFor(() => actor.system.gearSlots.head === helm.id, { message: "never worn" });
            assert.isTrue(actor.items.get(helm.id).system.equipped);
            await waitFor(() => sheet.element.querySelector('section[data-tab="items"] li.item[data-item-id]')?.dataset.itemId === helm.id,
              { message: "worn gear should list first" });

            await pickSlot(sheet, helm, "torso");
            await waitFor(() => actor.system.gearSlots.torso === helm.id);
            assert.equal(actor.system.gearSlots.head, "", "moved, not copied");

            await pickSlot(sheet, helm, "accessory");
            await waitFor(() => actor.system.accessories.includes(helm.id));
            assert.equal(actor.system.gearSlots.torso, "");

            await pickSlot(sheet, helm, "");
            await waitFor(() => !actor.items.get(helm.id).system.equipped, { message: "never taken off" });
            assert.notInclude(actor.system.accessories, helm.id);
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
