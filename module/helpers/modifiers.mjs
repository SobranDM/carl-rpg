/**
 * The homebrew-friendly modifier/bonus aggregation engine. This is the
 * ActiveEffect replacement described in the system's design plan: items and
 * skills modify arbitrary/homebrew skills with no master list, and a
 * skill's own effect changes at Rank 5/10/15, so bonuses can't be baked
 * into a fixed schema the way core ActiveEffect changes usually are.
 *
 * Every item type (gear, features, and the Rank-gated Skill/Spell/Damage
 * Effect types) carries structured `ChangeEntry` objects (see
 * module/data/shared/change-entry.mjs) with a `target` string resolved
 * dynamically at aggregation time - the same way Roll.replaceFormulaData
 * resolves `@`-paths via foundry.utils.getProperty, so a brand-new homebrew
 * skill name just works with no engine change.
 *
 * We deliberately do NOT call into ActiveEffect's own static apply helpers
 * (`ActiveEffect.applyChange`, `_applyChangeAdd` etc.) here: those exist to
 * handle arbitrary Foundry Document schema fields with type-aware casting,
 * which our own simple numeric/dice targets don't need, and several of them
 * are underscore-prefixed (non-public) internals that would be a needless
 * fragility to depend on across Foundry versions. The six modes below
 * (add/subtract/multiply/override/upgrade/downgrade) are the same ones
 * DataField#applyChange implements, reimplemented here as simple, explicit,
 * version-stable arithmetic.
 */

import { getRankDamageDie } from "./rules.mjs";

const RANKED_TYPES = new Set(["skill", "spell", "damageEffect"]);

/** Turn a display name into a stable, arbitrary-skill-friendly bag key. */
export function slugifySkillName(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return slug || "unknown";
}

function emptySkillEntry(name) {
  return {
    key: slugifySkillName(name),
    name,
    itemId: null,
    itemType: null,
    rank: 0,
    marked: false,
    category: null,
    isPassive: false,
    governingStat: "",
    baseDamage: null,
    damage: { baseDice: [], rankDice: [], flatBonuses: [], multipliers: [], overrides: [] },
  };
}

function getOrCreateSkill(skills, name) {
  const key = slugifySkillName(name);
  if (!skills[key]) skills[key] = emptySkillEntry(name);
  return skills[key];
}

/**
 * Apply one of the six modifier modes using simple explicit arithmetic.
 * @param {number} current
 * @param {string} mode  One of add|subtract|multiply|override|upgrade|downgrade
 * @param {number} delta
 * @returns {number}
 */
export function applyScalarChange(current, mode, delta) {
  const cur = Number(current) || 0;
  const val = Number(delta) || 0;
  switch (mode) {
    case "add": return cur + val;
    case "subtract": return cur - val;
    case "multiply": return cur * val;
    case "override": return val;
    case "upgrade": return Math.max(cur, val);
    case "downgrade": return Math.min(cur, val);
    default: return cur;
  }
}

function isDiceFormula(value) {
  return typeof value === "string" && /\d*d\d+/i.test(value);
}

/**
 * Resolve a ChangeEntry.value formula against rollData. Numeric results are
 * returned as numbers; dice/unresolvable formulas are returned as-is
 * (strings) for the roll builder to consume later.
 */
function resolveValue(formula, rollData) {
  if (formula === null || formula === undefined || formula === "") return 0;
  let resolved = String(formula);
  if (resolved.includes("@")) {
    const ReplaceFn = foundry?.dice?.Roll?.replaceFormulaData ?? globalThis.Roll?.replaceFormulaData;
    if (typeof ReplaceFn === "function") {
      resolved = ReplaceFn(resolved, rollData, { missing: "0" });
    }
  }
  if (isDiceFormula(resolved)) return resolved;
  const n = Number(resolved);
  return Number.isFinite(n) ? n : resolved;
}

/**
 * Collect every currently-active ChangeEntry from one embedded item: its
 * universal `changes` (item-base, always active while owned) plus, for
 * Rank-gated items, every `upgrades[].changes` whose rankThreshold is met.
 */
function collectItemChanges(item) {
  const sys = item.system;
  // Toggled spells (docs/known-gaps.md 1.4, e.g. a timed weapon-enchantment
  // spell) contribute nothing while switched off - unlike every other item
  // type/state, which is "always active while owned" per this function's own
  // established behavior.
  if (sys.isToggled && !sys.active) return [];
  const sourceItemRank = sys.rank ?? 0;
  const out = [];
  for (const change of sys.changes ?? []) {
    out.push({ change, sourceLabel: item.name, sourceItemId: item.id, sourceItemRank });
  }
  if (Array.isArray(sys.upgrades)) {
    for (const upgrade of sys.upgrades) {
      if (sourceItemRank < upgrade.rankThreshold) continue;
      for (const change of upgrade.changes ?? []) {
        out.push({
          change,
          sourceLabel: `${item.name} (Rank ${upgrade.rankThreshold})`,
          sourceItemId: item.id,
          sourceItemRank,
        });
      }
    }
  }
  return out;
}

/**
 * Collect every currently-triggered `targetEffects` entry (see
 * module/data/shared/upgrade-tier.mjs) from one item's unlocked Upgrade
 * tiers - i.e. "on hit, the target gains Debuff X". Rank-gated exactly like
 * collectItemChanges above (only tiers whose rankThreshold the item's own
 * current Rank meets); additionally crit-gated per-entry via `critOnly`.
 *
 * Deliberately does NOT know about "hit" at all - that's the caller's job
 * (module/dice/dice.mjs only calls this once an Attack has already resolved
 * as a hit). This never writes anything anywhere; it just reports what
 * *would* apply, for the chat card's "Apply to Target(s)" button
 * (module/chat/target-effects-card.mjs) to offer.
 *
 * @param {Item} item
 * @param {{isCrit?: boolean}} [options]
 * @returns {Array<{id: string, debuffKey: string, stacks: number, label: string, sourceLabel: string}>}
 */
export function collectItemTargetEffects(item, { isCrit = false } = {}) {
  const sys = item.system;
  const sourceItemRank = sys.rank ?? 0;
  const out = [];
  if (!Array.isArray(sys.upgrades)) return out;
  for (const upgrade of sys.upgrades) {
    if (sourceItemRank < upgrade.rankThreshold) continue;
    for (const te of upgrade.targetEffects ?? []) {
      if (!te.debuffKey) continue;
      if (te.critOnly && !isCrit) continue;
      out.push({
        id: te.id,
        debuffKey: te.debuffKey,
        stacks: te.stacks || 1,
        label: te.label || "",
        sourceLabel: `${item.name} (Rank ${upgrade.rankThreshold})`,
      });
    }
  }
  return out;
}

/**
 * The slot count an actor's currently-active Shield-style pool should have
 * (docs/known-gaps.md 1.4) - the first owned, active, isToggled Spell that
 * declares a nonzero shieldSlots, resolved through its Rank-gated Upgrade
 * tiers the same way rollHeal resolves healDice (highest-rankThreshold
 * unlocked tier that itself overrides shieldSlots wins; falls back to the
 * item's own base shieldSlots if no unlocked tier overrides it). Only ever
 * one such spell is expected to matter at a time - "the Shield" is a
 * singular ongoing effect, not a stackable one.
 * @param {Item[]} items  An actor's embedded items (Array.from(actor.items)).
 * @returns {number}
 */
export function computeActiveShieldSlots(items) {
  for (const item of items) {
    if (item.type !== "spell" || !item.system.isToggled || !item.system.active) continue;
    const sys = item.system;
    if (!sys.shieldSlots) continue;
    const rank = sys.rank ?? 0;
    const unlocked = (sys.upgrades ?? [])
      .filter((u) => rank >= u.rankThreshold && u.shieldSlots)
      .sort((a, b) => b.rankThreshold - a.rankThreshold);
    return unlocked[0]?.shieldSlots ?? sys.shieldSlots;
  }
  return 0;
}

function seedSkillFromItem(skills, item) {
  const entry = getOrCreateSkill(skills, item.name);
  entry.itemId = item.id;
  entry.itemType = item.type;
  entry.rank = item.system.rank ?? 0;
  entry.marked = !!item.system.marked;
  entry.isPassive = !!item.system.isPassive;
  entry.governingStat = item.system.governingStat ?? "";
  entry.category = item.system.category ?? (item.type === "spell" ? "spell" : null);
  if (item.system.baseDamage?.dice) {
    entry.baseDamage = foundry.utils.deepClone(item.system.baseDamage);
    entry.damage.baseDice.push({ formula: item.system.baseDamage.dice, label: item.name, mode: "add" });
  }
}

/**
 * Apply one ChangeEntry. Unconditional changes are baked directly into the
 * skills bag / actor stat-and-resource fields / bonuses bag. Changes that
 * carry `conditions` are NEVER auto-applied - they're pushed into
 * `conditionalModifiers` instead, for a roll dialog to offer as checkboxes
 * (see module/dice/roll-parts.mjs, Milestone 2) and apply only if checked.
 */
function applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx) {
  const { skills, bonuses, rollData, conditionalModifiers, caps, resistances, advancementBonuses, rankCaps } = ctx;
  // Level-gated grants (e.g. Bune's "At Level 50, +2 Dexterity") simply don't
  // apply at all below the threshold - re-evaluated fresh every
  // prepareDerivedData pass, so it turns on automatically the moment the
  // actor's Level reaches the gate. 0 (the default) means "always active".
  if (change.levelGate && Number(change.levelGate) > (rollData.lvl ?? 1)) return;
  const label = change.label || sourceLabel;
  const hasConditions = Array.isArray(change.conditions) && change.conditions.length > 0;
  // Exposes `@rank` in a ChangeEntry's `value` formula as the Rank of the
  // item THIS specific change/upgrade belongs to - e.g. Powerful Strike's
  // "Multiply your base damage dice result by your Rank in this Skill" is
  // simply value:"@rank", mode:"multiply".
  const scopedRollData = { ...rollData, rank: sourceItemRank };

  if (hasConditions) {
    conditionalModifiers.push({
      id: change.id,
      targetType: change.targetType,
      target: change.target,
      mode: change.mode,
      value: change.value,
      damageDiceKind: change.damageDiceKind,
      damageType: change.damageType || "",
      label,
      sourceItemId,
      sourceItemRank,
      conditions: change.conditions,
    });
    return;
  }

  switch (change.targetType) {
    case "skillRank": {
      const entry = getOrCreateSkill(skills, change.target);
      const value = resolveValue(change.value, scopedRollData);
      entry.rank = applyScalarChange(entry.rank, change.mode, value);
      // Reuses capMax here for a different purpose than the stat/resource
      // case above: not a ceiling on the CURRENT value, but on how high
      // CarlDice.rollAdvancementCheck will let this Skill's Rank climb via
      // future Advancement Checks (e.g. "Arcane Skill can be raised to Rank
      // 20" vs. the normal Rank-15 ceiling) - so the MOST PERMISSIVE (highest)
      // grant wins when multiple sources raise the same Skill's cap, unlike
      // accumulateCap's most-restrictive/lowest policy above.
      if (change.capMax) {
        const key = slugifySkillName(change.target);
        const cap = resolveValue(change.capMax, scopedRollData);
        if (typeof cap === "number") rankCaps[key] = key in rankCaps ? Math.max(rankCaps[key], cap) : cap;
      }
      break;
    }
    case "skillDamage": {
      const entry = getOrCreateSkill(skills, change.target);
      const kind = change.damageDiceKind || (isDiceFormula(change.value) ? "base" : "flat");
      // "Add 1 Rank damage die" (Table 37) refers to the die's OWN Rank
      // (the item this Upgrade belongs to), not the target skill's Rank -
      // this is what makes cross-skill grants like "your Pugilism strikes
      // add 1 Fire Fingers Rank damage die" resolve correctly.
      const resolvedFormula = kind === "rankDie" ? getRankDamageDie(sourceItemRank) : change.value;
      // Docs/known-gaps.md 1.7: an explicit per-term damage-type override
      // (e.g. Fire Fingers Rank 15 granting Pugilism a Rank damage die that
      // stays Fire). Blank means "inherit the item's own baseDamage.damageType
      // (or an unlocked upgrade tier's damageTypes override)" - resolved by
      // module/dice/dice.mjs's buildDamageRollParts at roll time, not here.
      const term = { formula: resolvedFormula, label, mode: change.mode, damageType: change.damageType || "" };
      if (change.mode === "multiply") {
        entry.damage.multipliers.push({ ...term, factor: resolveValue(change.value, scopedRollData) });
      } else if (change.mode === "override") {
        entry.damage.overrides.push(term);
      } else {
        if (kind === "rankDie") { if (resolvedFormula) entry.damage.rankDice.push(term); }
        else if (kind === "base") entry.damage.baseDice.push(term);
        else entry.damage.flatBonuses.push(term);
      }
      break;
    }
    case "stat": {
      // Accumulate into the bonuses bag under "stats.<key>" - NEVER write to
      // actorSystem.stats[key].value directly. That field is both the
      // DB-persisted base value AND the sheet's editable input; mutating it
      // here would bake the bonus into the "base" on the next form submit
      // (submitOnChange posts the whole form) and re-apply on top of that
      // every subsequent pass, compounding without bound. The genuinely
      // derived "effective" value is computed once, safely, in
      // CarlRPGCharacter#prepareDerivedData from value + this bonus.
      accumulateBonus(bonuses, `stats.${change.target}`, change, scopedRollData);
      accumulateCap(caps, `stats.${change.target}`, change, scopedRollData);
      break;
    }
    case "resource": {
      // Same reasoning as "stat" - e.g. target "hb.max" must never be
      // written directly, since that's the editable base field too.
      accumulateBonus(bonuses, change.target, change, scopedRollData);
      accumulateCap(caps, change.target, change, scopedRollData);
      break;
    }
    case "resistance": {
      // SET semantics, not accumulate - a Resistance/Immunity/Vulnerability
      // grant replaces whatever this actor's base system.resistances[type]
      // says, it doesn't stack numerically. Last-applied-wins across
      // multiple sources granting the same damage type (no adjudicated
      // priority order - a rare enough conflict that this project's usual
      // "surface state, don't over-engineer" default applies).
      if (change.target) resistances[change.target] = change.value;
      break;
    }
    case "advancementBonus": {
      // A flat bonus to CarlDice.rollAdvancementCheck's d20, scoped to one
      // named Skill/Spell/Damage Effect (e.g. "at the end of each floor, add
      // 1 to your Skill Advancement Checks for Alchemy"). Keyed by slugified
      // name, same convention as the skills bag itself.
      const key = slugifySkillName(change.target);
      const value = resolveValue(change.value, scopedRollData);
      if (typeof value === "number") advancementBonuses[key] = (advancementBonuses[key] ?? 0) + value;
      break;
    }
    default: {
      // rollMode / custom: a generic dotted-key accumulator for roll-time
      // lookups by convention (e.g. "evadeBonus", "aiFavor"). These target
      // keys are never schema fields, so direct accumulation is always safe.
      accumulateBonus(bonuses, change.target, change, scopedRollData);
      break;
    }
  }
}

/** Shared accumulation used by every targetType that writes into the (always non-schema, never form-bound) bonuses bag. */
function accumulateBonus(bonuses, key, change, rollData) {
  const value = resolveValue(change.value, rollData);
  if (typeof value !== "number") return;
  const current = bonuses[key] ?? 0;
  bonuses[key] = applyScalarChange(current, change.mode, value);
}

/** Records a ChangeEntry's optional `capMax` (an effective-value ceiling) into the caps bag, keeping the most restrictive (lowest) value per key. */
function accumulateCap(caps, key, change, rollData) {
  if (!change.capMax) return;
  const cap = resolveValue(change.capMax, rollData);
  if (typeof cap !== "number") return;
  caps[key] = key in caps ? Math.min(caps[key], cap) : cap;
}

/**
 * Aggregate every embedded item's structured changes into:
 *  - actorSystem.skills            dynamic bag keyed by slugified skill name
 *  - actorSystem.bonuses           dotted-key bag for stat/resource/rollMode/custom targets
 *  - actorSystem.conditionalModifiers  changes gated behind roll-time checkboxes
 *
 * Deliberately does NOT mutate actorSystem's own schema fields (stats.*.value,
 * hb.max, mana.max, ...) directly: those are simultaneously the DB-persisted
 * base values AND the sheet's editable inputs, so writing a boosted value
 * into them would get resubmitted as the new "base" on the next form save
 * (submitOnChange posts the whole form) and re-boosted again next pass -
 * silently compounding forever. Instead, everything lands in the bonuses
 * bag (never schema-backed, never form-bound), and CarlRPGCharacter/
 * CarlRPGNPC#prepareDerivedData reads specific known keys (e.g.
 * "stats.str", "hb.max") to compute genuinely separate derived-only
 * fields (stats.*.bonus, hb.bonusMax, ...) after this call returns.
 *
 * Called from CarlRPGCharacter#prepareDerivedData() - the correct lifecycle
 * hook, since TypeDataModel#prepareDerivedData runs after base data is
 * seeded and this.parent.items is fully populated. None of this is
 * persisted to the schema/DB; it's a derived-only cache rebuilt on every
 * data-prep pass.
 *
 * @param {foundry.abstract.TypeDataModel} actorSystem
 */
export function aggregateActorBonuses(actorSystem) {
  const actor = actorSystem.parent;
  const items = actor?.items ? Array.from(actor.items) : [];

  const skills = {};
  const bonuses = {};
  const conditionalModifiers = [];
  const caps = {};
  const resistances = {};
  const advancementBonuses = {};
  const rankCaps = {};

  const rollData = {
    stats: actorSystem.stats ? foundry.utils.deepClone(actorSystem.stats) : {},
    lvl: actorSystem.attributes?.level?.value ?? 1,
    floor: game.settings.get("carl-rpg", "currentFloor"),
  };

  for (const item of items) {
    if (RANKED_TYPES.has(item.type)) seedSkillFromItem(skills, item);
  }

  const ctx = { skills, bonuses, rollData, conditionalModifiers, caps, resistances, advancementBonuses, rankCaps };
  for (const item of items) {
    for (const { change, sourceLabel, sourceItemId, sourceItemRank } of collectItemChanges(item)) {
      applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx);
    }
  }

  actorSystem.skills = skills;
  actorSystem.bonuses = bonuses;
  actorSystem.conditionalModifiers = conditionalModifiers;
  actorSystem.caps = caps;
  actorSystem.grantedResistances = resistances;
  actorSystem.advancementBonuses = advancementBonuses;
  actorSystem.rankCaps = rankCaps;
}
