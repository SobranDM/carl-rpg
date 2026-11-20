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
export async function waitFor(
  predicate,
  { timeout = 5000, interval = 25, message = "waitFor: condition never became true" } = {},
) {
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
 * A Pet (module/data/pet.mjs). Pass `system.ownerId` to bond it to a crawler.
 * @param {string} [label]
 * @param {object} [data]
 * @returns {Promise<Actor>}
 */
export async function createTestPet(label = "pet", data = {}) {
  return Actor.create({
    name: `Quench ${label} ${foundry.utils.randomID()}`,
    type: "pet",
    ...data,
  });
}

/**
 * A Vehicle (module/data/vehicle.mjs).
 * @param {string} [label]
 * @param {object} [data]
 * @returns {Promise<Actor>}
 */
export async function createTestVehicle(label = "vehicle", data = {}) {
  return Actor.create({
    name: `Quench ${label} ${foundry.utils.randomID()}`,
    type: "vehicle",
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
  // Test gear fits any slot unless the test says where it goes
  // (docs/gear-slots.md: gear with no slot can't be worn). Tests of the
  // slot rules set `system.slots` themselves.
  if (type === "item" && data.system?.slots === undefined && !data.system?.consumable?.kind) {
    data = {
      ...data,
      system: { ...(data.system ?? {}), slots: Object.keys(CONFIG.CARLRPG.wearSlots) },
    };
  }
  // `system.equipped: true` here is a test's shortcut for worn gear (or, in
  // the migration tests, gear equipped the old way): kept, where a real
  // copy arriving on a Character starts unequipped (CarlRPGItem#_preCreate).
  const [item] = await actor.createEmbeddedDocuments(
    "Item",
    [
      {
        name: `Quench ${label} ${foundry.utils.randomID()}`,
        type,
        ...data,
      },
    ],
    { carlKeepEquipped: true },
  );
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
  const [combatant] = await combat.createEmbeddedDocuments("Combatant", [
    {
      actorId: actor.id,
      tokenId: token?.id ?? null,
      sceneId: token?.parent?.id ?? null,
    },
  ]);
  return { combat, combatant };
}

/**
 * The real game.user.targets / canvas.tokens.controlled descriptors, saved
 * by the outermost of any overlapping withFakeTargets calls and put back only
 * when the last one ends. Without this, two calls running at once (e.g.
 * `Promise.all([declare(), declare()])`) could have the later one "restore"
 * the earlier one's fake, leaving a deleted test actor targeted for every
 * later test.
 */
const fakeTargetState = { depth: 0, userDesc: undefined, controlledDesc: undefined, tokens: null };

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
  const fakeTokens = fakeTargets.map((t) => ({
    actor: t.actor,
    document: { uuid: t.uuid ?? t.actor.uuid },
    // The canvas ticker touches game.user.targets while the stub is live -
    // no-op stand-ins for the two PlaceableObject methods it calls.
    _drawTargetArrows() {},
    _refreshTarget() {},
  }));
  const fakeSet = new Set(fakeTokens);
  const tokens = canvas?.tokens ?? null;
  if (fakeTargetState.depth++ === 0) {
    fakeTargetState.userDesc = Object.getOwnPropertyDescriptor(user, "targets");
    fakeTargetState.tokens = tokens;
    fakeTargetState.controlledDesc = tokens
      ? Object.getOwnPropertyDescriptor(tokens, "controlled")
      : undefined;
  }
  // Each call reads its own set while it runs; overlapping calls share the
  // stub, so the latest-started call's set is what game.user.targets shows.
  Object.defineProperty(user, "targets", {
    configurable: true,
    enumerable: true,
    get: () => fakeSet,
  });
  if (tokens)
    Object.defineProperty(tokens, "controlled", {
      configurable: true,
      enumerable: true,
      get: () => [],
    });

  try {
    return await fn();
  } finally {
    if (--fakeTargetState.depth === 0) {
      const { userDesc, controlledDesc, tokens: savedTokens } = fakeTargetState;
      if (savedTokens) {
        if (controlledDesc) Object.defineProperty(savedTokens, "controlled", controlledDesc);
        else delete savedTokens.controlled;
      }
      if (userDesc) Object.defineProperty(user, "targets", userDesc);
      else delete user.targets;
      fakeTargetState.userDesc = fakeTargetState.controlledDesc = undefined;
      fakeTargetState.tokens = null;
    }
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

/**
 * A DragEvent carrying a real DataTransfer, as a browser delivers one.
 * @param {string} type  "dragstart", "drop", ...
 * @param {DataTransfer} [dataTransfer]
 * @returns {DragEvent}
 */
export function makeDragEvent(type, dataTransfer = new DataTransfer()) {
  return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
}

/**
 * Drop `data` on `element` (inside a rendered sheet) with a real DOM drop
 * event and report how many times the sheet dispatched it, by spying on its
 * `_onDropDocument`. More than one dispatch means two drop handlers are
 * bound. With `expectDispatch: false` it waits a while and expects none
 * (e.g. a hook blocked the drop).
 * @param {foundry.applications.api.DocumentSheetV2} sheet
 * @param {HTMLElement} element
 * @param {object} data  Drag data, e.g. `doc.toDragData()`.
 * @param {{expectDispatch?: boolean}} [options]
 * @returns {Promise<{dispatches: number, result: any}>}
 */
export async function dropOnSheet(sheet, element, data, { expectDispatch = true } = {}) {
  const proto = Object.getPrototypeOf(sheet);
  const calls = [];
  sheet._onDropDocument = (event, document) => {
    const pending = proto._onDropDocument.call(sheet, event, document);
    calls.push(pending);
    return pending;
  };
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", JSON.stringify(data));
    element.dispatchEvent(makeDragEvent("drop", dataTransfer));
    if (expectDispatch) {
      await waitFor(() => calls.length > 0, { message: "the sheet never handled the drop" });
    }
    const results = await Promise.all(calls);
    await settle(150);
    await Promise.all(calls);
    return { dispatches: calls.length, result: results[0] ?? null };
  } finally {
    delete sheet._onDropDocument;
  }
}

/**
 * Wrap a batch's registration function so the chat messages posted while
 * the batch runs are deleted when it ends (module/quench/register.mjs wraps
 * every batch). Rolls, Initiative, "Combat Over" and other cards are side
 * effects many tests never clean up; left behind they pile up in the world
 * (loaded at every startup) and in the chat log, a run at a time.
 *
 * Deletes every message created while the batch ran, whoever posted it.
 * After a combat was deleted it waits a moment and looks again: "Combat
 * Over" is posted un-awaited after the deletion (documents/combat.mjs).
 * @param {string} key  The batch key, for the log line.
 * @param {Function} fn  The batch's registration function.
 * @returns {Function}
 */
export function withMessageCleanup(key, fn) {
  return function (context) {
    let before = null;
    let combatDeleted = false;
    let hookId = null;
    // On the batch's root suite: before and after all of the batch's suites.
    context.before(function () {
      before = new Set(game.messages.keys());
      combatDeleted = false;
      hookId = Hooks.on("deleteCombat", () => {
        combatDeleted = true;
      });
    });
    context.after(async function () {
      this.timeout?.(QUENCH_DEFAULT_TIMEOUT_MS);
      if (!before) return;
      let deleted = 0;
      const sweep = async () => {
        const ids = game.messages.filter((m) => !before.has(m.id)).map((m) => m.id);
        if (!ids.length) return;
        try {
          await ChatMessage.deleteDocuments(ids);
          deleted += ids.length;
        } catch (err) {
          console.warn(`CarlRPG | ${key}: deleting its chat messages failed`, err);
        }
      };
      try {
        await sweep();
        if (combatDeleted) {
          await settle(300);
          await sweep();
        }
        if (deleted) console.info(`CarlRPG | ${key} left ${deleted} chat message(s); deleted`);
      } finally {
        if (hookId !== null) Hooks.off("deleteCombat", hookId);
        hookId = null;
        before = null;
      }
    });
    return fn.call(this, context);
  };
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

/**
 * The open system dialog (module/apps/carl-dialog.mjs) with this class.
 * @param {string} cssClass
 * @returns {Promise<foundry.applications.api.DialogV2>}
 */
export async function openDialog(cssClass) {
  let dialog;
  await waitFor(
    () => {
      dialog = [...foundry.applications.instances.values()].find(
        (app) =>
          app instanceof foundry.applications.api.DialogV2 &&
          app.rendered &&
          app.element.classList.contains(cssClass),
      );
      return !!dialog;
    },
    { message: `no .${cssClass} dialog opened` },
  );
  return dialog;
}

/** Click one of a dialog's footer buttons. */
export function pressDialog(dialog, action) {
  dialog.element.querySelector(`button[data-action="${action}"]`).click();
}

/**
 * Start something that opens a dialog, run `fn` on the dialog (it must
 * press a button), and return what the start resolved with. If `fn` throws,
 * the dialog is closed, so a failed assertion can't leave it behind for the
 * next test. (Closing it after a press would race the button's callback.)
 * @param {() => Promise<*>} start
 * @param {(dialog: foundry.applications.api.DialogV2) => void|Promise<void>} fn
 * @param {string} cssClass  The dialog's class.
 * @returns {Promise<*>}
 */
export async function withDialog(start, fn, cssClass) {
  const pending = start();
  let dialog = null;
  try {
    dialog = await openDialog(cssClass);
    await fn(dialog);
  } catch (err) {
    if (dialog?.rendered) await dialog.close();
    throw err;
  }
  return pending;
}
