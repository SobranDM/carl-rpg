/**
 * Dialog factory - the sole entry point for this system's roll-option
 * dialogs, so classes/behavior stay consistent. Adapted from foundryvtt-wwn's
 * module/applications/wwn-dialog.mjs (simplified - no theming layer).
 */

const { DialogV2 } = foundry.applications.api;

/** What a button callback's null/undefined becomes, so DialogV2 doesn't swap in its action. */
const NO_RESULT = Symbol("carl-dialog.no-result");

/**
 * DialogV2 resolves `callback() ?? button.action`, so a callback that
 * returns null/undefined (Cancel; a file picker with no file) would resolve
 * with the action string - truthy, and taken as a real answer. Each callback
 * is wrapped so that comes back as null. Buttons with no callback still
 * resolve with their action.
 * @param {object} button
 * @returns {object}
 */
function wrapButton(button) {
  if (typeof button.callback !== "function") return button;
  const callback = button.callback;
  return { ...button, callback: async (...args) => (await callback(...args)) ?? NO_RESULT };
}

/**
 * Show a themed system dialog and await its result.
 * @param {object} config
 * @param {string} config.title
 * @param {string} [config.content]
 * @param {string} [config.template]
 * @param {object} [config.context]
 * @param {Array} [config.buttons]
 * @param {Function} [config.onRender]
 * @param {object} [config.position]  Window position/size, e.g. {width: 720}.
 * @param {boolean} [config.trusted]  Pass the content to Foundry as an element,
 *   which it doesn't clean. A string is cleaned (foundry.utils.cleanHTML),
 *   and that strips URL schemes off its list - e.g. the blob: thumbnails of
 *   the Rulebook import's maps. Only for our own templates, with anything
 *   from outside escaped by Handlebars.
 * @returns {Promise<*>} The chosen button's callback result (its action if it
 *   has no callback), or null if cancelled/closed or the callback returned
 *   null/undefined.
 */
export async function showCarlDialog({
  title, content, template, context = {}, buttons, onRender, rejectClose = false, classes = [], position, trusted = false,
} = {}) {
  if (template) {
    content = await foundry.applications.handlebars.renderTemplate(template, context);
  }
  if (trusted && typeof content === "string") {
    const div = document.createElement("div");
    div.innerHTML = content;
    content = div;
  }
  return DialogV2.wait({
    window: { title },
    ...(position ? { position } : {}),
    classes: ["carl-rpg", "carl-dialog", ...classes],
    content,
    buttons: (buttons ?? [rollButton()]).map(wrapButton),
    rejectClose,
    render: onRender,
  }).then((result) => (result === NO_RESULT ? null : result)).catch(() => null);
}

/**
 * Standard roll button: resolves with the dialog's form data. Expanded, not
 * the bare `.object` - FormDataExtended.object is FLAT, keyed by each
 * field's exact `name` string ("conditions.abc.def": true), never nested,
 * so a dotted-path field (roll-options.hbs's per-condition checkboxes,
 * name="conditions.{{cm.id}}.{{cond.id}}") needs foundry.utils.expandObject
 * to become the nested `{conditions: {abc: {def: true}}}` shape every
 * caller (promptRollOptions's `result.conditions?.[cm.id]`) expects.
 */
export function rollButton({ label = "CARLRPG.Dialog.Roll" } = {}) {
  return formButton({ action: "roll", icon: "fa-solid fa-dice-d20", label });
}

/**
 * A default button that resolves with the dialog's form data, expanded
 * (see rollButton) - e.g. the sheet's Resistances dialog's Save.
 * @param {{action: string, icon: string, label: string}} options
 * @returns {object}
 */
export function formButton({ action, icon, label }) {
  return {
    action,
    icon,
    label,
    default: true,
    callback: (event, button) => foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(button.form).object),
  };
}

/** Standard cancel button: showCarlDialog resolves null. */
export function cancelButton({ label = "CARLRPG.Dialog.Cancel" } = {}) {
  return { action: "cancel", icon: "fa-solid fa-xmark", label, callback: () => null };
}
