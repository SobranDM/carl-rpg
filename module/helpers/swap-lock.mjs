/**
 * The Hotlist swap lock (module/helpers/hotlist.mjs): while a crawler's
 * swap is under way - a Swap and Attack keeps it until its Attack dialog
 * closes - nothing else may change their hands, worn gear or Hotlist on
 * this client. The equip helpers (equip-slots.mjs), the Hotlist's own
 * writes and CarlRPGItem#_preUpdate (an Equipped box) all check it; the
 * swap's own writes pass through with `duringSwap` / the `carlSwap` update
 * option.
 */

// Actors with a swap under way, by uuid.
const swapping = new Set();

/** Start a swap for this actor. */
export function beginSwap(actor) {
  swapping.add(actor.uuid);
}

/** End this actor's swap. */
export function endSwap(actor) {
  swapping.delete(actor.uuid);
}

/**
 * Refuse a change to this crawler's hands, worn gear or Hotlist while a
 * swap is under way, with the reason.
 * @param {Actor} actor
 * @returns {boolean}  true if refused.
 */
export function refuseWhileSwapping(actor) {
  if (!actor || !swapping.has(actor.uuid)) return false;
  ui.notifications.warn(game.i18n.localize("CARLRPG.Hotlist.Swap.InProgress"));
  return true;
}
