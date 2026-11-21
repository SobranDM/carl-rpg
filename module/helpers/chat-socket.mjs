/**
 * Foundry rejects ChatMessage#update()/setFlag() from any user who isn't the
 * message's author or a GM (Document#canUserModify checks OWNER, and only
 * the author + GM hold that by default). Every "Apply"/"Roll Evade" click
 * handler in module/chat/*.mjs needs to write onto a card that's routinely
 * authored by someone else (the GM rolls a Mob's Attack; the defending
 * player clicks the button) - a direct message.setFlag() call from that
 * player silently fails. updateCardMessage is the one write path all of
 * those handlers use instead: apply directly when permitted, otherwise
 * relay the already-computed update payload to the active GM's client,
 * which applies it verbatim (no re-derivation GM-side, so permission logic
 * never has to run twice with a chance of disagreeing).
 */

const SOCKET = "system.carl-rpg";
const ASK = "askGM";
const ANSWER = "gmAnswer";
const NOTICE = "userNotice";
/** How long a question waits for the GM's answer before giving up (a test may shorten it). */
export const askTiming = { timeoutMs: 30000 };

/** What the GM runs for askGM, by name (registerAskHandler). */
const askHandlers = new Map();
/** This client's questions still waiting for the GM's answer, by token. */
const waiting = new Map();

/**
 * Register what the active GM's client runs for one kind of question
 * (askGM). Call at load; the handler gets `(data, user)` - `user` is the
 * server-supplied sender - and returns a JSON-safe answer.
 * @param {string} name
 * @param {(data: object, user: User) => Promise<*>|*} handler
 */
export function registerAskHandler(name, handler) {
  askHandlers.set(name, handler);
}

/** Run a question's handler (on the GM's client, or the asker's own). */
async function answer(name, data, user) {
  const handler = askHandlers.get(name);
  if (!handler) return null;
  try {
    return (await handler(data ?? {}, user)) ?? null;
  } catch (err) {
    console.error(`CarlRPG | answering "${name}" failed`, err);
    return null;
  }
}

/**
 * Ask the active GM's client to do something and wait for its answer - a
 * write that must be checked and made in one step on the one writer (a
 * row's Apply claimed in the card's queue). The GM runs it directly. With no
 * GM online, `local` runs it on this client (it can write the card itself);
 * otherwise it's refused with a warning. The payload names the card as
 * `cardId` inside `data` - the chat-update relay keys on `messageId`.
 * @param {string} name  A registerAskHandler name.
 * @param {object} data
 * @param {{local?: boolean}} [options]
 * @returns {Promise<*>}  The answer; null if refused, unanswered or timed out.
 */
export async function askGM(name, data, { local = false } = {}) {
  const gm = game.users.activeGM;
  if (gm?.isSelf || (!gm && local)) return answer(name, data, game.user);
  if (!gm) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return null;
  }
  const token = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(token);
      ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.GMNoAnswer"));
      resolve(null);
    }, askTiming.timeoutMs);
    waiting.set(token, (value) => {
      clearTimeout(timer);
      waiting.delete(token);
      resolve(value);
    });
    game.socket.emit(SOCKET, { type: ASK, name, token, data });
  });
}

/**
 * Show a user a notification - here, or on their own client when the GM's
 * client is doing something they asked for.
 * @param {User|null} user  null: this client.
 * @param {string} key  A lang key, formatted with `data` on their client.
 * @param {object} [data]
 * @param {"info"|"warn"|"error"} [level]
 */
export function tellUser(user, key, data = {}, level = "warn") {
  if (!user || user.isSelf) {
    ui.notifications[level](game.i18n.format(key, data));
    return;
  }
  game.socket.emit(SOCKET, { type: NOTICE, userId: user.id, key, data, level });
}

/**
 * Register once, from the `ready` hook (needs game.users/game.socket live).
 * A ChatMessage update (`{messageId, updates}`, the original and default)
 * shares the one system socket with typed payloads. A question for the GM
 * and its answer
 * (`askGM`: `{type: "askGM", name, token, data}`, answered with
 * `{type: "gmAnswer", userId, token, value}`) and a notice for one user
 * (`tellUser`) share it too.
 */
export function registerChatSocket() {
  game.socket.on(SOCKET, async (payload = {}, senderId = null) => {
    // The GM's answer to this client's question (askGM), or a notice for it (tellUser).
    if (payload?.type === ANSWER || payload?.type === NOTICE) {
      if (payload.userId !== game.user.id) return;
      if (payload.type === NOTICE) {
        const level = ["info", "warn", "error"].includes(payload.level) ? payload.level : "warn";
        ui.notifications[level](game.i18n.format(String(payload.key ?? ""), payload.data ?? {}));
        return;
      }
      waiting.get(payload.token)?.(payload.value ?? null);
      return;
    }
    if (!game.users.activeGM?.isSelf) return;
    if (payload.type === ASK) {
      const user = game.users.get(senderId);
      if (!user) return;
      const value = await answer(payload.name, payload.data, user);
      game.socket.emit(SOCKET, { type: ANSWER, userId: user.id, token: payload.token, value });
      return;
    }
    const message = game.messages.get(payload.messageId);
    if (!message) return;
    await message.update(payload.updates);
  });
}

/**
 * @param {ChatMessage} message
 * @param {object} updates  A Document#update payload, e.g. {flags, content}.
 * @returns {Promise<ChatMessage|null>} The updated document when applied
 *   locally; null when relayed to the GM (no local document to return) or
 *   when no GM is connected to relay to.
 */
export async function updateCardMessage(message, updates) {
  if (message.canUserModify(game.user, "update")) return message.update(updates);
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return null;
  }
  game.socket.emit(SOCKET, { messageId: message.id, updates });
  return null;
}
