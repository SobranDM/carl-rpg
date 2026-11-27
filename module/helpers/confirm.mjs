/**
 * Asking before something that can't be undone (ruled 2026-11-27): deleting
 * an item from a sheet, and throwing away a loot box's prepared contents. A
 * plain click asks; Shift-click goes ahead at once, for someone clearing out
 * a lot. Removing a row inside an editor, clearing a Hotlist or Equipment
 * Doll slot, withdrawing a declaration and dropping an entry from an unsaved
 * Loot Forge draft don't ask - nothing is lost.
 */

/** The class on these prompts (tests find them by it). */
export const CONFIRM_CLASS = "carl-confirm-dialog";

/**
 * Delete an item, after Foundry's own "Delete Item" prompt - or at once on
 * Shift-click.
 * @param {Item} item
 * @param {Event} [event]  The click.
 * @returns {Promise<boolean>}  Whether it was deleted.
 */
export async function deleteItemAsking(item, event) {
  if (!item) return false;
  if (event?.shiftKey) return !!(await item.delete());
  return !!(await item.deleteDialog({ classes: [CONFIRM_CLASS] }));
}

/**
 * Ask whether to go ahead with something that can't be undone - or don't,
 * on Shift-click.
 * @param {Event} [event]  The click.
 * @param {{title: string, content: string}} prompt  content is HTML.
 * @returns {Promise<boolean>}
 */
export async function confirmUndoable(event, { title, content }) {
  if (event?.shiftKey) return true;
  const ok = await foundry.applications.api.DialogV2.confirm({
    classes: [CONFIRM_CLASS],
    window: { title, icon: "fa-solid fa-triangle-exclamation" },
    content,
  });
  return ok === true;
}
