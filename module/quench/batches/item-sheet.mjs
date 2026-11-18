import { CarlRPGItemSheet } from "../../sheets/item-sheet.mjs";
import { effectiveRank } from "../../helpers/modifiers.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  dropOnSheet,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

const ITEM_TYPES = ["item", "feature", "skill", "damageEffect", "spell", "class", "race"];
const RANKED_TYPES = ["skill", "spell", "damageEffect"];
/** Drawn as one page, no tabs (item-sheet.mjs SINGLE_PAGE_TYPES). */
const SINGLE_PAGE_TYPES = ["item"];

const worldItem = (type, label = type, data = {}) =>
  Item.create({ name: `Quench ${label} ${foundry.utils.randomID()}`, type, ...data });

/** Render an Item's sheet and wait until it's on screen. */
async function openSheet(item) {
  const sheet = item.sheet;
  await sheet.render({ force: true });
  await waitFor(() => sheet.rendered);
  return sheet;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.item-sheet",
    (context) => {
      const { describe, it, assert } = context;

      describe("item sheet on core ItemSheetV2", function () {
        useQuenchTimeout(this);

        it("every item type opens a CarlRPGItemSheet built on ItemSheetV2", async function () {
          for (const type of ITEM_TYPES) {
            const item = await worldItem(type);
            try {
              const sheet = await openSheet(item);
              assert.instanceOf(sheet, foundry.applications.sheets.ItemSheetV2, type);
              assert.instanceOf(sheet, CarlRPGItemSheet, type);
              assert.exists(sheet.element.querySelector('input[name="name"]'), `${type}: the form rendered`);
              if (SINGLE_PAGE_TYPES.includes(type)) {
                const page = sheet.element.querySelector(".carl-single-page");
                assert.exists(page, `${type}: one page`);
                assert.isNotNull(page.offsetParent, `${type}: the page is shown`);
                assert.notExists(sheet.element.querySelector("nav.tabs"), `${type}: no tab bar`);
              } else {
                const active = sheet.element.querySelector('.tab[data-group="primary"].active');
                assert.exists(active, `${type}: a primary tab is active`);
                const expected = RANKED_TYPES.includes(type) ? "main" : "description";
                assert.equal(active.dataset.tab, expected, `${type}: opens on its first tab`);
              }
              await sheet.close();
            } finally {
              await item.delete();
            }
          }
        });

        it("item is the sheet's Item; actor is its owner, or null in the sidebar", async function () {
          const actor = await createTestCharacter("owner");
          const loose = await worldItem("item", "loose");
          try {
            const owned = await createTestItem(actor, "skill", "owned");
            assert.strictEqual(owned.sheet.item, owned);
            assert.strictEqual(owned.sheet.actor, actor);
            assert.strictEqual(loose.sheet.item, loose);
            assert.isNull(loose.sheet.actor);
          } finally {
            await deleteTestActor(actor);
            await loose.delete();
          }
        });

        it("editing a field still saves the Item", async function () {
          const item = await worldItem("item", "rename");
          try {
            const sheet = await openSheet(item);
            const input = sheet.element.querySelector('input[name="name"]');
            const renamed = `${item.name} renamed`;
            input.value = renamed;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            await waitFor(() => item.name === renamed, { message: "the change was never saved" });
            await sheet.close();
          } finally {
            await item.delete();
          }
        });

        it("an owned Skill's sheet still offers its Advancement roll", async function () {
          const actor = await createTestCharacter("advancement");
          try {
            const skill = await createTestItem(actor, "skill", "advance");
            const sheet = await openSheet(skill);
            assert.exists(sheet.element.querySelector('[data-action="rollAdvancement"]'));
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a dropped ActiveEffect is ignored, not copied onto the Item", async function () {
          const target = await worldItem("item", "target");
          const source = await worldItem("item", "effect carrier", {
            effects: [{ name: "Quench effect", img: "icons/svg/aura.svg" }],
          });
          try {
            const effect = source.effects.contents[0];
            assert.exists(effect, "test setup: the source Item carries an effect");
            const sheet = await openSheet(target);
            const { dispatches, result } = await dropOnSheet(sheet, sheet.element, effect.toDragData());
            assert.equal(dispatches, 1, "handled once");
            assert.isNull(result);
            assert.equal(target.effects.size, 0);
            await sheet.close();
          } finally {
            await target.delete();
            await source.delete();
          }
        });

        it("a dropped Item does nothing", async function () {
          const target = await worldItem("class", "target");
          const dropped = await worldItem("skill", "dropped");
          try {
            const before = target.toObject();
            const sheet = await openSheet(target);
            const { dispatches, result } = await dropOnSheet(sheet, sheet.element, dropped.toDragData());
            assert.equal(dispatches, 1);
            assert.isNull(result);
            assert.deepEqual(target.toObject().system, before.system, "the target Item is unchanged");
            await sheet.close();
          } finally {
            await target.delete();
            await dropped.delete();
          }
        });

        it("drops go through the dropItemSheetData hook, which can block them", async function () {
          const target = await worldItem("item", "hooked");
          const dropped = await worldItem("item", "dropped");
          const seen = [];
          let block = false;
          const hookId = Hooks.on("dropItemSheetData", (item, sheet, data) => {
            if (item !== target) return undefined;
            seen.push(data);
            return block ? false : undefined;
          });
          try {
            const sheet = await openSheet(target);
            await dropOnSheet(sheet, sheet.element, dropped.toDragData());
            assert.equal(seen.length, 1, "the hook saw the drop");
            assert.equal(seen[0].uuid, dropped.uuid);

            block = true;
            const blocked = await dropOnSheet(sheet, sheet.element, dropped.toDragData(), { expectDispatch: false });
            assert.equal(blocked.dispatches, 0, "a false return stops it");
            await sheet.close();
          } finally {
            Hooks.off("dropItemSheetData", hookId);
            await target.delete();
            await dropped.delete();
          }
        });
      });
      describe("Rank tabs' lock icons", function () {
        useQuenchTimeout(this);

        it("follow the Skill's live Rank: Rank 4 + a '+1 Rank' feature opens the Rank 5 tab", async function () {
          const actor = await createTestCharacter("rank tabs");
          try {
            const name = `Quench Tab Skill ${foundry.utils.randomID()}`;
            const skill = await createTestItem(actor, "skill", name, { name, system: { rank: 4 } });
            const icon = (sheet, id) => sheet.element.querySelector(`nav.tabs [data-tab="${id}"] i`);
            let sheet = await openSheet(skill);
            assert.isTrue(icon(sheet, "rank5").classList.contains("fa-lock"), "Rank 4: locked");
            await sheet.close();

            await createTestItem(actor, "feature", "rank charm", {
              system: { changes: [{ targetType: "skillRank", target: name, mode: "add", value: "1" }] },
            });
            assert.equal(skill.system.rank, 4, "test setup: its own Rank is unchanged");
            assert.equal(effectiveRank(skill), 5, "test setup: the feature makes its live Rank 5");
            sheet = await openSheet(skill);
            assert.isTrue(icon(sheet, "rank5").classList.contains("fa-lock-open"), "live Rank 5: open");
            assert.isTrue(icon(sheet, "rank10").classList.contains("fa-lock"), "Rank 10 still locked");
            await sheet.close();
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
      describe("string lists: Favored Classes, Class Types, Parent Skills", function () {
        useQuenchTimeout(this);

        const LISTS = [["spell", "favoredClasses"], ["class", "classTypes"], ["damageEffect", "parentSkills"]];
        const addLink = (sheet, path) => sheet.element.querySelector(`[data-action="addArrayItem"][data-path="${path}"]`);
        const row = (sheet, path, index) => sheet.element.querySelector(`input[name="${path}.${index}"]`);
        const type = (input, value) => {
          input.value = value;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };

        it("Add makes an empty row to type into, and the typed entry saves", async function () {
          for (const [itemType, key] of LISTS) {
            const item = await worldItem(itemType, key);
            const path = `system.${key}`;
            try {
              const sheet = await openSheet(item);
              addLink(sheet, path).click();
              await waitFor(() => row(sheet, path, 0), { message: `${itemType}: Add made no row` });
              type(row(sheet, path, 0), "Mage");
              await waitFor(() => item._source.system[key][0] === "Mage", { message: `${itemType}: the entry never saved` });

              addLink(sheet, path).click();
              await waitFor(() => row(sheet, path, 1), { message: `${itemType}: a second Add made no row` });
              assert.deepEqual(item._source.system[key], ["Mage", ""], `${itemType}: the empty row is stored`);
              assert.deepEqual(item.system[key], ["Mage"], `${itemType}: an empty row isn't read as an entry`);
              await sheet.close();
            } finally {
              await item.delete();
            }
          }
        });

        it("a cleared entry doesn't block a later save", async function () {
          for (const [itemType, key] of LISTS) {
            const item = await worldItem(itemType, key, { system: { [key]: ["Mage"] } });
            const path = `system.${key}`;
            try {
              const sheet = await openSheet(item);
              type(row(sheet, path, 0), "");
              await waitFor(() => item._source.system[key][0] === "", { message: `${itemType}: the cleared entry never saved` });
              const renamed = `${item.name} renamed`;
              type(sheet.element.querySelector('input[name="name"]'), renamed);
              await waitFor(() => item.name === renamed, { message: `${itemType}: a later edit never saved` });
              assert.deepEqual(item.system[key], [], `${itemType}: the cleared entry isn't read`);
              await sheet.close();
            } finally {
              await item.delete();
            }
          }
        });
      });
    },
    { displayName: "CarlRPG: Item Sheet" },
  );
}
