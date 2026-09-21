/**
 * The "which one gets marked" buttons on an Attack chat card, for the one
 * case Skills, Spells & Gear calls out as a real choice: "When you make an
 * Attack that adds a Damage Effect, place a mark for later Skill
 * Advancement in either the Attack Skill or the Damage Effect, not both."
 * CarlDice.rollAttack (module/dice/dice.mjs) only ever appends this footer
 * when BOTH the Attack Skill and the chosen Damage Effect are still
 * eligible-and-unmarked at roll time - if only one of them is, it's marked
 * automatically with no card needed (see rollAttack's markChoicePending).
 *
 * Two buttons, one shared doneFlag: clicking either one marks that item and
 * flips the doneFlag, which disables BOTH buttons on the next render (see
 * module/chat/chat-listener.mjs's registry loop) - exactly the "not both"
 * rule the book describes, enforced by the UI itself rather than trusting
 * the player to only click once.
 */
import CarlDice from "../dice/dice.mjs";
import { canActOnUuidFlag } from "./evade-link-card.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";

const FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/mark-choice-footer.hbs";

/**
 * Render the "Mark for Advancement" footer offering both candidates.
 * @param {Item} skillItem
 * @param {Item} damageEffectItem
 * @returns {Promise<string>}
 */
export async function buildMarkChoiceFooter(skillItem, damageEffectItem) {
  const { renderTemplate } = foundry.applications.handlebars;
  return renderTemplate(FOOTER_TEMPLATE, { skillItem, damageEffectItem });
}

/**
 * Resolve a snapshotted item UUID back to the live Item, if it (and its
 * owning Actor) still exist.
 * @param {string} uuid
 * @returns {Promise<Item|null>}
 */
async function resolveItem(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  return doc instanceof Item ? doc : null;
}

/**
 * @param {ChatMessage} message
 * @param {string} flagKey  "markChoiceSkillUuid" | "markChoiceDamageEffectUuid"
 */
async function onMarkChoice(event, message, flagKey) {
  event.preventDefault();
  const item = await resolveItem(message.getFlag("carl-rpg", flagKey));
  if (!item) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.MarkChoice.ItemGone"));
    return;
  }
  // Re-checks !marked/advancementGate fresh at click time (not just trusting
  // the roll-time snapshot) - the item's state can change in between.
  await CarlDice.markForAdvancement(item);
  await updateCardMessage(message, { flags: { "carl-rpg": { markChoiceDone: true } } });
}

export const markChoiceActionEntries = [
  {
    action: "markChoiceSkill",
    buttonSelector: ".carl-mark-choice-skill",
    wrapperSelector: ".carl-mark-choice",
    canAct: (m) => canActOnUuidFlag(m, "markChoiceSkillUuid"),
    doneFlag: "markChoiceDone",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.MarkChoice.Done")}`,
    onClick: (event, message) => onMarkChoice(event, message, "markChoiceSkillUuid"),
  },
  {
    action: "markChoiceDamageEffect",
    buttonSelector: ".carl-mark-choice-damage-effect",
    wrapperSelector: ".carl-mark-choice",
    canAct: (m) => canActOnUuidFlag(m, "markChoiceDamageEffectUuid"),
    doneFlag: "markChoiceDone",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.MarkChoice.Done")}`,
    onClick: (event, message) => onMarkChoice(event, message, "markChoiceDamageEffectUuid"),
  },
];
