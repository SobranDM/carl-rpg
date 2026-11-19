/**
 * Party Skill Checks (The Core Mechanic, p.59): "every player rolls a Skill
 * Check for their crawler and compares it to the Difficulty. If half or more
 * of the party succeeds on their individual Skill Checks, the party
 * succeeds. The crawlers can't aid each other."
 *
 * The GM calls one from the Toolbox (module/apps/gm-toolbox.mjs): the
 * Skill's name, the Difficulty and who rolls. The card has a status row per
 * crawler (module/chat/status-rows.mjs), each with a Roll button for its
 * player - or, for a crawler no logged-in player owns, for the GM. A crawler
 * who owns the Skill rolls it; one who doesn't makes the Stat Check with
 * Disadvantage that an untrained Skill is (ruled 2026-11-18): an unsaved
 * Rank 0 copy (race-class-grants.mjs skillOrUntrainedCopy), as Command Pet
 * rolls Animal Handling. Its Stat is the compendium Skill's; a Skill in no
 * compendium has none, and the roll dialog's Stat dropdown picks one.
 *
 * Rolls post no card of their own (nobody may aid them - no Intervene).
 * Like the Reaction card, the roll is made on the roller's client and sent
 * to the active GM's client as an operation, which applies it to the
 * card's current state one at a time per card, refusing a row already
 * rolled or a closed card, and grades it against the card's Difficulty.
 * The card tallies as rows come in; once everyone has rolled, or the GM
 * closes it, it says whether the party succeeds (partyTally).
 */
import CarlDice from "../dice/dice.mjs";
import { createCardMessage } from "./chat-card.mjs";
import { headerProgress, iconButton, rememberOpenRows, statusChip, statusRow, statusSection, trackPerCard, versusNum } from "./status-rows.mjs";
import { queueForCard } from "../helpers/actor-queue.mjs";
import { findSkillLikeItem, skillOrUntrainedCopy } from "../helpers/race-class-grants.mjs";
import { degreeLabel, getDegreeOfSuccess, isHitDegree } from "../helpers/rules.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import { ownedByActivePlayer } from "../apps/actor-picker.mjs";
import { esc } from "../helpers/html.mjs";
import { actorFromUuid } from "../helpers/token-resolution.mjs";

const SCOPE = "carl-rpg";
const SOCKET = "system.carl-rpg";
// Never a `messageId` in the payload: the chat socket (helpers/chat-socket.mjs)
// treats any payload carrying one as a message update.
const OP = "partyCheckOp";
const FLAG = "partyCheck";

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */


/**
 * A new card's state.
 * @param {{skill: string, stat?: string, difficulty: number, actors: Actor[]}} args
 * @returns {object}
 */
export function buildPartyCheckState({ skill, stat = "", difficulty, actors }) {
  return {
    skill,
    stat,
    difficulty,
    closed: false,
    rows: Object.fromEntries(actors.map((a, i) => [`c${i}`, { uuid: a.uuid, name: a.name, check: null }])),
  };
}

/** The rows in order, each with its id. */
export function partyRows(state) {
  return Object.entries(state?.rows ?? {})
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([id, row]) => ({ id, ...row }));
}

/**
 * The tally (p.59): "If half or more of the party succeeds ... the party
 * succeeds." Settled once every crawler has rolled, or the GM closed it -
 * then only those who rolled count (a crawler who never rolled is out of
 * it, not a failure); a card closed with no rolls has no outcome.
 * @param {object} state
 * @returns {{total: number, rolled: number, successes: number, settled: boolean, outcome: "succeeds"|"fails"|"none"|null}}
 */
export function partyTally(state) {
  const rows = partyRows(state);
  const rolled = rows.filter((r) => r.check);
  const successes = rolled.filter((r) => r.check.success).length;
  const settled = !!state?.closed || (rows.length > 0 && rolled.length === rows.length);
  let outcome = null;
  if (settled) outcome = !rolled.length ? "none" : (successes * 2 >= rolled.length ? "succeeds" : "fails");
  return { total: rows.length, rolled: rolled.length, successes, settled, outcome };
}

/**
 * Grade a roll against the card's Difficulty (the roller's dialog field is
 * editable - the card's number is the one that counts).
 * @param {{total: number, naturalRoll: number|null}} roll
 * @param {number} difficulty
 * @returns {{degree: string, success: boolean}}
 */
export function gradePartyRoll(roll, difficulty) {
  const degree = getDegreeOfSuccess(roll.naturalRoll ?? null, Number(roll.total) || 0, difficulty);
  return { degree, success: isHitDegree(degree) };
}

/**
 * Who may roll a row here: its crawler's player - or the GM, when no
 * logged-in player owns it.
 * @param {object} row
 * @param {User} [user]
 * @returns {boolean}
 */
export function canRollRow(row, user = game.user) {
  const actor = actorFromUuid(row?.uuid);
  if (!actor) return false;
  if (user.isGM) return !ownedByActivePlayer(actor);
  return actor.testUserPermission(user, "OWNER");
}

/* -------------------------------------------- */
/*  Posting                                     */
/* -------------------------------------------- */

/**
 * Post a Party Skill Check card (GM - the Toolbox). The Skill's Stat, for an
 * untrained roll, is the compendium (or world) Skill's.
 * @param {{skill: string, difficulty: number, actors: Actor[]}} args
 * @returns {Promise<ChatMessage|null>}
 */
export async function postPartyCheck({ skill, difficulty, actors }) {
  const name = String(skill ?? "").trim();
  if (!name || !actors?.length) return null;
  const source = await findSkillLikeItem(name);
  const state = buildPartyCheckState({
    skill: source?.name ?? name, stat: source?.system?.governingStat ?? "", difficulty: Number(difficulty) || 0, actors,
  });
  return createCardMessage({
    title: game.i18n.format("CARLRPG.PartyCheck.Title", { skill: state.skill }),
    subtitle: game.i18n.format("CARLRPG.PartyCheck.Subtitle", { difficulty: state.difficulty }),
    img: source?.img ?? "icons/svg/d20-grey.svg",
    body: `<div class="carl-party-check"></div>`,
    flags: { kind: "partyCheck", [FLAG]: state },
    speaker: { alias: game.i18n.localize("CARLRPG.PartyCheck.Speaker") },
  });
}

/* -------------------------------------------- */
/*  Rolling (the roller's client)               */
/* -------------------------------------------- */

/**
 * Roll a row's Check and send it to the GM: the crawler's own Skill, else
 * an untrained Stat Check with Disadvantage.
 * @param {ChatMessage} message
 * @param {string} rowId
 * @returns {Promise<boolean>}  Whether a roll was sent.
 */
export async function rollPartyRow(message, rowId) {
  const state = message.getFlag(SCOPE, FLAG);
  const row = state?.rows?.[rowId];
  if (!row || row.check || state.closed || !canRollRow(row)) return false;
  const actor = actorFromUuid(row.uuid);
  if (!actor) return false;
  const { skill, trained } = await skillOrUntrainedCopy(actor, state.skill, { system: { governingStat: state.stat ?? "" } });
  const result = await CarlDice.rollOpposedSkillCheck(actor, skill, {
    // Called for by the GM, not an Action of its own.
    difficulty: state.difficulty, opponent: null, post: false, markUse: trained, isAction: false,
  });
  if (!result) return false;
  if (result.roll && game.dice3d) void game.dice3d.showForRoll(result.roll, game.user, true).catch(() => {});
  await sendOp(message, "roll", {
    rowId,
    check: {
      total: result.total, naturalRoll: result.naturalRoll ?? null, formula: result.formula ?? null,
      breakdown: String(result.breakdown ?? ""), roll: result.roll?.toJSON?.() ?? null,
      // The Stat it was rolled with, shown on the row when it isn't the
      // Skill's own (Off-Stat, p.58), so the table can see it.
      stat: String(result.statKey ?? ""),
      // Owned but Rank 0 still rolls with Disadvantage (dice.mjs); "trained" is "owns it".
      trained: !!trained && (Number(skill.system.rank) || 0) > 0,
    },
  });
  return true;
}

/* -------------------------------------------- */
/*  The GM's side                               */
/* -------------------------------------------- */

/** Send an operation to the active GM's client (or apply it, on that client). */
async function sendOp(message, op, data) {
  if (game.users.activeGM?.isSelf) return applyPartyOp(message.id, op, data, game.user);
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return false;
  }
  game.socket.emit(SOCKET, { type: OP, cardId: message.id, op, data });
  return true;
}

/** Register the GM side of the socket. Call once from `ready`. */
export function registerPartyCheckSocket() {
  game.socket.on(SOCKET, (payload, senderId) => {
    if (payload?.type !== OP || !game.users.activeGM?.isSelf) return;
    const user = game.users.get(senderId);
    if (user) void applyPartyOp(payload.cardId, payload.op, payload.data ?? {}, user);
  });
}

/**
 * Apply one operation to a card, in turn (active GM's client).
 *  - "roll": a row's roll - refused for a closed card, a row already
 *    rolled, or a user who may not roll it; graded against the card.
 *  - "close": the GM settles the card with whoever has rolled.
 * @param {string} cardId
 * @param {"roll"|"close"} op
 * @param {object} data
 * @param {User} user  Who asked.
 * @returns {Promise<boolean>}  Whether the card changed.
 */
export function applyPartyOp(cardId, op, data, user) {
  return queueForCard(cardId, async () => {
    const message = game.messages.get(cardId);
    const state = message?.getFlag(SCOPE, FLAG);
    if (!state || state.closed) return false;
    if (op === "close") {
      if (!user.isGM) return false;
      await message.update({ [`flags.${SCOPE}.${FLAG}.closed`]: true });
      return true;
    }
    if (op !== "roll") return false;
    const rowId = String(data?.rowId ?? "");
    const row = state.rows?.[rowId];
    if (!row || row.check) return false;
    // A player rolls for a crawler they own; the GM for anyone.
    if (!user.isGM && !actorFromUuid(row.uuid)?.testUserPermission(user, "OWNER")) return false;
    const sent = data?.check ?? {};
    const total = Number(sent.total);
    if (!Number.isFinite(total)) return false;
    const naturalRoll = Number.isFinite(Number(sent.naturalRoll)) ? Number(sent.naturalRoll) : null;
    const graded = gradePartyRoll({ total, naturalRoll }, state.difficulty);
    const check = {
      total, naturalRoll, formula: sent.formula ?? null, breakdown: String(sent.breakdown ?? ""),
      roll: sent.roll ?? null, trained: !!sent.trained, degree: graded.degree, success: graded.success,
      stat: String(sent.stat ?? ""),
    };
    await message.update({ [`flags.${SCOPE}.${FLAG}.rows.${rowId}.check`]: check });
    return true;
  });
}

/* -------------------------------------------- */
/*  Clicks                                      */
/* -------------------------------------------- */

// Rows being rolled on this client (`messageId:rowId`): one roll per click.
const rolling = trackPerCard(new Set());

async function onPartyCheckButton(event, message, button) {
  event.preventDefault();
  event.stopPropagation();
  const state = message.getFlag(SCOPE, FLAG);
  if (!state || state.closed) return;
  const op = button.dataset.op;
  if (op === "close") {
    if (game.user.isGM) await sendOp(message, "close", {});
    return;
  }
  if (op !== "roll") return;
  const key = `${message.id}:${button.dataset.rowId}`;
  if (rolling.has(key)) return;
  rolling.add(key);
  button.disabled = true;
  try {
    await rollPartyRow(message, button.dataset.rowId);
  } finally {
    rolling.delete(key);
    button.disabled = false;
  }
}

/** Registry entries for module/chat/chat-listener.mjs. */
export const partyCheckActionEntries = [{ action: "partyCheck", custom: true, onClick: onPartyCheckButton }];

/* -------------------------------------------- */
/*  Drawing the card                            */
/* -------------------------------------------- */

// Open expanders by `messageId:rowKey`, kept across redraws.
const openRows = new Set();

/** One crawler's row, for this viewer. */
/**
 * A row's Off-Stat label ("Off-Stat: INT, not CON"), or "" when the roll used
 * the Skill's own Stat. A card from before rows recorded the Stat (no
 * `stat`) shows none.
 * @param {string} [stat]      The Stat rolled with.
 * @param {string} [governing] The Skill's Stat ("" for a Skill in no compendium).
 * @returns {string}
 */
export function offStatLabel(stat, governing = "") {
  if (!stat || stat === (governing ?? "")) return "";
  const abbr = (key) => game.i18n.localize(CARLRPG.statAbbreviations?.[key] ?? key);
  return governing
    ? game.i18n.format("CARLRPG.PartyCheck.OffStat", { stat: abbr(stat), governing: abbr(governing) })
    : game.i18n.format("CARLRPG.PartyCheck.OffStatNoGoverning", { stat: abbr(stat) });
}

function crawlerRow(state, row, cardId) {
  const i18n = game.i18n;
  const check = row.check;
  let chip;
  if (!check) chip = statusChip("waiting");
  else chip = check.success ? statusChip("success") : statusChip("fail");
  const sub = [];
  if (check) {
    sub.push(degreeLabel(check.degree));
    if (!check.trained) sub.push(i18n.localize("CARLRPG.PartyCheck.Untrained"));
    const off = offStatLabel(check.stat, state.stat);
    if (off) sub.push(off);
  }
  const acts = !check && !state.closed && canRollRow(row)
    ? iconButton("fa-dice-d20", i18n.format("CARLRPG.PartyCheck.Roll", { name: row.name }), { action: "partyCheck", op: "roll", "row-id": row.id })
    : "";
  return statusRow({
    chip,
    what: `<strong>${esc(row.name)}</strong>`,
    sub,
    num: check ? versusNum(check.total, state.difficulty) : "",
    acts,
    detail: check?.breakdown ? `<div>${esc(check.breakdown)}</div>` : "",
    key: row.id,
    open: openRows.has(`${cardId}:${row.id}`),
  });
}

/**
 * Draw a Party Skill Check card for this viewer from its flags: the rows,
 * the running tally, the outcome once settled, and the GM's Close. Called
 * from module/chat/chat-listener.mjs on every render.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decoratePartyCheckCard(message, html) {
  const container = html.querySelector(".carl-party-check");
  const state = message.getFlag(SCOPE, FLAG);
  if (!container || !state) return;
  const i18n = game.i18n;
  const tally = partyTally(state);

  if (tally.settled) {
    headerProgress(html, i18n.localize(`CARLRPG.PartyCheck.Outcome.${tally.outcome}`), { locked: true });
  } else {
    headerProgress(html, i18n.format("CARLRPG.PartyCheck.Progress", { rolled: tally.rolled, total: tally.total }));
  }

  const section = statusSection({
    name: state.skill,
    summary: i18n.format("CARLRPG.PartyCheck.Tally", { successes: tally.successes, rolled: tally.rolled }),
    rows: partyRows(state).map((row) => crawlerRow(state, row, message.id)),
  });

  let outcome = "";
  if (tally.settled) {
    const tone = tally.outcome === "succeeds" ? "good" : tally.outcome === "fails" ? "bad" : "neutral";
    const detail = tally.outcome === "none"
      ? i18n.localize("CARLRPG.PartyCheck.NoRolls")
      : i18n.format(state.closed && tally.rolled < tally.total ? "CARLRPG.PartyCheck.ResultClosed" : "CARLRPG.PartyCheck.Result", {
        successes: tally.successes, rolled: tally.rolled, total: tally.total,
      });
    outcome = `<div class="carl-party-outcome" data-tone="${tone}">
      <strong>${esc(i18n.localize(`CARLRPG.PartyCheck.Outcome.${tally.outcome}`))}</strong>
      <span>${esc(detail)}</span></div>`;
  }

  const foot = !tally.settled && game.user.isGM
    ? `<div class="carl-status-foot"><span class="carl-status-gm"><button type="button" class="carl-status-button" data-action="partyCheck" data-op="close">
        <i class="fas fa-lock"></i> ${esc(i18n.localize("CARLRPG.PartyCheck.Close"))}</button></span></div>`
    : "";
  container.innerHTML = `<p class="carl-party-rule">${esc(i18n.localize("CARLRPG.PartyCheck.Rule"))}</p>${section}${outcome}${foot}`;
  rememberOpenRows(container, message.id, openRows);
}
