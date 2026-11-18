/**
 * The "Apply Healing" (+ optional "Mend Debuff") buttons on a Heal roll's
 * chat card - the write side of CarlDice.rollHeal (module/dice/dice.mjs),
 * see docs/known-gaps.md 1.2. Mirrors the target-effect pipeline's shape
 * (module/chat/target-effects-card.mjs): the roll only ever snapshots what
 * it needs as chat message flags, the actual system.hb.value/
 * system.conditions writes happen here, on click, gated to GM/owner, with a
 * flag-based double-apply guard.
 *
 * Who it heals is decided when it's cast (module/helpers/heal-targets.mjs):
 * the targeted token(s), or the caster. They're snapshotted as one row each
 * (`healRecipients`, keyed r0, r1... - not by uuid, which Foundry would
 * expand as a dotted key), each with its own `applied`, so two owners
 * clicking at once each mark only their own. Like a potion poured into
 * another player's crawler (module/chat/consumable-card.mjs), Apply is for
 * the GM or a recipient's owner: it heals the rows that user can update.
 * `healActorUuid` is the caster; a card from before recipients were
 * snapshotted has only that, and heals it.
 */
import { removeConditionFromActor } from "../helpers/conditions.mjs";
import { findConditionWithMechanic, conditionLabel } from "../helpers/debuff-effects.mjs";
import { shortRestUpdates, conditionsAfterRest, hbCeiling, restoreUpTo } from "../helpers/rest.mjs";
import { showCarlDialog, rollButton, cancelButton } from "../apps/carl-dialog.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { isVehicle } from "../helpers/actor-kinds.mjs";

const SCOPE = "carl-rpg";
const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/heal-footer.hbs";

/**
 * Render the chat-card footer: the healing summary (naming who it heals), an
 * "Apply Healing" button, and (only when the unlocked tier grants it) a
 * "Mend Debuff" button.
 * @param {{full?: boolean, rest?: boolean, amount?: number, canMend?: boolean, names?: string[]}} options
 *   full: heals to full; rest: also a Short Rest's benefits (Heal Self
 *   Rank 15). names: who it heals.
 * @returns {Promise<string>}
 */
export async function buildHealFooter({ full = false, rest = full, amount = 0, canMend = false, names = [] } = {}) {
  const { renderTemplate } = foundry.applications.handlebars;
  const who = names.join(", ");
  let summary;
  if (!who) {
    summary = full
      ? game.i18n.localize(rest ? "CARLRPG.Heal.WillHealFull" : "CARLRPG.Heal.WillHealFullOnly")
      : game.i18n.format("CARLRPG.Heal.WillHeal", { amount });
  } else if (full) {
    summary = game.i18n.format(rest ? "CARLRPG.Heal.WillHealFullRestNamed" : "CARLRPG.Heal.WillHealFullNamed", { names: who });
  } else {
    summary = game.i18n.format("CARLRPG.Heal.WillHealNamed", { names: who, amount });
  }
  return renderTemplate(FOOTER_TEMPLATE, { summary, canMend });
}

/**
 * @param {string} uuid
 * @returns {Promise<Actor|null>}
 */
async function resolveHealActor(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  return doc instanceof Actor ? doc : (doc.actor ?? null);
}

/** Whether this user owns the actor behind a token/actor uuid (a GM always does). */
function ownsUuid(uuid) {
  if (game.user.isGM) return true;
  if (!uuid) return false;
  try {
    const doc = fromUuidSync(uuid);
    const actor = doc instanceof Actor ? doc : doc?.actor;
    return !!actor?.isOwner;
  } catch (e) {
    return false;
  }
}

/**
 * The card's recipient rows: `healRecipients` in order, or - a card from
 * before those - the one actor it snapshotted.
 * @param {ChatMessage} message
 * @returns {{id: string, uuid: string, name: string, applied: boolean}[]}
 */
export function healRows(message) {
  const rows = message.getFlag(SCOPE, "healRecipients");
  if (rows && typeof rows === "object") {
    return Object.entries(rows)
      .filter(([, r]) => r?.uuid)
      .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
      .map(([id, r]) => ({ id, uuid: r.uuid, name: r.name ?? "", applied: !!r.applied }));
  }
  const uuid = message.getFlag(SCOPE, "healActorUuid");
  return uuid ? [{ id: "r0", uuid, name: "", applied: !!message.getFlag(SCOPE, "healApplied"), legacy: true }] : [];
}

/**
 * @param {ChatMessage} message
 * @returns {boolean} Whether the current user may click Apply/Mend for this
 *   card - a GM always can; otherwise only an owner of one of its recipients.
 */
export function canApplyHeal(message) {
  if (game.user.isGM) return true;
  return healRows(message).some((row) => ownsUuid(row.uuid));
}

/**
 * Whether Apply is used up for this viewer: every recipient they could heal
 * has been (all of them, for a GM).
 * @param {ChatMessage} message
 * @returns {boolean}
 */
export function healDoneFor(message) {
  if (message.getFlag(SCOPE, "healApplied")) return true;
  const rows = healRows(message).filter((row) => ownsUuid(row.uuid));
  return rows.length > 0 && rows.every((row) => row.applied);
}

// Cards being applied on this client - a second click while the first is
// still running does nothing.
const applying = new Set();

// Rows this client has applied, by message.id:rowId, until the card's own
// flag says so: a player's mark reaches the card through the GM a moment
// later, and a click before then mustn't heal again.
const appliedHere = new Set();

/** Whether a row is applied, as this client knows it (the card, or its own mark not yet arrived). */
function rowApplied(message, row) {
  const key = `${message.id}:${row.id}`;
  if (row.applied) appliedHere.delete(key);
  return row.applied || appliedHere.has(key);
}

/**
 * Apply the snapshotted healing to each recipient this user can update,
 * marking each row so it can't double-apply on a later re-render. Each
 * row's state is read again from the card just before it's healed: one
 * applied meanwhile (by another user, once their mark has reached the card)
 * is skipped. A recipient that can't be healed now (a vehicle, The Taint)
 * isn't marked, so its Apply stays live.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
export async function onApplyHeal(event, message) {
  event.preventDefault();
  if (applying.has(message.id)) return;
  const rows = healRows(message).filter((row) => !rowApplied(message, row) && ownsUuid(row.uuid));
  if (!rows.length) return;
  applying.add(message.id);
  try {
    const full = message.getFlag(SCOPE, "healFull") ?? false;
    // A card from before Heal Critter's plain full heal: full always rested.
    const rest = message.getFlag(SCOPE, "healRest") ?? full;
    const amount = message.getFlag(SCOPE, "healAmount") ?? 0;
    const ready = [];
    for (const row of rows) {
      const actor = await resolveHealActor(row.uuid);
      if (!actor) {
        ui.notifications.warn(game.i18n.localize("CARLRPG.Heal.NoActor"));
        continue;
      }
      const refusal = healRefusal(actor);
      if (refusal) ui.notifications.warn(refusal);
      else ready.push({ row, actor });
    }

    // Read again now, after the waits: applied meanwhile, it's skipped.
    const current = new Map(healRows(message).map((row) => [row.id, row]));
    const done = ready.filter(({ row }) => current.has(row.id) && !rowApplied(message, current.get(row.id)));
    if (!done.length) return;
    for (const { row } of done) appliedHere.add(`${message.id}:${row.id}`);

    const all = [...current.values()];
    const appliedIds = new Set([...all.filter((r) => r.applied).map((r) => r.id), ...done.map(({ row }) => row.id)]);
    const updates = all.some((r) => r.legacy)
      ? { healApplied: true }
      : {
        healRecipients: Object.fromEntries(done.map(({ row }) => [row.id, { applied: true }])),
        ...(all.every((r) => appliedIds.has(r.id)) ? { healApplied: true } : {}),
      };
    await updateCardMessage(message, { flags: { [SCOPE]: updates } });
    for (const { actor } of done) await healActor(actor, { full, rest, amount });
  } finally {
    applying.delete(message.id);
  }
}

/**
 * Why an actor can't be healed now, or null: a vehicle (repaired by a GM
 * edit of its Health Bar, not healed), or a creature The Taint stops being
 * healed ("You can't be healed", Table 11 - the button stays live, so the
 * heal can still be applied once it's gone).
 * @param {Actor} actor
 * @returns {string|null}  A localized warning.
 */
function healRefusal(actor) {
  if (isVehicle(actor)) return game.i18n.localize("CARLRPG.Vehicle.NotHealed");
  const taint = findConditionWithMechanic(actor.system, "noHealing");
  if (taint) return game.i18n.format("CARLRPG.Heal.BlockedByDebuff", { name: actor.name, debuff: conditionLabel(taint) });
  return null;
}

/**
 * Heal one actor (healRefusal already checked).
 * @param {Actor} actor
 * @param {{full: boolean, rest: boolean, amount: number}} heal
 * @returns {Promise<boolean>}  Whether it was healed.
 */
async function healActor(actor, { full, rest, amount }) {
  const sys = actor.system;
  const effectiveMax = hbCeiling(sys);
  let updates;
  if (full && rest) {
    // "Heal to full and gain the benefits of a short rest" (Heal Self Rank
    // 15) reuses the Short Rest formula for the Mana half-restore, but
    // overrides hb.value straight to effectiveMax rather than the Short
    // Rest's flat "+5" - see docs/known-gaps.md 1.2 and module/helpers/rest.mjs.
    updates = { ...shortRestUpdates(actor), "system.hb.value": Math.max(sys.hb?.value ?? 0, effectiveMax) };
    // The Short Rest also ends whatever a short rest ends (Minor Injury -
    // rest.mjs's conditionsAfterRest), independent of the separate Mend
    // Debuff button, which still lets the caster pick one more to remove.
    updates["system.conditions"] = conditionsAfterRest(sys.conditions, "short");
  } else if (full) {
    // "Heal back to 100% Health Bar" (Heal Critter) - the Health Bar only.
    updates = { "system.hb.value": Math.max(sys.hb?.value ?? 0, effectiveMax) };
  } else {
    updates = { "system.hb.value": restoreUpTo(sys.hb?.value ?? 0, amount, effectiveMax) };
  }
  await actor.update(updates);
  ui.notifications.info(game.i18n.format("CARLRPG.Heal.AppliedNotice", { name: actor.name }));
  return true;
}

/**
 * Remove one entry from a recipient's current `system.conditions` -
 * directly, if there's only one to choose from, otherwise via a picker
 * dialog (each Debuff named with whose it is, when the heal took several).
 * Kept deliberately simple, per docs/known-gaps.md 1.2 - no attempt to
 * filter the list to conditions matching the tier's descriptive scope
 * ("Minor Injury, Poison, or Disease" / "Major Injury or other Debuff");
 * the caster picks from everything currently on the recipient(s) this user
 * can update.
 * @param {PointerEvent} event
 * @param {ChatMessage} message
 */
export async function onMendDebuff(event, message) {
  event.preventDefault();
  const actors = [];
  for (const row of healRows(message).filter((r) => ownsUuid(r.uuid))) {
    const actor = await resolveHealActor(row.uuid);
    if (actor && !actors.includes(actor)) actors.push(actor);
  }
  if (!actors.length) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Heal.NoActor"));
    return;
  }

  const choices = actors.flatMap((actor) => (actor.system.conditions ?? []).map((c, index) => ({ actor, index, condition: c })));
  if (!choices.length) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Heal.NoConditions", { name: actors.map((a) => a.name).join(", ") }));
    return;
  }

  let chosen = choices[0];
  // Only one Debuff to mend - just remove it, no need to make the player
  // pick from a list of one.
  if (choices.length > 1) {
    const named = actors.length > 1;
    const options = choices
      .map((c, i) => {
        const label = c.condition.label || c.condition.key;
        return `<option value="${i}">${foundry.utils.escapeHTML(named ? `${c.actor.name}: ${label}` : label)}</option>`;
      })
      .join("");
    const result = await showCarlDialog({
      title: game.i18n.localize("CARLRPG.Heal.MendTitle"),
      content: `<div class="carl-dialog-body"><div class="form-group">
        <select name="index">${options}</select>
      </div></div>`,
      buttons: [rollButton({ label: "CARLRPG.Heal.MendConfirm" }), cancelButton()],
    });
    if (!result) return;
    chosen = choices[Number(result.index)];
    if (!chosen) return;
  }
  if (!chosen.actor.system.conditions?.[chosen.index]) return;
  await removeConditionFromActor(chosen.actor, chosen.index);
  await updateCardMessage(message, { flags: { [SCOPE]: { healMended: true } } });
  ui.notifications.info(game.i18n.format("CARLRPG.Heal.MendedNotice", { name: chosen.actor.name }));
}

/**
 * Registry entries consumed by the shared registerChatListener (module/chat/
 * chat-listener.mjs) - preserves this pair's GM/owner visibility gating and
 * one-shot "already used" disabling per button (one cast grants exactly one
 * Mend; Apply is used up per viewer once every recipient they can heal is -
 * `isDone`). Both share `.carl-heal-actions` (the buttons) as their
 * wrapperSelector, so a viewer who can't act still sees the summary naming
 * who it heals; if `!canApplyHeal`, the second `.remove()` call is a
 * harmless no-op on an already-removed element.
 */
export const healActionEntries = [
  {
    action: "applyHeal",
    buttonSelector: ".carl-apply-heal",
    wrapperSelector: ".carl-heal-actions",
    canAct: canApplyHeal,
    doneFlag: "healApplied",
    isDone: healDoneFor,
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Heal.Applied")}`,
    onClick: onApplyHeal,
  },
  {
    action: "mendDebuff",
    buttonSelector: ".carl-mend-debuff",
    wrapperSelector: ".carl-heal-actions",
    canAct: canApplyHeal,
    doneFlag: "healMended",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Heal.Mended")}`,
    onClick: onMendDebuff,
  },
];
