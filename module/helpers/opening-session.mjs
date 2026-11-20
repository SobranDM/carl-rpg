import { boxesOf, openBox } from "./boxes.mjs";
import { askGM, registerAskHandler } from "./chat-socket.mjs";
import { queueOn } from "./actor-queue.mjs";

/**
 * The Opening Session (docs/loot-and-achievements.md): the party opens its
 * loot boxes together, one crawler at a time, every box shown to everyone
 * (ruled 2026-11-19). Only the GM writes its state - the world setting
 * `openingSession` - and every client draws it (apps/opening-session.mjs).
 * A player's Open! and Next! go to the active GM's client (askGM), which
 * checks them and runs them one at a time; each names the turn it was
 * clicked on, so a double click (or two people clicking) can't skip a box.
 *
 * State: {active, turn, order: actorIds, crawler: index into order,
 *   step: "grid"|"opening"|"revealed"|"done", boxes: [{id, name, img,
 *   tierKey}] (the crawler's, Bronze first), box: index into boxes,
 *   result: openBox's summary, or {failed: true}}.
 */

const SCOPE = "carl-rpg";
const SETTING = "openingSession";
const ASK = "openingSession";
/** How long a box shakes and glows before it opens (a test may shorten it). */
export const sessionTiming = { openingMs: 2500 };

const queues = new Map();
const IDLE = { active: false, turn: 0 };

/**
 * Register the session's setting (init). Its change redraws every client's
 * window - `onChange` is given the window's sync function by the app.
 * @param {(state: object) => void} onChange
 */
export function registerOpeningSessionSetting(onChange) {
  game.settings.register(SCOPE, SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: IDLE,
    onChange,
  });
  // Where this client keeps the window.
  game.settings.register(SCOPE, "openingSessionPosition", {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
  registerAskHandler(ASK, (data, user) => act(data?.action, user, data?.turn));
}

/** The session now. */
export function sessionState() {
  return game.settings.get(SCOPE, SETTING) ?? IDLE;
}

/** The crawler whose turn it is. */
export function currentCrawler(state = sessionState()) {
  return state.active ? (game.actors.get(state.order?.[state.crawler]) ?? null) : null;
}

/**
 * May this user press Open! or Next! now? The GM, or the current crawler's
 * owner (ruled 2026-11-19).
 * @param {User} user
 * @param {object} [state]
 * @returns {boolean}
 */
export function canAdvance(user, state = sessionState()) {
  if (!state.active || !user) return false;
  if (user.isGM) return true;
  const actor = currentCrawler(state);
  return !!actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

/**
 * Start a session (GM): these crawlers, in this order. Those without a box
 * are passed over.
 * @param {string[]} actorIds
 * @returns {Promise<object|null>}  The state, or null if nobody has a box.
 */
export async function startSession(actorIds) {
  if (!game.user.isGM) return null;
  const order = actorIds.filter((id) => boxesOf(game.actors.get(id)).length);
  if (!order.length) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Opening.NoBoxes"));
    return null;
  }
  const turn = (sessionState().turn ?? 0) + 1;
  const state = enterCrawler({ active: true, turn, order }, 0);
  await write(state);
  return state;
}

/**
 * Press a button: "open" (the grid's Open!), "next" (after a reveal), and
 * the GM's "skip" (the next crawler) and "end". A player's press goes to
 * the GM's client.
 * @param {"open"|"next"|"skip"|"end"} action
 * @returns {Promise<boolean>}  Whether it was done.
 */
export async function pressSession(action) {
  const turn = sessionState().turn;
  return !!(await askGM(ASK, { action, turn }));
}

/** The GM's side of a press, one at a time. */
function act(action, user, turn) {
  if (!game.user.isGM) return false;
  return queueOn(queues, "session", async () => {
    const state = foundry.utils.deepClone(sessionState());
    // Pressed on a session that has moved on since: ignored.
    if (!state.active || turn !== state.turn) return false;
    const gmOnly = action === "skip" || action === "end";
    if (gmOnly ? !user?.isGM : !canAdvance(user, state)) return false;
    switch (action) {
      case "open":
        if (state.step !== "grid") return false;
        await openNext(state, 0);
        return true;
      case "next":
        if (state.step !== "revealed") return false;
        if (state.box + 1 < state.boxes.length) await openNext(state, state.box + 1);
        else await write(enterCrawler(state, state.crawler + 1));
        return true;
      case "skip":
        if (state.step === "opening") return false;
        await write(enterCrawler(state, state.crawler + 1));
        return true;
      case "end":
        await write({ ...IDLE, turn: state.turn + 1 });
        return true;
      default:
        return false;
    }
  });
}

/**
 * Shake and glow a box on every screen, then open it (GM): its contents to
 * the crawler (helpers/boxes.mjs openBox), and the reveal.
 */
async function openNext(state, index) {
  const opening = { ...state, step: "opening", box: index, result: null, turn: state.turn + 1 };
  await write(opening);
  await new Promise((resolve) => setTimeout(resolve, sessionTiming.openingMs));
  await reveal(opening);
}

/**
 * Open the session's current box and show what came out. Whatever goes
 * wrong, the session moves on: a box that won't open shows as failed.
 */
async function reveal(state) {
  const actor = game.actors.get(state.order[state.crawler]);
  const live = actor?.items.get(state.boxes[state.box]?.id);
  let result = null;
  try {
    result = live ? await openBox(live) : null;
  } catch (err) {
    console.error("CarlRPG | opening a loot box failed", err);
  }
  await write({
    ...state,
    step: "revealed",
    result: result ?? { failed: true },
    turn: state.turn + 1,
  });
}

/**
 * The state at a crawler's turn: their boxes in a grid. Crawlers with none
 * left are passed over; after the last, the session is done.
 */
function enterCrawler(state, index) {
  let i = index;
  while (i < state.order.length && !boxesOf(game.actors.get(state.order[i])).length) i++;
  const turn = state.turn + 1;
  if (i >= state.order.length) {
    return {
      ...state,
      crawler: state.order.length,
      step: "done",
      boxes: [],
      box: 0,
      result: null,
      turn,
    };
  }
  const boxes = boxesOf(game.actors.get(state.order[i])).map((b) => ({
    id: b.id,
    name: b.name,
    img: b.img,
    tierKey: b.system.tier,
  }));
  return { ...state, crawler: i, step: "grid", boxes, box: 0, result: null, turn };
}

/** Write the state (GM): every client redraws. */
function write(state) {
  return game.settings.set(SCOPE, SETTING, state);
}

/**
 * The GM's client came back mid-opening (a reload while a box was shaking):
 * open it now. Call from `ready`.
 */
export async function resumeSession() {
  const state = sessionState();
  if (!game.users.activeGM?.isSelf || !state.active || state.step !== "opening") return;
  await queueOn(queues, "session", () => reveal(foundry.utils.deepClone(sessionState())));
}
