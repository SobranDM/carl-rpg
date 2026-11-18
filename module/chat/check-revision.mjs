/**
 * A crawler's Check card, revised in place (docs/intervene.md):
 *  - **Intervene** (Interrupt, p.82): another crawler in the fight spends an
 *    Action, rolls 1d6 and adds it to the Check's total "after the result is
 *    announced". Any d20 Check but a Stat Check; several crawlers may each
 *    add one. Open while the fight is still on the round the card was
 *    rolled in, and until the card has been acted on.
 *  - **Rerolls:** the d20 again, the card updated in place - AI Favor (p.61)
 *    on any of these cards, Fuzzy Dice (p.73) on a Driving Check. Intervene
 *    d6s already added stay, and more can follow.
 * The kinds (`KINDS`): a Skill, Spell, Opposed, Stat or Evade Check
 * ("check"), an Attack ("attack"; CarlDice.reviseAttack re-grades its
 * target rows), and a Driving Check ("driving"; module/helpers/
 * vehicle-driving.mjs re-commits the vehicle's round). Each is re-graded
 * from what it stores - its base d20 and total and its d6s
 * (`interventions`) - and redrawn.
 *
 * The Evade on an Attack card's row is revised too, addressed by row
 * (`rowId`, `which`: module/chat/row-evade.mjs): only that row is written.
 *
 * Every revision is applied on the active GM's client, one at a time per
 * card (two Intervenes at once both land; a row and its Attack share the
 * card's queue). With no GM online the roller's own reroll still applies on
 * their client, as far as it can.
 */
import CarlDice, { checkSubtitle, interventionRolls, withManaCostSubtitle } from "../dice/dice.mjs";
import { degreeBadge, getDegreeOfSuccess } from "../helpers/rules.mjs";
import { isCrawler } from "../helpers/actor-kinds.mjs";
import { canAct, payAction } from "../helpers/actions.mjs";
import { rerollOpen } from "../helpers/ai-favor.mjs";
import { resolveOccupant } from "../helpers/vehicle-state.mjs";
import { queueOn } from "../helpers/actor-queue.mjs";
import { canDrive, drivingOpen, reviseDriving, upgradeReady } from "../helpers/vehicle-driving.mjs";
import { updateVehicle } from "../helpers/vehicles.mjs";
import { esc, renderRollCard } from "./chat-card.mjs";
import { isCardLocked } from "./taunt-card.mjs";
import { reviseRow, rowAt, rowCheck, rowCheckOpen, rowInterveneOpen, rowInterveners, rowRerollSources } from "./row-evade.mjs";

const SCOPE = "carl-rpg";
const SOCKET = "system.carl-rpg";
const OP = "checkRevision";

/**
 * The kinds of card revised in place: whether each can still change, and
 * how it's revised (its new parts; `after`, if any, runs once they're
 * written).
 */
const KINDS = {
  check: { open: () => true, revise: async (message, change) => reviseCheck(message, change) },
  attack: { open: (message) => !isCardLocked(message), revise: (message, change) => CarlDice.reviseAttack(message, change) },
  driving: { open: drivingOpen, revise: reviseDriving },
};

/* -------------------------------------------- */
/*  Reading a card                              */
/* -------------------------------------------- */

/** A card's base Check (`flags.carl-rpg.aiReroll`), or null. */
function specOf(message) {
  return message?.flags?.[SCOPE]?.aiReroll ?? null;
}

/**
 * Which kind of revisable card this is, or null. A Driving card is one
 * even without `aiReroll` (a Pet driver's, which only Fuzzy Dice rerolls).
 * @param {ChatMessage} message
 * @returns {string|null}
 */
function kindOf(message) {
  const flags = message?.flags?.[SCOPE] ?? {};
  const kind = flags.aiReroll?.kind ?? (flags.driving ? "driving" : null);
  return kind && KINDS[kind] ? kind : null;
}

/**
 * Whether a card can still change - before asking who could change it, or
 * how: not replaced by an older (new-card) reroll, and not acted on.
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function cardOpen(message) {
  const kind = kindOf(message);
  if (!kind || message.flags[SCOPE].aiRerolled) return false;
  return KINDS[kind].open(message);
}

/**
 * The Check a reroll rolls again: its d20 expression, the rest of its total
 * and its Difficulty. A Driving card's lives on `driving.roll`.
 * @param {ChatMessage} message
 * @returns {{formula: string, natural: number, total: number, difficulty: number|null}|null}
 */
export function rerollBase(message) {
  const flags = message?.flags?.[SCOPE] ?? {};
  return kindOf(message) === "driving" ? (flags.driving.roll ?? null) : (flags.aiReroll ?? null);
}

/**
 * The rerolls this user could make on this card now, in the order offered:
 *  - **AI Favor** (p.61): the crawler's owner (or the GM), with AI Favor
 *    left; once per Check, never a Natural 1;
 *  - **Fuzzy Dice** (p.73): a Driving Check, for whoever drives it, while
 *    the vehicle's Fuzzy Dice are unused this Floor.
 * @param {ChatMessage} message
 * @param {User} [user]
 * @returns {Array<{key: "favor"|"fuzzyDice", actor?: Actor, favor?: number, vehicle?: Actor}>}
 */
export function rerollSources(message, user = game.user) {
  if (!cardOpen(message)) return [];
  const flags = message.flags[SCOPE];
  const sources = [];
  const spec = flags.aiReroll;
  if (rerollOpen(spec)) {
    const actor = actorOf(spec.actorUuid);
    const favor = actor?.system.details?.aiFavor ?? 0;
    if (actor?.type === "character" && favor >= 1 && (user.isGM || actor.testUserPermission(user, "OWNER"))) {
      sources.push({ key: "favor", actor, favor });
    }
  }
  if (flags.driving) {
    const vehicle = resolveOccupant(flags.driving.vehicleUuid);
    if (vehicle && canDrive(vehicle, user) && upgradeReady(vehicle, "fuzzyDice")) sources.push({ key: "fuzzyDice", vehicle });
  }
  return sources;
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
  return !!kindOf(message);
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
 * Whether an Intervene can still change this card: a crawler's Check (not a
 * Stat Check, p.82), rolled in a fight that's still on that round, not a
 * Natural 1 or 20 (their result is fixed), and still open (`cardOpen`: an
 * Attack not acted on, a row's Evade whose row isn't applied, a Driving
 * result not used).
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function interveneOpen(message) {
  const spec = specOf(message);
  if (!spec || spec.variant === "stat") return false;
  if (spec.natural === 1 || spec.natural === 20) return false;
  if (!cardFight(spec)) return false;
  return cardOpen(message);
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
  const roller = actorOf(specOf(message).actorUuid);
  const hint = esc(game.i18n.format("CARLRPG.Intervene.Hint", { name: roller?.name ?? "?" }));
  // The handshake icon, named in its tooltip - beside the Reroll d20.
  rollIcons(html)?.insertAdjacentHTML("afterbegin", `<button type="button" class="carl-status-icon carl-intervene-button" data-action="intervene"
      data-tooltip="${hint}" aria-label="${hint}"><i class="fa-solid fa-handshake-angle" aria-hidden="true"></i></button>`);
}

/**
 * The card footer's strip of roll icons (Intervene, Reroll), made on first
 * use. Shared with module/chat/ai-favor-reroll.mjs.
 * @param {HTMLElement} html
 * @returns {HTMLElement|null}
 */
export function rollIcons(html) {
  const card = html.querySelector(".carl-chat-card");
  if (!card) return null;
  let footer = card.querySelector(".carl-chat-footer");
  if (!footer) {
    footer = document.createElement("footer");
    footer.className = "carl-chat-footer";
    card.append(footer);
  }
  let strip = footer.querySelector(":scope > .carl-roll-icons");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "carl-roll-icons";
    footer.append(strip);
  }
  return strip;
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
  if (!interveneOpen(message)) {
    // A card not redrawn since it closed (its round ended, say).
    ui.notifications.warn(game.i18n.localize("CARLRPG.Intervene.Closed"));
    return false;
  }
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

/**
 * Intervene on the Evade of an Attack card's row (its handshake icon): pick
 * who, roll their d6 (shown), and send it to the GM, who spends their
 * Action and re-grades the row.
 * @param {ChatMessage} message  The Attack card.
 * @param {string} rowId
 * @param {"free"|"evade"} which
 * @param {{intervener?: Actor, roll?: Roll}} [options]  Preset (tests).
 * @returns {Promise<boolean>}
 */
export async function interveneRow(message, rowId, which, { intervener = null, roll = null } = {}) {
  if (!rowInterveneOpen(message, rowId, which)) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Intervene.Closed"));
    return false;
  }
  const who = intervener ?? await pickIntervener(rowInterveners(message, rowId, which));
  if (!who || !canAct(who, "other")) return false;
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return false;
  }
  const d6 = roll ?? await new Roll("1d6").evaluate();
  if (game.dice3d && !roll) await game.dice3d.showForRoll(d6, game.user, true);
  return sendRevision(message, "intervene", { rowId, which, byUuid: who.uuid, byName: who.name, value: d6.total, roll: d6.toJSON() });
}

/** Registry entry for module/chat/chat-listener.mjs (drawn by decorateIntervene). */
export const interveneActionEntries = [{ action: "intervene", custom: true, onClick: onIntervene }];

/* -------------------------------------------- */
/*  Applying a revision (GM)                    */
/* -------------------------------------------- */

/**
 * Send a revision to the active GM, or apply it here (the GM; or, with no
 * GM online, the roller's own reroll of a card they can update). The
 * payload names the card as `cardId` - the chat socket keys on `messageId`.
 * @param {ChatMessage} message
 * @param {"intervene"|"reroll"} op
 * @param {object} data  A reroll: {source, natural, total, roll}.
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

// Revisions, one at a time per queue: a card, or - a row's Evade - the
// Attack card it shares its state with.
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
  return queueOn(queues, cardId, task);
}

async function reviseNow(cardId, op, data, user) {
  const message = game.messages.get(cardId);
  if (data?.rowId) return reviseRowNow(message, op, data, user);
  const kind = kindOf(message);
  if (!kind) return false;
  const spec = specOf(message);
  let interventions = [...interventionsOf(message)];
  let reroll = null;
  let pay = null;
  let source = null;

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
      // The source must still be one this user has (rerollSources checks the
      // card is open, and the AI Favor or Fuzzy Dice is there to spend).
      source = rerollSources(message, user).find((s) => s.key === (data.source ?? "favor"));
      if (!source) return false;
      reroll = { natural: Number(data.natural), total: Number(data.total), roll: data.roll, source: source.key };
      break;
    }
    default:
      return false;
  }

  const parts = await KINDS[kind].revise(message, { interventions, reroll });
  if (!parts) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
    return false;
  }
  // Re-checked now its new parts are ready: something done meanwhile (a
  // row applied) closes it. Undoing a d6 was checked by its undo.
  if (op !== "unintervene" && !cardOpen(message)) return false;
  // The intervener's Action, now the card is ready to change: refused with
  // none left. Undoing it takes this d6 back off (helpers/action-undo.mjs).
  if (pay) {
    const roller = actorOf(spec.actorUuid);
    const label = game.i18n.format("CARLRPG.Actions.Label.Intervene", { name: roller?.name ?? "?" });
    const { paid } = await payAction(pay.actor, "other", label, { undo: [{ t: "intervene", messageId: cardId, id: pay.entry.id }] });
    if (!paid) return false;
  }
  // What a reroll costs: 1 AI Favor (p.61), or the vehicle's Fuzzy Dice for
  // this Floor (p.73).
  if (source?.key === "favor") {
    await source.actor.update({ "system.details.aiFavor": Math.max(0, (source.actor.system.details?.aiFavor ?? 0) - 1) });
  } else if (source?.key === "fuzzyDice") {
    if (!await updateVehicle(source.vehicle, { "system.upgrades.fuzzyDice.usedFloor": game.settings.get(SCOPE, "currentFloor") })) return false;
  }
  await writeCard(message, parts);
  if (parts.after) await parts.after();
  return true;
}

/**
 * A revision of the Evade on an Attack card's row (module/chat/row-evade.mjs):
 * an Intervene, its undo, or an AI Reroll - only that row is written.
 * @param {ChatMessage|undefined} message  The Attack card.
 * @param {"intervene"|"reroll"|"unintervene"} op
 * @param {{rowId: string, which: "free"|"evade"}} data
 * @param {User} user
 * @returns {Promise<boolean>}
 */
async function reviseRowNow(message, op, data, user) {
  const { rowId, which } = data;
  const check = rowCheck(rowAt(message, rowId), which);
  if (!check) return false;
  let interventions = [...(check.interventions ?? [])];
  let reroll = null;
  let pay = null;
  let source = null;
  switch (op) {
    case "intervene": {
      if (!rowInterveneOpen(message, rowId, which)) return false;
      const actor = actorOf(data.byUuid);
      const value = Math.trunc(Number(data.value));
      if (!actor || !(value >= 1 && value <= 6)) return false;
      if (!rowInterveners(message, rowId, which, user).includes(actor)) return false;
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
      source = rowRerollSources(message, rowId, which, user).find((s) => s.key === (data.source ?? "favor"));
      if (!source) return false;
      reroll = { natural: Number(data.natural), total: Number(data.total), roll: data.roll ?? null, breakdown: data.breakdown };
      break;
    }
    default:
      return false;
  }
  const revised = await reviseRow(message, rowId, which, { interventions, reroll });
  if (!revised) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
    return false;
  }
  // Re-checked now: something done meanwhile (the row applied) closes it.
  if (op !== "unintervene" && !rowCheckOpen(message, rowId, which)) return false;
  if (pay) {
    const roller = actorOf(check.actorUuid);
    const label = game.i18n.format("CARLRPG.Actions.Label.Intervene", { name: roller?.name ?? "?" });
    const { paid } = await payAction(pay.actor, "other", label, {
      undo: [{ t: "intervene", messageId: message.id, id: pay.entry.id, rowId, which }],
    });
    if (!paid) return false;
  }
  if (source?.key === "favor") {
    await source.actor.update({ "system.details.aiFavor": Math.max(0, (source.actor.system.details?.aiFavor ?? 0) - 1) });
  }
  await revised.write();
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
  if (flags.driving?.rerolledBy) flags.driving = { ...flags.driving, rerolledBy: ForcedReplacement.create(flags.driving.rerolledBy) };
  if (flags.targetRows) flags.targetRows = ForcedReplacement.create(flags.targetRows);
  if (flags.attackDice) flags.attackDice = ForcedReplacement.create(flags.attackDice);
  const { ForcedDeletion } = foundry.data.operators;
  for (const key of parts.unset ?? []) {
    if (message.flags?.[SCOPE]?.[key] !== undefined) flags[key] = new ForcedDeletion();
  }
  await message.update({ content, rolls: parts.rolls, flags: { [SCOPE]: flags } });
}
