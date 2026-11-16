/**
 * The Reaction card: the Crawler Reaction Phase on one chat card (Step 2,
 * p.81-82; docs/combat-phases.md). Posted by the GM's Next Phase out of Mob
 * Action Declaration, it lists every declared Mob Attack, grouped by who it
 * is aimed at, and players react from its buttons:
 *  - Taunt (p.200): an Opposed Check against a Mob; on a Success every
 *    single-target Attack of that Mob moves onto the taunter.
 *  - Catch (Catcher, p.191): take one ally's single-target Attack.
 *  - Evade: one button per crawler rolls every Evade it needs (p.81).
 *  - Intervene (p.82): +1d6 to another crawler's Check.
 *  - AI Reroll (p.61): reroll one of your own failed Checks.
 *  - GM: Open Evades (Taunts and Catches first, then Evades - "Taunt... after
 *    seeing where the Mob Attacks are headed"), and Lock Results, which runs
 *    Resolution (module/helpers/reaction-resolve.mjs).
 * A Disadvantaged Attack's free Evade (p.61, p.96) is rolled for its target
 * when the card is posted, and Taunt Rank 5+ rolls one against each Attack it
 * pulls (Advantage at Rank 15).
 *
 * Rolls are made on the roller's own client (their dialog, their dice) and
 * post nothing: what they did is sent to the active GM's client as an
 * operation, which applies it to the card's current state - one at a time per
 * card, refusing anything that no longer fits - and writes the whole state
 * back. The card is updated in place and drawn per viewer from its flags.
 */
import CarlDice, { extractNaturalD20 } from "../dice/dice.mjs";
import { createCardMessage, esc } from "./chat-card.mjs";
import { rerollFormula } from "../helpers/ai-favor.mjs";
import { mobAttackRow } from "../helpers/attack-targets.mjs";
import { rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { slugifySkillName } from "../helpers/modifiers.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import { currentPhase } from "../helpers/combat-phases.mjs";
import { declaredAttacks } from "../helpers/declarations.mjs";
import { canAct, combatantInFight, evadeIsFree, hasSpent, refundAction, spendAction } from "../helpers/actions.mjs";
import {
  buildReactionState, catchableHits, checkAt, checkList, crawlerKey, evadableHitsFor, gradeCheck, hitEvadable,
  hitLabel, hitList, hitMissed, intervenableAllies, intervenableChecks, makeCheck, pullableHits, rerollableChecks,
  sectionsOf, tauntableMobs, decidingEvade,
} from "../helpers/reaction-state.mjs";

const SCOPE = "carl-rpg";
const SOCKET = "system.carl-rpg";
const OP = "reactionOp";
const GREAT = ["criticalHit", "amazingSuccess"];

/* -------------------------------------------- */
/*  Lookups                                     */
/* -------------------------------------------- */

/** An Actor from a token or actor uuid (sync), or null. */
export function actorFor(uuid) {
  if (!uuid) return null;
  try {
    const doc = fromUuidSync(uuid);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  } catch {
    return null;
  }
}

/** This round's Reaction card for a combat, if it has one. */
export function reactionCardFor(combat) {
  const ref = combat?.getFlag(SCOPE, "reactionCard");
  if (!ref || ref.round !== combat.round) return null;
  return game.messages.get(ref.messageId) ?? null;
}

/**
 * The combatants this user can react for: the crawlers and Pets of the
 * card's combat they own (a GM: all of them).
 * @param {object} state
 * @returns {{uuid: string, name: string, actor: Actor}[]}
 */
function reactors(state) {
  const combat = game.combats.get(state.combatId);
  if (!combat) return [];
  return combat.combatants.contents.flatMap((c) => {
    const actor = c.actor;
    if (!actor || !rollsLikeCrawler(actor) || !actor.isOwner) return [];
    return [{ uuid: c.token?.uuid ?? actor.uuid, name: c.token?.name ?? actor.name, actor }];
  });
}

/** An owned Skill by name, and its Rank. */
function skillOf(actor, name) {
  const item = actor.items.find((i) => i.type === "skill" && i.name === name);
  if (!item) return null;
  const rank = actor.system.skills?.[slugifySkillName(name)]?.rank ?? item.system.rank ?? 0;
  return { item, rank };
}

/** The roll data a Check sends to the GM. */
function checkPayload(result) {
  return {
    formula: result.formula, naturalRoll: result.naturalRoll, total: result.total,
    difficulty: result.difficulty, breakdown: result.breakdown, roll: result.roll?.toJSON?.() ?? null,
  };
}

/** Show a roll's dice to everyone, if Dice So Nice is running. */
function showDice(roll) {
  if (roll && game.dice3d) void game.dice3d.showForRoll(roll, game.user, true).catch(() => {});
}

/* -------------------------------------------- */
/*  Posting and retiring                        */
/* -------------------------------------------- */

/**
 * Post this round's Reaction card from its declarations - GM only, called by
 * Next Phase out of Declaration (module/helpers/combat-phases.mjs). With
 * nothing declared there is no card.
 * @param {Combat} combat
 * @returns {Promise<ChatMessage|null>}
 */
export async function startReaction(combat) {
  if (!game.user.isGM) return null;
  const declarations = declaredAttacks(combat);
  if (!declarations.length) return null;
  const state = buildReactionState(combat, declarations);
  // "the targeted crawler(s) gain a free Evade Check against the
  // Disadvantaged Attack" (p.61) - rolled now, so a miss shows before anyone reacts.
  await rollFreeEvades(state, hitList(state).filter((hit) => hit.row.freeEvade && hitEvadable(hit)));
  const message = await createCardMessage({
    title: game.i18n.format("CARLRPG.Reaction.Title", { round: combat.round }),
    subtitle: game.i18n.localize("CARLRPG.Phase.Step.react"),
    img: "icons/svg/combat.svg",
    body: `<div class="carl-reaction"></div>`,
    flags: { kind: "reaction", reaction: state },
    // Not whichever token the GM has selected (likely the Mob that just declared).
    speaker: { alias: game.i18n.localize("CARLRPG.Phase.Speaker") },
  });
  await combat.setFlag(SCOPE, "reactionCard", { round: combat.round, messageId: message.id });
  return message;
}

/**
 * Previous Phase out of Reaction: the card and its rolls are thrown away
 * (the declarations stay).
 * @param {Combat} combat
 * @returns {Promise<void>}
 */
export async function retireReaction(combat) {
  const message = reactionCardFor(combat);
  // The Actions spent from it (Taunt, Catch, Evade, Intervene) come back too.
  for (const spent of message?.getFlag(SCOPE, "reaction")?.spentActions ?? []) {
    await refundAction(combat, spent.combatantId, spent.id);
  }
  if (message) await message.delete();
  if (combat.getFlag(SCOPE, "reactionCard")) await combat.unsetFlag(SCOPE, "reactionCard");
}

/**
 * Roll free Evades (GM) for these hits' current targets, in place on the state.
 * @param {object} state
 * @param {object[]} hits
 * @param {{advantage?: string}} [options]
 */
async function rollFreeEvades(state, hits, { advantage = "normal" } = {}) {
  for (const hit of hits) {
    const actor = actorFor(hit.targetUuid);
    if (!actor) continue;
    const result = await CarlDice.rollEvadeCheck(actor, {
      difficulty: hit.row.difficulty, post: false, isAction: false, preset: { advantage },
    });
    if (!result) continue;
    showDice(result.roll);
    hit.free = makeCheck("free", result);
    await grantEvadeAdvantage(state, hit, hit.free);
  }
}

/**
 * A Natural 20 or Amazing Success on an Evade: Advantage on the evader's
 * next Attack against that Mob (p.79) - the combatant flag rollAttack reads.
 * @param {object} state
 * @param {object} hit
 * @param {object} check
 */
async function grantEvadeAdvantage(state, hit, check) {
  if (!GREAT.includes(check?.degree)) return;
  const combat = game.combats.get(state.combatId);
  const combatant = combat?.combatants.find((c) => (c.token?.uuid ?? c.actor?.uuid) === hit.targetUuid);
  const mobUuid = state.attacks[hit.attackId]?.mobUuid;
  if (combatant && mobUuid) await combatant.setFlag(SCOPE, "advantageVsUuid", mobUuid);
}

/* -------------------------------------------- */
/*  The GM's side: one operation at a time      */
/* -------------------------------------------- */

const queues = new Map();

/**
 * Run `task` after every earlier one for this card (GM client).
 * @template T
 * @param {string} cardId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withCard(cardId, task) {
  const next = (queues.get(cardId) ?? Promise.resolve()).then(task, task);
  queues.set(cardId, next.catch(() => {}));
  return next;
}

/**
 * Write a card's whole state back. Each write counts up `rev`, so undoing an
 * Action can tell whether the card has changed since (helpers/action-undo.mjs).
 */
export async function writeState(message, state) {
  state.rev = (state.rev ?? 0) + 1;
  const { ForcedReplacement } = foundry.data.operators;
  await message.update({ flags: { [SCOPE]: { reaction: ForcedReplacement.create(state) } } });
}

/**
 * Send an operation to the active GM's client (or apply it, on that client).
 * @param {ChatMessage} message
 * @param {string} op
 * @param {object} data
 */
async function sendOp(message, op, data) {
  if (game.users.activeGM?.isSelf) return applyOp(message.id, op, data, game.user);
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return;
  }
  game.socket.emit(SOCKET, { type: OP, cardId: message.id, op, data });
}

/** Register the GM side of the socket. Call once from `ready`. */
export function registerReactionSocket() {
  game.socket.on(SOCKET, (payload, senderId) => {
    if (payload?.type !== OP || !game.users.activeGM?.isSelf) return;
    const user = game.users.get(senderId);
    if (user) void applyOp(payload.cardId, payload.op, payload.data ?? {}, user);
  });
}

/**
 * Apply one operation to a card, in turn.
 * @param {string} cardId
 * @param {string} op
 * @param {object} data
 * @param {User} user  Who asked.
 * @returns {Promise<boolean>} Whether the card changed.
 */
export function applyOp(cardId, op, data, user) {
  return withCard(cardId, async () => {
    const message = game.messages.get(cardId);
    const current = message?.getFlag(SCOPE, "reaction");
    if (!current || current.locked) return false;
    const state = foundry.utils.deepClone(current);
    // What an Action spent by this op undoes to (payFor).
    opBefore.set(state, { messageId: cardId, before: current });
    const owns = (uuid) => user.isGM || !!actorFor(uuid)?.testUserPermission(user, "OWNER");
    let changed = false;
    try {
      switch (op) {
        case "taunt": changed = await opTaunt(state, data, owns); break;
        case "catch": changed = await opCatch(state, data, owns); break;
        case "evade": changed = await opEvade(state, data, owns); break;
        case "intervene": changed = await opIntervene(state, data, owns); break;
        case "reroll": changed = await opReroll(state, data, owns); break;
        case "openEvades":
          // "Last call" for Taunts and Catches (p.90): Evades open.
          if (user.isGM && state.stage === "taunt") {
            state.stage = "evade";
            changed = true;
          }
          break;
      }
    } catch (err) {
      console.error(`CarlRPG | Reaction card: "${op}" failed`, err);
      return false;
    }
    if (changed) await writeState(message, state);
    return changed;
  });
}

/** A Check record from what a client sent (its own fields only). */
function receivedCheck(kind, data) {
  return makeCheck(kind, {
    roll: data?.roll ?? null, total: data?.total, naturalRoll: data?.naturalRoll ?? null,
    formula: data?.formula ?? null, difficulty: data?.difficulty ?? null, breakdown: String(data?.breakdown ?? ""),
  });
}

/** Ensure a crawlers entry. */
function crawlerEntry(state, uuid, name) {
  return (state.crawlers[crawlerKey(uuid)] ??= { uuid, name, evaded: false });
}

async function opTaunt(state, { byUuid, byName, mobUuid, rank, check }, owns) {
  if (state.stage !== "taunt" || !owns(byUuid)) return false;
  const mob = Object.values(state.attacks).find((a) => a.mobUuid === mobUuid);
  if (!mob) return false;
  if (!(await payFor(state, byUuid, "CARLRPG.Reaction.Op.taunt"))) return false;
  const taunt = {
    id: foundry.utils.randomID(), order: state.nextOrder++, byUuid, byName: String(byName ?? "?"),
    mobUuid, mobName: mob.mobName, rank: Number(rank) || 0, check: receivedCheck("taunt", check), pulled: [],
  };
  state.taunts[taunt.id] = taunt;
  crawlerEntry(state, byUuid, taunt.byName);
  if (taunt.check.success) await pullTaunt(state, taunt);
  return true;
}

/**
 * A successful Taunt: every single-target Attack of that Mob moves onto the
 * taunter, its to-hit re-resolved for them (their Held, their vehicle seat),
 * and gets a free Evade when it is still Disadvantaged - or from Taunt Rank 5
 * ("a free Evade Check against each Taunted Attack"), with Advantage at 15.
 * @param {object} state
 * @param {object} taunt
 */
async function pullTaunt(state, taunt) {
  const actor = actorFor(taunt.byUuid);
  if (!actor) return;
  const pulled = [];
  for (const hit of pullableHits(state, taunt.mobUuid, taunt.byUuid)) {
    const attack = state.attacks[hit.attackId];
    const { row } = mobAttackRow({
      id: hit.row.id, target: { uuid: taunt.byUuid, actor }, base: attack.mobBase, ownRows: attack.mobOwnRows ?? [], zone: hit.row.zone,
    });
    Object.assign(hit, {
      row, targetUuid: taunt.byUuid, targetName: taunt.byName, tauntedBy: { uuid: taunt.byUuid, name: taunt.byName }, free: null, evade: null,
    });
    taunt.pulled.push(hit.id);
    pulled.push(hit);
  }
  const free = pulled.filter((hit) => (hit.row.freeEvade || taunt.rank >= 5) && hitEvadable(hit));
  await rollFreeEvades(state, free, { advantage: taunt.rank >= 15 ? "advantage" : "normal" });
}

async function opCatch(state, { byUuid, byName, hitId }, owns) {
  if (state.stage !== "taunt" || !owns(byUuid)) return false;
  const hit = catchableHits(state, byUuid).find((h) => h.id === hitId);
  if (!hit) return false;
  if (!(await payFor(state, byUuid, "CARLRPG.Reaction.Op.catch"))) return false;
  const name = String(byName ?? "?");
  Object.assign(hit, { caughtBy: { uuid: byUuid, name }, targetUuid: byUuid, targetName: name });
  crawlerEntry(state, byUuid, name);
  return true;
}

async function opEvade(state, { uuid, checks }, owns) {
  if (state.stage !== "evade" || !owns(uuid)) return false;
  const hits = evadableHitsFor(state, uuid);
  const crawler = crawlerEntry(state, uuid, hits[0]?.targetName ?? "?");
  if (crawler.evaded || !hits.length) return false;
  // One Evade Action covers every Attack on them this round (p.81).
  if (!(await payFor(state, uuid, "CARLRPG.Roll.Evade", { tag: "evade" }))) return false;
  for (const hit of hits) {
    if (!checks?.[hit.id]) continue;
    hit.evade = receivedCheck("evade", checks[hit.id]);
    await grantEvadeAdvantage(state, hit, hit.evade);
  }
  crawler.evaded = true;
  return true;
}

async function opIntervene(state, { byUuid, byName, ref, value }, owns) {
  if (!owns(byUuid)) return false;
  const target = intervenableChecks(state, byUuid).find((c) => sameRef(c.ref, ref));
  const roll = Math.trunc(Number(value));
  if (!target || !(roll >= 1 && roll <= 6)) return false;
  if (!(await payFor(state, byUuid, "CARLRPG.Reaction.Op.intervene"))) return false;
  const check = checkAt(state, target.ref);
  const wasSuccess = check.success;
  check.interventions.push({ byUuid, byName: String(byName ?? "?"), value: roll });
  gradeCheck(check);
  await afterCheckChanged(state, target, check, wasSuccess);
  return true;
}

async function opReroll(state, { ref, naturalRoll, total, roll, breakdown }, owns) {
  const entry = checkList(state).find((c) => sameRef(c.ref, ref));
  if (!entry || !owns(entry.ownerUuid)) return false;
  if (!rerollableChecks(state, entry.ownerUuid).some((c) => sameRef(c.ref, ref))) return false;
  const actor = actorFor(entry.ownerUuid);
  const favor = actor?.system.details?.aiFavor ?? 0;
  if (actor?.type !== "character" || favor < 1) return false;
  await actor.update({ "system.details.aiFavor": favor - 1 });
  const check = checkAt(state, ref);
  const wasSuccess = check.success;
  check.aiRerolled = { natural: check.natural, base: check.base, breakdown: check.breakdown, roll: check.roll };
  Object.assign(check, {
    natural: naturalRoll ?? null, base: Number(total) || 0, roll: roll ?? null,
    breakdown: String(breakdown ?? ""),
  });
  gradeCheck(check);
  await afterCheckChanged(state, entry, check, wasSuccess);
  return true;
}

/**
 * After an Intervene or reroll: a Taunt that became a Success pulls its
 * Mob's Attacks now; a great Evade earns its Advantage.
 */
async function afterCheckChanged(state, entry, check, wasSuccess) {
  if (entry.ref.type === "taunt") {
    if (!wasSuccess && check.success) await pullTaunt(state, state.taunts[entry.ref.tauntId]);
  } else {
    await grantEvadeAdvantage(state, state.hits[entry.ref.hitId], check);
  }
}

// The card as it was before the op working on a state (applyOp), by state.
const opBefore = new WeakMap();

/**
 * Spend the Action a Reaction-card op takes (helpers/actions.mjs), on the
 * GM's client as the op is applied. False - the op is refused - when the
 * crawler has none left (the roller's client checked before rolling; only a
 * race lands here). A tagged Action already spent this round (an Evade)
 * costs nothing more. What it spends is kept on the card, so discarding the
 * card (retireReaction) gives it back.
 * @param {object} state  The card's state.
 * @param {string} uuid  Who acts.
 * @param {string} labelKey
 * @param {{tag?: string}} [options]
 * @returns {Promise<boolean>}
 */
async function payFor(state, uuid, labelKey, { tag = null } = {}) {
  const actor = actorFor(uuid);
  if (!actor) return true;
  if (tag === "evade" ? evadeIsFree(actor) : (tag && hasSpent(actor, tag))) return true;
  if (!canAct(actor, "other", { warn: false })) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Actions.NoneLeft", { name: actor.name }));
    return false;
  }
  const fight = combatantInFight(actor);
  // Undoing it puts the card back as it was before this op - if nothing
  // has changed on it since (helpers/action-undo.mjs).
  const card = opBefore.get(state);
  const undo = card ? [{
    t: "reaction", messageId: card.messageId, before: foundry.utils.deepClone(card.before), rev: (card.before.rev ?? 0) + 1,
  }] : [];
  const id = await spendAction(actor, "other", game.i18n.localize(labelKey), { tag, undo });
  if (fight && !id) return false;
  if (fight && id) (state.spentActions ??= []).push({ combatantId: fight.combatant.id, id });
  return true;
}

function sameRef(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  return a.type === "taunt" ? a.tauntId === b.tauntId : (a.hitId === b.hitId && a.which === b.which);
}

/* -------------------------------------------- */
/*  Players' side: pick, roll, send             */
/* -------------------------------------------- */

/**
 * A one-question picker; skipped when there's only one choice.
 * @param {string} title
 * @param {string} label
 * @param {{value: string, label: string}[]} options
 * @returns {Promise<string|null>}
 */
async function pick(title, label, options) {
  if (!options.length) return null;
  if (options.length === 1) return options[0].value;
  const choices = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  return foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<div class="form-group"><label>${esc(label)}</label><div class="form-fields"><select name="choice">${choices}</select></div></div>`,
    ok: { label: game.i18n.localize("CARLRPG.Reaction.Choose"), callback: (event, button) => button.form.elements.choice.value },
    rejectClose: false,
  });
}

/** Pick one of the user's reactors from a filtered list. */
async function pickReactor(list, title) {
  const uuid = await pick(title, game.i18n.localize("CARLRPG.Reaction.Who"), list.map((r) => ({ value: r.uuid, label: r.name })));
  return list.find((r) => r.uuid === uuid) ?? null;
}

/** "Wren: Evade vs. Goblin's Bite (16)" for a Check picker. */
function checkLabel(state, entry) {
  const i18n = game.i18n;
  const what = entry.ref.type === "taunt"
    ? i18n.format("CARLRPG.Reaction.TauntOf", { mob: entry.taunt.mobName })
    : i18n.format(entry.ref.which === "free" ? "CARLRPG.Reaction.FreeEvadeOf" : "CARLRPG.Reaction.EvadeOf",
      { attack: hitLabel(state, entry.hit) });
  return `${entry.ownerName}: ${what} - ${entry.check.total}`;
}

/** The buttons this viewer gets on this card. */
function availableOps(state) {
  if (!state || state.locked) return [];
  const mine = reactors(state);
  const ops = [];
  if (state.stage === "taunt") {
    if (mine.some((r) => skillOf(r.actor, "Taunt") && tauntableMobs(state, r.uuid).length)) ops.push("taunt");
    if (mine.some((r) => (skillOf(r.actor, "Catcher")?.rank ?? 0) >= 1 && catchableHits(state, r.uuid).length)) ops.push("catch");
  } else if (mine.some((r) => !state.crawlers[crawlerKey(r.uuid)]?.evaded && evadableHitsFor(state, r.uuid).length)) {
    ops.push("evade");
  }
  if (mine.some((r) => intervenableChecks(state, r.uuid).length)) ops.push("intervene");
  if (mine.some((r) => r.actor.type === "character" && (r.actor.system.details?.aiFavor ?? 0) >= 1
    && rerollableChecks(state, r.uuid).length)) ops.push("reroll");
  if (game.user.isGM && state.stage === "taunt") ops.push("openEvades");
  return ops;
}

async function onTaunt(message, state) {
  const list = reactors(state).filter((r) => skillOf(r.actor, "Taunt") && tauntableMobs(state, r.uuid).length);
  const taunter = await pickReactor(list, game.i18n.localize("CARLRPG.Reaction.Op.taunt"));
  if (!taunter || !canAct(taunter.actor, "other")) return;
  const mobs = tauntableMobs(state, taunter.uuid);
  const mobUuid = await pick(game.i18n.localize("CARLRPG.Reaction.Op.taunt"), game.i18n.localize("CARLRPG.Reaction.WhichMob"),
    mobs.map((m) => ({ value: m.mobUuid, label: m.mobName })));
  const mob = actorFor(mobUuid);
  if (!mob) return;
  const { item, rank } = skillOf(taunter.actor, "Taunt");
  const statKey = item.system.opposedStat || "int";
  const difficulty = 10 + (mob.system.stats?.[statKey]?.mod ?? 0) + game.settings.get(SCOPE, "currentFloor");
  const result = await CarlDice.rollOpposedSkillCheck(taunter.actor, item, { difficulty, opponent: mob, post: false });
  if (!result) return;
  showDice(result.roll);
  await sendOp(message, "taunt", { byUuid: taunter.uuid, byName: taunter.name, mobUuid, rank, check: checkPayload(result) });
}

async function onCatch(message, state) {
  const list = reactors(state).filter((r) => (skillOf(r.actor, "Catcher")?.rank ?? 0) >= 1 && catchableHits(state, r.uuid).length);
  const catcher = await pickReactor(list, game.i18n.localize("CARLRPG.Reaction.Op.catch"));
  if (!catcher || !canAct(catcher.actor, "other")) return;
  const hitId = await pick(game.i18n.localize("CARLRPG.Reaction.Op.catch"), game.i18n.localize("CARLRPG.Reaction.WhichAttack"),
    catchableHits(state, catcher.uuid).map((hit) => ({ value: hit.id, label: hitLabel(state, hit) })));
  if (hitId) await sendOp(message, "catch", { byUuid: catcher.uuid, byName: catcher.name, hitId });
}

async function onEvade(message, state) {
  const list = reactors(state).filter((r) => !state.crawlers[crawlerKey(r.uuid)]?.evaded && evadableHitsFor(state, r.uuid).length);
  const evader = await pickReactor(list, game.i18n.localize("CARLRPG.Reaction.Op.evade"));
  if (!evader) return;
  if (!evadeIsFree(evader.actor) && !canAct(evader.actor, "other")) return;
  // One Evade Action, a separate Check against each Attack (p.81): one
  // dialog, then the same choices for the rest. Only the first counts as the
  // crawler's Action for "next Action" Debuffs.
  const hits = evadableHitsFor(state, evader.uuid);
  const checks = {};
  let preset = null;
  for (const hit of hits) {
    const result = await CarlDice.rollEvadeCheck(evader.actor, {
      difficulty: hit.row.difficulty, post: false, isAction: !preset, preset,
    });
    if (!result) {
      if (!preset) return; // the dialog was cancelled
      continue;
    }
    if (!preset) {
      const { difficulty, ...rest } = result.options ?? {};
      preset = rest;
    }
    showDice(result.roll);
    checks[hit.id] = checkPayload(result);
  }
  await sendOp(message, "evade", { uuid: evader.uuid, checks });
}

async function onIntervene(message, state) {
  const list = reactors(state).filter((r) => intervenableChecks(state, r.uuid).length);
  const title = game.i18n.localize("CARLRPG.Reaction.Op.intervene");
  const helper = await pickReactor(list, title);
  if (!helper || !canAct(helper.actor, "other")) return;
  // Who to help, then which of their Checks.
  const allyUuid = await pick(title, game.i18n.localize("CARLRPG.Reaction.WhichAlly"),
    intervenableAllies(state, helper.uuid).map((a) => ({ value: a.uuid, label: a.name })));
  if (!allyUuid) return;
  const options = intervenableChecks(state, helper.uuid).filter((c) => c.ownerUuid === allyUuid);
  const index = await pick(title, game.i18n.localize("CARLRPG.Reaction.WhichCheck"),
    options.map((c, i) => ({ value: String(i), label: checkLabel(state, c) })));
  const target = options[Number(index)];
  if (!target) return;
  const roll = await new Roll("1d6").evaluate();
  showDice(roll);
  ui.notifications.info(game.i18n.format("CARLRPG.Reaction.Intervened", { name: helper.name, value: roll.total, target: target.ownerName }));
  await sendOp(message, "intervene", { byUuid: helper.uuid, byName: helper.name, ref: target.ref, value: roll.total });
}

async function onReroll(message, state) {
  const options = reactors(state)
    .filter((r) => r.actor.type === "character" && (r.actor.system.details?.aiFavor ?? 0) >= 1)
    .flatMap((r) => rerollableChecks(state, r.uuid));
  const index = await pick(game.i18n.localize("CARLRPG.Reaction.Op.reroll"), game.i18n.localize("CARLRPG.Reaction.WhichCheck"),
    options.map((c, i) => ({ value: String(i), label: checkLabel(state, c) })));
  const target = options[Number(index)];
  if (!target) return;
  const { check } = target;
  const roll = await new Roll(rerollFormula({ formula: check.formula, natural: check.natural, total: check.base })).evaluate();
  showDice(roll);
  await sendOp(message, "reroll", {
    ref: target.ref, naturalRoll: extractNaturalD20(roll), total: roll.total, roll: roll.toJSON(),
    breakdown: game.i18n.format("CARLRPG.Reaction.RerollBreakdown", { formula: roll.formula, total: roll.total }),
  });
}

/**
 * The card's buttons, dispatched by `data-op`.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 * @param {HTMLElement} button
 */
async function onReactionButton(event, message, button) {
  event.preventDefault();
  const state = message.getFlag(SCOPE, "reaction");
  const op = button.dataset.op;
  if (!state || state.locked) return;
  if (op === "lock") {
    const combat = game.combats.get(state.combatId);
    if (game.user.isGM && combat && currentPhase(combat) === "react") await combat.nextTurn();
    return;
  }
  if (!availableOps(state).includes(op)) return;
  button.disabled = true;
  try {
    switch (op) {
      case "taunt": await onTaunt(message, state); break;
      case "catch": await onCatch(message, state); break;
      case "evade": await onEvade(message, state); break;
      case "intervene": await onIntervene(message, state); break;
      case "reroll": await onReroll(message, state); break;
      case "openEvades": await sendOp(message, "openEvades", {}); break;
    }
  } finally {
    button.disabled = false;
  }
}

/** Registry entries for module/chat/chat-listener.mjs. */
export const reactionActionEntries = [{ action: "reactionCard", custom: true, onClick: onReactionButton }];

/* -------------------------------------------- */
/*  Drawing the card                            */
/* -------------------------------------------- */

const OP_ICONS = {
  taunt: "fa-bullhorn", catch: "fa-hand", evade: "fa-person-running", intervene: "fa-handshake-angle",
  reroll: "fa-rotate", openEvades: "fa-forward", lock: "fa-lock",
};

/**
 * Which roll breakdowns this client has open, by `messageId:checkKey`. The
 * card is redrawn on every change, which would otherwise close them.
 * @type {Set<string>}
 */
const openChecks = new Set();

/**
 * One Check, collapsed to its result; expands to its roll.
 * @param {object|null} check
 * @param {string} label
 * @param {string} key  Stable per Check on the card ("hit:<id>:evade", "taunt:<id>").
 * @param {string} messageId
 */
function renderCheck(check, label, key, messageId) {
  const i18n = game.i18n;
  if (!check) return "";
  const degree = i18n.localize(CARLRPG.degreesOfSuccess[check.degree] ?? check.degree);
  const css = check.success ? "hit" : ["criticalFail", "majorFail"].includes(check.degree) ? "miss" : "warn";
  const details = [];
  details.push(`<div>${esc(check.breakdown || "")}</div>`);
  const dice = rolledD20s(check.roll);
  if (dice) details.push(`<div>${esc(i18n.format("CARLRPG.Reaction.Dice", { dice }))}</div>`);
  for (const i of check.interventions ?? []) {
    details.push(`<div>${esc(i18n.format("CARLRPG.Reaction.InterveneLine", { name: i.byName, value: i.value }))}</div>`);
  }
  if (check.aiRerolled) {
    details.push(`<div>${esc(i18n.format("CARLRPG.Reaction.RerolledFrom", { total: check.aiRerolled.base, natural: check.aiRerolled.natural ?? "-" }))}</div>`);
  }
  const vs = check.difficulty === null || check.difficulty === undefined ? "" : ` ${esc(i18n.format("CARLRPG.Reaction.Vs", { difficulty: check.difficulty }))}`;
  const tags = [
    (check.interventions ?? []).length ? `<i class="fas fa-handshake-angle" data-tooltip="${esc(i18n.localize("CARLRPG.Reaction.Op.intervene"))}"></i>` : "",
    check.aiRerolled ? `<i class="fas fa-rotate" data-tooltip="${esc(i18n.localize("CARLRPG.Reaction.Op.reroll"))}"></i>` : "",
  ].join("");
  const open = openChecks.has(`${messageId}:${key}`) ? " open" : "";
  return `<details class="carl-check" data-check-key="${esc(key)}"${open}>
    <summary><span class="carl-check-kind">${esc(label)}</span> <strong>${esc(check.total)}</strong>${vs}
      <span class="carl-check-degree ${css}">${esc(degree)}</span>${tags}</summary>
    <div class="carl-check-detail">${details.join("")}</div>
  </details>`;
}

/** "7, 15" - the d20s a stored Roll rolled. */
function rolledD20s(rollData) {
  const term = rollData?.terms?.find((t) => t.faces === 20);
  const results = term?.results?.map((r) => r.result);
  return results?.length ? results.join(", ") : "";
}

/** One Attack on one defender. */
function renderHit(state, hit, messageId) {
  const i18n = game.i18n;
  const attack = state.attacks[hit.attackId] ?? {};
  const tags = [];
  if (attack.isArea) tags.push(i18n.localize("CARLRPG.Targets.AreaAttack"));
  if (hit.row.zone === "splash") tags.push(i18n.localize("CARLRPG.Targets.Splash"));
  if (hit.tauntedBy) tags.push(i18n.format("CARLRPG.Reaction.TauntedFrom", { name: hit.originalName }));
  if (hit.caughtBy) tags.push(i18n.format("CARLRPG.Reaction.CaughtFor", { name: hit.originalName }));

  let status;
  if (!hit.row.hit) status = i18n.localize("CARLRPG.Reaction.Status.Miss");
  else if (hit.caughtBy) status = i18n.localize("CARLRPG.Reaction.Status.Caught");
  else if (hitMissed(hit)) status = i18n.localize("CARLRPG.Reaction.Status.FreeEvaded");
  else {
    const deciding = decidingEvade(hit);
    if (deciding?.success) status = i18n.localize(attack.isArea ? "CARLRPG.Reaction.Status.EvadedHalf" : "CARLRPG.Reaction.Status.Evaded");
    else if (hit.evade) status = i18n.localize("CARLRPG.Reaction.Status.Hit");
    else status = i18n.localize(hit.row.isCharacter ? "CARLRPG.Reaction.Status.Incoming" : "CARLRPG.Reaction.Status.Hit");
  }
  const difficulty = hit.row.isCharacter && hit.row.difficulty !== null && hit.row.difficulty !== undefined
    ? ` <span class="carl-hit-difficulty">${esc(i18n.format("CARLRPG.Reaction.EvadeDifficulty", { difficulty: hit.row.difficulty }))}</span>` : "";
  return `<li class="carl-hit">
    <div class="carl-hit-head">
      <span class="carl-hit-attack"><strong>${esc(attack.mobName)}</strong>: ${esc(attack.attackName)}${difficulty}</span>
      <span class="carl-hit-status">${esc(status)}</span>
    </div>
    ${tags.length ? `<div class="carl-hit-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    ${attackDetails(attack)}
    ${renderCheck(hit.free, i18n.localize("CARLRPG.Reaction.FreeEvade"), `hit:${hit.id}:free`, messageId)}
    ${renderCheck(hit.evade, i18n.localize("CARLRPG.Roll.Evade"), `hit:${hit.id}:evade`, messageId)}
  </li>`;
}

/**
 * A Mob Attack's printed range and effect ("the target is Poisoned"), as its
 * stat block gives them - on-hit effects are the GM's to apply, so they stay
 * in view through Reaction and Resolution. Shared with the Damage card.
 * @param {{effect?: string, range?: string}} attack
 * @returns {string}
 */
export function attackDetails(attack) {
  const i18n = game.i18n;
  const parts = [];
  if (attack?.range) parts.push(`<span class="carl-attack-range">${esc(i18n.localize("CARLRPG.Attack.Range"))}: ${esc(attack.range)}</span>`);
  if (attack?.effect) parts.push(`<span class="carl-attack-effect">${esc(attack.effect)}</span>`);
  return parts.length ? `<div class="carl-attack-details">${parts.join("")}</div>` : "";
}

/** One Taunt Check. */
function renderTaunt(taunt, messageId) {
  const i18n = game.i18n;
  const result = taunt.check.success
    ? i18n.format("CARLRPG.Reaction.TauntPulled", { mob: taunt.mobName, count: taunt.pulled.length })
    : i18n.format("CARLRPG.Reaction.TauntFailed", { mob: taunt.mobName });
  return `<li class="carl-taunt">
    <div class="carl-hit-head"><span>${esc(i18n.format("CARLRPG.Reaction.TauntOf", { mob: taunt.mobName }))}</span>
      <span class="carl-hit-status">${esc(result)}</span></div>
    ${renderCheck(taunt.check, game.i18n.localize("CARLRPG.Reaction.Op.taunt"), `taunt:${taunt.id}`, messageId)}
  </li>`;
}

/**
 * Draw a Reaction card's sections and buttons, for whoever is viewing it.
 * Called from module/chat/chat-listener.mjs on every render.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateReactionCard(message, html) {
  const container = html.querySelector(".carl-reaction");
  const state = message.getFlag(SCOPE, "reaction");
  if (!container || !state) return;
  const i18n = game.i18n;
  const stage = state.locked ? "locked" : state.stage;
  const sections = sectionsOf(state).map((section) => {
    const evaded = state.crawlers[crawlerKey(section.uuid)]?.evaded;
    return `<section class="carl-reaction-section">
      <header>${esc(section.name)}${evaded ? ` <span class="carl-evaded-tag">${esc(i18n.localize("CARLRPG.Reaction.EvadeUsed"))}</span>` : ""}</header>
      <ul class="plain">${section.taunts.map((taunt) => renderTaunt(taunt, message.id)).join("")}${section.hits.map((hit) => renderHit(state, hit, message.id)).join("")}</ul>
    </section>`;
  }).join("");

  const ops = new Set(availableOps(state));
  const order = ["taunt", "catch", "evade", "intervene", "reroll"];
  const buttons = order.filter((op) => ops.has(op) || state.locked).map((op) => button(op, state.locked || !ops.has(op)));
  if (game.user.isGM) {
    if (ops.has("openEvades")) buttons.push(button("openEvades", false));
    buttons.push(button("lock", !!state.locked));
  }
  container.innerHTML = `<div class="carl-reaction-stage" data-stage="${esc(stage)}">${esc(i18n.localize(`CARLRPG.Reaction.Stage.${stage}`))}</div>
    ${sections}
    ${buttons.length ? `<div class="carl-reaction-buttons">${buttons.join("")}</div>` : ""}`;
  // Remember which breakdowns this viewer opens, so a redraw keeps them open.
  // "toggle" doesn't bubble - listen in the capture phase.
  container.addEventListener("toggle", (event) => {
    const key = event.target?.dataset?.checkKey;
    if (!key) return;
    const id = `${message.id}:${key}`;
    if (event.target.open) openChecks.add(id);
    else openChecks.delete(id);
  }, true);
}

function button(op, disabled) {
  return `<button type="button" data-action="reactionCard" data-op="${op}" ${disabled ? "disabled" : ""}>
    <i class="fas ${OP_ICONS[op]}"></i> ${esc(game.i18n.localize(`CARLRPG.Reaction.Op.${op}`))}</button>`;
}
