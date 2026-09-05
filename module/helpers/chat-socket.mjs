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

/** Register once, from the `ready` hook (needs game.users/game.socket live). */
export function registerChatSocket() {
  game.socket.on(SOCKET, async ({ messageId, updates } = {}) => {
    if (!game.users.activeGM?.isSelf) return;
    const message = game.messages.get(messageId);
    if (!message) return;
    await message.update(updates);
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
