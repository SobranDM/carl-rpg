import { enrichDescription } from "../helpers/rich-text.mjs";

const SCOPE = "carl-rpg";
const SETTING = "aiTextTooltips";
const ANCHOR_ID = "carl-ai-text-anchor";
// A little under the tooltip's max-width (CSS), plus its margin: whether it
// fits to the token's right.
const ROOM_PX = 380;

/**
 * A Mob's AI Text (system.aiText) beside its token while it's hovered
 * (ruled 2026-11-21): Foundry's own tooltip, "AI" in its upper left, after
 * the usual tooltip delay; to the token's right, or its left by the screen's
 * edge. Anyone who can hover the token sees it - the AI tells a crawler
 * what they're looking at, so it shows even when the token's name is
 * hidden. Gone when the pointer leaves the token, a button is pressed
 * (a drag), or the canvas pans. A GM's world setting turns it off.
 *
 * The tooltip is anchored to an invisible element laid over the token on
 * screen: Foundry's tooltips anchor to page elements, not canvas objects.
 */
export function registerAiTextTooltipSetting() {
  game.settings.register(SCOPE, SETTING, {
    name: "CARLRPG.AiText.Setting.Name",
    hint: "CARLRPG.AiText.Setting.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: (on) => {
      if (!on) hideAiText();
    },
  });
}

/** The token hover hooks: once, at `ready`. */
export function registerAiTextTooltipHooks() {
  // By document: a token redrawn while hovered (a new image) is a new
  // Token object for the same token.
  const ours = (doc) => !!doc && [shownFor, pendingFor].some((t) => t?.document === doc);
  Hooks.on("hoverToken", (token, hovered) => {
    if (hovered) scheduleAiText(token);
    else if (ours(token.document)) hideAiText();
  });
  for (const hook of ["canvasPan", "canvasTearDown"]) Hooks.on(hook, hideAiText);
  // Only its own token's deletion, not any token's.
  Hooks.on("deleteToken", (doc) => {
    if (ours(doc)) hideAiText();
  });
  // A token that moves while hovered (arrow keys, another user) leaves it.
  Hooks.on("updateToken", (doc, changes) => {
    const moved = "x" in changes || "y" in changes || "width" in changes || "height" in changes;
    if (moved && ours(doc)) hideAiText();
  });
  // A press on the board (a drag starting, a click) clears it.
  document.addEventListener("pointerdown", () => hideAiText(), { capture: true, passive: true });
}

/**
 * The AI Text a token shows on hover, or "" for none: a Mob's, while the
 * setting is on.
 * @param {Token|null} token
 * @returns {string}
 */
export function aiTextOf(token) {
  if (!game.settings.get(SCOPE, SETTING)) return "";
  const actor = token?.actor;
  if (actor?.type !== "mob") return "";
  const html = String(actor.system.aiText ?? "");
  return hasText(html) ? html : "";
}

/** Whether HTML holds any text: "<p> </p>" doesn't. */
function hasText(html) {
  return !!String(html).replace(/<[^>]*>|&nbsp;|\s/g, "");
}

/**
 * Which side of the token the tooltip opens on: right, unless there's no
 * room there.
 * @param {{left: number, right: number}} rect  The token on screen.
 * @param {number} screenWidth
 * @returns {string}  A TooltipManager.TOOLTIP_DIRECTIONS value.
 */
export function aiTextDirection(rect, screenWidth) {
  const dirs = foundry.helpers.interaction.TooltipManager.TOOLTIP_DIRECTIONS;
  return rect.right + ROOM_PX > screenWidth && rect.left - ROOM_PX >= 0 ? dirs.LEFT : dirs.RIGHT;
}

/**
 * The tooltip's content: the "AI" badge, then the enriched text.
 * @param {string} enriched
 * @returns {HTMLElement}
 */
export function aiTextContent(enriched) {
  const body = document.createElement("div");
  body.className = "carl-ai-tooltip-body";
  const badge = document.createElement("span");
  badge.className = "carl-ai-badge";
  badge.textContent = game.i18n.localize("CARLRPG.AiText.Badge");
  const text = document.createElement("div");
  text.className = "carl-ai-tooltip-text";
  text.innerHTML = enriched;
  body.append(badge, text);
  return body;
}

/** The token whose AI Text is showing, or waiting to. */
let shownFor = null;
let pendingFor = null;
let timer = null;

/**
 * Show a token's AI Text after the tooltip delay, if it's still hovered then.
 * @param {Token} token
 */
function scheduleAiText(token) {
  hideAiText();
  if (!aiTextOf(token)) return;
  pendingFor = token;
  const delay = foundry.helpers.interaction.TooltipManager.TOOLTIP_ACTIVATION_MS;
  timer = setTimeout(() => {
    timer = null;
    if (pendingFor === token && token.hover) {
      showAiText(token).catch((err) => {
        if (pendingFor === token) pendingFor = null;
        console.warn("carl-rpg | couldn't show a Mob's AI Text", err);
      });
    }
  }, delay);
}

/**
 * Show a token's AI Text now.
 * @param {Token} token
 * @returns {Promise<boolean>}  Whether it's showing.
 */
export async function showAiText(token) {
  const html = aiTextOf(token);
  if (!html || !canvas?.ready) return false;
  pendingFor = token;
  const enriched = await enrichDescription(html, token.actor);
  if (pendingFor !== token) return false; // moved on while enriching
  // All of it a GM secret this user can't see: nothing to show.
  if (!hasText(enriched)) {
    pendingFor = null;
    return false;
  }
  const anchor = placeAnchor(token);
  game.tooltip.activate(anchor, {
    html: aiTextContent(enriched),
    cssClass: "carl-ai-tooltip",
    direction: aiTextDirection(anchor.getBoundingClientRect(), window.innerWidth),
  });
  pendingFor = null;
  shownFor = token;
  return true;
}

/** Hide the AI Text, if it's showing or waiting to. */
export function hideAiText() {
  clearTimeout(timer);
  timer = null;
  pendingFor = null;
  if (!shownFor) return;
  shownFor = null;
  if (game.tooltip.element?.id === ANCHOR_ID) game.tooltip.deactivate();
}

/**
 * The invisible anchor, laid over the token as it is on screen.
 * @param {Token} token
 * @returns {HTMLElement}
 */
function placeAnchor(token) {
  let anchor = document.getElementById(ANCHOR_ID);
  if (!anchor) {
    anchor = document.createElement("div");
    anchor.id = ANCHOR_ID;
    anchor.setAttribute("aria-hidden", "true");
    document.body.append(anchor);
  }
  const { x, y, width, height } = token.bounds;
  const topLeft = canvas.clientCoordinatesFromCanvas({ x, y });
  const scale = canvas.stage.scale.x;
  Object.assign(anchor.style, {
    left: `${topLeft.x}px`,
    top: `${topLeft.y}px`,
    width: `${width * scale}px`,
    height: `${height * scale}px`,
  });
  return anchor;
}
