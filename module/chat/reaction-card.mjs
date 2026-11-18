/**
 * The Reaction card: the Crawler Reaction Phase on one chat card (Step 2,
 * p.81-82; docs/combat-phases.md). Posted by the GM's Next Phase out of Mob
 * Action Declaration, it lists every declared Mob Attack, grouped by who it
 * is aimed at, and players react from its buttons:
 *  - Taunt (p.200): an Opposed Check against a Mob; on a Success every
 *    single-target Attack of that Mob still landing moves onto the taunter.
 *  - Catch (Catcher, p.191): take one ally's single-target Attack.
 *  - Evade, in each crawler's section: rolls every Evade it needs (p.81).
 *  - Intervene (p.82) and AI Reroll (p.61), on the row of the Check they
 *    change.
 *  - GM: Lock Results, which runs Resolution (module/helpers/
 *    reaction-resolve.mjs).
 * No stages (docs/reaction-card-redesign.md): everything is open until Lock
 * Results. An Attack that moves off a crawler takes their Evade of it along
 * (an Evade left covering nothing gives its Action back); one that lands on
 * a crawler who has Evaded is rolled with their Evade's choices - one Evade
 * Action covers every Attack (p.81).
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
import {
  checkDetail, checkNotes, d6CouldChange, headerProgress, iconButton, rememberOpenRows, statusChip, statusRow, statusSection, versusNum,
} from "./status-rows.mjs";
import { rerollFormula } from "../helpers/ai-favor.mjs";
import { mobAttackRow } from "../helpers/attack-targets.mjs";
import { rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { slugifySkillName } from "../helpers/modifiers.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import { currentPhase } from "../helpers/combat-phases.mjs";
import { declaredAttacks } from "../helpers/declarations.mjs";
import { canAct, evadeIsFree, hasSpent, payAction, refundAction } from "../helpers/actions.mjs";
import {
  buildReactionState, cardProgress, catchableHits, checkAt, checkList, crawlerKey, evadableHitsFor, gradeCheck, hitEvadable,
  hitLabel, hitList, hitStatus, idleEvaders, intervenableChecks, makeCheck, pullableAreaAttacks, pullableHits, rerollableChecks,
  sectionCounts, sectionsOf, tauntableMobs, unevadedNames,
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
        case "pullArea": changed = user.isGM && await opPullArea(state, data); break;
        case "catch": changed = await opCatch(state, data, owns); break;
        case "evade": changed = await opEvade(state, data, owns); break;
        case "intervene": changed = await opIntervene(state, data, owns); break;
        case "reroll": changed = await opReroll(state, data, owns); break;
      }
    } catch (err) {
      console.error(`CarlRPG | Reaction card: "${op}" failed`, err);
      return false;
    }
    if (!changed) return false;
    // An op that gave someone's Evade Action back can't be undone: putting
    // the card back would restore an Evade whose Action is already refunded.
    // An extra count on `rev` makes its undo record stale.
    if (state.blockUndo) {
      delete state.blockUndo;
      state.rev = (state.rev ?? 0) + 1;
    }
    await writeState(message, state);
    return true;
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
  if (!owns(byUuid)) return false;
  const mob = Object.values(state.attacks).find((a) => a.mobUuid === mobUuid);
  // Nothing left to pull (all dodged since the Mob was picked): refused
  // before it costs an Action.
  if (!mob || !tauntableMobs(state, byUuid).some((m) => m.mobUuid === mobUuid)) return false;
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
 * A successful Taunt: every single-target Attack of that Mob still landing
 * moves onto the taunter, its to-hit re-resolved for them (their Held, their
 * vehicle seat), and gets a free Evade when it is still Disadvantaged - or
 * from Taunt Rank 5 ("a free Evade Check against each Taunted Attack"), with
 * Advantage at 15. A taunter who has already Evaded rolls against the rest
 * with that Evade; anyone whose Evade now covers nothing gets its Action back.
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
  await evadeArrivals(state, pulled);
  await refundIdleEvades(state);
}

/**
 * Attacks that have landed on someone who already Evaded this round: rolled
 * now with that Evade's choices (one Evade Action covers every Attack,
 * p.81). One that can't be rolled (a Stunned crawler) stays incoming, and
 * their Evade button comes back - free, the Action is spent.
 * @param {object} state
 * @param {object[]} hits
 */
async function evadeArrivals(state, hits) {
  for (const hit of hits) {
    const crawler = state.crawlers?.[crawlerKey(hit.targetUuid)];
    if (!crawler?.evaded || !hitEvadable(hit)) continue;
    const actor = actorFor(hit.targetUuid);
    if (!actor) continue;
    const result = await CarlDice.rollEvadeCheck(actor, {
      difficulty: hit.row.difficulty, post: false, isAction: false, preset: presetFrom(crawler.evadePreset),
    });
    if (!result) continue;
    showDice(result.roll);
    hit.evade = { ...makeCheck("evade", result), auto: true };
    await grantEvadeAdvantage(state, hit, hit.evade);
  }
}

/**
 * Give back the Evade Action of anyone whose Evade no longer covers any
 * Attack - everything it rolled against moved away. It's as if they'd never
 * Evaded: an Attack landing on them later needs a new Evade.
 * @param {object} state
 */
async function refundIdleEvades(state) {
  const combat = game.combats.get(state.combatId);
  for (const crawler of idleEvaders(state)) {
    const spent = crawler.evadeSpent;
    Object.assign(crawler, { evaded: false, evadePreset: null, evadeSpent: null });
    if (!spent || !combat) continue;
    await refundAction(combat, spent.combatantId, spent.id);
    state.spentActions = (state.spentActions ?? []).filter((s) => s.id !== spent.id);
    state.blockUndo = true;
  }
}

/** An Evade dialog's choices, as kept on the card (Sets as arrays). */
function presetData(preset) {
  const list = (value) => (value ? [...value].map(String) : null);
  return {
    advantage: ["advantage", "disadvantage"].includes(preset?.advantage) ? preset.advantage : "normal",
    modifier: Number(preset?.modifier) || 0,
    checked: list(preset?.checked) ?? [],
    checkedDebuffs: list(preset?.checkedDebuffs),
  };
}

/** The kept choices, as rollEvadeCheck's `preset` takes them. */
function presetFrom(data) {
  const kept = presetData(data);
  return { ...kept, checked: new Set(kept.checked), checkedDebuffs: kept.checkedDebuffs ? new Set(kept.checkedDebuffs) : null };
}

/**
 * The GM lets a successful Taunt pull the Mob's Area Attacks too: each is
 * re-aimed at the taunter - they take it in its full area, and the crawlers
 * it was going to hit are no longer in it (the GM can re-declare it if
 * they'd still be caught). Its to-hit is re-resolved for the taunter, with
 * the Taunt's free Evade as for its other Attacks. Before Evades open.
 * @param {object} state
 * @param {{tauntId: string}} data
 * @returns {Promise<boolean>}
 */
async function opPullArea(state, { tauntId }) {
  const taunt = state.taunts?.[tauntId];
  if (!taunt?.check?.success || taunt.areaPulled) return false;
  const actor = actorFor(taunt.byUuid);
  const attackIds = pullableAreaAttacks(state, taunt.mobUuid, taunt.byUuid);
  if (!actor || !attackIds.length) return false;
  const pulled = [];
  const spared = new Set();
  for (const attackId of attackIds) {
    const attack = state.attacks[attackId];
    const hits = hitList(state).filter((hit) => hit.attackId === attackId);
    const keep = hits.find((hit) => hit.targetUuid === taunt.byUuid) ?? hits[0];
    for (const hit of hits) {
      if (hit === keep) continue;
      if (hit.targetUuid !== taunt.byUuid) spared.add(hit.targetName);
      delete state.hits[hit.id];
    }
    const wasElsewhere = keep.targetUuid !== taunt.byUuid;
    if (wasElsewhere) spared.add(keep.targetName);
    const { row } = mobAttackRow({
      id: keep.row.id, target: { uuid: taunt.byUuid, actor }, base: attack.mobBase, ownRows: attack.mobOwnRows ?? [], zone: "full",
    });
    Object.assign(keep, {
      row, targetUuid: taunt.byUuid, targetName: taunt.byName, free: null, evade: null,
      ...(wasElsewhere ? { tauntedBy: { uuid: taunt.byUuid, name: taunt.byName } } : {}),
    });
    taunt.pulled.push(keep.id);
    pulled.push(keep);
  }
  taunt.areaPulled = true;
  taunt.spared = [...spared].filter((name) => name !== taunt.byName);
  const free = pulled.filter((hit) => (hit.row.freeEvade || taunt.rank >= 5) && hitEvadable(hit));
  await rollFreeEvades(state, free, { advantage: taunt.rank >= 15 ? "advantage" : "normal" });
  await evadeArrivals(state, pulled);
  await refundIdleEvades(state);
  return true;
}

async function opCatch(state, { byUuid, byName, hitId }, owns) {
  if (!owns(byUuid)) return false;
  const hit = catchableHits(state, byUuid).find((h) => h.id === hitId);
  if (!hit) return false;
  if (!(await payFor(state, byUuid, "CARLRPG.Reaction.Op.catch"))) return false;
  const name = String(byName ?? "?");
  // The ally's failed Evade of it (if any) drops off: the Catcher takes it,
  // and can't Evade it.
  Object.assign(hit, { caughtBy: { uuid: byUuid, name }, targetUuid: byUuid, targetName: name, free: null, evade: null });
  crawlerEntry(state, byUuid, name);
  await refundIdleEvades(state);
  return true;
}

async function opEvade(state, { uuid, checks, preset }, owns) {
  if (!owns(uuid)) return false;
  const hits = evadableHitsFor(state, uuid);
  if (!hits.length) return false;
  const crawler = crawlerEntry(state, uuid, hits[0].targetName ?? "?");
  // One Evade Action covers every Attack on them this round (p.81) - a
  // second Evade (an Attack that couldn't be rolled for them) is free.
  const paid = await payFor(state, uuid, "CARLRPG.Roll.Evade", { tag: "evade" });
  if (!paid) return false;
  for (const hit of hits) {
    if (!checks?.[hit.id]) continue;
    hit.evade = receivedCheck("evade", checks[hit.id]);
    await grantEvadeAdvantage(state, hit, hit.evade);
  }
  crawler.evaded = true;
  crawler.evadePreset = presetData(preset);
  if (paid.spent) crawler.evadeSpent = paid.spent;
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
 * Mob's Attacks still landing now; a great Evade earns its Advantage.
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
 * @returns {Promise<{spent: {combatantId: string, id: string}|null}|false>}
 *   false: refused. `spent`: the Action spent here, if one was.
 */
async function payFor(state, uuid, labelKey, { tag = null } = {}) {
  const actor = actorFor(uuid);
  const free = { spent: null };
  if (!actor) return free;
  if (tag === "evade" ? (evadeIsFree(actor) || hasSpent(actor, tag)) : (tag && hasSpent(actor, tag))) return free;
  // Undoing it puts the card back as it was before this op - if nothing
  // has changed on it since (helpers/action-undo.mjs).
  const card = opBefore.get(state);
  const undo = card ? [{
    t: "reaction", messageId: card.messageId, before: foundry.utils.deepClone(card.before), rev: (card.before.rev ?? 0) + 1,
  }] : [];
  const { paid, id, fight } = await payAction(actor, "other", game.i18n.localize(labelKey), { tag, undo });
  if (!paid) return false;
  if (!fight || !id) return free;
  const spent = { combatantId: fight.combatant.id, id };
  (state.spentActions ??= []).push(spent);
  return { spent };
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

/* -------------------------------------------- */
/*  What this viewer can do                     */
/* -------------------------------------------- */

/** This viewer's crawlers who could Taunt now. */
function taunters(state) {
  return reactors(state).filter((r) => skillOf(r.actor, "Taunt") && tauntableMobs(state, r.uuid).length);
}

/** This viewer's crawlers who could Catch now (Catcher Rank 1+). */
function catchers(state) {
  return reactors(state).filter((r) => (skillOf(r.actor, "Catcher")?.rank ?? 0) >= 1 && catchableHits(state, r.uuid).length);
}

/** This viewer's crawler whose section this is, if they have Attacks to Evade. */
function evaderFor(state, uuid) {
  if (!evadableHitsFor(state, uuid).length) return null;
  return reactors(state).find((r) => r.uuid === uuid) ?? null;
}

/** This viewer's crawlers who could Intervene on this Check (not their own). */
function helpersFor(state, ref) {
  return reactors(state).filter((r) => intervenableChecks(state, r.uuid).some((c) => sameRef(c.ref, ref)));
}

/** This viewer's crawler who could AI Reroll this Check: its own, with AI Favor. */
function rerollerFor(state, ref) {
  return reactors(state).find((r) => r.actor.type === "character" && (r.actor.system.details?.aiFavor ?? 0) >= 1
    && rerollableChecks(state, r.uuid).some((c) => sameRef(c.ref, ref))) ?? null;
}

async function onTaunt(message, state) {
  const list = taunters(state);
  const taunter = await pickReactor(list, game.i18n.localize("CARLRPG.Reaction.Op.taunt"));
  if (!taunter || !canAct(taunter.actor, "other")) return;
  const { item, rank } = skillOf(taunter.actor, "Taunt");
  // "Enemies within 30 feet of you" - 60 at Rank 10 (p.200). Measured now,
  // taunter to Mob; one out of range is marked and asked about, not refused.
  const range = tauntRange(rank);
  const mobs = tauntableMobs(state, taunter.uuid).map((m) => ({ ...m, distance: tokenDistance(taunter.uuid, m.mobUuid) }));
  const label = (m) => (m.distance === null ? m.mobName
    : game.i18n.format(m.distance > range ? "CARLRPG.Reaction.TauntOutOfRange" : "CARLRPG.Reaction.TauntInRange",
      { mob: m.mobName, distance: m.distance }));
  const mobUuid = await pick(game.i18n.localize("CARLRPG.Reaction.Op.taunt"), game.i18n.localize("CARLRPG.Reaction.WhichMob"),
    mobs.map((m) => ({ value: m.mobUuid, label: label(m) })));
  const chosen = mobs.find((m) => m.mobUuid === mobUuid);
  const mob = actorFor(mobUuid);
  if (!mob || !chosen) return;
  if (chosen.distance !== null && chosen.distance > range) {
    const anyway = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CARLRPG.Reaction.Op.taunt") },
      classes: ["carl-taunt-range"],
      content: `<p>${esc(game.i18n.format("CARLRPG.Reaction.TauntRangeConfirm", {
        mob: chosen.mobName, name: taunter.name, distance: chosen.distance, range,
      }))}</p>`,
      rejectClose: false,
    });
    if (!anyway) return;
  }
  const statKey = item.system.opposedStat || "int";
  const difficulty = 10 + (mob.system.stats?.[statKey]?.mod ?? 0) + game.settings.get(SCOPE, "currentFloor");
  const result = await CarlDice.rollOpposedSkillCheck(taunter.actor, item, { difficulty, opponent: mob, post: false });
  if (!result) return;
  showDice(result.roll);
  await sendOp(message, "taunt", { byUuid: taunter.uuid, byName: taunter.name, mobUuid, rank, check: checkPayload(result) });
}

async function onCatch(message, state) {
  const catcher = await pickReactor(catchers(state), game.i18n.localize("CARLRPG.Reaction.Op.catch"));
  if (!catcher || !canAct(catcher.actor, "other")) return;
  const hitId = await pick(game.i18n.localize("CARLRPG.Reaction.Op.catch"), game.i18n.localize("CARLRPG.Reaction.WhichAttack"),
    catchableHits(state, catcher.uuid).map((hit) => ({ value: hit.id, label: hitLabel(state, hit) })));
  if (hitId) await sendOp(message, "catch", { byUuid: catcher.uuid, byName: catcher.name, hitId });
}

/**
 * A section's Evade: one Evade Action, a separate Check against each Attack
 * (p.81) - one dialog, then the same choices for the rest. Only the first
 * counts as the crawler's Action for "next Action" Debuffs. The choices go
 * to the card too, for Attacks that land on them later.
 */
async function onEvade(message, state, uuid) {
  const evader = evaderFor(state, uuid);
  if (!evader) return;
  if (!evadeIsFree(evader.actor) && !hasSpent(evader.actor, "evade") && !canAct(evader.actor, "other")) return;
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
  await sendOp(message, "evade", { uuid: evader.uuid, checks, preset: presetData(preset) });
}

/** A row's Intervene: pick who (if several), roll their d6, send it. */
async function onIntervene(message, state, ref) {
  const title = game.i18n.localize("CARLRPG.Reaction.Op.intervene");
  const helper = await pickReactor(helpersFor(state, ref), title);
  if (!helper || !canAct(helper.actor, "other")) return;
  const owner = checkList(state).find((c) => sameRef(c.ref, ref));
  const roll = await new Roll("1d6").evaluate();
  showDice(roll);
  ui.notifications.info(game.i18n.format("CARLRPG.Reaction.Intervened", { name: helper.name, value: roll.total, target: owner?.ownerName ?? "?" }));
  await sendOp(message, "intervene", { byUuid: helper.uuid, byName: helper.name, ref, value: roll.total });
}

/** A row's AI Reroll: the d20 again with the rest of the old total. */
async function onReroll(message, state, ref) {
  if (!rerollerFor(state, ref)) return;
  const check = checkAt(state, ref);
  if (!check) return;
  const roll = await new Roll(rerollFormula({ formula: check.formula, natural: check.natural, total: check.base })).evaluate();
  showDice(roll);
  await sendOp(message, "reroll", {
    ref, naturalRoll: extractNaturalD20(roll), total: roll.total, roll: roll.toJSON(),
    breakdown: game.i18n.format("CARLRPG.Reaction.RerollBreakdown", { formula: roll.formula, total: roll.total }),
  });
}

/** A row's Check reference, from its button. */
function refOf(button) {
  try {
    const ref = JSON.parse(button.dataset.ref ?? "null");
    return ref && typeof ref === "object" ? ref : null;
  } catch {
    return null;
  }
}

/**
 * The card's buttons, dispatched by `data-op`.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 * @param {HTMLElement} button
 */
async function onReactionButton(event, message, button) {
  // A row's icon sits in its expander's summary: don't toggle it too.
  event.preventDefault();
  event.stopPropagation();
  const state = message.getFlag(SCOPE, "reaction");
  const op = button.dataset.op;
  if (!state || state.locked) return;
  if (op === "lock") {
    const combat = game.combats.get(state.combatId);
    if (game.user.isGM && combat && currentPhase(combat) === "react") await combat.nextTurn();
    return;
  }
  if (op === "pullArea") {
    if (game.user.isGM) await sendOp(message, "pullArea", { tauntId: button.dataset.tauntId });
    return;
  }
  button.disabled = true;
  try {
    switch (op) {
      case "taunt": if (taunters(state).length) await onTaunt(message, state); break;
      case "catch": if (catchers(state).length) await onCatch(message, state); break;
      case "evade": await onEvade(message, state, button.dataset.uuid); break;
      case "intervene": if (refOf(button)) await onIntervene(message, state, refOf(button)); break;
      case "reroll": if (refOf(button)) await onReroll(message, state, refOf(button)); break;
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

/**
 * Which rows' expanders this client has open, by `messageId:rowKey`. The
 * card is redrawn on every change, which would otherwise close them.
 * @type {Set<string>}
 */
const openRows = new Set();


/** A row's Intervene and AI Reroll icons, for this viewer. */
function checkActions(state, ref) {
  if (!ref || state.locked) return "";
  const data = { action: "reactionCard", ref: JSON.stringify(ref) };
  const acts = [];
  if (rerollerFor(state, ref)) acts.push(iconButton("fa-dice-d20", game.i18n.localize("CARLRPG.Reaction.Op.reroll"), { ...data, op: "reroll" }));
  // Only where a d6 could still change the result (the op itself allows any).
  if (d6CouldChange(checkAt(state, ref), { taunt: ref.type === "taunt" }) && helpersFor(state, ref).length) {
    acts.push(iconButton("fa-handshake-angle", game.i18n.localize("CARLRPG.Intervene.Button"), { ...data, op: "intervene" }));
  }
  return acts.join("");
}

/** "<strong>Ghoul</strong> · Bite", and the scroll icon when it has printed effect text. */
function attackWhat(attack) {
  return `<strong>${esc(attack.mobName ?? "?")}</strong>`;
}

/**
 * The line under a row's Mob name: its Attack and the Evade it calls for
 * ("Bite · Evade 15"), so the name keeps the row's width.
 * @param {object} attack
 * @param {number|null} [difficulty]  The Evade target, where there is one.
 * @returns {string[]}
 */
export function attackLine(attack, difficulty = null) {
  const line = [attack?.attackName ?? "?"];
  if (difficulty !== null && difficulty !== undefined) line.push(game.i18n.format("CARLRPG.Reaction.Sub.evade", { difficulty }));
  return line;
}

function effectFlag(attack) {
  return attack?.effect
    ? `<i class="fas fa-scroll carl-status-flag" data-tooltip="${esc(game.i18n.localize("CARLRPG.Reaction.HasEffect"))}"></i>` : "";
}

/** One Attack on one defender. */
function hitRow(state, hit, messageId) {
  const i18n = game.i18n;
  const attack = state.attacks[hit.attackId] ?? {};
  const { status, check, which } = hitStatus(state, hit);
  // The Evade target: a creature that Evades, and isn't Caught (it can't).
  const evadeTarget = hit.row?.isCharacter && hit.row?.hit && !hit.caughtBy ? (check?.difficulty ?? hit.row.difficulty) : null;
  const sub = attackLine(attack, evadeTarget);
  if (attack.isArea) sub.push(i18n.localize("CARLRPG.Reaction.Sub.area"));
  if (hit.row?.zone === "splash") sub.push(i18n.localize("CARLRPG.Targets.Splash"));
  if (hit.tauntedBy) sub.push(i18n.format("CARLRPG.Reaction.Sub.from", { name: hit.originalName }));
  if (hit.caughtBy) sub.push(i18n.format("CARLRPG.Reaction.CaughtFor", { name: hit.originalName }));
  if (which === "free") sub.push(check.success ? i18n.localize("CARLRPG.Reaction.FreeEvade") : i18n.format("CARLRPG.Reaction.Sub.freeFailed", { total: check.total }));
  if (which === "evade" && check.degree === "nearMissFail") sub.push(i18n.localize(CARLRPG.degreesOfSuccess.nearMissFail));
  sub.push(...checkNotes(check));
  if (check?.auto) sub.push(i18n.localize("CARLRPG.Reaction.Sub.auto"));
  if (status === "hit" && hit.row?.isCharacter && !hit.evade) sub.push(i18n.localize("CARLRPG.Reaction.Sub.notEvaded"));

  // The roll's total; its target is on the line under the name.
  const num = check && (which === "evade" || status !== "incoming") ? `<b>${esc(check.total)}</b>` : "";
  const key = `hit:${hit.id}`;
  const detail = `${checkDetail(check)}${attackDetails(attack)}`;
  return statusRow({
    chip: statusChip(status), what: attackWhat(attack), flag: effectFlag(attack), sub, num,
    acts: which ? checkActions(state, { type: "hit", hitId: hit.id, which }) : "",
    detail, key, open: openRows.has(`${messageId}:${key}`),
  });
}

/** An Attack that has moved off this crawler: struck through, saying where it went. */
function movedRow(state, hit) {
  const i18n = game.i18n;
  const attack = state.attacks[hit.attackId] ?? {};
  const where = hit.caughtBy
    ? i18n.format("CARLRPG.Reaction.Sub.caughtBy", { name: hit.targetName })
    : i18n.format("CARLRPG.Reaction.Sub.tauntedTo", { name: hit.targetName });
  return statusRow({ chip: statusChip("moved"), what: attackWhat(attack), sub: [...attackLine(attack), where], ghost: true });
}

/** One Taunt Check - with, for the GM, "Pull Area Attacks too" while it can. */
function tauntRow(state, taunt, messageId) {
  const i18n = game.i18n;
  const success = taunt.check.success;
  const sub = [success
    ? i18n.format("CARLRPG.Reaction.Sub.pulled", { count: taunt.pulled.length })
    : i18n.localize("CARLRPG.StatusChip.tauntFailed")];
  if (taunt.areaPulled) {
    sub.push(taunt.spared?.length
      ? i18n.format("CARLRPG.Reaction.AreaPulledSpared", { name: taunt.byName, spared: taunt.spared.join(", ") })
      : i18n.format("CARLRPG.Reaction.AreaPulled", { name: taunt.byName }));
  }
  sub.push(...checkNotes(taunt.check));
  const canPullArea = game.user.isGM && !state.locked && success && !taunt.areaPulled
    && pullableAreaAttacks(state, taunt.mobUuid, taunt.byUuid).length;
  const pullArea = canPullArea
    ? `<button type="button" class="carl-pull-area" data-action="reactionCard" data-op="pullArea" data-taunt-id="${esc(taunt.id)}"
        data-tooltip="${esc(i18n.format("CARLRPG.Reaction.PullAreaHint", { name: taunt.byName }))}">
        <i class="fa-solid fa-burst"></i> ${esc(i18n.localize("CARLRPG.Reaction.PullArea"))}</button>`
    : "";
  const key = `taunt:${taunt.id}`;
  return statusRow({
    chip: statusChip(success ? "taunt" : "tauntFailed", success ? {} : { label: i18n.localize("CARLRPG.StatusChip.taunt") }),
    what: `<strong>${esc(taunt.mobName)}</strong>`, sub,
    num: versusNum(taunt.check.total, taunt.check.difficulty),
    acts: checkActions(state, { type: "taunt", tauntId: taunt.id }),
    detail: checkDetail(taunt.check), key, open: openRows.has(`${messageId}:${key}`),
    after: pullArea,
  });
}

/** A section's heading summary: what's still bad or pending, or "All clear". */
function sectionSummary(state, section) {
  const i18n = game.i18n;
  const counts = sectionCounts(state, section);
  const parts = [];
  if (section.taunts.length) parts.push(i18n.localize("CARLRPG.StatusChip.taunt"));
  for (const key of ["hit", "incoming", "caught", "half"]) {
    if (counts[key]) parts.push(i18n.format(`CARLRPG.Reaction.Sum.${key}`, { n: counts[key] }));
  }
  const pending = counts.hit + counts.incoming + counts.caught + counts.half;
  if (!pending && (section.hits.length || section.moved.length)) parts.push(i18n.localize("CARLRPG.Reaction.Sum.clear"));
  if (!state.locked && state.crawlers?.[crawlerKey(section.uuid)]?.evaded) parts.push(i18n.localize("CARLRPG.Reaction.EvadeUsed"));
  return parts.join(" · ");
}

/** A section's Evade button, for whoever owns that crawler. */
function sectionEvade(state, section) {
  if (state.locked || !evaderFor(state, section.uuid)) return "";
  const count = evadableHitsFor(state, section.uuid).length;
  return `<button type="button" class="carl-status-button is-primary" data-action="reactionCard" data-op="evade" data-uuid="${esc(section.uuid)}">
    <i class="fas fa-person-running"></i> ${esc(game.i18n.format("CARLRPG.Reaction.EvadeButton", { count }))}</button>`;
}

/**
 * A Mob Attack's printed range and effect ("the target is Poisoned"), as its
 * stat block gives them - on-hit effects are the GM's to apply. In the row's
 * expander here; shared with the Damage card.
 * @param {{effect?: string, range?: string}} attack
 * @returns {string}
 */
export function attackDetails(attack) {
  const i18n = game.i18n;
  const parts = [];
  if (attack?.range) parts.push(`<div class="carl-attack-range">${esc(i18n.localize("CARLRPG.Attack.Range"))}: ${esc(attack.range)}</div>`);
  if (attack?.effect) parts.push(`<div class="carl-attack-effect">${esc(attack.effect)}</div>`);
  return parts.join("");
}

/**
 * Taunt's range (p.200): 30 ft, 60 ft from Rank 10.
 * @param {number} rank
 * @returns {number}
 */
export function tauntRange(rank) {
  return rank >= 10 ? 60 : 30;
}

/**
 * How far apart two combatants' tokens are on the viewed scene, in the
 * scene's units by its grid rules, or null when either has no token there.
 * @param {string} fromUuid  A token or actor uuid.
 * @param {string} toUuid
 * @returns {number|null}
 */
export function tokenDistance(fromUuid, toUuid) {
  const a = sceneToken(fromUuid);
  const b = sceneToken(toUuid);
  if (!a || !b || !canvas?.grid) return null;
  return Math.round(canvas.grid.measurePath([a.center, b.center]).distance);
}

/** A uuid's token on the viewed scene (a token's own, or an actor's first). */
function sceneToken(uuid) {
  const doc = uuid ? fromUuidSync(uuid) : null;
  if (!doc || !canvas?.ready) return null;
  const token = doc.documentName === "Token" ? doc : doc.getActiveTokens?.(false, true)?.[0];
  return token?.parent === canvas.scene ? token.object ?? null : null;
}

/**
 * Draw a Reaction card for whoever is viewing it (docs/reaction-card-
 * redesign.md): the progress badge in its header, who it's waiting on, a
 * section per creature with a row per Attack or Taunt, and the footer's
 * Taunt, Catch and (GM) Lock Results. Called from module/chat/
 * chat-listener.mjs on every render.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function decorateReactionCard(message, html) {
  const container = html.querySelector(".carl-reaction");
  const state = message.getFlag(SCOPE, "reaction");
  if (!container || !state) return;
  const i18n = game.i18n;

  // The header: "3 of 5 settled", or Locked (and Resolution's name).
  const { settled, total } = cardProgress(state);
  if (state.locked) {
    headerProgress(html, i18n.localize("CARLRPG.Reaction.Locked"), { locked: true, subtitle: i18n.localize("CARLRPG.Phase.Step.resolve") });
  } else {
    headerProgress(html, i18n.format("CARLRPG.Reaction.Progress", { settled, total }));
  }

  let lead = "";
  if (state.locked) {
    lead = `<div class="carl-status-note">${esc(i18n.localize("CARLRPG.Reaction.LockedNote"))}</div>`;
  } else {
    const waiting = unevadedNames(state);
    if (waiting.length) {
      lead = `<div class="carl-status-waiting"><i class="fas fa-person-running" aria-hidden="true"></i>
        <span>${esc(i18n.localize("CARLRPG.Reaction.WaitingOn"))} ${waiting.map((n) => `<b>${esc(n)}</b>`).join(" · ")}</span></div>`;
    }
  }

  const sections = sectionsOf(state).map((section) => statusSection({
    name: section.name,
    summary: sectionSummary(state, section),
    rows: [
      ...section.taunts.map((taunt) => tauntRow(state, taunt, message.id)),
      ...section.moved.map((hit) => movedRow(state, hit)),
      ...section.hits.map((hit) => hitRow(state, hit, message.id)),
    ],
    actions: sectionEvade(state, section),
  })).join("");

  const foot = [];
  if (!state.locked) {
    if (taunters(state).length) foot.push(footButton("taunt", "fa-bullhorn"));
    if (catchers(state).length) foot.push(footButton("catch", "fa-hand"));
    if (game.user.isGM) foot.push(`<span class="carl-status-gm">${footButton("lock", "fa-lock")}</span>`);
  }
  container.innerHTML = `${lead}${sections}${foot.length ? `<div class="carl-status-foot">${foot.join("")}</div>` : ""}`;
  rememberOpenRows(container, message.id, openRows);
}

/** A footer button. */
function footButton(op, icon) {
  return `<button type="button" class="carl-status-button" data-action="reactionCard" data-op="${op}">
    <i class="fas ${icon}"></i> ${esc(game.i18n.localize(`CARLRPG.Reaction.Op.${op}`))}</button>`;
}
