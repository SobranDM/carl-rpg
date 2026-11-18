/**
 * Client-side state that must not outlive what it is about: the per-key
 * Promise queues (module/helpers/actor-queue.mjs queueOn) drop a key once its
 * last task settles, and a deleted card's per-card entries (open expanders,
 * results on their way; module/chat/status-rows.mjs) are forgotten; and
 * each batch's stray chat messages are deleted (helpers.mjs withMessageCleanup).
 */
import { queueOn } from "../../helpers/actor-queue.mjs";
import { trackPerCard, untrackPerCard } from "../../chat/status-rows.mjs";
import { useQuenchTimeout, waitFor, withMessageCleanup } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.memory-hygiene",
    (context) => {
      const { describe, it, assert } = context;

      describe("queueOn: a Promise chain per key", function () {
        useQuenchTimeout(this);

        it("runs a key's tasks one at a time, in order, and drops the key once the last settles", async function () {
          const queues = new Map();
          const order = [];
          let release;
          const gate = new Promise((resolve) => { release = resolve; });
          const first = queueOn(queues, "card", async () => { await gate; order.push(1); return "a"; });
          const second = queueOn(queues, "card", async () => { order.push(2); return "b"; });
          assert.isTrue(queues.has("card"), "kept while tasks are waiting");
          release();
          assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
          assert.deepEqual(order, [1, 2]);
          await waitFor(() => !queues.has("card"), { message: "the key was never dropped" });
        });

        it("a failed task rejects its own caller, the next still runs, and the key is still dropped", async function () {
          const queues = new Map();
          const failed = queueOn(queues, "actor", async () => { throw new Error("boom"); });
          const next = queueOn(queues, "actor", async () => "ran");
          let error = null;
          await failed.catch((err) => { error = err; });
          assert.equal(error?.message, "boom");
          assert.equal(await next, "ran");
          await waitFor(() => queues.size === 0, { message: "the key was never dropped" });
        });
      });

      describe("deleting a card forgets its client-side entries", function () {
        useQuenchTimeout(this);

        it("drops the card's own keys from tracked Sets and Maps, not other cards'", async function () {
          const opened = trackPerCard(new Set());
          const local = trackPerCard(new Map());
          let message = null;
          try {
            message = await ChatMessage.create({ content: "<p>Quench memory-hygiene</p>" });
            const id = message.id;
            opened.add(`${id}:t0:evade`).add("someOtherCard:t0");
            local.set(`${id}:t0`, { applied: true }).set(id, true).set("someOtherCard:t1", { evaded: true });
            await message.delete();
            message = null;
            await waitFor(() => !opened.has(`${id}:t0:evade`) && !local.has(`${id}:t0`) && !local.has(id),
              { message: "the deleted card's entries stayed" });
            assert.isTrue(opened.has("someOtherCard:t0"), "another card's open row stays");
            assert.isTrue(local.has("someOtherCard:t1"), "another card's local result stays");
          } finally {
            untrackPerCard(opened);
            untrackPerCard(local);
            if (message && game.messages.get(message.id)) await message.delete();
          }
        });
      });

      describe("withMessageCleanup: a batch's stray chat messages", function () {
        useQuenchTimeout(this);

        it("deletes the messages posted while the batch ran, and keeps older ones", async function () {
          const hooks = {};
          const fakeContext = { before: (fn) => { hooks.before = fn; }, after: (fn) => { hooks.after = fn; } };
          const wrapped = withMessageCleanup("carl-rpg.memory-hygiene-fake", (ctx) => {
            assert.strictEqual(ctx, fakeContext, "the batch gets the same context");
            return "registered";
          });
          assert.equal(wrapped.call(null, fakeContext), "registered");
          assert.isFunction(hooks.before);
          assert.isFunction(hooks.after);

          const older = await ChatMessage.create({ content: "<p>Quench memory-hygiene older</p>" });
          let stray = null;
          let ran = false;
          try {
            await hooks.before.call({});
            stray = await ChatMessage.create({ content: "<p>Quench memory-hygiene stray</p>" });
            await hooks.after.call({ timeout() {} });
            ran = true;
            assert.isFalse(game.messages.has(stray.id), "the batch's message is deleted");
            assert.isTrue(game.messages.has(older.id), "a message from before the batch stays");
          } finally {
            if (!ran) await hooks.after.call({ timeout() {} });
            if (game.messages.get(older.id)) await older.delete();
            if (stray && game.messages.get(stray.id)) await stray.delete();
          }
        });
      });
    },
    { displayName: "CarlRPG: memory hygiene (queues, per-card state)" },
  );
}
