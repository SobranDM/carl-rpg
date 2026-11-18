/**
 * Undoing a spent Action (docs/action-tracking.md): a red bubble's click
 * takes back what the Action did - the card it posted, the Mana and
 * Debuffs it used up, the gear it moved, the declaration, the Reaction
 * card's Taunt or Evade - and then the Action itself.
 *
 * Each Action carries its undo records (helpers/actions.mjs noteUndo, kept
 * on the spent entry). Undo is all or nothing: refused, with the reason,
 * when any part can't be taken back -
 *  - a card has already been acted on (damage applied, a target Evaded, a
 *    potion drunk, a Heal applied);
 *  - the Reaction card has changed since, or is locked;
 *  - a row's Evade has been applied, its injury added, or Intervened on;
 *  - a declaration's Declaration Phase is over.
 * The Reaction card and a row's Evade are checked again in their card's
 * queue when the undo's turn comes: changed meanwhile, the undo stops there
 * and the Action isn't given back (the asker is told). The GM can still add
 * an Action from the tracker.
 *
 * Run on the active GM's client, which can write everything involved,
 * outside the Actions queue (a declaration and the Reaction card have
 * queues of their own that may wait on it).
 */
import { actionRecord, applyActionOp, undoHandlers } from "./actions.mjs";
import { currentPhase } from "./combat-phases.mjs";
import { declaredAttacks, removeDeclaration } from "./declarations.mjs";
import { isCardLocked } from "../chat/taunt-card.mjs";
import { withCard, writeState } from "../chat/reaction-card.mjs";
import { applyRevision, interventionsOf, interveneOpen, withCardQueue } from "../chat/check-revision.mjs";
import { clearRowEvade, recoilSettledBy, rowAt, rowCheck, rowInterveneOpen } from "../chat/row-evade.mjs";
import { tellUser } from "./chat-socket.mjs";

const SCOPE = "carl-rpg";

/** A card's "already done" flags - its buttons have been used (chat-listener.mjs doneFlag). */
const DONE_FLAGS = [
  "damageApplied", "targetEffectsApplied", "healApplied", "healMended", "consumableApplied",
  "tauntedBy", "debuffAdded", "markChoiceDone", "grindSurplusApplied",
];

/** Undos under way on this client, by entry id: a double-click undoes once. */
const undoing = new Set();

/** Hook into helpers/actions.mjs. Call once at init. */
export function registerActionUndo() {
  undoHandlers.reason = undoBlocker;
  undoHandlers.undo = undoSpent;
  undoHandlers.rollback = runRecords;
}

/**
 * Why a spent Action can't be undone, or null if it can.
 * @param {object} entry  The spent entry.
 * @param {object[]} [spent]  The combatant's spent entries this round, in
 *   order - gear moved by a later Action must be undone first.
 * @returns {string|null}  A localized reason.
 */
export function undoBlocker(entry, spent = []) {
  const t = (key, data) => game.i18n.format(`CARLRPG.Actions.Undo.${key}`, data ?? {});
  const later = spent.slice(spent.findIndex((e) => e.id === entry.id) + 1);
  for (const record of entry.undo ?? []) {
    switch (record.t) {
      case "gear": {
        // A snapshot: putting it back would undo a later Retrieve too.
        const movedSince = later.some((e) => (e.undo ?? []).some((r) => r.t === "gear" && r.uuid === record.uuid));
        if (movedSince) return t("GearChanged");
        break;
      }
      case "blocked":
        return t(record.reason || "Blocked");
      case "message": {
        const message = game.messages.get(record.id);
        if (message && cardActedOn(message)) return t("CardUsed");
        // Someone else's Intervene is on it: that comes off first.
        if (message && interventionsOf(message).length) return t("InterveneFirst");
        break;
      }
      case "intervene": {
        const message = game.messages.get(record.messageId);
        // On a row's Evade (an Attack card): that Check's d6s.
        if (record.rowId) {
          const check = rowCheck(rowAt(message, record.rowId), record.which);
          if (!check?.interventions?.some((i) => i.id === record.id)) break;
          if (!rowInterveneOpen(message, record.rowId, record.which)) return t("CardUsed");
          break;
        }
        // Gone (or the d6 already off): only the Action comes back.
        if (!message || !interventionsOf(message).some((i) => i.id === record.id)) break;
        if (!interveneOpen(message)) return t("CardUsed");
        break;
      }
      case "rowEvade": {
        const reason = rowEvadeBlocker(record);
        if (reason) return t(reason);
        break;
      }
      case "reaction": {
        const state = game.messages.get(record.messageId)?.getFlag(SCOPE, "reaction");
        if (!state) break; // the card is gone, and its Actions with it
        if (state.locked) return t("ReactionLocked");
        if ((state.rev ?? 0) !== record.rev) return t("ReactionChanged");
        break;
      }
      case "declaration": {
        const combat = game.combats.get(record.combatId);
        const stillThere = combat && declaredAttacks(combat).some((d) => d.id === record.id);
        if (stillThere && currentPhase(combat) !== "declare") return t("DeclarationOver");
        break;
      }
      // Always taken back (runRecord).
      case "mana":
      case "conditions":
      case "set":
      case "seat":
      case "item":
        break;
      // A record this version doesn't know (a newer client's, a typo): it
      // can't be taken back, so neither is the Action.
      default:
        console.warn(`CarlRPG | undoing an Action: unknown undo record "${record?.t}"`, record);
        return t("Blocked");
    }
  }
  return null;
}

/**
 * Why a row's paid Evade or Shield Block (`which`, module/chat/row-evade.mjs)
 * can't be taken back, as an Undo lang key, or null. Gone, or replaced by a
 * later one: null - only the Action comes back.
 * @param {object} record  A "rowEvade" undo record.
 * @returns {string|null}
 */
function rowEvadeBlocker(record) {
  const attack = game.messages.get(record.messageId);
  const row = rowAt(attack, record.rowId);
  const check = rowCheck(row, record.which ?? "evade");
  if (!check || check.id !== record.checkId) return null;
  if (row.applied || row.injuryAdded || recoilSettledBy(attack, record.rowId)) return "CardUsed";
  if (check.interventions?.length) return "InterveneFirst";
  return null;
}

/** Whether a card's buttons have been used: it can't simply be taken back. */
function cardActedOn(message) {
  if (DONE_FLAGS.some((flag) => !!message.getFlag(SCOPE, flag))) return true;
  // A heal applied to some of its recipients (module/chat/heal-card.mjs).
  if (Object.values(message.getFlag(SCOPE, "healRecipients") ?? {}).some((r) => r?.applied)) return true;
  return !!message.getFlag(SCOPE, "targetRows") && isCardLocked(message);
}

/**
 * Undo a spent Action and take it back (active GM). A player's undo tells
 * the GM (the refund op).
 * @param {string} combatId
 * @param {string} combatantId
 * @param {string} entryId
 * @param {User} user  Who asked.
 * @returns {Promise<boolean>}  Whether it was undone.
 */
export async function undoSpent(combatId, combatantId, entryId, user) {
  const combat = game.combats.get(combatId);
  const combatant = combat?.combatants.get(combatantId);
  if (!combatant || undoing.has(entryId)) return false;
  if (!user.isGM && !combatant.actor?.testUserPermission(user, "OWNER")) return false;
  const spent = actionRecord(combat, combatantId).spent;
  const entry = spent.find((e) => e.id === entryId);
  if (!entry) return false;
  const reason = undoBlocker(entry, spent);
  if (reason) {
    ui.notifications.warn(reason);
    return false;
  }
  undoing.add(entryId);
  try {
    // All or nothing: a part that can no longer be taken back when its turn
    // comes (the Reaction card changed while the undo waited in its queue)
    // stops the undo there, and the Action stays spent.
    const failed = await runRecords(entry.undo ?? [], { stopOnRefusal: true });
    if (failed) {
      tellUser(user, `CARLRPG.Actions.Undo.${failed}`);
      return false;
    }
    await applyActionOp(combatId, "refund", { combatantId, entryId }, user);
    return true;
  } finally {
    undoing.delete(entryId);
  }
}

/**
 * Take back what an Action did, last thing first. One record failing
 * (a document since deleted) doesn't stop the rest. A record that refuses
 * - its part can't be taken back now - is reported, and with
 * `stopOnRefusal` nothing after it runs. (A part that can refuse - a
 * Reaction-card op, a row's Evade or Shield Block, an Intervene - is noted
 * last on its Action, so it runs first: a refusal leaves the rest undone.)
 * @param {object[]} records
 * @param {{stopOnRefusal?: boolean}} [options]
 * @returns {Promise<string|null>}  The first refusal, as an Undo lang key
 *   ("ReactionChanged"...), or null.
 */
export async function runRecords(records, { stopOnRefusal = false } = {}) {
  let refused = null;
  for (const record of [...(records ?? [])].reverse()) {
    let reason = null;
    try {
      reason = await runRecord(record);
    } catch (err) {
      console.error(`CarlRPG | undoing an Action: "${record.t}" failed`, err);
    }
    if (!reason) continue;
    refused ??= reason;
    if (stopOnRefusal) break;
  }
  return refused;
}

/**
 * Take back one part of an Action.
 * @param {object} record
 * @returns {Promise<string|null|undefined>}  An Undo lang key if it refused.
 */
async function runRecord(record) {
  switch (record.t) {
    case "message":
      await game.messages.get(record.id)?.delete();
      return;
    case "mana": {
      const actor = fromUuidSync(record.uuid);
      if (!actor) return;
      const mana = actor.system.mana ?? {};
      const value = Math.min(mana.max ?? Infinity, (mana.value ?? 0) + (Number(record.amount) || 0));
      await actor.update({ "system.mana.value": value });
      return;
    }
    case "conditions": {
      const actor = fromUuidSync(record.uuid);
      if (!actor) return;
      const current = actor.system.toObject?.().conditions ?? foundry.utils.deepClone(actor.system.conditions ?? []);
      const have = new Set(current.map((c) => c.id));
      const back = (record.removed ?? []).filter((c) => !have.has(c.id));
      if (back.length) await actor.update({ "system.conditions": [...current, ...back] });
      return;
    }
    case "set": {
      const doc = fromUuidSync(record.uuid);
      if (doc) await doc.update(record.data, { carlUndo: true });
      return;
    }
    case "seat": {
      const vehicle = fromUuidSync(record.uuid);
      if (!vehicle) return;
      const occupants = vehicle.system.toObject().occupants.filter((o) => o.uuid !== record.key);
      if (record.entry) occupants.push(record.entry);
      await vehicle.update({ "system.occupants": occupants }, { carlUndo: true });
      return;
    }
    case "gear": {
      const actor = fromUuidSync(record.uuid);
      if (!actor) return;
      const { gearSlots, accessories, hotlist } = record.slots;
      // Only slots still holding something it owns (or empty) are put back.
      await actor.update({ "system.gearSlots": gearSlots, "system.accessories": accessories, "system.hotlist": hotlist }, { carlUndo: true });
      const updates = Object.entries(record.equipped ?? {})
        .filter(([id, equipped]) => actor.items.get(id) && !!actor.items.get(id).system.equipped !== equipped)
        .map(([id, equipped]) => ({ _id: id, "system.equipped": equipped }));
      if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { carlUndo: true });
      return;
    }
    case "item": {
      const actor = fromUuidSync(record.actorUuid);
      if (!actor) return;
      const item = actor.items.get(record.id);
      if (item) await item.update({ "system.quantity": Number(item.system.quantity ?? 0) + 1 }, { carlUndo: true });
      else if (record.data) await actor.createEmbeddedDocuments("Item", [record.data], { keepId: true, carlUndo: true });
      return;
    }
    case "intervene": {
      // The d6 off the card (or its row), and it re-graded without it.
      await applyRevision(record.messageId, "unintervene", record.rowId
        ? { id: record.id, rowId: record.rowId, which: record.which }
        : { id: record.id }, game.user);
      // Refused (its card couldn't be re-graded): the d6 is still on it.
      return interventionStillOn(record) ? "Failed" : null;
    }
    case "rowEvade":
      // In the Attack card's queue (after any Intervene or reroll on it),
      // checked again: a row applied since the undo was asked refuses it.
      return withCardQueue(record.messageId, async () => {
        const message = game.messages.get(record.messageId);
        if (!message) return null;
        const reason = rowEvadeBlocker(record);
        if (reason) return reason;
        await clearRowEvade(message, record.rowId, record.checkId, record.which ?? "evade");
        return null;
      });
    case "declaration": {
      const combat = game.combats.get(record.combatId);
      // Withdrawing it gives back its Debuffs - and its Action (the same one).
      if (combat) await removeDeclaration(combat, record.id);
      return;
    }
    case "reaction":
      // Checked again in the card's queue: an op that landed while this
      // waited (another crawler's Intervene) changes `rev`, and the card
      // can't be put back without losing it - refused.
      return withCard(record.messageId, async () => {
        const message = game.messages.get(record.messageId);
        const current = message?.getFlag(SCOPE, "reaction");
        if (!current) return null; // the card is gone, and its Actions with it
        if (current.locked) return "ReactionLocked";
        if ((current.rev ?? 0) !== record.rev) return "ReactionChanged";
        const restored = foundry.utils.deepClone(record.before);
        restored.rev = current.rev ?? 0; // counts on from here (writeState)
        await writeState(message, restored);
        return null;
      });
    case "blocked":
      // Nothing to take back (undoBlocker refuses its undo; a refused Action's rollback skips it).
      return;
    default:
      // Unknown: refused, so the Action isn't given back for something still done.
      console.warn(`CarlRPG | undoing an Action: unknown undo record "${record?.t}"`, record);
      return "Blocked";
  }
}

/** Whether an Intervene's d6 is still on its card (or row). */
function interventionStillOn(record) {
  const message = game.messages.get(record.messageId);
  if (!message) return false;
  const list = record.rowId
    ? (rowCheck(rowAt(message, record.rowId), record.which)?.interventions ?? [])
    : interventionsOf(message);
  return list.some((i) => i.id === record.id);
}
