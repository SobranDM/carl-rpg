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
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}
