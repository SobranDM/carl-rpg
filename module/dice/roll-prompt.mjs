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
 * Conditional modifiers relevant to rolling a specific skill/spell/damage
 * effect: every conditionalModifier targeting that skill by name
 * (skillRank/skillDamage), plus every non-skill-scoped one
 * (stat/resource/rollMode/custom), which are offered on any roll for this
 * actor.
 * @param {foundry.abstract.TypeDataModel} actorSystem
 * @param {string|null} skillName
 * @returns {object[]}
 */
export function collectApplicableConditionalModifiers(actorSystem, skillName = null) {
  const list = actorSystem?.conditionalModifiers ?? [];
  const skillKey = skillName ? slugifySkillName(skillName) : null;
  return list.filter((cm) => {
    if (cm.targetType === "skillRank" || cm.targetType === "skillDamage") {
      return !!skillKey && slugifySkillName(cm.target) === skillKey;
    }
    return true;
  });
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {number|null} [options.difficulty]  Pre-filled Difficulty, editable by the GM.
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
  title, difficulty = null, showDifficulty = true, conditionalModifiers = [], damageEffectChoices = [], manaCostChoices = [],
} = {}) {
  const result = await showCarlDialog({
    title,
    template: "systems/carl-rpg/templates/dialog/roll-options.hbs",
    context: { difficulty, showDifficulty, conditions: conditionalModifiers, damageEffectChoices, manaCostChoices },
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
