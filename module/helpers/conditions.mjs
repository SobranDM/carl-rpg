/**
 * An actor's Conditions (Debuffs and Buffs, Table 11 - CONFIG.CARLRPG.
 * debuffs): building entries, and the one writer of `system.conditions`.
 *
 * Every change to the list is a data op (add, push, patch, remove,
 * removeMechanic, restore) applied by changeConditions to the list as it
 * is when the op runs, in the actor's queue (actor-queue.mjs) on the active
 * GM's client - asked for from any other client (chat-socket.mjs askGM). A
 * write from a player's client and one from the GM's (a round's end, an
 * expiry, damage) are applied one after the other to the current list, so
 * neither can overwrite the other's change. With no GM online an owner's
 * change is made on their own client. (Ruled 2026-11-19.)
 *
 * One exception rides another update: an HB change that adds or ends Dying
 * (CarlRPGActor#_preUpdate) carries the list it was made with.
 */
import { askGM, registerAskHandler } from "./chat-socket.mjs";
import { noteUndo } from "./actions.mjs";
import { conditionLabel, isOneShotDebuff } from "./debuff-effects.mjs";
import { takesConditions } from "./actor-kinds.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { fightOf } from "./fights.mjs";

/** The askGM question a player's client sends with its ops. */
const CHANGE = "changeConditions";

/**
 * The Dying countdown a creature starts with: "Your CON Mod is how many
 * rounds you have before you die" (Table 11; the Mod, never below 0).
 * @param {object} sys  An actor's system data.
 * @returns {number}
 */
export function dyingRounds(sys) {
  return Math.max(0, sys?.stats?.con?.mod ?? 0);
}

/**
 * Build one `system.conditions` entry from a debuff key, the same shape
 * whether it was added manually from the Conditions tab or automatically
 * from an Attack/Spell's targetEffects.
 * @param {string} key  Key into CONFIG.CARLRPG.debuffs, or "custom".
 * @param {{stacks?: number, source?: string, label?: string}} [options]
 *   `label` overrides the debuff's default localized label (e.g. an
 *   Upgrade-authored display override); omit to use the preset's own label.
 * @returns {object}
 */
export function buildConditionEntry(key, { stacks = 1, source = "", label = "" } = {}) {
  const preset = CONFIG.CARLRPG.debuffs[key];
  const entry = {
    key,
    label: label || (preset ? game.i18n.localize(preset.label) : ""),
    stacks,
    remaining: preset?.durationType === "rounds" ? (preset.durationValue ?? null) : null,
    source,
  };
  // "Until the end of 10 minutes" (Shit-Faced), "...of 1 hour" (Sore as
  // Shit), "until the end of the combat or 5 minutes" (Burned...): on the
  // world clock, ended by the expiry sweep (module/helpers/expiry.mjs). A
  // combat round moves the clock 10 seconds (p.62), so this holds in a
  // fight too; "end of the combat" is processCombatEnd's (round-end.mjs).
  if (preset?.durationType === "real-minutes" && preset.durationValue) {
    entry.expiresAt = game.time.worldTime + preset.durationValue * 60;
  }
  return entry;
}

// "A 2nd Minor/Major Injury converts to the matching Long-Term version"
// (Table 11, Debuffs) - the second application doesn't stack alongside the
// first, it escalates into a single worse condition instead.
const INJURY_UPGRADES = {
  minorInjury: "longTermMinorInjury",
  majorInjury: "longTermMajorInjury",
};

/**
 * Push a new condition entry onto an actor's `system.conditions` -
 * enforcing Table 11's `stackable` flag (CONFIG.CARLRPG.debuffs) along the
 * way: a non-stackable Debuff already present doesn't get a duplicate row.
 * A 2nd Minor/Major Injury is the one special case that isn't a simple
 * refresh - it replaces the existing entry with the Long-Term version.
 * @param {Actor} actor
 * @param {string} key
 * @param {{stacks?: number, source?: string, label?: string}} [options]
 * @returns {Promise<Actor|null>}  null if it couldn't be added (changeConditions).
 */
export async function addConditionToActor(actor, key, options = {}) {
  // Vehicles take no Debuffs (Object Immunities, p.584) - and have nowhere
  // to put them.
  if (!takesConditions(actor)) return actor;
  return (await changeConditions(actor, [{ op: "add", key, options }])) ? actor : null;
}

/**
 * Add a Condition to a list (an "add" op), by Table 11's rules: a
 * non-stackable Debuff already there is refreshed, not duplicated (Dying's
 * countdown never is); a 2nd Minor/Major Injury becomes the Long-Term one;
 * Dying starts its countdown. "You're Staggered (see below) and take 1d10+F
 * Poison damage" (Sepsis) - a Debuff whose effect is partly another applies
 * that one too (`mechanics.alsoApplies`), by the same rules.
 * @param {object} sys  The actor's system data.
 * @param {object[]} list  Changed in place.
 * @param {string} key
 * @param {{stacks?: number, source?: string, label?: string}} options
 */
function addEntry(sys, list, key, options) {
  const preset = CONFIG.CARLRPG.debuffs[key];
  const existingIndex = list.findIndex((c) => c.key === key);
  let placed = false;
  if (existingIndex !== -1) {
    const upgradeKey = INJURY_UPGRADES[key];
    if (upgradeKey) {
      list.splice(existingIndex, 1, buildConditionEntry(upgradeKey, options));
      placed = true;
    } else if (preset?.stackable === false) {
      // Refreshed (its duration, if it has one) - except Dying's countdown:
      // re-applying it must not hand back rounds already lost.
      if (!preset.mechanics?.countdown) {
        list[existingIndex] = buildConditionEntry(key, { ...options, stacks: list[existingIndex].stacks });
      }
      placed = true;
    }
  }
  if (!placed) {
    const entry = buildConditionEntry(key, options);
    // "Your CON Mod is how many rounds you have before you die" (Dying) -
    // ticked down at the end of each round by module/helpers/round-end.mjs.
    if (preset?.mechanics?.countdown && entry.remaining === null) entry.remaining = dyingRounds(sys);
    list.push(entry);
  }
  for (const extraKey of preset?.mechanics?.alsoApplies ?? []) {
    addEntry(sys, list, extraKey, { source: options.source ?? "" });
  }
}

/**
 * The ops that turn one list into another, by entry id: removals, the
 * fields that changed on an entry (patched - so a change made meanwhile to
 * another field of it is kept), and new entries (pushed). For a caller that works
 * the new list out itself (a rest, a potion, a round's end) - applied to
 * the list as it is then, so a change made meanwhile to another entry is
 * kept.
 * @param {object[]} before
 * @param {object[]} after
 * @returns {object[]}
 */
export function conditionOps(before, after) {
  const ops = [];
  const afterIds = new Set(after.map((c) => c.id).filter(Boolean));
  const removed = before.filter((c) => !afterIds.has(c.id)).map((c) => c.id);
  if (removed.length) ops.push({ op: "remove", ids: removed });
  const beforeById = new Map(before.map((c) => [c.id, c]));
  for (const entry of after) {
    const old = entry.id ? beforeById.get(entry.id) : undefined;
    if (!old) ops.push({ op: "push", entry });
    else {
      const fields = {};
      for (const key of new Set([...Object.keys(old), ...Object.keys(entry)])) {
        if (JSON.stringify(old[key]) !== JSON.stringify(entry[key])) fields[key] = entry[key] ?? null;
      }
      if (Object.keys(fields).length) ops.push({ op: "patch", id: entry.id, fields });
    }
  }
  return ops;
}

/**
 * Apply ops to a list.
 * @param {object} sys  The actor's system data.
 * @param {object[]} list  Changed in place.
 * @param {object[]} ops
 * @returns {object[]}  The entries removed.
 */
function applyOps(sys, list, ops) {
  const removed = [];
  const removeWhere = (test) => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (test(list[i])) removed.unshift(...list.splice(i, 1));
    }
  };
  const has = (id) => !!id && list.some((c) => c.id === id);
  for (const op of ops) {
    switch (op?.op) {
      case "add":
        addEntry(sys, list, op.key, op.options ?? {});
        break;
      case "push":
        if (op.entry && !has(op.entry.id)) list.push(foundry.utils.deepClone(op.entry));
        break;
      case "restore":
        // Given back (an undo): only those not there already.
        for (const entry of op.entries ?? []) if (!has(entry.id)) list.push(foundry.utils.deepClone(entry));
        break;
      case "patch": {
        // Only the fields given; an entry since removed stays removed.
        const index = list.findIndex((c) => c.id === op.id);
        if (index !== -1) Object.assign(list[index], foundry.utils.deepClone(op.fields ?? {}));
        break;
      }
      case "remove": {
        const ids = new Set(op.ids ?? []);
        removeWhere((c) => ids.has(c.id));
        break;
      }
      case "removeMechanic":
        removeWhere((c) => !!CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.[op.flag]);
        break;
    }
  }
  return removed;
}

/**
 * The ops a user who doesn't own the actor may have applied: removing a
 * one-shot Debuff (Stunned/Queasy/Staggered - the only ones a roll ever
 * consumes, a player's Attack using up a Mob's Stunned) from a creature
 * they have targeted or that is in a started Combat (a Taunt's attacking
 * Mob isn't necessarily targeted). Everything else is dropped.
 * @param {object[]} ops
 * @param {object[]} list
 * @param {Actor} actor
 * @param {User} user
 * @returns {object[]}
 */
export function opsAllowed(ops, list, actor, user) {
  if (user.isGM || actor.testUserPermission(user, "OWNER")) return ops;
  const targeted = [...(user.targets ?? [])].some((t) => t.actor === actor || t.document?.actorId === actor.id);
  const inCombat = !!fightOf(actor);
  if (!targeted && !inCombat) return [];
  const oneShot = new Set(list.filter((c) => isOneShotDebuff(c.key)).map((c) => c.id));
  return ops.filter((op) => op?.op === "remove").map((op) => ({ op: "remove", ids: (op.ids ?? []).filter((id) => oneShot.has(id)) }));
}

/**
 * Apply ops to the actor's current list, with any other fields in the same
 * update (HB, Mana, a flag). On the writer's client, in the actor's queue.
 * @param {Actor} actor
 * @param {object[]} ops
 * @param {object} updates
 * @param {User} [user]  Who asked (the GM's side of a player's ops).
 * @returns {Promise<{removed: object[]}|null>}  null: refused - an op this
 *   user may not make (opsAllowed) - and nothing written.
 */
async function writeNow(actor, ops, updates, user = null) {
  const before = actor.system.toObject().conditions ?? [];
  const list = foundry.utils.deepClone(before);
  const allowed = user ? opsAllowed(ops, before, actor, user) : ops;
  if (allowed.length < ops.length) return null;
  const removed = applyOps(actor.system, list, allowed);
  const changed = JSON.stringify(list) !== JSON.stringify(before);
  const write = { ...updates, ...(changed ? { "system.conditions": list } : {}) };
  if (Object.keys(write).length) await actor.update(write);
  return { removed };
}

/**
 * Change an actor's Conditions - the one writer of `system.conditions`
 * (see the top of this file). Awaits the change being made.
 * @param {Actor} actor
 * @param {object[]} ops  [{op: "add", key, options}, {op: "push", entry},
 *   {op: "patch", id, fields}, {op: "remove", ids}, {op: "removeMechanic",
 *   flag}, {op: "restore", entries}].
 * @param {{updates?: object, inQueue?: boolean}} [options]
 *   updates: other fields of the actor written in the same update.
 *   inQueue: the caller is already running in this actor's queue on this
 *   client (round-end, expiry, a rest, a potion): not queued again, which
 *   would wait on itself.
 * @returns {Promise<{removed: object[]}|null>}  What it removed; null if it
 *   couldn't be made (no GM online to make it for a non-owner, or none
 *   answering).
 */
export async function changeConditions(actor, ops, { updates = {}, inQueue = false } = {}) {
  if (!actor) return null;
  // Nothing for the list: the other fields are written here, as ever.
  if (!ops?.length) {
    if (Object.keys(updates).length) await actor.update(updates);
    return { removed: [] };
  }
  const gm = game.users.activeGM;
  if (gm && !gm.isSelf) {
    const answer = await askGM(CHANGE, { uuid: actor.uuid, ops, updates });
    return answer ? { removed: answer.removed ?? [] } : null;
  }
  if (!gm && !actor.isOwner) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Chat.NoGMOnline"));
    return null;
  }
  return inQueue ? writeNow(actor, ops, updates) : queueForActor(actor.uuid, () => writeNow(actor, ops, updates));
}

// The GM's side of a player's changeConditions: `user` is the server-supplied
// sender. Only an owner (or the GM) may change anything but a consumed
// one-shot Debuff (opsAllowed); other fields only with the ops of an owner.
registerAskHandler(CHANGE, async ({ uuid, ops, updates } = {}, user) => {
  const doc = uuid ? await fromUuid(uuid) : null;
  const actor = doc instanceof Actor ? doc : doc?.actor;
  if (!actor || !Array.isArray(ops)) return null;
  const owner = user.isGM || actor.testUserPermission(user, "OWNER");
  return queueForActor(actor.uuid, () => writeNow(actor, ops, owner ? (updates ?? {}) : {}, user));
});

/**
 * Remove conditions by their entry id - used when a roll consumes a
 * one-shot debuff (Stunned, Queasy, Staggered; see module/helpers/
 * debuff-effects.mjs's consumedConditionIds). A player's roll often
 * consumes a debuff on a Mob they don't own: the GM removes it then
 * (changeConditions' opsAllowed), with no GM online it stays.
 * @param {Actor} actor
 * @param {string[]} conditionIds
 * @returns {Promise<void>}
 */
export async function removeConditionsById(actor, conditionIds) {
  if (!actor || !conditionIds?.length) return;
  // Used up by an Action of this actor's own: back if it's undone.
  const used = (actor.system.conditions ?? []).filter((c) => conditionIds.includes(c.id));
  if (used.length) noteUndo(actor, { t: "conditions", uuid: actor.uuid, removed: foundry.utils.deepClone(used) });
  if (!used.length) return;
  const change = changeConditions(actor, [{ op: "remove", ids: [...conditionIds] }]);
  // Someone else's creature (a Mob's Stunned an Attack used up): the GM
  // removes it; the roll doesn't wait for that.
  if (actor.isOwner) await change;
}

/**
 * Remove every condition whose debuff carries a given mechanics flag (e.g.
 * Terrified's `endsOnHbLoss` after a hit lands). GM/owner only - callers
 * are the damage-apply paths, which already run with update permission.
 * @param {Actor} actor
 * @param {string} flag
 * @returns {Promise<string[]>} Labels of the removed conditions.
 */
export async function removeConditionsWithMechanic(actor, flag) {
  const current = actor?.system?.conditions ?? [];
  if (!current.some((c) => CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.[flag])) return [];
  const result = await changeConditions(actor, [{ op: "removeMechanic", flag }]);
  return (result?.removed ?? []).map(conditionLabel);
}

/**
 * Remove one entry from an actor's `system.conditions` by index - the
 * counterpart to addConditionToActor. Used by the Heal chat card's "Mend
 * Debuff" button (module/chat/heal-card.mjs, Heal Self Rank 5/10) so
 * removing a condition goes through the same one-code-path shape as adding
 * one, and by extension stays consistent with the Conditions tab's own
 * per-row delete (module/helpers/array-editor.mjs's onDeleteArrayItem,
 * which this mirrors for a non-sheet caller).
 * @param {Actor} actor
 * @param {number} index
 * @returns {Promise<Actor>}
 */
export async function removeConditionFromActor(actor, index) {
  const id = (actor.system.toObject().conditions ?? [])[index]?.id;
  if (id) await changeConditions(actor, [{ op: "remove", ids: [id] }]);
  return actor;
}

/**
 * Resolve the display label for a collected targetEffect entry (see
 * module/helpers/modifiers.mjs#collectItemTargetEffects): its own author
 * override if set, else the localized CONFIG.CARLRPG.debuffs label, else
 * the raw key as a last-resort fallback.
 * @param {{debuffKey: string, label?: string}} targetEffect
 * @returns {string}
 */
export function resolveTargetEffectLabel(targetEffect) {
  if (targetEffect.label) return targetEffect.label;
  const preset = CONFIG.CARLRPG.debuffs[targetEffect.debuffKey];
  return preset ? game.i18n.localize(preset.label) : targetEffect.debuffKey;
}
