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
 *
 * One deliberate exception to "everything here is a live, per-render bonus
 * on top of base": a `class`/`race` item's own `stat`/`skillRank` changes
 * are a one-time, permanent bump to the BASE value instead (see
 * module/helpers/race-class-grants.mjs, the write side of this) - this
 * file's `applyOneChange` (`isBakedGrant`) skips the live delta for exactly
 * that combination so the actor doesn't double-dip, while still applying
 * any `capMax` ceiling on the same entry live, every pass, same as always.
 */

import { getRankDamageDie } from "./rules.mjs";
import { CARLRPG } from "./config.mjs";

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
    out.push({ change, sourceLabel: item.name, sourceItemId: item.id, sourceItemRank, sourceItemType: item.type });
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
          sourceItemType: item.type,
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
 * current Rank meets); additionally gated per-entry via `critOnly` (natural
 * 20) and/or `amazingSuccessOnly` (Degree of Success "Amazing Success") -
 * the book's own "AS: Effect" weapon-enchant convention (Crafting p.223)
 * is explicit these are mutually exclusive triggers on a Critical Hit.
 *
 * Deliberately does NOT know about "hit" at all - that's the caller's job
 * (module/dice/dice.mjs only calls this once an Attack has already resolved
 * as a hit). This never writes anything anywhere; it just reports what
 * *would* apply, for the chat card's "Apply to Target(s)" button
 * (module/chat/target-effects-card.mjs) to offer.
 *
 * @param {Item} item
 * @param {{isCrit?: boolean, isAmazingSuccess?: boolean}} [options]
 * @returns {Array<{id: string, debuffKey: string, stacks: number, label: string, sourceLabel: string}>}
 */
export function collectItemTargetEffects(item, { isCrit = false, isAmazingSuccess = false } = {}) {
  const sys = item.system;
  const sourceItemRank = sys.rank ?? 0;
  const out = [];
  if (!Array.isArray(sys.upgrades)) return out;
  for (const upgrade of sys.upgrades) {
    if (sourceItemRank < upgrade.rankThreshold) continue;
    for (const te of upgrade.targetEffects ?? []) {
      if (!te.debuffKey) continue;
      if (te.critOnly && !isCrit) continue;
      if (te.amazingSuccessOnly && !isAmazingSuccess) continue;
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
export function applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx, sourceItemType) {
  const { skills, bonuses, rollData, conditionalModifiers, caps, resistances, advancementBonuses, rankCaps, actorSystem } = ctx;
  // Race/Class stat and skillRank grants are one-time, permanent bumps to
  // the actor's BASE value (module/helpers/race-class-grants.mjs bakes them
  // in on the way in, via a real actor.update/item.update) - NOT a live
  // bonus recomputed every render pass like every other item type's
  // changes. Skip the live delta for exactly these two targetType/
  // sourceItemType combinations, or the actor double-dips (base already
  // includes the grant, then the live bag would add it again on top).
  // capMax/rankCap handling on these same entries is UNAFFECTED - those are
  // ceilings tied to which items are CURRENTLY owned, not part of the
  // one-time base bump, so they stay fully live (see the two cases below).
  // A "stat" change only actually gets baked (module/helpers/
  // race-class-grants.mjs's bakeItemGrants) when its target is a real stat
  // key - validated here the same way, against the same
  // CARLRPG.statAbbreviations table race-class-grants.mjs derives its own
  // STAT_KEYS from, so the two can't silently drift apart and leave some
  // invalid-target grant neither baked nor live. "skillRank" has no
  // equivalent validity gate on the baking side - every skillRank change
  // that reaches bakeItemGrants' pending list gets baked unconditionally.
  const isBakedGrant = (sourceItemType === "class" || sourceItemType === "race")
    && (change.targetType === "skillRank"
      || (change.targetType === "stat" && !!CARLRPG.statAbbreviations[change.target]));
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
      // See isBakedGrant above - a Race/Class's own skillRank delta was
      // already baked into the matching Skill/Spell/Damage-Effect item's
      // real system.rank (module/helpers/race-class-grants.mjs), which
      // seedSkillFromItem already seeded into this same skills bag before
      // applyOneChange ever runs - applying it again here would double it.
      if (!isBakedGrant) {
        const entry = getOrCreateSkill(skills, change.target);
        const value = resolveValue(change.value, scopedRollData);
        entry.rank = applyScalarChange(entry.rank, change.mode, value);
      }
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
      // actorSystem.stats[key].value directly here for a live (gear/spell/
      // feature/skill/etc.) bonus. That field is both the DB-persisted base
      // value AND the sheet's editable input; mutating it on every pass
      // would bake the bonus into the "base" on the next form submit
      // (submitOnChange posts the whole form) and re-apply on top of that
      // every subsequent pass, compounding without bound. The genuinely
      // derived "effective" value is computed once, safely, in
      // CarlRPGCharacter#prepareDerivedData from value + this bonus.
      //
      // Race/Class stat changes are the one deliberate exception - see
      // isBakedGrant above: their delta was already written directly into
      // stats.<key>.value (a real, one-time actor.update, NOT this
      // per-render bonus bag) by module/helpers/race-class-grants.mjs, so
      // it must NOT also accumulate here.
      // "multiply" needs the actor's real base Stat value (never the
      // zeroed-per-pass bonus accumulator) to mean anything - rollData.stats
      // is a deepClone of actorSystem.stats taken fresh at the start of this
      // aggregation pass (see aggregateActorBonuses), so it reliably reflects
      // the real persisted base value, not stale derived data.
      const statBase = rollData.stats?.[change.target]?.value;
      if (!isBakedGrant) {
        accumulateBonus(bonuses, `stats.${change.target}`, change, scopedRollData,
          typeof statBase === "number" ? statBase : undefined);
      }
      accumulateCap(caps, `stats.${change.target}`, change, scopedRollData);
      break;
    }
    case "resource": {
      // Same reasoning as "stat" - e.g. target "hb.max" must never be
      // written directly, since that's the editable base field too. Only
      // "dr" gets a real "multiply" base here: it's the one resourceTargets
      // key with a genuinely stable, always-persisted base on BOTH actor
      // types (actor-base.mjs's schema.dr, never touched by prepareDerivedData
      // beyond the derived drBonus/drEffective). "hb.max" is a real editable
      // base for Character but is fully recomputed from level/tier EVERY
      // pass for Mob (see mob.mjs's hbSlotsRule, documented there as "the
      // same pattern actor-base.mjs's own mana.max already uses for a
      // fully-derived resource") - and "mana.max" is fully derived from
      // stats.int.effective + bonus for BOTH actor types (never a real base
      // at all, computed AFTER this aggregation pass even runs). Neither is
      // safe to read here as "the base", so multiply on those two falls back
      // to the old (documented, pre-existing) no-op-for-a-single-item
      // behavior rather than silently reading a stale/wrong number.
      const resourceBase = change.target === "dr" ? actorSystem?.dr : undefined;
      accumulateBonus(bonuses, change.target, change, scopedRollData,
        typeof resourceBase === "number" ? resourceBase : undefined);
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

/**
 * Shared accumulation used by every targetType that writes into the (always
 * non-schema, never form-bound) bonuses bag.
 *
 * `current` (the running per-render accumulator for this key, starting at 0
 * every aggregation pass - see aggregateActorBonuses) is the right thing to
 * compare against for add/subtract (multiple items' flat bonuses should
 * simply sum) but it is NOT the actor's real base value, so multiply/
 * override/upgrade/downgrade against it are meaningless (e.g. "multiply
 * Strength by 2" against a zeroed accumulator is always 0 for the first/only
 * contributing item). override/upgrade/downgrade are handled by keeping them
 * OFF the Mode dropdown for every targetType that funnels through here (see
 * CARLRPG.changeModesByTarget in config.mjs) rather than by trying to make
 * "current" mean something it structurally can't (this bag is rebuilt from
 * scratch every pass and never sees the actor's persisted base - see the
 * comment on applyOneChange's "stat" case).
 *
 * multiply gets a real fix instead of just being hidden: when the caller
 * supplies `baseValue` (the actor's genuine persisted base for this target -
 * e.g. rollData.stats[target].value, or actorSystem.dr - NOT another
 * ChangeEntry's contribution), a multiply ChangeEntry contributes
 * `baseValue * (factor - 1)` into the bonus bag, so effective = base + bonus
 * = base * factor for a single contributor. Design choice for MULTIPLE
 * multiply contributors on the same key: each contributes independently
 * against the same original base (bonus totals `n * base * (factor-1)`)
 * rather than compounding multiplicatively against each other - this matches
 * how every other mode here already combines (additively into one shared
 * bag) and avoids an order-dependent result, at the cost of "two x2 items"
 * yielding 3x total (not 4x).
 *
 * When no baseValue is available (custom/rollMode/advancementBonus targets,
 * or a "resource" target other than "dr" - see applyOneChange's "resource"
 * case for exactly which resource keys have a stable-enough base to scale),
 * multiply falls back to the old current*value behavior - a known no-op for
 * a single contributor, unchanged from before this fix, since there is no
 * real base to scale.
 */
export function accumulateBonus(bonuses, key, change, rollData, baseValue) {
  const value = resolveValue(change.value, rollData);
  if (typeof value !== "number") return;
  const current = bonuses[key] ?? 0;
  if (change.mode === "multiply" && typeof baseValue === "number") {
    bonuses[key] = current + baseValue * (value - 1);
    return;
  }
  bonuses[key] = applyScalarChange(current, change.mode, value);
}

/** Records a ChangeEntry's optional `capMax` (an effective-value ceiling) into the caps bag, keeping the most restrictive (lowest) value per key. */
export function accumulateCap(caps, key, change, rollData) {
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
 * CarlRPGMob#prepareDerivedData reads specific known keys (e.g.
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

  const ctx = { skills, bonuses, rollData, conditionalModifiers, caps, resistances, advancementBonuses, rankCaps, actorSystem };
  for (const item of items) {
    for (const { change, sourceLabel, sourceItemId, sourceItemRank, sourceItemType } of collectItemChanges(item)) {
      applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx, sourceItemType);
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
