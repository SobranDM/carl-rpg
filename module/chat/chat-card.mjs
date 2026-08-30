/**
 * Chat card factory - the sole entry point for this system's chat messages,
 * so styling/speaker handling stay consistent. Adapted from foundryvtt-wwn's
 * module/chat/chat-card.mjs.
 */

import { buildRollRows } from "./roll-rows.mjs";

const SHELL_TEMPLATE = "systems/carl-rpg/templates/chat/card-shell.hbs";

/**
 * @param {Actor} actor
 * @param {TokenDocument} [token]
 */
export function getCarlSpeaker(actor, token = null) {
  token ??= actor?.token ?? actor?.getActiveTokens?.(true, true)?.[0] ?? null;
  return ChatMessage.getSpeaker({ actor, token });
}

async function renderShell({
  title, subtitle, img, badge = null, body = "", footer = null,
  rolls = [], rollMeta = [], description = "", isPrivate = false,
}) {
  const { renderTemplate } = foundry.applications.handlebars;
  const rollRows = await buildRollRows(rolls, rollMeta, { isPrivate });
  return renderTemplate(SHELL_TEMPLATE, { title, subtitle, img, badge, body, footer, rollRows, description });
}

/**
 * Create a chat message carrying one or more evaluated Rolls.
 *
 * @param {object} options
 * @param {Roll[]} options.rolls
 * @param {object[]} [options.rollMeta]  Per-index row metadata: {label, detail, breakdown}.
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {string} [options.img]
 * @param {object} [options.badge]  {label, type: "hit"|"miss"|"warn"}
 * @param {string} [options.body]   Extra trusted HTML below the roll rows.
 * @param {string} [options.footer]
 * @param {string} [options.description]
 * @param {Actor} [options.actor]
 * @param {TokenDocument} [options.token]
 * @param {object} [options.flags]
 * @param {string[]} [options.whisper]
 */
export async function createRollMessage({
  rolls = [], rollMeta = [], title, subtitle, img, badge, body = "", footer, description = "",
  actor, token, flags = {}, whisper, messageMode,
} = {}) {
  // v14: ChatMessage#applyRollMode/CONST.DICE_ROLL_MODES are deprecated in
  // favor of ChatMessage.applyMode's "public"|"self"|"gm"|"blind" modes.
  const mode = messageMode ?? game.settings.get("core", "messageMode");
  const isPrivate = mode === "blind";
  const content = await renderShell({ title, subtitle, img, badge, body, footer, rolls, rollMeta, description, isPrivate });
  const messageData = {
    speaker: getCarlSpeaker(actor, token),
    rolls,
    content,
    sound: CONFIG.sounds.dice,
    whisper,
    flags: { "carl-rpg": { chatCard: true, ...flags } },
  };
  ChatMessage.applyMode(messageData, mode);
  return ChatMessage.create(messageData);
}

/**
 * Create a non-roll card (item descriptions, GM notices, etc.).
 */
export async function createCardMessage({
  title, subtitle, img, badge, body = "", footer, actor, token, flags = {}, whisper,
} = {}) {
  const content = await renderShell({ title, subtitle, img, badge, body, footer });
  const messageData = {
    speaker: getCarlSpeaker(actor, token),
    content,
    whisper,
    flags: { "carl-rpg": { chatCard: true, kind: "card", ...flags } },
  };
  return ChatMessage.create(messageData);
}
