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
  rolls = [], rollMeta = [], extraRollRows = [], description = "", isPrivate = false,
}) {
  const { renderTemplate } = foundry.applications.handlebars;
  const rollRows = await buildRollRows(rolls, rollMeta, { isPrivate, extraRows: extraRollRows });
  return renderTemplate(SHELL_TEMPLATE, { title, subtitle, img, badge, body, footer, rollRows, description });
}

/**
 * Create a chat message carrying one or more evaluated Rolls.
 *
 * @param {object} options
 * @param {Roll[]} options.rolls
 * @param {object[]} [options.rollMeta]  Per-index row metadata: {label, detail, breakdown}.
 * @param {object[]} [options.extraRollRows]  Non-Roll-backed rows spliced into
 *   the roll table, e.g. {label, detail, breakdown, total, insertAt}.
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
  rolls = [], rollMeta = [], extraRollRows = [], title, subtitle, img, badge, body = "", footer, description = "",
  actor, token, flags = {}, whisper, messageMode,
} = {}) {
  // v14: ChatMessage#applyRollMode/CONST.DICE_ROLL_MODES are deprecated in
  // favor of ChatMessage.applyMode's "public"|"self"|"gm"|"blind" modes.
  const mode = messageMode ?? game.settings.get("core", "messageMode");
  const isPrivate = mode === "blind";
  const content = await renderShell({ title, subtitle, img, badge, body, footer, rolls, rollMeta, extraRollRows, description, isPrivate });
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

/**
 * Sugar over createCardMessage for a small one-off notice (ported from
 * foundryvtt-wwn's chat-card.mjs for factory parity). Simpler than WWN's
 * version - no bodyTemplate/context/list indirection, since every caller in
 * this codebase already builds its own trusted HTML string directly.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {string} [options.img]
 * @param {string} [options.body]      Plain text, HTML-escaped.
 * @param {string} [options.bodyHtml]  Trusted HTML - not escaped, overrides body.
 * @param {Actor} [options.actor]
 * @param {TokenDocument} [options.token]
 * @param {object} [options.flags]
 * @param {string[]} [options.whisper]
 */
export async function createNoticeMessage({
  title, subtitle, img, body = "", bodyHtml, actor, token, flags = {}, whisper,
} = {}) {
  return createCardMessage({
    title, subtitle, img,
    body: bodyHtml ?? (body ? `<p>${foundry.utils.escapeHTML(body)}</p>` : ""),
    actor, token, whisper,
    flags: { kind: "notice", ...flags },
  });
}

/**
 * Splice a trusted HTML fragment onto the end of an existing card's content,
 * for a caller to persist via updateCardMessage (module/helpers/
 * chat-socket.mjs) - the "fold a follow-up into the same card" pattern (see
 * module/chat/damage-card.mjs's digest) instead of posting a new message.
 * @param {ChatMessage} message
 * @param {string} html
 * @returns {string} The full new message content.
 */
export function appendCardSection(message, html) {
  const div = document.createElement("div");
  div.innerHTML = message.content;
  div.querySelector(".carl-chat-card")?.insertAdjacentHTML("beforeend", html);
  return div.innerHTML;
}
