/**
 * The Reroll button on a crawler's Check card (rules and data: module/
 * helpers/ai-favor.mjs). One button for every reroll source: a d20 icon
 * with no text, to save room on the card (the Reaction card's too), its
 * tooltip naming the source - "AI Reroll", or "Reroll" when it will ask:
 *  - **AI Favor** (p.61): 1 AI Favor, once per Check, never a Natural 1;
 *  - **Fuzzy Dice** (p.73): "One Driving Skill Check reroll per Floor".
 * With one source the click goes straight to it; with several that fit the
 * roll, a dialog picks one (docs/intervene.md, stage 2 ruling 2). The d20 is
 * rolled again with everything else kept, and the card is revised in place
 * (module/chat/check-revision.mjs) - any Intervene d6s stay. The GM spends
 * the source as it applies the reroll.
 *
 * Cards rerolled before rerolls were made in place carry `aiRerolled`:
 * they're drawn as replaced, and offer nothing.
 */
import { extractNaturalD20 } from "../dice/dice.mjs";
import { rerollFormula } from "../helpers/ai-favor.mjs";
import { rerollBase, rerollSources, rollIcons, sendRevision } from "./check-revision.mjs";
import { rowAt, rowCheck, rowRerollSources } from "./row-evade.mjs";
import { esc } from "../helpers/html.mjs";
import { actorFromUuid } from "../helpers/token-resolution.mjs";

const SCOPE = "carl-rpg";
const inFlight = new Set();

/** @returns {Actor|null} The crawler who rolled the Check. */
function rerollActor(spec) {
  return actorFromUuid(spec?.actorUuid);
}

/**
 * Whether the current user may reroll this card now, by any source.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function canReroll(message) {
  return rerollSources(message).length > 0;
}

/** One source's name, for the button's tooltip and the picker. */
function sourceLabel(source) {
  if (source.key === "fuzzyDice") return game.i18n.format("CARLRPG.Reroll.Source.fuzzyDice", { vehicle: source.vehicle.name });
  return game.i18n.format("CARLRPG.Reroll.Source.favor", { favor: source.favor });
}

/** The button's tooltip: the one source the click will use, or "Reroll" when it asks. */
function buttonHint(sources) {
  return game.i18n.localize(`CARLRPG.Reroll.Tooltip.${sources.length > 1 ? "choose" : sources[0].key}`);
}

/**
 * Per-viewer decoration (called from module/chat/chat-listener.mjs): the
 * Reroll button on a card that offers one, or the "rerolled" state on a
 * card an older reroll replaced.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateAiReroll(message, html) {
  const flags = message.flags?.[SCOPE] ?? {};
  const card = html.querySelector(".carl-chat-card");
  if (!card) return;
  if (flags.aiRerolled) {
    card.classList.add("carl-rerolled");
    card.querySelectorAll(".carl-chat-footer button").forEach((button) => { button.disabled = true; });
    const note = document.createElement("p");
    note.className = "carl-reroll-superseded";
    note.textContent = game.i18n.localize("CARLRPG.Reroll.Superseded");
    const footer = card.querySelector(".carl-chat-footer");
    if (footer) footer.before(note);
    else card.append(note);
    return;
  }
  const sources = rerollSources(message);
  if (!sources.length) return;
  const hint = esc(buttonHint(sources));
  rollIcons(html)?.insertAdjacentHTML("beforeend", `<button type="button" class="carl-status-icon carl-ai-reroll-button" data-action="aiReroll"
      data-tooltip="${hint}" aria-label="${hint}"><i class="fas fa-dice-d20" aria-hidden="true"></i></button>`);
}

/**
 * Pick one of several reroll sources (radio buttons, the first ticked).
 * @param {object[]} sources
 * @returns {Promise<object|null>}
 */
async function pickSource(sources) {
  const options = sources.map((s, i) => `<label class="carl-reroll-source">
      <input type="radio" name="source" value="${esc(s.key)}"${i === 0 ? " checked" : ""}> ${esc(sourceLabel(s))}
    </label>`).join("");
  const key = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("CARLRPG.Reroll.PickTitle") },
    classes: ["carl-reroll-pick"],
    content: `<fieldset><legend>${esc(game.i18n.localize("CARLRPG.Reroll.PickLabel"))}</legend>${options}</fieldset>`,
    ok: { label: game.i18n.localize("CARLRPG.Reroll.Button"), callback: (event, button) => button.form.elements.source.value },
    rejectClose: false,
  });
  return sources.find((s) => s.key === key) ?? null;
}

/**
 * Reroll this card's Check (the button's action): pick the source if
 * there's a choice, roll the new d20 here (shown), and send it to the GM,
 * who spends the source and revises the card.
 * @param {ChatMessage} message
 * @param {{source?: "favor"|"fuzzyDice"}} [options]  Preset source (tests,
 *   macros) - skips the picker.
 * @returns {Promise<boolean>} Whether the reroll went ahead.
 */
export async function rerollMessage(message, { source = null } = {}) {
  if (inFlight.has(message.id)) return false;
  const flags = message.flags[SCOPE] ?? {};
  const sources = rerollSources(message);
  if (!sources.length) {
    // Cards aren't redrawn when AI Favor runs out, so an older card can
    // still show the button.
    const actor = rerollActor(flags.aiReroll);
    if (actor?.isOwner && (actor.system.details?.aiFavor ?? 0) < 1) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Reroll.NoFavor", { name: actor.name }));
    } else {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Closed"));
    }
    return false;
  }

  // An Attack needs the Skill or Spell it rolled (a Scroll's cast rebuilds
  // its Spell) - checked before anything is spent.
  const spec = flags.aiReroll;
  if (spec?.kind === "attack" && !spec.castAs && !rerollActor(spec)?.items.get(spec.skillItemId)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
    return false;
  }

  inFlight.add(message.id);
  try {
    const chosen = source ? sources.find((s) => s.key === source)
      : sources.length === 1 ? sources[0] : await pickSource(sources);
    if (!chosen) return false;
    const base = rerollBase(message);
    const roll = await new Roll(rerollFormula(base)).evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
    return await sendRevision(message, "reroll", {
      source: chosen.key, natural: extractNaturalD20(roll), total: roll.total, roll: roll.toJSON(),
    });
  } finally {
    inFlight.delete(message.id);
  }
}

function onAiReroll(event, message) {
  event.preventDefault();
  return rerollMessage(message);
}

/**
 * AI Reroll the Evade on an Attack card's row (its d20 icon, module/chat/
 * attack-targets-card.mjs): the d20 again with the rest of the old total,
 * sent to the GM, who spends the AI Favor and re-grades the row.
 * @param {ChatMessage} message  The Attack card.
 * @param {string} rowId
 * @param {"free"|"evade"} which
 * @returns {Promise<boolean>}
 */
export async function rerollRow(message, rowId, which) {
  const key = `${message.id}:${rowId}:${which}`;
  if (inFlight.has(key)) return false;
  if (!rowRerollSources(message, rowId, which).length) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Closed"));
    return false;
  }
  // The row is written to the Attack card, normally the GM's: with no GM
  // online, nothing is spent on a reroll that can't land.
  if (!game.users.activeGM && !message.canUserModify(game.user, "update")) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return false;
  }
  const check = rowCheck(rowAt(message, rowId), which);
  inFlight.add(key);
  try {
    const roll = await new Roll(rerollFormula({ formula: check.formula, natural: check.natural, total: check.base })).evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
    return await sendRevision(message, "reroll", {
      rowId, which, source: "favor", natural: extractNaturalD20(roll), total: roll.total, roll: roll.toJSON(),
      breakdown: game.i18n.format("CARLRPG.Reaction.RerollBreakdown", { formula: roll.formula, total: roll.total }),
    });
  } finally {
    inFlight.delete(key);
  }
}

/** Registry entry for module/chat/chat-listener.mjs (drawn by decorateAiReroll). */
export const aiRerollActionEntries = [{ action: "aiReroll", custom: true, onClick: onAiReroll }];
