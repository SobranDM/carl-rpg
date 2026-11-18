/**
 * Combat Actions (docs/action-tracking.md): who has how many Actions this
 * round, what they've been spent on, and the refusal when there are none
 * left.
 *
 * The rules: crawlers get two Actions a round, and Interrupts count against
 * them (p.64, p.81). A Mob gets 1 Move and 1 other Action, and "can move
 * twice if need be" (p.270). Bosses and Elites get 1 Action per crawler,
 * "even if a crawler kicks the bucket mid-fight", for anything (p.81, p.270).
 * A commanded Pet gets two, a Mount one (p.232). Clean Up resets them all
 * (p.80). AI Favor buys an extra non-Attack Action once a round (p.61).
 *
 * Only tracked in a phased fight (helpers/combat-phases.mjs). Outside one,
 * every check passes and nothing is recorded. Action *types* aren't
 * enforced (Interrupts in any step, a Pet's restrictions): only the count,
 * a Mob's Move-only Action, and AI Favor's non-Attack one. An uncommanded
 * Pet has none, but Evades for free (evadesWithoutAction).
 *
 * Stored on the Combat as `flags.carl-rpg.actions = {key, combatants: {id: {spent, bonus, favor}}}`.
 * `key` is the round, plus the Surprise step. A store from another key reads
 * as empty, so nothing needs resetting. Only GMs write it: a player's spend
 * goes to the active GM's client (`actionOp` on the system socket), applied
 * one at a time per combat.
 */
import { currentPhase, isPhased, phasedCombatFor } from "./combat-phases.mjs";
import { isCrawler, isMinion, isPet, isVehicle } from "./actor-kinds.mjs";
import { queueOn } from "./actor-queue.mjs";

const SCOPE = "carl-rpg";
const SOCKET = "system.carl-rpg";
const OP = "actionOp";
const UNDO_OP = "actionUndo";

/** What an Action can pay for: an Attack, a Move, or anything else. */
export const ACTION_KINDS = Object.freeze(["attack", "move", "other"]);

/* -------------------------------------------- */
/*  Who's in a fight                            */
/* -------------------------------------------- */

/**
 * Whether this actor is a combatant in any started fight - PvP included.
 * The Hotlist's and consumables' "in a fight" rules (Retrieve cards, Spells
 * only from the Hotlist, Potion Sickness) use this.
 * @param {Actor|null|undefined} actor
 * @returns {boolean}
 */
export function isInCombat(actor) {
  if (!actor) return false;
  return game.combats.some((c) => c.started && c.combatants.some((cb) => cb.actor === actor));
}

/**
 * The phased fight this actor is a combatant of, with its combatant, or
 * null - where its Actions are tracked.
 * @param {Actor|null|undefined} actor
 * @returns {{combat: Combat, combatant: Combatant}|null}
 */
export function combatantInFight(actor) {
  // A vehicle doesn't act - its crew does (their boarding, driving, exits).
  if (!actor || isVehicle(actor)) return null;
  const combat = phasedCombatFor(actor);
  const combatant = combat?.combatants.find((c) => c.actor === actor);
  return combatant ? { combat, combatant } : null;
}

/* -------------------------------------------- */
/*  The budget                                  */
/* -------------------------------------------- */

/** The crawlers in a fight, fallen ones included ("even if a crawler kicks the bucket"). */
function crawlerCount(combat) {
  return combat.combatants.filter((c) => isCrawler(c.actor)).length;
}

/**
 * How many Actions a combatant gets this round, before GM adjustments and
 * AI Favor: `move` Move-only Actions (a Mob's), `action` Actions for
 * anything.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @returns {{move: number, action: number}}
 */
export function baseBudget(combat, combatant) {
  const actor = combatant?.actor;
  if (!actor || isVehicle(actor)) return { move: 0, action: 0 };
  // Surprise: "they get a free Action ... only one action" (p.80).
  if (currentPhase(combat) === "surprise") return { move: 0, action: isCrawler(actor) ? 1 : 0 };
  if (isCrawler(actor)) return { move: 0, action: 2 };
  if (isPet(actor)) {
    if (actor.system.isMount) return { move: 0, action: 1 };
    return { move: 0, action: petCommanded(combat, actor) ? 2 : 0 };
  }
  // A Mob.
  const override = actor.system.actionsPerRound;
  if (Number.isInteger(override) && override >= 0) return { move: 0, action: override };
  if (actor.system.mobTier || actor.system.isElite) return { move: 0, action: Math.max(1, crawlerCount(combat)) };
  return { move: 1, action: 1 };
}

/**
 * Whether a Pet has been commanded (free or restricted) in this fight. A
 * Minion always has: it needs no Command Check (p.233).
 */
function petCommanded(combat, actor) {
  if (isMinion(actor)) return true;
  const command = actor.system.command ?? {};
  return ["free", "restricted"].includes(command.state) && command.combatId === combat.id;
}

/** The store's key for the current round (and the Surprise step). */
function storeKey(combat) {
  return `${combat.round}:${currentPhase(combat) === "surprise" ? "surprise" : "round"}`;
}

/**
 * A combatant's record this round.
 * @param {Combat} combat
 * @param {string} combatantId
 * @returns {{spent: object[], bonus: number, favor: boolean}}
 */
export function actionRecord(combat, combatantId) {
  const store = combat?.getFlag(SCOPE, "actions");
  const rec = store?.key === storeKey(combat) ? store.combatants?.[combatantId] : null;
  return { spent: rec?.spent ?? [], bonus: rec?.bonus ?? 0, favor: !!rec?.favor };
}

/**
 * A combatant's bubbles this round, in order: Move-only (yellow), Actions
 * (green), then the AI Favor Action (gold). A spent bubble carries what it
 * paid for.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @returns {{pool: "move"|"action"|"favor", spent: object|null}[]}
 */
export function actionBubbles(combat, combatant) {
  const budget = baseBudget(combat, combatant);
  const rec = actionRecord(combat, combatant.id);
  const counts = { move: budget.move, action: Math.max(0, budget.action + rec.bonus), favor: rec.favor ? 1 : 0 };
  const byPool = { move: [], action: [], favor: [] };
  for (const entry of rec.spent) (byPool[entry.pool] ??= []).push(entry);
  const bubbles = [];
  for (const pool of ["move", "action", "favor"]) {
    for (let i = 0; i < counts[pool]; i++) bubbles.push({ pool, spent: byPool[pool][i] ?? null });
    // Spent beyond the budget (a GM took one away after it was used): still shown.
    for (let i = counts[pool]; i < byPool[pool].length; i++) bubbles.push({ pool, spent: byPool[pool][i] });
  }
  return bubbles;
}

/**
 * Which pool would pay for this kind of Action, or null if none can:
 *  - an Attack: only an ordinary Action (not a Mob's Move, not AI Favor's);
 *  - a Move: the Move-only one first, then an Action, then AI Favor's;
 *  - anything else: an Action, then AI Favor's.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @param {string} kind
 * @param {string|null} [pool]  A specific pool (a clicked bubble).
 * @returns {"move"|"action"|"favor"|null}
 */
export function payingPool(combat, combatant, kind, pool = null) {
  const free = { move: 0, action: 0, favor: 0 };
  for (const b of actionBubbles(combat, combatant)) if (!b.spent) free[b.pool] += 1;
  const order = kind === "attack" ? ["action"] : kind === "move" ? ["move", "action", "favor"] : ["action", "favor"];
  const allowed = pool ? order.filter((p) => p === pool) : order;
  return allowed.find((p) => free[p] > 0) ?? null;
}

/* -------------------------------------------- */
/*  Checking and spending                       */
/* -------------------------------------------- */

/**
 * Can this actor take this kind of Action now? Always true outside a phased
 * fight. Refuses - for players and the GM alike - when nothing is left to
 * pay with; the GM can add an Action from the tracker.
 * @param {Actor} actor
 * @param {string} [kind]  "attack" | "move" | "other"
 * @param {{warn?: boolean}} [options]
 * @returns {boolean}
 */
export function canAct(actor, kind = "other", { warn = true } = {}) {
  const fight = combatantInFight(actor);
  if (!fight) return true;
  if (payingPool(fight.combat, fight.combatant, kind)) return true;
  if (warn) {
    const key = kind === "attack" && payingPool(fight.combat, fight.combatant, "other")
      ? "CARLRPG.Actions.NoAttackLeft" : "CARLRPG.Actions.NoneLeft";
    ui.notifications.warn(game.i18n.format(key, { name: actor.name }));
  }
  return false;
}

/**
 * Spend one of this actor's Actions on something that has happened. Nothing
 * outside a phased fight.
 * @param {Actor} actor
 * @param {string} kind  "attack" | "move" | "other"
 * @param {string} label  What it paid for ("Attack: Longsword").
 * @param {{tag?: string|null}} [options]  tag: what kind of Action it was,
 *   when something later in the round depends on it ("evade" - see
 *   hasSpent).
 * @returns {Promise<string|null>}  The spent entry's id (to refund it), or
 *   null: not in a phased fight, or - on the active GM's client, where it's
 *   applied at once - refused because none was left. (A player's spend is
 *   applied on the GM's client; its id is returned without waiting.)
 */
export async function spendAction(actor, kind, label, { tag = null, id = null, undo = [] } = {}) {
  const fight = combatantInFight(actor);
  if (!fight) return null;
  id ||= foundry.utils.randomID();
  const applied = await sendOp(fight.combat, "spend", {
    combatantId: fight.combatant.id, kind, label: String(label ?? ""), tag, id, undo,
  });
  return applied === false ? null : id;
}

/**
 * Pay for an Action applied on the GM's client as part of a change to
 * shared state (a Reaction card op, an Intervene on a Check card): refused,
 * with a warning, when none is left. Outside a phased fight it's free.
 * @param {Actor} actor
 * @param {"attack"|"move"|"other"} kind
 * @param {string} label
 * @param {{tag?: string|null, undo?: object[]}} [options]
 * @returns {Promise<{paid: boolean, id: string|null, fight: object|null}>}
 */
export async function payAction(actor, kind, label, { tag = null, undo = [] } = {}) {
  const fight = combatantInFight(actor);
  if (!fight) return { paid: true, id: null, fight: null };
  if (!canAct(actor, kind, { warn: false })) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Actions.NoneLeft", { name: actor.name }));
    return { paid: false, id: null, fight };
  }
  const id = await spendAction(actor, kind, label, { tag, undo });
  return { paid: !!id, id, fight };
}

/* -------------------------------------------- */
/*  Taking an Action                            */
/* -------------------------------------------- */

/** How strict each kind is about what pays for it (payingPool). */
const STRICTNESS = { move: 0, other: 1, attack: 2 };

// The Action under way for each actor on this client, by uuid.
const scopes = new Map();

/**
 * Do something that is one Action in a fight: checked first, spent only if
 * it happens, with a record of how to undo it (helpers/action-undo.mjs).
 * The one place Actions are taken - every Attack, Cast, Retrieve, Command
 * Pet... goes through here.
 *
 * Something done as part of another Action (an Attack's Hotlist swap, a
 * Scroll's cast, boarding's DEX Check) passes that Action's context as
 * `within`: it's paid by it - one Action, at the strictest kind asked for (a
 * Swap and Attack is an Attack, so AI Favor's Action can't pay for it).
 * Without `within`, it's an Action of its own: if this actor has one under
 * way on this client (a second click, another dialog), it waits its turn.
 *
 * `fn` gets a context:
 *  - `tracked`: this is a fight's Action of its own - a dialog shows its
 *    "Uses an Action" box only then;
 *  - `id`: the Action's id once spent (a Mob's declaration keeps it);
 *  - `use()` / `free()`: settle whether it took the Action. Otherwise it did
 *    if `fn` returned something truthy;
 *  - `require()`: for an `optional` Action, check there's one left once
 *    `fn` knows it's using one (a Check's "Uses an Action" box);
 *  - `label`: settable, for a label only known inside.
 * Pass it on as `within` to anything done as part of it.
 *
 * Outside a phased fight `fn` just runs.
 * @param {Actor} actor
 * @param {"attack"|"move"|"other"} kind
 * @param {string} label  What it's spent on ("Attack: Longsword").
 * @param {(ctx: object) => Promise<*>} fn
 * @param {{tag?: string|null, optional?: boolean, within?: object|null}} [options]
 *   tag: as spendAction. optional: not checked up front - `fn` decides (and
 *   as part of another Action, it never makes that one stricter). within:
 *   the context of the Action this is part of.
 * @returns {Promise<*>}  What `fn` returned, or null if refused.
 */
export async function takeAction(actor, kind, label, fn, { tag = null, optional = false, within = null } = {}) {
  if (within) {
    const outer = within.scope ?? null;
    if (outer && !optional && STRICTNESS[kind] > STRICTNESS[outer.kind]) {
      if (!canAct(actor, kind)) return null;
      outer.kind = kind;
      outer.label = label;
    }
    return fn(partContext(outer));
  }
  if (!combatantInFight(actor)) return fn(partContext(null));
  return inTurn(actor, async () => {
    if (!combatantInFight(actor)) return fn(partContext(null));
    if (!optional && !canAct(actor, kind)) return null;

    const scope = { kind, label, tag, undo: [], used: null, id: foundry.utils.randomID() };
    const ctx = {
      tracked: true,
      scope,
      id: scope.id,
      use: () => { scope.used = true; },
      free: () => { scope.used = false; },
      require: () => canAct(actor, scope.kind),
      get label() { return scope.label; },
      set label(value) { scope.label = value; },
    };
    scopes.set(actor.uuid, scope);
    let result;
    try {
      result = await fn(ctx);
    } finally {
      scopes.delete(actor.uuid);
    }
    if (!(scope.used ?? !!result)) return result;
    const spent = await spendAction(actor, scope.kind, scope.label, { tag: scope.tag, id: scope.id, undo: scope.undo });
    // Refused on the GM's own client (another click got there first): take it
    // back. (Not when the fight ended meanwhile - then there's nothing to pay.)
    if (!spent && combatantInFight(actor)) await undoHandlers.rollback?.(scope.undo);
    return result;
  });
}

// Each actor's Actions on this client, one at a time: a promise chain by uuid.
const turns = new Map();

/** Run an actor's Action after any already under way on this client. */
function inTurn(actor, task) {
  const key = actor.uuid;
  const run = (turns.get(key) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => {});
  turns.set(key, settled);
  settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key);
  });
  return run;
}

/**
 * The context of something that isn't an Action of its own: part of
 * another (`outer`, passed on so a part of it can still make it stricter),
 * or outside a fight.
 * @param {object|null} outer  The Action's scope.
 * @returns {object}
 */
function partContext(outer) {
  return { tracked: false, scope: outer, id: null, use() {}, free() {}, require: () => true, label: "" };
}

/** The context of a roll that's no Action at all (a card's Evade, a free Evade). */
export function passiveContext() {
  return partContext(null);
}

/**
 * Record how to undo part of the Action under way for this actor, if any
 * (helpers/action-undo.mjs runs them, last first). Each is `{t, ...}`:
 *  - `message` {id}: a chat card it posted;
 *  - `mana` {uuid, amount}: Mana it spent;
 *  - `conditions` {uuid, removed}: one-shot Debuffs it used up;
 *  - `set` {uuid, data}: fields to put back (a Pet's command, a toggle, an
 *    advancement mark, an Evade on an Attack card);
 *  - `seat` {uuid, key, entry}: one occupant into a vehicle (entry null:
 *    take them out again) or back into it (entry: their seat);
 *  - `gear` {uuid, slots, equipped}: the crawler's slots, Hotlist and worn
 *    gear before it;
 *  - `item` {actorUuid, id, data}: one of a consumable it used;
 *  - `declaration` {combatId, id}; `reaction` {messageId, before, rev};
 *  - `intervene` {messageId, id}: an Intervene d6 on a Check card;
 *  - `blocked` {reason}: it can't be undone (a potion already drunk).
 * @param {Actor} actor  Whose Action it is.
 * @param {object} record
 */
export function noteUndo(actor, record) {
  const scope = actor ? scopes.get(actor.uuid) : null;
  if (scope) scope.undo.push(record);
}

/**
 * Note the crawler's slots, Hotlist and worn gear before the Action under
 * way changes them - once per Action.
 * @param {Actor} actor
 */
export function noteGear(actor) {
  const scope = actor ? scopes.get(actor.uuid) : null;
  if (!scope || scope.undo.some((r) => r.t === "gear" && r.uuid === actor.uuid)) return;
  scope.undo.push(gearRecord(actor));
}

/**
 * A crawler's slots, Hotlist and worn gear, to put back.
 * @param {Actor} actor
 * @returns {object}
 */
export function gearRecord(actor) {
  const sys = actor.system;
  return {
    t: "gear",
    uuid: actor.uuid,
    slots: foundry.utils.deepClone({
      gearSlots: sys.gearSlots ?? {}, accessories: [...(sys.accessories ?? [])], hotlist: [...(sys.hotlist ?? [])],
    }),
    equipped: Object.fromEntries(actor.items.filter((i) => i.type === "item").map((i) => [i.id, !!i.system.equipped])),
  };
}

/**
 * Hooks into the undo module (helpers/action-undo.mjs), set at init so this
 * module doesn't import it: `rollback(records)` takes back a refused
 * Action's effects; `undo(combatId, combatantId, entryId, user)` undoes a
 * spent one on the active GM's client; `reason(entry, spent)` says why a
 * spent entry can't be undone (given the combatant's spent list), or null.
 * @type {{rollback?: Function, undo?: Function, reason?: Function}}
 */
export const undoHandlers = {};

/**
 * Undo a spent Action - what it did, and the Action itself (a red bubble's
 * click). A player may undo their own; the GM is told. Refused, with the
 * reason, when it can't be (helpers/action-undo.mjs).
 * @param {Combat} combat
 * @param {string} combatantId
 * @param {string} entryId
 * @returns {Promise<void>}
 */
export async function undoAction(combat, combatantId, entryId) {
  if (!combat || !entryId) return;
  const entry = actionRecord(combat, combatantId).spent.find((e) => e.id === entryId);
  if (!entry) return;
  // Checked here first, so a player sees why (the GM checks again).
  const reason = undoHandlers.reason?.(entry, actionRecord(combat, combatantId).spent);
  if (reason) {
    ui.notifications.warn(reason);
    return;
  }
  if (game.users.activeGM?.isSelf) {
    await undoHandlers.undo?.(combat.id, combatantId, entryId, game.user);
    return;
  }
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return;
  }
  game.socket.emit(SOCKET, { type: UNDO_OP, combatId: combat.id, combatantId, entryId });
}

/**
 * Whether this actor has already spent an Action tagged so this round -
 * "evade": one Evade Action covers every Attack on them this round (p.81),
 * so a later Evade the same round is free.
 * @param {Actor} actor
 * @param {string} tag
 * @returns {boolean}
 */
export function hasSpent(actor, tag) {
  const fight = combatantInFight(actor);
  if (!fight) return false;
  return actionRecord(fight.combat, fight.combatant.id).spent.some((e) => e.tag === tag);
}

/**
 * An uncommanded Pet in a phased fight: it has no Actions, but still tries
 * not to get hit - its Evade costs nothing (a house ruling; the book is
 * silent). A Mount, with its own Action, pays as usual.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function evadesWithoutAction(actor) {
  if (!isPet(actor) || actor.system.isMount) return false;
  const fight = combatantInFight(actor);
  return !!fight && !petCommanded(fight.combat, actor);
}

/**
 * Whether an Evade costs this actor nothing now: they've already spent the
 * round's Evade Action (one covers every Attack, p.81), or they're an
 * uncommanded Pet (evadesWithoutAction).
 * @param {Actor} actor
 * @returns {boolean}
 */
export function evadeIsFree(actor) {
  return hasSpent(actor, "evade") || evadesWithoutAction(actor);
}

/**
 * Take back a spent Action (a misclick, a withdrawn declaration). A player
 * may undo their own; the GM is told.
 * @param {Combat} combat
 * @param {string} combatantId
 * @param {string} entryId
 * @returns {Promise<void>}
 */
export async function refundAction(combat, combatantId, entryId) {
  if (!combat || !entryId) return;
  await sendOp(combat, "refund", { combatantId, entryId });
}

/**
 * AI Favor's extra non-Attack Action (p.61), once a round: spends 1 AI
 * Favor and adds a gold bubble.
 * @param {Actor} actor  A crawler its user owns.
 * @returns {Promise<boolean>}
 */
export async function buyFavorAction(actor) {
  const fight = combatantInFight(actor);
  if (!fight || !isCrawler(actor) || !actor.isOwner) return false;
  const favor = actor.system.details?.aiFavor ?? 0;
  if (favor < 1) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Actions.NoFavor", { name: actor.name }));
    return false;
  }
  if (actionRecord(fight.combat, fight.combatant.id).favor) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Actions.FavorUsed", { name: actor.name }));
    return false;
  }
  await actor.update({ "system.details.aiFavor": favor - 1 });
  await sendOp(fight.combat, "favor", { combatantId: fight.combatant.id });
  return true;
}

/**
 * GM: add (+1) or take away (-1) an Action for this round - Stealth, the
 * Selfie Stick, a Divine Debuff, a magic item.
 * @param {Combat} combat
 * @param {string} combatantId
 * @param {number} delta
 */
export async function adjustActions(combat, combatantId, delta) {
  if (!game.user.isGM) return;
  await sendOp(combat, "adjust", { combatantId, delta: Math.sign(Number(delta) || 0) });
}

/** GM: clear a combatant's spent Actions and adjustments for this round. */
export async function resetActions(combat, combatantId) {
  if (!game.user.isGM) return;
  await sendOp(combat, "reset", { combatantId });
}

/**
 * Spend a specific bubble from the tracker (a Move, Help, Call a Play...).
 * @param {Combat} combat
 * @param {string} combatantId
 * @param {"move"|"action"|"favor"} pool
 */
export async function spendBubble(combat, combatantId, pool) {
  const kind = pool === "move" ? "move" : "other";
  const label = game.i18n.localize(pool === "move" ? "CARLRPG.Actions.Move" : "CARLRPG.Actions.Other");
  await sendOp(combat, "spend", { combatantId, kind, label, pool, id: foundry.utils.randomID() });
}

/* -------------------------------------------- */
/*  The GM's side                               */
/* -------------------------------------------- */

const queues = new Map();

/** Apply here (the active GM) or send to the active GM. */
async function sendOp(combat, op, data) {
  if (game.users.activeGM?.isSelf) return applyActionOp(combat.id, op, data, game.user);
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return null;
  }
  game.socket.emit(SOCKET, { type: OP, combatId: combat.id, op, data });
  return null;
}

/** Register the GM side of the socket. Call once from `ready`. */
export function registerActionSocket() {
  game.socket.on(SOCKET, (payload, senderId) => {
    if (![OP, UNDO_OP].includes(payload?.type) || !game.users.activeGM?.isSelf) return;
    const user = game.users.get(senderId);
    if (!user) return;
    // An undo runs outside the Actions queue: it may wait on a declaration's
    // or a Reaction card's own queue, which may be waiting on this one.
    if (payload.type === UNDO_OP) void undoHandlers.undo?.(payload.combatId, payload.combatantId, payload.entryId, user);
    else void applyActionOp(payload.combatId, payload.op, payload.data ?? {}, user);
  });
}

/**
 * Apply one change to a combat's Actions, after any earlier one (GM client).
 * @param {string} combatId
 * @param {string} op  "spend" | "refund" | "favor" | "adjust" | "reset"
 * @param {object} data
 * @param {User} user  Who asked.
 * @returns {Promise<boolean>}  Whether it changed anything.
 */
export function applyActionOp(combatId, op, data, user) {
  return queueOn(queues, combatId, () => applyNow(combatId, op, data, user));
}

async function applyNow(combatId, op, data, user) {
  const combat = game.combats.get(combatId);
  if (!combat || !isPhased(combat)) return false;
  const combatant = combat.combatants.get(data.combatantId);
  if (!combatant) return false;
  const owns = user.isGM || !!combatant.actor?.testUserPermission(user, "OWNER");
  const key = storeKey(combat);
  const stored = combat.getFlag(SCOPE, "actions");
  const store = stored?.key === key ? foundry.utils.deepClone(stored) : { key, combatants: {} };
  const rec = (store.combatants[combatant.id] ??= { spent: [], bonus: 0, favor: false });

  switch (op) {
    case "spend": {
      if (!owns) return false;
      const pool = payingPool(combat, combatant, data.kind, data.pool ?? null);
      if (!pool) {
        // Checked before the roll on the roller's client; only a race lands here.
        ui.notifications.warn(game.i18n.format("CARLRPG.Actions.NoneLeft", { name: combatant.name }));
        return false;
      }
      rec.spent.push({
        id: String(data.id || foundry.utils.randomID()), kind: data.kind, label: String(data.label ?? ""),
        tag: data.tag ? String(data.tag) : null, pool, by: user.id,
        undo: Array.isArray(data.undo) ? data.undo : [],
      });
      break;
    }
    case "refund": {
      if (!owns) return false;
      const index = rec.spent.findIndex((e) => e.id === data.entryId);
      if (index < 0) return false;
      const [entry] = rec.spent.splice(index, 1);
      if (!user.isGM) {
        ui.notifications.info(game.i18n.format("CARLRPG.Actions.Refunded", {
          user: user.name, name: combatant.name, label: entry.label || game.i18n.localize("CARLRPG.Actions.Other"),
        }));
      }
      break;
    }
    case "favor":
      if (!owns || rec.favor) return false;
      rec.favor = true;
      break;
    case "adjust": {
      if (!user.isGM) return false;
      const base = baseBudget(combat, combatant).action;
      rec.bonus = Math.max(-base, rec.bonus + (Number(data.delta) || 0));
      break;
    }
    case "reset":
      if (!user.isGM) return false;
      store.combatants[combatant.id] = { spent: [], bonus: 0, favor: false };
      break;
    default:
      return false;
  }
  const { ForcedReplacement } = foundry.data.operators;
  await combat.update({ flags: { [SCOPE]: { actions: ForcedReplacement.create(store) } } });
  return true;
}
