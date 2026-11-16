/**
 * A crawler's Check or Attack card, revised in place (docs/intervene.md):
 *  - **Intervene** (Interrupt, p.82): another crawler in the fight spends an
 *    Action, rolls 1d6 and adds it to the Check's total "after the result is
 *    announced". Any d20 Check but a Stat Check; several crawlers may each
 *    add one. Open while the fight is still on the round the card was
 *    rolled in, and until the card has been acted on.
 *  - **AI Favor reroll** (p.61): the d20 again, the card updated in place.
 *    Intervene d6s already added stay, and more can follow.
 * The card is re-graded from what it stores - its base d20 and total
 * (`aiReroll`) and its d6s (`interventions`) - and redrawn: an Attack's
 * target rows are re-graded (CarlDice.reviseAttack), a Check's Degree.
 *
 * Every revision is applied on the active GM's client, one at a time per
 * card (two Intervenes at once both land). With no GM online the roller's
 * own reroll still applies on their client. Stat Checks, Driving Checks and
 * the Evades on an Attack card's rows aren't covered yet (a Driving Check
 * and a row's Evade are still rerolled as a new card).
 */
import CarlDice, { checkSubtitle, interventionRolls, withManaCostSubtitle } from "../dice/dice.mjs";
import { degreeBadge, getDegreeOfSuccess } from "../helpers/rules.mjs";
import { isCrawler } from "../helpers/actor-kinds.mjs";
import { canAct, payAction } from "../helpers/actions.mjs";
import { esc, renderRollCard } from "./chat-card.mjs";
import { isCardLocked } from "./taunt-card.mjs";

const SCOPE = "carl-rpg";
const SOCKET = "system.carl-rpg";
const OP = "checkRevision";

/** The cards revised in place: a Skill, Spell, Opposed or Evade Check, and an Attack. */
const KINDS = new Set(["check", "attack"]);

/* -------------------------------------------- */
/*  Reading a card                              */
/* -------------------------------------------- */

/** A card's base Check (`flags.carl-rpg.aiReroll`), or null. */
function specOf(message) {
  return message?.flags?.[SCOPE]?.aiReroll ?? null;
}

/**
 * The Intervene d6s on a card.
 * @param {ChatMessage} message
 * @returns {{id: string, byUuid: string, byName: string, value: number, roll: object}[]}
 */
export function interventionsOf(message) {
  return message?.flags?.[SCOPE]?.interventions ?? [];
}

/** Whether this card is one revised in place. */
export function revisedInPlace(message) {
  const spec = specOf(message);
  return !!spec && KINDS.has(spec.kind);
}

/** An Actor from a token or actor uuid (sync), or null. */
function actorOf(uuid) {
  try {
    const doc = uuid ? fromUuidSync(uuid) : null;
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  } catch (err) {
    return null;
  }
}

/**
 * The fight a card was rolled in, while it's still on that round - or null.
 * @param {object|null} spec
 * @returns {Combat|null}
 */
export function cardFight(spec) {
  const combat = spec?.fight ? game.combats.get(spec.fight.combatId) : null;
  return combat?.started && combat.round === spec.fight.round ? combat : null;
}

/**
 * Whether an Intervene can still change this card: a crawler's Check or
 * Attack (not a Stat Check, p.82), rolled in a fight that's still on that
 * round, not a Natural 1 or 20 (their result is fixed), not replaced, and -
 * an Attack - not acted on yet.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function interveneOpen(message) {
  const flags = message?.flags?.[SCOPE] ?? {};
  const spec = flags.aiReroll;
  if (!spec || !KINDS.has(spec.kind) || spec.variant === "stat" || flags.aiRerolled) return false;
  if (spec.natural === 1 || spec.natural === 20) return false;
  if (!cardFight(spec)) return false;
  if (spec.kind === "attack" && isCardLocked(message)) return false;
  return true;
}

/**
 * The crawlers this user could Intervene with on this card: their own (any,
 * for the GM) in the card's fight, other than the roller.
 * @param {ChatMessage} message
 * @param {User} [user]
 * @returns {Actor[]}
 */
export function interveners(message, user = game.user) {
  const spec = specOf(message);
  const combat = cardFight(spec);
  if (!combat) return [];
  const roller = actorOf(spec.actorUuid);
  const seen = new Set();
  return combat.combatants.map((c) => c.actor).filter((actor) => {
    if (!actor || !isCrawler(actor) || actor === roller || seen.has(actor.uuid)) return false;
    seen.add(actor.uuid);
    return user.isGM || actor.testUserPermission(user, "OWNER");
  });
}

/* -------------------------------------------- */
/*  The button                                  */
/* -------------------------------------------- */

/**
 * Per-viewer decoration (module/chat/chat-listener.mjs): the Intervene
 * button, for the crawlers' owners who could use it.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateIntervene(message, html) {
  if (!interveneOpen(message) || !interveners(message).length) return;
  const card = html.querySelector(".carl-chat-card");
  if (!card) return;
  let footer = card.querySelector(".carl-chat-footer");
  if (!footer) {
    footer = document.createElement("footer");
    footer.className = "carl-chat-footer";
    card.append(footer);
  }
  const roller = actorOf(specOf(message).actorUuid);
  footer.insertAdjacentHTML("beforeend", `<div class="carl-intervene">
    <button type="button" class="carl-intervene-button" data-action="intervene"
      data-tooltip="${esc(game.i18n.format("CARLRPG.Intervene.Hint", { name: roller?.name ?? "?" }))}">
      <i class="fa-solid fa-handshake-angle"></i> ${esc(game.i18n.localize("CARLRPG.Intervene.Button"))}
    </button></div>`);
}

/** Pick one of several crawlers (none asked with one). */
async function pickIntervener(list) {
  if (list.length <= 1) return list[0] ?? null;
  const options = list.map((a) => `<option value="${esc(a.uuid)}">${esc(a.name)}</option>`).join("");
  const uuid = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("CARLRPG.Intervene.Button") },
    classes: ["carl-intervene-pick"],
    content: `<div class="form-group"><label>${esc(game.i18n.localize("CARLRPG.Reaction.Who"))}</label>
      <div class="form-fields"><select name="who">${options}</select></div></div>`,
    ok: { label: game.i18n.localize("CARLRPG.Reaction.Choose"), callback: (event, button) => button.form.elements.who.value },
    rejectClose: false,
  });
  return list.find((a) => a.uuid === uuid) ?? null;
}

/**
 * Intervene on a card: pick who, roll their d6 (shown), and send it to the
 * GM, who spends their Action and re-grades the card.
 * @param {ChatMessage} message
 * @param {{intervener?: Actor, roll?: Roll}} [options]  Preset (tests).
 * @returns {Promise<boolean>}
 */
export async function intervene(message, { intervener = null, roll = null } = {}) {
  if (!interveneOpen(message)) return false;
  const who = intervener ?? await pickIntervener(interveners(message));
  if (!who || !canAct(who, "other")) return false;
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return false;
  }
  const d6 = roll ?? await new Roll("1d6").evaluate();
  if (game.dice3d && !roll) await game.dice3d.showForRoll(d6, game.user, true);
  return sendRevision(message, "intervene", { byUuid: who.uuid, byName: who.name, value: d6.total, roll: d6.toJSON() });
}

function onIntervene(event, message) {
  event.preventDefault();
  return intervene(message);
}

/** Registry entry for module/chat/chat-listener.mjs (drawn by decorateIntervene). */
export const interveneActionEntries = [{ action: "intervene", custom: true, onClick: onIntervene }];

/* -------------------------------------------- */
/*  Applying a revision (GM)                    */
/* -------------------------------------------- */

/**
 * Send a revision to the active GM, or apply it here (the GM; or, with no
 * GM online, the roller's own reroll of a card they can update).
 * @param {ChatMessage} message
 * @param {"intervene"|"reroll"} op
 * @param {object} data
 * @returns {Promise<boolean>}
 */
export async function sendRevision(message, op, data) {
  if (game.users.activeGM?.isSelf) return applyRevision(message.id, op, data, game.user);
  if (!game.users.activeGM) {
    if (op === "reroll" && message.canUserModify(game.user, "update")) return applyRevision(message.id, op, data, game.user);
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return false;
  }
  game.socket.emit(SOCKET, { type: OP, cardId: message.id, op, data });
  return true;
}

/** Register the GM side of the socket. Call once from `ready`. */
export function registerCheckRevisionSocket() {
  game.socket.on(SOCKET, (payload, senderId) => {
    if (payload?.type !== OP || !game.users.activeGM?.isSelf) return;
    const user = game.users.get(senderId);
    if (user) void applyRevision(payload.cardId, payload.op, payload.data ?? {}, user);
  });
}

// Revisions per card, one at a time.
const queues = new Map();

/**
 * Apply one revision to a card, after any earlier one.
 * @param {string} cardId
 * @param {"intervene"|"reroll"|"unintervene"} op
 * @param {object} data
 * @param {User} user  Who asked.
 * @returns {Promise<boolean>}  Whether the card changed.
 */
export function applyRevision(cardId, op, data, user) {
  const task = () => reviseNow(cardId, op, data, user).catch((err) => {
    console.error(`CarlRPG | revising a card: "${op}" failed`, err);
    return false;
  });
  const next = (queues.get(cardId) ?? Promise.resolve()).then(task, task);
  queues.set(cardId, next);
  return next;
}

async function reviseNow(cardId, op, data, user) {
  const message = game.messages.get(cardId);
  const spec = specOf(message);
  if (!message || !revisedInPlace(message)) return false;
  let interventions = [...interventionsOf(message)];
  let reroll = null;
  let pay = null;
  let favorFrom = null;

  switch (op) {
    case "intervene": {
      if (!interveneOpen(message)) return false;
      const actor = actorOf(data.byUuid);
      const value = Math.trunc(Number(data.value));
      if (!actor || !(value >= 1 && value <= 6)) return false;
      if (!interveners(message, user).includes(actor)) return false;
      const entry = { id: foundry.utils.randomID(), byUuid: actor.uuid, byName: String(data.byName ?? actor.name), value, roll: data.roll ?? null };
      interventions.push(entry);
      pay = { actor, entry };
      break;
    }
    case "unintervene": {
      if (!user.isGM) return false;
      const kept = interventions.filter((i) => i.id !== data.id);
      if (kept.length === interventions.length) return false;
      interventions = kept;
      break;
    }
    case "reroll": {
      const actor = actorOf(spec.actorUuid);
      if (!actor || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return false;
      if (spec.used || spec.natural === 1 || (spec.kind === "attack" && isCardLocked(message))) return false;
      const favor = actor.system.details?.aiFavor ?? 0;
      if (actor.type !== "character" || favor < 1) return false;
      reroll = { natural: Number(data.natural), total: Number(data.total), roll: data.roll };
      favorFrom = actor;
      break;
    }
    default:
      return false;
  }

  const parts = spec.kind === "attack"
    ? await CarlDice.reviseAttack(message, { interventions, reroll })
    : reviseCheck(message, { interventions, reroll });
  if (!parts) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
    return false;
  }
  // The intervener's Action, now the card is ready to change: refused with
  // none left. Undoing it takes this d6 back off (helpers/action-undo.mjs).
  if (pay) {
    const roller = actorOf(spec.actorUuid);
    const label = game.i18n.format("CARLRPG.Actions.Label.Intervene", { name: roller?.name ?? "?" });
    const { paid } = await payAction(pay.actor, "other", label, { undo: [{ t: "intervene", messageId: cardId, id: pay.entry.id }] });
    if (!paid) return false;
  }
  // The AI Favor a reroll costs (p.61).
  if (favorFrom) await favorFrom.update({ "system.details.aiFavor": Math.max(0, (favorFrom.system.details?.aiFavor ?? 0) - 1) });
  await writeCard(message, parts);
  return true;
}

/**
 * A Skill, Spell, Opposed or Evade Check card's new parts: its Degree from
 * the base total plus the d6s.
 * @param {ChatMessage} message
 * @param {{interventions: object[], reroll: object|null}} change
 * @returns {object}
 */
function reviseCheck(message, { interventions, reroll }) {
  const spec = foundry.utils.deepClone(specOf(message));
  let base = message.rolls?.[0];
  if (reroll) {
    spec.rerolledFrom = { natural: spec.natural, total: spec.total };
    Object.assign(spec, { natural: reroll.natural, total: reroll.total, used: true });
    base = Roll.fromData(reroll.roll);
  }
  const total = spec.total + interventions.reduce((sum, i) => sum + (Number(i.value) || 0), 0);
  const degree = getDegreeOfSuccess(spec.natural, total, spec.difficulty);
  const flags = { aiReroll: spec, interventions };
  let body = spec.body ?? "";
  if (spec.variant === "evade") {
    if (degree === "majorFail") body += `<p>${game.i18n.localize("CARLRPG.Roll.EvadeMajorFail")}</p>`;
    else if (degree === "criticalFail") body += `<p>${game.i18n.localize("CARLRPG.Roll.EvadeCriticalFail")}</p>`;
    Object.assign(flags, { evadeDegree: degree, evadeTotal: total });
  }
  if (spec.used) body += `<p class="carl-reroll-note">${game.i18n.localize("CARLRPG.Reroll.Note")}</p>`;
  const d6 = interventionRolls(interventions);
  return {
    rolls: [base, ...d6.rolls],
    rollMeta: [
      { label: spec.label, detail: spec.used ? game.i18n.localize("CARLRPG.Reroll.Detail") : "", breakdown: spec.breakdown },
      ...d6.meta,
    ],
    extraRollRows: d6.totalRow(total),
    title: spec.title,
    subtitle: withManaCostSubtitle(checkSubtitle(degree, spec.difficulty), spec.chosenManaCost),
    img: spec.img,
    badge: degreeBadge(degree),
    body,
    flags,
    unset: [],
  };
}

/**
 * Write a card's new parts: its content, Rolls and flags. The per-row and
 * dice records are replaced whole, so a stale key can't survive a merge.
 * @param {ChatMessage} message
 * @param {object} parts
 */
async function writeCard(message, parts) {
  const { ForcedReplacement } = foundry.data.operators;
  const content = await renderRollCard(parts, !!message.blind);
  const flags = { ...parts.flags, interventions: ForcedReplacement.create(parts.flags.interventions ?? []) };
  if (flags.targetRows) flags.targetRows = ForcedReplacement.create(flags.targetRows);
  if (flags.attackDice) flags.attackDice = ForcedReplacement.create(flags.attackDice);
  const { ForcedDeletion } = foundry.data.operators;
  for (const key of parts.unset ?? []) {
    if (message.flags?.[SCOPE]?.[key] !== undefined) flags[key] = new ForcedDeletion();
  }
  await message.update({ content, rolls: parts.rolls, flags: { [SCOPE]: flags } });
}
