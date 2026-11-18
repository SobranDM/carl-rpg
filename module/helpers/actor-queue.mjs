/**
 * Serialize writes to one actor on this client. Two tasks that each read an
 * actor's state and write it back (Race/Class grant baking; round-end
 * Debuff processing and the timed-effect expiry sweep, which both rewrite
 * `system.conditions`) must not interleave, or one silently overwrites the
 * other's change. A plain Promise chain per key is enough: everything that
 * needs ordering runs through it on the same client.
 *
 * Use the actor's uuid as the key, so a token's own actor and the world
 * actor it came from queue separately.
 */
const queues = new Map();

/**
 * Run `task` after every earlier task queued under the same key.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>|T} task
 * @returns {Promise<T>}
 */
export function queueForActor(key, task) {
  return queueOn(queues, key, task);
}

/**
 * Run `task` after every earlier task queued in `queues` under `key`: a
 * Promise chain per key. The key is dropped once its last task settles, so
 * a key per document (an actor, a card, a combat) doesn't stay for the rest
 * of the session.
 * @template T
 * @param {Map<string, Promise<void>>} queues
 * @param {string} key
 * @param {() => Promise<T>|T} task
 * @returns {Promise<T>}
 */
export function queueOn(queues, key, task) {
  const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}
