/**
 * The GM Toolbox's shared actor picker (module/apps/actor-picker.mjs;
 * docs/release-0.7.0.md §5): Select All on its own row, the groups named
 * for what they hold, who plays each, Select All / count / filter.
 */
import { actorPickerContent, playedBy, wireActorPicker } from "../../apps/actor-picker.mjs";
import { createTestCharacter, createTestPet, deleteTestActor, useQuenchTimeout } from "../helpers.mjs";

/** The picker's content in a detached element, wired as the dialog wires it. */
function drawn(groups) {
  const root = document.createElement("div");
  root.innerHTML = actorPickerContent(groups, "Who?");
  wireActorPicker(root);
  return root;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.actor-picker",
    (context) => {
      const { describe, it, assert } = context;

      describe("the shared actor picker", function () {
        useQuenchTimeout(this);

        it("Select All has its own row; the groups say what they hold", async function () {
          const here = await createTestCharacter("picker here");
          const away = await createTestCharacter("picker away");
          try {
            const root = drawn({ active: [here], other: [away], pets: [] });
            const picker = root.querySelector(".carl-actor-picker");
            const selectAll = picker.querySelector(":scope > .carl-actor-picker-select-all");
            assert.exists(selectAll, "a row of its own, not beside a group");
            assert.notExists(picker.querySelector(".carl-actor-picker-list .carl-actor-picker-select-all"));

            const headings = [...root.querySelectorAll(".carl-actor-picker-heading")].map((h) => h.textContent.trim());
            assert.deepEqual(headings, [
              game.i18n.format("CARLRPG.Toolbox.ActorPicker.LoggedIn", { count: 1 }),
              game.i18n.format("CARLRPG.Toolbox.ActorPicker.NotLoggedIn", { count: 1 }),
            ]);
            const other = root.querySelector('[data-group="other"]');
            assert.isFalse(other.open, "Not logged in starts collapsed");
            assert.exists(other.querySelector(".carl-actor-picker-hint"));

            const box = (actor) => root.querySelector(`input[data-actor-id="${actor.id}"]`);
            assert.isTrue(box(here).checked, "logged in: ticked");
            assert.isFalse(box(away).checked, "not logged in: unticked");
            const who = box(away).closest(".carl-actor-picker-option").querySelector(".carl-actor-picker-who").textContent.trim();
            assert.equal(who, playedBy(away), "each row says who plays it");
          } finally {
            await deleteTestActor(here);
            await deleteTestActor(away);
          }
        });

        it("Select All, the count and the filter", async function () {
          const a = await createTestCharacter("Alpha picker");
          const b = await createTestCharacter("Bravo picker");
          const pet = await createTestPet("Charlie picker");
          try {
            const root = drawn({ active: [a], other: [b], pets: [pet] });
            const count = () => root.querySelector("[data-picker-count]").textContent;
            assert.equal(count(), game.i18n.format("CARLRPG.Toolbox.ActorPicker.SelectedCount", { count: 1, total: 3 }));
            const selectAll = root.querySelector("[data-picker-select-all]");
            selectAll.checked = true;
            selectAll.dispatchEvent(new Event("change"));
            assert.isTrue([...root.querySelectorAll("input[data-actor-id]")].every((box) => box.checked));
            assert.equal(count(), game.i18n.format("CARLRPG.Toolbox.ActorPicker.SelectedCount", { count: 3, total: 3 }));

            const filter = root.querySelector(".carl-actor-picker-filter");
            filter.value = b.name.toLowerCase();
            filter.dispatchEvent(new Event("input"));
            const shown = [...root.querySelectorAll(".carl-actor-picker-option")].filter((r) => !r.hidden).map((r) => r.querySelector("input").dataset.actorId);
            assert.deepEqual(shown, [b.id]);
            assert.isTrue(root.querySelector('[data-group="other"]').open, "the match's group opens");
          } finally {
            for (const actor of [a, b, pet]) await deleteTestActor(actor);
          }
        });

        it("a GM-only Character says so", async function () {
          const npc = await createTestCharacter("picker npc", { ownership: { default: 0 } });
          try {
            if (game.users.some((u) => !u.isGM && npc.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) this.skip();
            assert.equal(playedBy(npc), game.i18n.localize("CARLRPG.Toolbox.ActorPicker.GmOnly"));
          } finally {
            await deleteTestActor(npc);
          }
        });
      });
    },
    { displayName: "CarlRPG: Actor picker" },
  );
}
