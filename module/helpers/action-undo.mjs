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
 *  - a declaration's Declaration Phase is over.
 * The GM can still add an Action from the tracker.
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
    }
  }
  return null;
}

/** Whether a card's buttons have been used: it can't simply be taken back. */
function cardActedOn(message) {
  if (DONE_FLAGS.some((flag) => !!message.getFlag(SCOPE, flag))) return true;
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
    await runRecords(entry.undo ?? []);
    await applyActionOp(combatId, "refund", { combatantId, entryId }, user);
    return true;
  } finally {
    undoing.delete(entryId);
  }
}

/**
 * Take back what an Action did, last thing first. One record failing
 * (a document since deleted) doesn't stop the rest.
 * @param {object[]} records
 */
export async function runRecords(records) {
  for (const record of [...(records ?? [])].reverse()) {
    try {
      await runRecord(record);
    } catch (err) {
      console.error(`CarlRPG | undoing an Action: "${record.t}" failed`, err);
    }
  }
}

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
    case "declaration": {
      const combat = game.combats.get(record.combatId);
      // Withdrawing it gives back its Debuffs - and its Action (the same one).
      if (combat) await removeDeclaration(combat, record.id);
      return;
    }
    case "reaction":
      await withCard(record.messageId, async () => {
        const message = game.messages.get(record.messageId);
        const current = message?.getFlag(SCOPE, "reaction");
        if (!current || current.locked || (current.rev ?? 0) !== record.rev) return;
        const restored = foundry.utils.deepClone(record.before);
        restored.rev = current.rev ?? 0; // counts on from here (writeState)
        await writeState(message, restored);
      });
      return;
  }
}
