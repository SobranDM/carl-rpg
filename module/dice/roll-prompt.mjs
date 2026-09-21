/**
 * Roll-options dialog: Advantage/Disadvantage, an optional Difficulty, a
 * freetext situational modifier, and one checkbox per applicable
 * ChangeEntry.conditions toggle (see module/helpers/modifiers.mjs -
 * conditions are NEVER auto-evaluated; this dialog is the only place they
 * get applied, based on what the player/GM checks per the fiction).
 */
import { showCarlDialog, rollButton, cancelButton } from "../apps/carl-dialog.mjs";
import { slugifySkillName } from "../helpers/modifiers.mjs";

/**
 * When a Damage Effect with more than one `parentSkills` entry is rolled
 * directly (CarlDice.rollDamageEffect), the player must pick which owned
 * Skill/Spell candidate to attack with - one button per candidate, plus
 * Cancel. Not needed (and never called) when there's only one candidate.
 * @param {Item} damageEffectItem
 * @param {Item[]} candidates  Owned Skill/Spell items matching parentSkills.
 * @returns {Promise<string|null>} The chosen candidate's id, or null if cancelled.
 */
export async function promptParentSkillChoice(damageEffectItem, candidates) {
  const buttons = candidates.map((c) => ({
    action: c.id,
    label: c.name,
    callback: () => c.id,
  }));
  buttons.push(cancelButton());
  return showCarlDialog({
    title: game.i18n.format("CARLRPG.Dialog.ChooseParentSkillTitle", { name: damageEffectItem.name }),
    content: `<p>${game.i18n.format("CARLRPG.Dialog.ChooseParentSkillBody", { name: damageEffectItem.name })}</p>`,
    buttons,
  });
}

/**
 * Conditional modifiers relevant to rolling a specific skill/spell/damage
 * effect: every conditionalModifier targeting that skill by name
 * (skillRank/skillDamage), plus every non-skill-scoped one
 * (stat/resource/rollMode/custom), which are offered on any roll for this
 * actor, plus - for an Attack roll - every skillRank/skillDamage-targeted
 * conditionalModifier sourced from one of `extraSourceItemIds` (a Damage
 * Effect candidate for this Attack). A Damage Effect's own conditions
 * target ITSELF, not the parent Skill (e.g. Choke Out/Smush/Skullcracker's
 * grapple-check bonuses), so without this they'd never surface at all when
 * rolling the Skill they're attached to. Surfacing every CANDIDATE's
 * conditions here (not just the one that ends up chosen) is deliberate -
 * CarlDice.rollAttack narrows to only the actually-chosen Damage Effect's
 * conditions once it's known, after the dialog resolves.
 * @param {foundry.abstract.TypeDataModel} actorSystem
 * @param {string|null} skillName
 * @param {string[]} [extraSourceItemIds]
 * @returns {object[]}
 */
export function collectApplicableConditionalModifiers(actorSystem, skillName = null, extraSourceItemIds = []) {
  const list = actorSystem?.conditionalModifiers ?? [];
  const skillKey = skillName ? slugifySkillName(skillName) : null;
  return list.filter((cm) => {
    if (cm.targetType === "skillRank" || cm.targetType === "skillDamage") {
      if (skillKey && slugifySkillName(cm.target) === skillKey) return true;
      return extraSourceItemIds.includes(cm.sourceItemId);
    }
    return true;
  });
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {number|null} [options.difficulty]  Pre-filled Difficulty, editable by the GM.
 * @param {"advantage"|null} [options.defaultAdvantage]  Pre-selects the
 *   Advantage radio and surfaces a hint explaining why (currently only the
 *   Nat-20/Amazing-Success Evade entitlement - module/dice/dice.mjs's
 *   rollAttack - sets this). Still fully overridable by the player/GM.
 * @param {boolean} [options.showDifficulty]
 * @param {object[]} [options.conditionalModifiers]  From collectApplicableConditionalModifiers().
 * @param {{id: string, name: string, rank: number}[]} [options.damageEffectChoices]  Rank-0
 *   entries are expected to already be filtered out by the caller (docs/known-gaps.md 1.5).
 * @param {{manaCost: number, description: string, isBase: boolean}[]} [options.manaCostChoices]
 *   Spell Mana-cost variants (docs/known-gaps.md 1.6) - index 0 is always the base cost
 *   (`isBase: true`). Built by the caller (module/dice/dice.mjs's buildManaCostChoices).
 * @returns {Promise<{advantage: "normal"|"advantage"|"disadvantage", difficulty: number|null, modifier: number, checked: Set<string>, damageEffectId: string|null, manaCostChoice: number}|null>}
 *   null if the dialog was cancelled/closed.
 */
export async function promptRollOptions({
  title, difficulty = null, showDifficulty = true, defaultAdvantage = null,
  conditionalModifiers = [], damageEffectChoices = [], manaCostChoices = [],
} = {}) {
  const result = await showCarlDialog({
    title,
    template: "systems/carl-rpg/templates/dialog/roll-options.hbs",
    context: { difficulty, showDifficulty, defaultAdvantage, conditions: conditionalModifiers, damageEffectChoices, manaCostChoices },
    buttons: [rollButton(), cancelButton()],
  });
  if (!result) return null;

  // Each conditionalModifier may list multiple alternative conditions (e.g.
  // "attacking from behind OR flanking"); checking any one of them applies
  // the change once (OR logic, no double-counting).
  const checked = new Set();
  for (const cm of conditionalModifiers) {
    const changeConditions = result.conditions?.[cm.id] ?? {};
    if (Object.values(changeConditions).some(Boolean)) checked.add(cm.id);
  }

  return {
    advantage: result.advantage ?? "normal",
    difficulty: result.difficulty !== undefined && result.difficulty !== "" ? Number(result.difficulty) : null,
    modifier: Number(result.modifier) || 0,
    checked,
    damageEffectId: result.damageEffectId || null,
    manaCostChoice: result.manaCostChoice !== undefined && result.manaCostChoice !== "" ? Number(result.manaCostChoice) : 0,
  };
}
