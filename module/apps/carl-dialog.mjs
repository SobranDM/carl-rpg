/**
 * Dialog factory - the sole entry point for this system's roll-option
 * dialogs, so classes/behavior stay consistent. Adapted from foundryvtt-wwn's
 * module/applications/wwn-dialog.mjs (simplified - no theming layer).
 */

const { DialogV2 } = foundry.applications.api;

/**
 * Show a themed system dialog and await its result.
 * @param {object} config
 * @param {string} config.title
 * @param {string} [config.content]
 * @param {string} [config.template]
 * @param {object} [config.context]
 * @param {Array} [config.buttons]
 * @param {Function} [config.onRender]
 * @returns {Promise<*>} The chosen button's callback result, or null if cancelled/closed.
 */
export async function showCarlDialog({
  title, content, template, context = {}, buttons, onRender, rejectClose = false, classes = [],
} = {}) {
  if (template) {
    content = await foundry.applications.handlebars.renderTemplate(template, context);
  }
  return DialogV2.wait({
    window: { title },
    classes: ["carl-rpg", "carl-dialog", ...classes],
    content,
    buttons: buttons ?? [rollButton()],
    rejectClose,
    render: onRender,
  }).catch(() => null);
}

/** Standard roll button: resolves with the dialog's form data. */
export function rollButton({ label = "CARLRPG.Dialog.Roll" } = {}) {
  return {
    action: "roll",
    icon: "fa-solid fa-dice-d20",
    label,
    default: true,
    callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object,
  };
}

/** Standard cancel button. */
export function cancelButton({ label = "CARLRPG.Dialog.Cancel" } = {}) {
  return { action: "cancel", icon: "fa-solid fa-xmark", label, callback: () => null };
}
