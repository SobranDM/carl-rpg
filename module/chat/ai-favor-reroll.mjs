/**
 * The "Reroll (AI Favor)" button on a crawler's Check card (rules and data:
 * module/helpers/ai-favor.mjs). Clicking it spends 1 AI Favor, rolls the d20
 * again with everything else kept, and posts the result as a new card; the
 * old card is marked rerolled and its buttons stop working. Shown only to
 * the crawler's owner (or the GM), while they have AI Favor, on a Check
 * that wasn't a Natural 1 and hasn't been rerolled or acted on yet.
 */
import CarlDice, { extractNaturalD20, withManaCostSubtitle } from "../dice/dice.mjs";
import { getDegreeOfSuccess, degreeBadge, isHitDegree } from "../helpers/rules.mjs";
import { rerollFormula, rerollOpen } from "../helpers/ai-favor.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { createRollMessage } from "./chat-card.mjs";
import { isCardLocked } from "./taunt-card.mjs";
import { recordRowEvade, resolveRowTarget } from "./attack-targets-card.mjs";

const SCOPE = "carl-rpg";
const inFlight = new Set();

/** @returns {Actor|null} The crawler who rolled the Check. */
function rerollActor(spec) {
  try {
    const doc = fromUuidSync(spec.actorUuid);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  } catch (err) {
    return null;
  }
}

/** The Attack card and row a row-Evade reroll writes to. */
function rowEvadeTarget(spec) {
  const attack = game.messages.get(spec.attackMessageId);
  const row = attack?.flags?.[SCOPE]?.targetRows?.[spec.rowId];
  return { attack, row };
}

/**
 * Whether the current user may reroll this card now.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function canReroll(message) {
  const flags = message.flags?.[SCOPE] ?? {};
  const spec = flags.aiReroll;
  if (!rerollOpen(spec) || flags.aiRerolled) return false;
  const actor = rerollActor(spec);
  if (actor?.type !== "character" || !actor.isOwner) return false;
  if ((actor.system.details?.aiFavor ?? 0) < 1) return false;
  // "Before the GM announces the result": not once the Attack has been
  // acted on (a row Evaded or applied, a Taunt, damage applied).
  if (spec.kind === "attack" && isCardLocked(message)) return false;
  if (spec.kind === "rowEvade") {
    const { row } = rowEvadeTarget(spec);
    if (!row || row.applied || row.replaced) return false;
    // A failed free Evade was followed by an ordinary one - that's the
    // result now.
    if (spec.free && !isHitDegree(spec.degree) && row.evade) return false;
    // The injury this Evade called for has already been added.
    if (flags.debuffAdded) return false;
  }
  return true;
}

/**
 * Per-viewer decoration (called from module/chat/chat-listener.mjs): the
 * reroll button on a card that offers one, or the "rerolled" state on a
 * card that's been replaced.
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
  if (!canReroll(message)) return;
  let footer = card.querySelector(".carl-chat-footer");
  if (!footer) {
    footer = document.createElement("footer");
    footer.className = "carl-chat-footer";
    card.append(footer);
  }
  const favor = rerollActor(flags.aiReroll)?.system.details?.aiFavor ?? 0;
  footer.insertAdjacentHTML("beforeend", `<div class="carl-ai-reroll">
    <button type="button" class="carl-ai-reroll-button" data-action="aiReroll" title="${game.i18n.localize("CARLRPG.Reroll.Hint")}">
      <i class="fas fa-dice-d20"></i> ${game.i18n.format("CARLRPG.Reroll.Button", { favor })}
    </button></div>`);
}

/** A new Roll of the same d20 expression plus the rest of the old total. */
async function rollAgain(spec) {
  const roll = await new Roll(rerollFormula(spec)).evaluate();
  const natural = extractNaturalD20(roll);
  return { roll, natural, total: roll.total, degree: getDegreeOfSuccess(natural, roll.total, spec.difficulty) };
}

const rerollNote = () => `<p class="carl-reroll-note">${game.i18n.localize("CARLRPG.Reroll.Note")}</p>`;

/** Stat, Skill, Opposed and sheet Evade Checks: a new card with the new d20. */
async function rerollCheck(spec, actor) {
  const { roll, total, degree } = await rollAgain(spec);
  let body = spec.body ?? "";
  const flags = { aiReroll: { ...spec, used: true } };
  if (spec.variant === "evade") {
    if (degree === "majorFail") body += `<p>${game.i18n.localize("CARLRPG.Roll.EvadeMajorFail")}</p>`;
    else if (degree === "criticalFail") body += `<p>${game.i18n.localize("CARLRPG.Roll.EvadeCriticalFail")}</p>`;
    Object.assign(flags, { evadeDegree: degree, evadeTotal: total });
  }
  return createRollMessage({
    rolls: [roll],
    rollMeta: [{ label: spec.label, detail: game.i18n.localize("CARLRPG.Reroll.Detail"), breakdown: spec.breakdown }],
    title: spec.title,
    subtitle: withManaCostSubtitle(game.i18n.localize(CONFIG.CARLRPG.degreesOfSuccess[degree]), spec.chosenManaCost),
    img: spec.img,
    badge: degreeBadge(degree),
    body: body + rerollNote(),
    flags,
    actor,
  });
}

/** An Attack row's Evade: the new result replaces the old one on the row. */
async function rerollRowEvade(spec, target) {
  const { attack, row } = rowEvadeTarget(spec);
  const { roll, degree } = await rollAgain(spec);
  await recordRowEvade(attack, row, target, {
    roll, breakdown: spec.breakdown, degree, debuffNote: spec.body ?? "", free: !!spec.free, reroll: spec,
  });
}

/**
 * Spend 1 AI Favor and reroll this card's Check (the button's action).
 * @param {ChatMessage} message
 * @returns {Promise<boolean>} Whether the reroll happened.
 */
export async function rerollMessage(message) {
  if (inFlight.has(message.id)) return false;
  const spec = message.flags[SCOPE]?.aiReroll;
  const actor = spec ? rerollActor(spec) : null;
  if (!canReroll(message)) {
    // Cards aren't redrawn when AI Favor runs out, so an older card can
    // still show the button.
    if (actor?.isOwner && (actor.system.details?.aiFavor ?? 0) < 1) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Reroll.NoFavor", { name: actor.name }));
    }
    return false;
  }

  // Everything the reroll needs, checked before any AI Favor is spent.
  let target = null;
  if (spec.kind === "attack" && !actor.items.get(spec.skillItemId)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
    return false;
  }
  if (spec.kind === "rowEvade") {
    const { attack, row } = rowEvadeTarget(spec);
    target = await resolveRowTarget(row);
    if (!target) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
      return false;
    }
    if (!attack.canUserModify(game.user, "update") && !game.users.activeGM) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
      return false;
    }
  }

  inFlight.add(message.id);
  try {
    const favor = actor.system.details?.aiFavor ?? 0;
    await actor.update({ "system.details.aiFavor": favor - 1 });
    await updateCardMessage(message, { flags: { [SCOPE]: { aiRerolled: true, aiReroll: { used: true } } } });
    if (spec.kind === "attack") await CarlDice.rerollAttack(message);
    else if (spec.kind === "rowEvade") await rerollRowEvade(spec, target);
    else await rerollCheck(spec, actor);
    return true;
  } finally {
    inFlight.delete(message.id);
  }
}

function onAiReroll(event, message) {
  event.preventDefault();
  return rerollMessage(message);
}

/** Registry entry for module/chat/chat-listener.mjs (drawn by decorateAiReroll). */
export const aiRerollActionEntries = [{ action: "aiReroll", custom: true, onClick: onAiReroll }];
