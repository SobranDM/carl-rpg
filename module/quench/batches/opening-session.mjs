import {
  canAdvance,
  pressSession,
  sessionState,
  sessionTiming,
  startSession,
} from "../../helpers/opening-session.mjs";
import { giveBox, prepareBox } from "../../helpers/boxes.mjs";
import { createTestCharacter, deleteTestActor, useQuenchTimeout, waitFor } from "../helpers.mjs";

/**
 * The Opening Session (0.8.0 phase 5, docs/loot-and-achievements.md): the
 * party opening its loot boxes together - one crawler at a time, Bronze
 * first, Open!/Next! for that crawler's player or the GM, Skip Player and
 * End for the GM. Run as the GM; the boxes are prepared, so no tables are
 * rolled.
 */
const text = (name) => ({ kind: "text", name, img: "icons/svg/item-bag.svg", quantity: 1 });

/** A crawler with prepared boxes: [tier, item name] each. */
async function crawlerWithBoxes(label, boxes) {
  const actor = await createTestCharacter(label);
  for (const [tierKey, item] of boxes) {
    const box = await giveBox(actor, { tierKey });
    await prepareBox(box, { tierKey, gold: 5, entries: [text(item)] });
  }
  return actor;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.opening-session",
    (context) => {
      const { describe, it, assert, before, after, afterEach } = context;

      describe("Opening loot boxes together", function () {
        useQuenchTimeout(this, 30000);
        let openingMs;
        before(function () {
          openingMs = sessionTiming.openingMs;
          sessionTiming.openingMs = 0;
        });
        after(function () {
          sessionTiming.openingMs = openingMs;
        });
        afterEach(async function () {
          if (sessionState().active) await pressSession("end");
        });

        it("crawler by crawler, Bronze first; each box opened onto its crawler", async function () {
          const a = await crawlerWithBoxes("opener A", [
            ["gold", "Quench Gold Thing"],
            ["bronze", "Quench Bronze Thing"],
          ]);
          const b = await crawlerWithBoxes("opener B", [["silver", "Quench Silver Thing"]]);
          const none = await createTestCharacter("no boxes");
          try {
            const state = await startSession([a.id, none.id, b.id]);
            assert.deepEqual(state.order, [a.id, b.id], "a crawler without a box is passed over");
            assert.equal(state.step, "grid");
            assert.deepEqual(
              state.boxes.map((x) => x.tierKey),
              ["bronze", "gold"],
            );

            assert.isTrue(await pressSession("open"));
            let now = sessionState();
            assert.equal(now.step, "revealed");
            assert.equal(now.result.items[0].name, "Quench Bronze Thing");
            assert.exists(a.items.getName("Quench Bronze Thing"), "on the crawler's sheet");

            assert.isTrue(await pressSession("next"));
            now = sessionState();
            assert.equal(now.step, "revealed");
            assert.equal(now.result.items[0].name, "Quench Gold Thing");

            assert.isTrue(await pressSession("next"), "the last box: on to the next crawler");
            now = sessionState();
            assert.equal(now.order[now.crawler], b.id);
            assert.equal(now.step, "grid");

            await pressSession("open");
            await pressSession("next");
            assert.equal(sessionState().step, "done");
            assert.isFalse(a.items.some((i) => i.type === "box"));
            assert.isFalse(b.items.some((i) => i.type === "box"));
          } finally {
            for (const actor of [a, b, none]) await deleteTestActor(actor);
          }
        });

        it("two presses at once (a double click): one box opened", async function () {
          const a = await crawlerWithBoxes("double", [
            ["bronze", "Quench First"],
            ["bronze", "Quench Second"],
          ]);
          try {
            await startSession([a.id]);
            const done = await Promise.all([pressSession("open"), pressSession("open")]);
            assert.lengthOf(done.filter(Boolean), 1);
            assert.lengthOf(
              a.items.filter((i) => i.type === "box"),
              1,
              "the other box is still unopened",
            );
          } finally {
            await deleteTestActor(a);
          }
        });

        it("only the crawler's player or the GM may press Open!/Next!", async function () {
          const a = await crawlerWithBoxes("who", [["bronze", "Quench Who"]]);
          try {
            const player = { id: foundry.utils.randomID(), isGM: false };
            const stranger = { id: foundry.utils.randomID(), isGM: false };
            await a.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
            await startSession([a.id]);
            assert.isTrue(canAdvance(game.user), "the GM");
            assert.isTrue(canAdvance(player), "the crawler's player");
            assert.isFalse(canAdvance(stranger), "anyone else");
          } finally {
            await deleteTestActor(a);
          }
        });

        it("the GM's Skip Player and End", async function () {
          const a = await crawlerWithBoxes("skipped", [["bronze", "Quench Skipped"]]);
          const b = await crawlerWithBoxes("after", [["bronze", "Quench After"]]);
          try {
            await startSession([a.id, b.id]);
            assert.isTrue(await pressSession("skip"));
            assert.equal(sessionState().order[sessionState().crawler], b.id);
            assert.exists(
              a.items.find((i) => i.type === "box"),
              "a skipped crawler keeps their box",
            );
            assert.isTrue(await pressSession("end"));
            assert.isFalse(sessionState().active);
          } finally {
            await deleteTestActor(a);
            await deleteTestActor(b);
          }
        });

        it("a box that can't be opened: shown as such, kept, and the session goes on", async function () {
          const a = await createTestCharacter("broken box");
          try {
            const box = await giveBox(a, { tierKey: "bronze" });
            await prepareBox(box, {
              tierKey: "bronze",
              gold: 0,
              entries: [{ kind: "item", uuid: "Item.quenchNoSuchItem", name: "Gone", quantity: 1 }],
            });
            await startSession([a.id]);
            await pressSession("open");
            assert.isTrue(sessionState().result.failed);
            assert.exists(a.items.get(box.id));
            await pressSession("next");
            assert.equal(sessionState().step, "done");
          } finally {
            await deleteTestActor(a);
          }
        });

        it("a box that throws while opening: shown as failed, and the session goes on", async function () {
          const a = await crawlerWithBoxes("throwing box", [["bronze", "Quench Never"]]);
          // Making its items fails (as a server error would) - this crawler only.
          a.createEmbeddedDocuments = async () => {
            throw new Error("Quench: making items failed");
          };
          try {
            const box = a.items.find((i) => i.type === "box");
            await startSession([a.id]);
            await pressSession("open");
            assert.equal(sessionState().step, "revealed", "not stuck shaking");
            assert.isTrue(sessionState().result.failed);
            assert.exists(a.items.get(box.id), "it stays unopened");
            await pressSession("next");
            assert.equal(sessionState().step, "done");
          } finally {
            delete a.createEmbeddedDocuments;
            await deleteTestActor(a);
          }
        });

        it("every client's window opens with the session and closes when it ends", async function () {
          const a = await crawlerWithBoxes("window", [["bronze", "Quench Window"]]);
          try {
            await startSession([a.id]);
            await waitFor(
              () => foundry.applications.instances.get("carl-opening-session")?.rendered,
            );
            const app = foundry.applications.instances.get("carl-opening-session");
            assert.include(app.element.textContent, a.name);
            assert.exists(app.element.querySelector('[data-action="open"]'));
            await pressSession("end");
            await waitFor(
              () => !foundry.applications.instances.get("carl-opening-session")?.rendered,
            );
          } finally {
            await deleteTestActor(a);
          }
        });

        it("nobody with a box: no session", async function () {
          const a = await createTestCharacter("boxless");
          try {
            assert.isNull(await startSession([a.id]));
            assert.isFalse(sessionState().active);
          } finally {
            await deleteTestActor(a);
          }
        });
      });
    },
    { displayName: "CarlRPG: opening loot boxes together" },
  );
}
