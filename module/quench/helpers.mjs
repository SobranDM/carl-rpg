/**
 * Shared Quench fixture helpers for carl-rpg's own in-system test suite.
 * Pattern adapted from the sibling wwn-system-tests/deltagreen-system-tests
 * projects' module/quench/helpers.mjs, rebuilt against carl-rpg's own
 * Actor/Item schema (module/data/**).
 */

export const QUENCH_DEFAULT_TIMEOUT_MS = 20000;

/**
 * Document-integration tests (Actor.create, embedded Item writes, multiple
 * settle() waits) can comfortably exceed Mocha's default 2000ms timeout on a
 * slower machine - bump it once per describe() block. Call as
 * `useQuenchTimeout(this)` from inside a non-arrow `function () {}` describe
 * callback (arrow functions don't bind Mocha's own `this`).
 * @param {Mocha.Context} mochaCtx
 * @param {number} [ms]
 */
export function useQuenchTimeout(mochaCtx, ms = QUENCH_DEFAULT_TIMEOUT_MS) {
  if (mochaCtx && typeof mochaCtx.timeout === "function") mochaCtx.timeout(ms);
  return ms;
}

/**
 * Temporarily override a world setting (e.g. "currentFloor") for the
 * duration of `fn`, restoring the prior value afterward - so a test's
 * expected numbers don't depend on whatever the GM's real world happens to
 * have the setting at.
 * @param {string} settingKey
 * @param {*} value
 * @param {() => Promise<*>|*} fn
 */
export async function withSetting(settingKey, value, fn) {
  const prior = game.settings.get("carl-rpg", settingKey);
  await game.settings.set("carl-rpg", settingKey, value);
  try {
    return await fn();
  } finally {
    await game.settings.set("carl-rpg", settingKey, prior);
  }
}

/** Brief settle for prepareDerivedData / hook side effects to finish. */
export async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` until it returns truthy, or throw once `timeout` elapses.
 * Needed anywhere a Document hook (_onCreate/_onUpdate) fires an unawaited
 * async side effect - e.g. module/documents/item.mjs's _onCreate calling
 * bakeItemGrants - since Foundry does not wait for that hook's own returned
 * Promise before createEmbeddedDocuments/update resolves back to the caller.
 * A single fixed settle() delay is a race; polling isn't.
 * @param {() => *} predicate
 * @param {{timeout?: number, interval?: number, message?: string}} [options]
 */
export async function waitFor(predicate, { timeout = 5000, interval = 25, message = "waitFor: condition never became true" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await settle(interval);
  }
  if (!predicate()) throw new Error(message);
}

/**
 * @param {string} [label]
 * @param {object} [data]  Merged into the Actor.create payload (e.g. `{system: {...}}`).
 * @returns {Promise<Actor>}
 */
export async function createTestCharacter(label = "character", data = {}) {
  return Actor.create({
    name: `Quench ${label} ${foundry.utils.randomID()}`,
    type: "character",
    ...data,
  });
}

/**
 * @param {string} [label]
 * @param {object} [data]
 * @returns {Promise<Actor>}
 */
export async function createTestMob(label = "mob", data = {}) {
  return Actor.create({
    name: `Quench ${label} ${foundry.utils.randomID()}`,
    type: "mob",
    ...data,
  });
}

/**
 * @param {Actor} actor
 * @param {string} type  One of item|feature|skill|damageEffect|spell|class|race.
 * @param {string} [label]
 * @param {object} [data]
 * @returns {Promise<Item>}
 */
export async function createTestItem(actor, type, label = type, data = {}) {
  const [item] = await actor.createEmbeddedDocuments("Item", [{
    name: `Quench ${label} ${foundry.utils.randomID()}`,
    type,
    ...data,
  }]);
  return item;
}

/** @param {Actor} actor */
export async function deleteTestActor(actor) {
  if (!actor?.id) return;
  const current = game.actors.get(actor.id);
  if (current) await current.delete();
}

/**
 * Mirrors wwn-system-tests' deleteTestCombat: deleting the active/viewed
 * Combat can otherwise trigger a stale-id activate() race.
 * @param {Combat} combat
 */
export async function deleteTestCombat(combat) {
  if (!combat?.id) return;
  const current = game.combats.get(combat.id);
  if (!current) return;
  try {
    if (game.combat?.id === current.id || ui.combat?.viewed?.id === current.id) {
      const others = game.combats.filter((c) => c.id !== current.id);
      if (others.length) await others[0].activate().catch(() => {});
      else await current.update({ active: false }).catch(() => {});
    }
    await current.delete();
  } catch (err) {
    if (game.combats.get(combat.id)) throw err;
  }
}

/**
 * Create a Combat with one embedded Combatant for the given actor/token -
 * for tests exercising Combatant-scoped flags (Nat-20/Amazing-Success
 * Advantage tracking, module/helpers/token-resolution.mjs's resolveCombatantFor).
 * @param {Actor} actor
 * @param {TokenDocument|null} [token]
 * @returns {Promise<{combat: Combat, combatant: Combatant}>}
 */
export async function createTestCombat(actor, token = null) {
  const combat = await Combat.create({});
  const [combatant] = await combat.createEmbeddedDocuments("Combatant", [{
    actorId: actor.id,
    tokenId: token?.id ?? null,
    sceneId: token?.parent?.id ?? null,
  }]);
  return { combat, combatant };
}

/**
 * Temporarily replace game.user.targets with fake token-like objects shaped
 * the way module/dice/dice.mjs's rollAttack reads them (`target.actor`,
 * `target.document?.uuid`). Also clears canvas.tokens.controlled, matching
 * the sibling projects' precedent, so no real scene selection interferes.
 * @param {Array<{actor: Actor, uuid?: string}>} fakeTargets
 * @param {() => Promise<*>|*} fn
 */
export async function withFakeTargets(fakeTargets, fn) {
  const user = game.user;
  const descriptor = Object.getOwnPropertyDescriptor(user, "targets");
  const fakeTokens = fakeTargets.map((t) => ({
    actor: t.actor,
    document: { uuid: t.uuid ?? t.actor.uuid },
    // The canvas ticker touches game.user.targets while the stub is live -
    // no-op stand-ins for the two PlaceableObject methods it calls.
    _drawTargetArrows() {},
    _refreshTarget() {},
  }));
  const fakeSet = new Set(fakeTokens);
  Object.defineProperty(user, "targets", {
    configurable: true,
    enumerable: true,
    get: () => fakeSet,
  });

  const tokens = canvas?.tokens;
  const controlledDesc = tokens ? Object.getOwnPropertyDescriptor(tokens, "controlled") : undefined;
  if (tokens) {
    Object.defineProperty(tokens, "controlled", { configurable: true, enumerable: true, get: () => [] });
  }

  try {
    return await fn();
  } finally {
    if (tokens) {
      if (controlledDesc) Object.defineProperty(tokens, "controlled", controlledDesc);
      else delete tokens.controlled;
    }
    if (descriptor) Object.defineProperty(user, "targets", descriptor);
    else delete user.targets;
  }
}

/**
 * Pinning CONFIG.Dice.randomUniform to a constant makes every rolled die
 * (regardless of how many terms/keep-modifiers a formula has) resolve to the
 * SAME face, since they all draw from the same overridden generator -
 * exactly what's needed to force a specific Degree of Success deterministically
 * in a Quench test.
 * @param {number} unit  A value in (0, 1). Use PIN_D20_MID unless a test truly
 *   needs a specific face - the exact unit->face mapping (whether Foundry
 *   uses `ceil(u*faces)` or `ceil((1-u)*faces)`) is NOT verified here, but
 *   0.5 lands on face 10 of a d20 either way, since both formulas are
 *   symmetric at the midpoint.
 * @param {() => Promise<*>|*} fn
 */
export async function withPinnedDice(unit, fn) {
  const prior = CONFIG.Dice.randomUniform;
  CONFIG.Dice.randomUniform = () => unit;
  try {
    return await fn();
  } finally {
    CONFIG.Dice.randomUniform = prior;
  }
}

/** Pins a d20 to face 10, regardless of which direction randomUniform maps to a face - see withPinnedDice. */
export const PIN_D20_MID = 0.5;

/**
 * A bare `Roll`-shaped object for extractNaturalD20 (module/dice/dice.mjs) -
 * cheaper than actually rolling dice when only the d20-face-extraction logic
 * is under test.
 * @param {Array<{result: number, active: boolean}>} d20Results
 * @returns {{dice: Array<{faces: number, results: Array<{result: number, active: boolean}>}>}}
 */
export function mockD20Roll(d20Results) {
  return { dice: [{ faces: 20, results: d20Results }] };
}
