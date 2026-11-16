/**
 * Shared logic for writing a Condition (Debuff/Buff) entry onto an actor's
 * `system.conditions` array (Table 11, see module/helpers/config.mjs's
 * CONFIG.CARLRPG.debuffs). Factored out of module/sheets/actor-sheet.mjs's
 * manual "Add Condition" picker so the Attack chat card's automatic
 * "Apply to Target(s)" button (module/chat/target-effects-card.mjs) builds
 * and pushes conditions identically - one code path, two entry points.
 */
import { relayRemoveConditions } from "./chat-socket.mjs";
import { noteUndo } from "./actions.mjs";
import { conditionLabel } from "./debuff-effects.mjs";
import { takesConditions } from "./actor-kinds.mjs";

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
  // Vehicles take no Debuffs (Object Immunities, p.584) - and have nowhere
  // to put them.
  if (!takesConditions(actor)) return actor;
  const result = await writeConditionToActor(actor, key, options);

  // "You're Staggered (see below) and take 1d10+F Poison damage" (Sepsis,
  // Table 11) - a debuff whose effect is partly another debuff applies that
  // one too (CONFIG.CARLRPG.debuffs' `mechanics.alsoApplies`), through this
  // same function so its own stacking rule is respected.
  const alsoApplies = CONFIG.CARLRPG.debuffs[key]?.mechanics?.alsoApplies ?? [];
  for (const extraKey of alsoApplies) {
    await addConditionToActor(actor, extraKey, { source: options.source ?? "" });
  }
  return result;
}

async function writeConditionToActor(actor, key, options) {
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
      // Dying's countdown is never refreshed this way - re-applying it must
      // not hand back rounds already lost.
      if (preset.mechanics?.countdown) return actor;
      current[existingIndex] = buildConditionEntry(key, { ...options, stacks: current[existingIndex].stacks });
      return actor.update({ "system.conditions": current });
    }
  }

  const entry = buildConditionEntry(key, options);
  // "Your CON Mod is how many rounds you have before you die" (Dying) - the
  // countdown lives in the entry's `remaining`, ticked down at the end of
  // each round by module/helpers/round-end.mjs.
  if (CONFIG.CARLRPG.debuffs[key]?.mechanics?.countdown && entry.remaining === null) {
    entry.remaining = Math.max(0, actor.system.stats?.con?.mod ?? 0);
  }
  current.push(entry);
  return actor.update({ "system.conditions": current });
}

/**
 * Remove conditions by their entry id - used when a roll consumes a
 * one-shot debuff (Stunned, Queasy, Staggered; see module/helpers/
 * debuff-effects.mjs's consumedConditionIds). A player's roll often
 * consumes a debuff on a Mob they don't own, so this relays the removal to
 * the active GM in that case instead of failing silently.
 * @param {Actor} actor
 * @param {string[]} conditionIds
 * @returns {Promise<void>}
 */
export async function removeConditionsById(actor, conditionIds) {
  if (!actor || !conditionIds?.length) return;
  // Used up by an Action of this actor's own: back if it's undone.
  const used = (actor.system.conditions ?? []).filter((c) => conditionIds.includes(c.id));
  if (used.length) noteUndo(actor, { t: "conditions", uuid: actor.uuid, removed: foundry.utils.deepClone(used) });
  if (!actor.isOwner) {
    relayRemoveConditions(actor, conditionIds);
    return;
  }
  const ids = new Set(conditionIds);
  const current = actor.system.conditions ?? [];
  const remaining = current.filter((c) => !ids.has(c.id));
  if (remaining.length !== current.length) await actor.update({ "system.conditions": remaining });
}

/**
 * Remove every condition whose debuff carries a given mechanics flag (e.g.
 * Terrified's `endsOnHbLoss` after a hit lands). GM/owner only - callers
 * are the damage-apply paths, which already run with update permission.
 * @param {Actor} actor
 * @param {string} flag
 * @returns {Promise<string[]>} Labels of the removed conditions.
 */
export async function removeConditionsWithMechanic(actor, flag) {
  const current = actor?.system?.conditions ?? [];
  const removed = current.filter((c) => CONFIG.CARLRPG.debuffs[c.key]?.mechanics?.[flag]);
  if (!removed.length) return [];
  await actor.update({ "system.conditions": current.filter((c) => !removed.includes(c)) });
  return removed.map(conditionLabel);
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
