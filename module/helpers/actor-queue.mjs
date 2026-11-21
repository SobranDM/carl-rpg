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

// Chat cards' write queues (the writer's client - the active GM's, or with
// none online the one client that can write the card), by card id: the
// Reaction card, Check/Attack/Driving cards' revisions (and a row's Evade,
// Apply, Taunt redirect and undo, which share their Attack card's), Heal and
// Party Check cards. A card is only ever one of these kinds.
const cards = new Map();

/**
 * Run `task` in a card's write queue: after every write on that card already
 * queued, before the next. Never call it from inside a task on the same
 * card: the queue would wait on itself.
 * @template T
 * @param {string} cardId
 * @param {() => Promise<T>|T} task
 * @returns {Promise<T>}
 */
export function queueForCard(cardId, task) {
  return queueOn(cards, cardId, task);
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
