/**
 * Generic toggle for a boolean sheet-UI-state field (drawer open/closed),
 * sibling to module/helpers/array-editor.mjs - a boolean flip is a
 * different concern from an array add/delete, so it gets its own small
 * helper rather than overloading that one. Driven by a dotted `data-path`
 * to a boolean field, same data-driven convention as the array editor.
 * The state is a real persisted DataModel field (see actor-base.mjs's
 * `uiState` and skill.mjs's `damageEffectsExpanded`), never client-only, so
 * a drawer's open/closed state survives a sheet close/reopen.
 */

/**
 * @param {PointerEvent} event
 * @param {HTMLElement} target
 * @param {Actor|Item} document
 */
export async function onToggleDrawer(event, target, document) {
  // A drawer header can host an interactive field of its own (e.g. the
  // Spells header's Mana input, see collapsible-section.hbs) - don't toggle
  // when the actual click landed on a form control, only on the header
  // itself/its label/caret.
  if (event.target.closest('input, select, textarea, button, a:not([data-action="toggleDrawer"])')) return;
  event.preventDefault();
  if (!document) return;
  const path = target.dataset.path;
  if (!path) return;
  const current = foundry.utils.getProperty(document, path) ?? false;
  await document.update({ [path]: !current });
}
