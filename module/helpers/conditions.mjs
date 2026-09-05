/**
 * Shared logic for writing a Condition (Debuff/Buff) entry onto an actor's
 * `system.conditions` array (Table 11, see module/helpers/config.mjs's
 * CONFIG.CARLRPG.debuffs). Factored out of module/sheets/actor-sheet.mjs's
 * manual "Add Condition" picker so the Attack chat card's automatic
 * "Apply to Target(s)" button (module/chat/target-effects-card.mjs) builds
 * and pushes conditions identically - one code path, two entry points.
 */

/**
 * Build one `system.conditions` entry from a debuff key, the same shape
 * whether it was added manually from the Conditions tab or automatically
 * from an Attack/Spell's targetEffects.
 * @param {string} key  Key into CONFIG.CARLRPG.debuffs, or "custom".
 * @param {{stacks?: number, source?: string, label?: string}} [options]
 *   `label` overrides the debuff's default localized label (e.g. an
 *   Upgrade-authored display override); omit to use the preset's own label.
 * @returns {object}
 */
export function buildConditionEntry(key, { stacks = 1, source = "", label = "" } = {}) {
  const preset = CONFIG.CARLRPG.debuffs[key];
  const hasTimedDuration = preset?.durationType === "rounds" || preset?.durationType === "real-minutes";
  return {
    key,
    label: label || (preset ? game.i18n.localize(preset.label) : ""),
    stacks,
    remaining: hasTimedDuration ? (preset.durationValue ?? null) : null,
    source,
  };
}

// "A 2nd Minor/Major Injury converts to the matching Long-Term version"
// (Table 11, Debuffs) - the second application doesn't stack alongside the
// first, it escalates into a single worse condition instead.
const INJURY_UPGRADES = {
  minorInjury: "longTermMinorInjury",
  majorInjury: "longTermMajorInjury",
};

/**
 * Push a new condition entry onto an actor's `system.conditions` -
 * enforcing Table 11's `stackable` flag (CONFIG.CARLRPG.debuffs) along the
 * way: a non-stackable Debuff already present doesn't get a duplicate row.
 * A 2nd Minor/Major Injury is the one special case that isn't a simple
 * refresh - it replaces the existing entry with the Long-Term version.
 * @param {Actor} actor
 * @param {string} key
 * @param {{stacks?: number, source?: string, label?: string}} [options]
 * @returns {Promise<Actor>}
 */
export async function addConditionToActor(actor, key, options = {}) {
  const current = foundry.utils.deepClone(actor.system.conditions ?? []);
  const existingIndex = current.findIndex((c) => c.key === key);

  if (existingIndex !== -1) {
    const upgradeKey = INJURY_UPGRADES[key];
    if (upgradeKey) {
      current.splice(existingIndex, 1, buildConditionEntry(upgradeKey, options));
      return actor.update({ "system.conditions": current });
    }
    const preset = CONFIG.CARLRPG.debuffs[key];
    if (preset?.stackable === false) {
      // Already present and not meant to stack - refresh its duration (if
      // it has one) instead of silently no-oping or pushing a duplicate row.
      current[existingIndex] = buildConditionEntry(key, { ...options, stacks: current[existingIndex].stacks });
      return actor.update({ "system.conditions": current });
    }
  }

  current.push(buildConditionEntry(key, options));
  return actor.update({ "system.conditions": current });
}

/**
 * Remove one entry from an actor's `system.conditions` by index - the
 * counterpart to addConditionToActor. Used by the Heal chat card's "Mend
 * Debuff" button (module/chat/heal-card.mjs, Heal Self Rank 5/10) so
 * removing a condition goes through the same one-code-path shape as adding
 * one, and by extension stays consistent with the Conditions tab's own
 * per-row delete (module/helpers/array-editor.mjs's onDeleteArrayItem,
 * which this mirrors for a non-sheet caller).
 * @param {Actor} actor
 * @param {number} index
 * @returns {Promise<Actor>}
 */
export async function removeConditionFromActor(actor, index) {
  const current = actor.system.conditions ?? [];
  const updated = current.filter((_, i) => i !== index);
  return actor.update({ "system.conditions": updated });
}

/**
 * Resolve the display label for a collected targetEffect entry (see
 * module/helpers/modifiers.mjs#collectItemTargetEffects): its own author
 * override if set, else the localized CONFIG.CARLRPG.debuffs label, else
 * the raw key as a last-resort fallback.
 * @param {{debuffKey: string, label?: string}} targetEffect
 * @returns {string}
 */
export function resolveTargetEffectLabel(targetEffect) {
  if (targetEffect.label) return targetEffect.label;
  const preset = CONFIG.CARLRPG.debuffs[targetEffect.debuffKey];
  return preset ? game.i18n.localize(preset.label) : targetEffect.debuffKey;
}
