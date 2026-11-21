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
import { deityBenefitApplies } from "./worship.mjs";
import { drGroupOf, givesBonuses, isWeaponFor } from "./gear.mjs";
import { currentFloor } from "./floor.mjs";

const RANKED_TYPES = new Set(["skill", "spell", "damageEffect"]);

/**
 * A name's slug: accents dropped ("Épée" is "epee"), any run of characters
 * that aren't letters or digits (in any script) one dash, lowercased. An
 * ASCII name slugs as it always has; one in another script keeps its
 * letters ("Таунт" is "таунт"). "" for a name with no letters or digits.
 * @param {*} name
 * @returns {string}
 */
function nameSlug(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-+|-+$)/g, "");
}

/** Turn a display name into a stable, arbitrary-skill-friendly bag key. */
export function slugifySkillName(name) {
  return nameSlug(name) || "unknown";
}

/**
 * Do two names name the same Skill (same slug)? A name with no letters or
 * digits (blank, "???") matches nothing - slugifySkillName makes those all
 * "unknown".
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function sameSkillName(a, b) {
  const slug = nameSlug(a);
  return !!slug && slug === nameSlug(b);
}

/**
 * An owned Skill, Spell or Damage Effect's Rank as rolls read it: its live
 * Rank (effectiveRank). `actor` is the item's own; kept for the callers.
 * @param {Actor} actor
 * @param {Item} item
 * @returns {number}
 */
export function ownedRank(actor, item) {
  return effectiveRank(item);
}

/**
 * The actor's own Skill (or, with `types`, Spell/Damage Effect) of this
 * name, matched by slug, and its live Rank (effectiveRank). With two of the
 * same name, the one the skill bag counts (seedSkillFromItem). Null without
 * a real owned item - a "+1 Catcher" on gear doesn't give the Skill.
 * @param {Actor|null} actor
 * @param {string} name
 * @param {string[]} [types]
 * @returns {{item: Item, rank: number}|null}
 */
export function ownedSkill(actor, name, types = ["skill"]) {
  if (!actor?.items || !nameSlug(name)) return null;
  const counted = actor.items.get(actor.system?.skills?.[slugifySkillName(name)]?.itemId ?? "");
  const item =
    counted && types.includes(counted.type) && sameSkillName(counted.name, name)
      ? counted
      : actor.items.find((i) => types.includes(i.type) && sameSkillName(i.name, name));
  return item ? { item, rank: effectiveRank(item) } : null;
}

/**
 * Is this Damage Effect attached to this Skill or Spell (its parentSkills
 * names it, by slug)?
 * @param {Item|object} damageEffect
 * @param {Item|object} parentItem
 * @returns {boolean}
 */
export function damageEffectFits(damageEffect, parentItem) {
  if (parentItem?.type !== "skill" && parentItem?.type !== "spell") return false;
  return (damageEffect?.system?.parentSkills ?? []).some((name) =>
    sameSkillName(name, parentItem.name),
  );
}

/**
 * A Skill, Spell or Damage Effect's live Rank - the one its Upgrade tiers
 * unlock at: its own Rank plus the "+N to a Skill" bonuses active right now
 * (worn gear, Buffs), as the actor's skill bag has it (aggregateActorBonuses
 * gates tiers on the same Rank). A "+N" gear bonus unlocks the Skill's
 * Upgrades only while the Rank stays there - unequipped, it's gone on the
 * next prepare (ruled 2026-11-18). Advancement and Rank caps read the
 * item's own system.rank instead. An item that isn't one of the actor's own
 * (a Scroll's Spell, cast at the scroll's Rank - p.99), or isn't ranked,
 * keeps its own Rank.
 * @param {Item|null} item
 * @returns {number}
 */
export function effectiveRank(item) {
  const own = Number(item?.system?.rank) || 0;
  if (!RANKED_TYPES.has(item?.type)) return own;
  const actor = item.actor;
  if (!actor || !item.id || !actor.items?.has(item.id)) return own;
  const entry = actor.system?.skills?.[slugifySkillName(item.name)];
  return entry && entry.itemId === item.id && Number.isFinite(entry.rank) ? entry.rank : own;
}

/**
 * A Skill, Spell or Damage Effect's Upgrade tiers unlocked at a Rank, in
 * authored order. The Rank defaults to the item's live Rank (effectiveRank:
 * tier gating, ruled 2026-11-18); a caller that gates on something else -
 * the item's own Rank, a Scroll's fixed Rank - passes it.
 * @param {Item|{system: object}|null} item
 * @param {number} [rank]
 * @returns {object[]}
 */
export function unlockedTiers(item, rank) {
  const upgrades = item?.system?.upgrades;
  if (!Array.isArray(upgrades) || !upgrades.length) return [];
  const at = rank ?? effectiveRank(item);
  return upgrades.filter((u) => at >= u.rankThreshold);
}

/**
 * The unlocked tiers, highest Rank first - the order in which "the highest
 * unlocked tier that sets X wins".
 * @param {Item|{system: object}|null} item
 * @param {number} [rank]  As unlockedTiers.
 * @returns {object[]}
 */
export function tiersHighestFirst(item, rank) {
  return unlockedTiers(item, rank).sort((a, b) => b.rankThreshold - a.rankThreshold);
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
    case "add":
      return cur + val;
    case "subtract":
      return cur - val;
    case "multiply":
      return cur * val;
    case "override":
      return val;
    case "upgrade":
      return Math.max(cur, val);
    case "downgrade":
      return Math.min(cur, val);
    default:
      return cur;
  }
}

function isDiceFormula(value) {
  return typeof value === "string" && /\d*d\d+/i.test(value);
}

/**
 * A skillDamage ChangeEntry's kind: its author-declared damageDiceKind, else
 * "base" for dice and "flat" for anything else. With mode "multiply",
 * "base" multiplies the base damage dice result ("Multiply your base damage
 * dice result by your Rank in this Skill, then add your modifiers and
 * buffs" - Powerful Strike, p.180); any other kind multiplies the total
 * damage ("deals x2 the total damage" - Choke Out, Smush).
 * @param {object} change
 * @returns {string}
 */
function skillDamageKind(change) {
  return change.damageDiceKind || (isDiceFormula(change.value) ? "base" : "flat");
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
    const ReplaceFn =
      foundry?.dice?.Roll?.replaceFormulaData ?? globalThis.Roll?.replaceFormulaData;
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
 * universal `changes` (item-base, always active while owned - for a Skill,
 * Spell or Damage Effect, from Rank 1) plus, for Rank-gated items, every
 * `upgrades[].changes` whose rankThreshold is met.
 * @param {Item} item
 * @param {number} [rank]  The Rank tiers unlock at, and `@rank`/a Rank
 *   damage die read: the item's live Rank (aggregateActorBonuses passes
 *   it - see effectiveRank); defaults to its own.
 */
function collectItemChanges(item, rank = item.system.rank ?? 0) {
  const sys = item.system;
  // Toggled spells (docs/known-gaps.md 1.4, e.g. a timed weapon-enchantment
  // spell) contribute nothing while switched off - unlike every other item
  // type/state, which is "always active while owned" per this function's own
  // established behavior.
  if (sys.isToggled && !sys.active) return [];
  // "Only gear in your Gear Slots grants its benefits" (p.98) - an owned
  // but unequipped gear item contributes nothing.
  if (item.type === "item" && !givesBonuses(item)) return [];
  // A Skill, Spell or Damage Effect gives nothing until it's learned: no
  // Bonuses at Rank 0 or below (ruled 2026-11-20). Its Upgrades start at
  // Rank 5, so this only stops the base ones.
  if (RANKED_TYPES.has(item.type) && !(Number(rank) >= 1)) return [];
  const sourceItemRank = rank;
  const out = [];
  // A Damage Effect is never an always-on modifier - "choose one available
  // Damage Effect before you make the Attack Skill Check... if the Attack
  // hits, apply the chosen Damage Effect" (Playing the Game) means its
  // bonus only ever applies to the ONE attack it's explicitly picked for,
  // via CarlDice.rollAttack's ad-hoc damageEffectItem merge - never as a
  // standing buff to its parentSkills merely from being owned. A change
  // targeting the Damage Effect's OWN name still applies here as usual (its
  // own Rank-gated upgrades, e.g. Iron Punch Rank 5's own rank damage die -
  // read back via that same ad-hoc merge at roll time); only a change
  // targeting something ELSE is excluded.
  const isDamageEffect = item.type === "damageEffect";
  const targetsSelf = (change) =>
    !change.target || slugifySkillName(change.target) === slugifySkillName(item.name);
  for (const change of sys.changes ?? []) {
    if (isDamageEffect && !targetsSelf(change)) continue;
    out.push({
      change,
      sourceLabel: item.name,
      sourceItemId: item.id,
      sourceItemRank,
      sourceItemType: item.type,
    });
  }
  if (Array.isArray(sys.upgrades)) {
    for (const upgrade of unlockedTiers(item, sourceItemRank)) {
      for (const change of upgrade.changes ?? []) {
        if (isDamageEffect && !targetsSelf(change)) continue;
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
 * module/data/shared/upgrade-tier.mjs) from one item - its base list (any
 * Rank, module/data/ranked-item-base.mjs) and its unlocked Upgrade tiers -
 * i.e. "on hit, the target gains Debuff X". Tiers are Rank-gated exactly like
 * collectItemChanges above (only tiers whose rankThreshold the item's live
 * Rank meets - effectiveRank); additionally gated per-entry via `critOnly` (natural
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
 * A gear item's entries (module/data/item.mjs) may name the Attack Skills
 * they come with (`skills`, "Only with": blank means any Attack), and/or
 * come with any Hand-to-Hand Attack (`handToHandOnly`: the Skill's
 * Hand-to-Hand box, homebrew Skills included). With both, either fits.
 * With `skillName` given, an entry the Attack's Skill doesn't fit is left
 * out; `handToHand` says whether that Skill is hand-to-hand (undefined:
 * not known, so the box isn't checked - as with no `skillName`).
 *
 * @param {Item} item
 * @param {{isCrit?: boolean, isAmazingSuccess?: boolean|null, skillName?: string|null, handToHand?: boolean}} [options]
 *   isAmazingSuccess null: keep Amazing-Success-only entries, marked
 *   `amazingSuccessOnly`, for each target to decide (attackTargetEffects).
 * @returns {Array<{id: string, debuffKey: string, stacks: number, label: string, sourceLabel: string, amazingSuccessOnly: boolean}>}
 */
export function collectItemTargetEffects(
  item,
  { isCrit = false, isAmazingSuccess = false, skillName = null, handToHand = undefined } = {},
) {
  const sys = item.system;
  const sourceItemRank = effectiveRank(item);
  const out = [];
  const skillSlug = skillName ? slugifySkillName(skillName) : null;
  const take = (te, sourceLabel) => {
    if (!te.debuffKey) return;
    if (te.critOnly && !isCrit) return;
    if (te.amazingSuccessOnly && isAmazingSuccess === false) return;
    const only = (te.skills ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
    const named =
      only.length > 0 && !!skillSlug && only.some((s) => slugifySkillName(s) === skillSlug);
    if (te.handToHandOnly && handToHand !== undefined) {
      if (!handToHand && !named) return;
    } else if (skillSlug && only.length && !named) return;
    out.push({
      id: te.id,
      debuffKey: te.debuffKey,
      stacks: te.stacks || 1,
      label: te.label || "",
      sourceLabel,
      amazingSuccessOnly: !!te.amazingSuccessOnly,
    });
  };
  // The base list: at any Rank.
  for (const te of sys.targetEffects ?? []) take(te, item.name);
  for (const upgrade of unlockedTiers(item, sourceItemRank)) {
    for (const te of upgrade.targetEffects ?? [])
      take(te, `${item.name} (Rank ${upgrade.rankThreshold})`);
  }
  return out;
}

/**
 * Every On-hit Debuff a crawler's Attack carries (docs/skill-item-
 * sheets.md): its Skill's (base and unlocked tiers), its Damage Effect's,
 * and each held or worn gear item's - equipped, as gear in a slot or hand
 * always is (equip-slots.mjs; "You must be holding or wearing it", p.116) -
 * that fits this Attack Skill ("Only with"). A Critical-Hit-only entry is
 * decided here (a natural 20 is the whole Attack's). An Amazing-Success-
 * only one is decided here too when `isAmazingSuccess` is a boolean; pass
 * null to keep it, marked, for each target's own Degree to decide
 * (debuffLandsOn - attack-targets-card.mjs's applyRow).
 * @param {Actor|null} actor
 * @param {Item} skillItem
 * @param {{damageEffectItem?: Item|null, isCrit?: boolean, isAmazingSuccess?: boolean|null}} [options]
 * @returns {object[]}  collectItemTargetEffects's entries.
 */
export function attackTargetEffects(
  actor,
  skillItem,
  { damageEffectItem = null, isCrit = false, isAmazingSuccess = null } = {},
) {
  // Hand-to-hand: the Skill's own box (hand-to-hand.mjs isHandToHand, not
  // imported - it imports this module).
  const handToHand = skillItem
    ? skillItem.type === "skill" && !!skillItem.system?.isHandToHand
    : undefined;
  const options = { isCrit, isAmazingSuccess, skillName: skillItem?.name ?? null, handToHand };
  const gear = (actor?.items ?? []).filter(
    (i) => i.type === "item" && givesBonuses(i) && (i.system.targetEffects ?? []).length,
  );
  return [skillItem, damageEffectItem, ...gear]
    .filter(Boolean)
    .flatMap((item) => collectItemTargetEffects(item, options));
}

/**
 * Is this Skill, Spell or Damage Effect's damage Armor-Piercing at its Rank:
 * its own box, or an unlocked Upgrade tier's (gated on the item's live Rank,
 * effectiveRank, as collectItemTargetEffects gates its Debuffs)?
 * @param {Item|null} item
 * @returns {boolean}
 */
export function itemIsArmorPiercing(item) {
  const sys = item?.system;
  if (!sys) return false;
  if (sys.armorPiercing) return true;
  return unlockedTiers(item).some((u) => u.armorPiercing);
}

/**
 * Is a crawler's (or Pet's) Attack Armor-Piercing - "Armor-Piercing damage
 * (ignores DR)" (Dagger Rank 5, Javelin Rank 10, Spells)? From its Skill or
 * Spell, its Damage Effect, or the weapon it's made with: equipped gear
 * whose Weapon Skill is this Attack's Skill and whose Armor-Piercing box is
 * ticked. Other Armor-Piercing gear doesn't count - it isn't this Attack's
 * weapon.
 * @param {Actor|null} actor
 * @param {Item} skillItem
 * @param {{damageEffectItem?: Item|null}} [options]
 * @returns {boolean}
 */
export function attackIsArmorPiercing(actor, skillItem, { damageEffectItem = null } = {}) {
  if (itemIsArmorPiercing(skillItem) || itemIsArmorPiercing(damageEffectItem)) return true;
  return (actor?.items ?? []).some(
    (i) =>
      i.type === "item" && i.system.armorPiercing && givesBonuses(i) && isWeaponFor(i, skillItem),
  );
}

/**
 * A Mob Attack Debuff's trigger (CONFIG.CARLRPG.mobAttackTriggers) and the
 * Evade Degrees it lands on.
 */
const BAD_EVADE_DEGREES = {
  majorFail: ["majorFail", "criticalFail"],
  criticalFail: ["criticalFail"],
};

/**
 * Does this carried Debuff land on this defender? Hit, not Evaded, not
 * Immune, a Catcher at Rank 15 are the caller's (attack-targets-card.mjs
 * landDebuffs); this is the entry's own trigger:
 *  - a crawler's Amazing-Success-only one needs an Amazing Success against
 *    this target;
 *  - a Mob Attack's "on an Evade Major Fail or worse" / "on a Critical
 *    Fail" one (docs/mob-sheet.md) needs that Evade - or no Evade at all:
 *    "a debuff that only lands on a particularly bad Evade DOES land if the
 *    Crawler doesn't Evade at all" (ruled 2026-11-17). A failed free Evade
 *    decides nothing (p.96), so it counts as none.
 * @param {{amazingSuccessOnly?: boolean, trigger?: string}} te
 * @param {{amazing?: boolean, evade?: {degree: string, success: boolean}|null}} row
 *   An Attack card target row, or a Damage card row's `{...row, evade}`.
 * @returns {boolean}
 */
export function debuffLandsOn(te, row) {
  if (te.amazingSuccessOnly && !row?.amazing) return false;
  const degrees = BAD_EVADE_DEGREES[te.trigger];
  if (degrees && row?.evade && !degrees.includes(row.evade.degree)) return false;
  return true;
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
    return tiersHighestFirst(item).find((u) => u.shieldSlots)?.shieldSlots ?? sys.shieldSlots;
  }
  return 0;
}

/**
 * The Rank a Skill/Spell can be raised to on this actor: the normal ceiling
 * (CONFIG skillRankCap, 15) unless a Race/Class raises it.
 * @param {object} actorSystem
 * @param {string} name  The Skill/Spell's name.
 * @returns {number}
 */
export function skillRankCap(actorSystem, name) {
  return actorSystem?.rankCaps?.[slugifySkillName(name)] ?? CARLRPG.skillRankCap;
}

/**
 * One Skill/Spell item's own skill-bag entry, as if it were the only thing
 * the actor owned: its base damage, Rank and the changes its unlocked
 * Upgrade tiers add to itself. A Scroll casts its Spell this way - at the
 * scroll's fixed Rank, from an item the caster doesn't own (module/helpers/
 * consumables.mjs) - so the caster's own copy of the Spell and their gear
 * don't change it ("cannot change the Rank of the Spell being cast", p.99).
 * @param {object} actorSystem  The caster's system data (for roll data).
 * @param {Item} item  An embedded (possibly unsaved) Skill or Spell.
 * @returns {{skillEntry: object, conditionalModifiers: object[]}}
 */
export function buildItemSkillEntry(actorSystem, item) {
  const ctx = makeAggregationContext(actorSystem);
  const { skills } = ctx;
  seedSkillFromItem(skills, item);
  const key = slugifySkillName(item.name);
  for (const {
    change,
    sourceLabel,
    sourceItemId,
    sourceItemRank,
    sourceItemType,
  } of collectItemChanges(item)) {
    // Only what the Spell does to itself - not a change it makes to some
    // other Skill, which would land in a bag nothing reads.
    if (change.target && slugifySkillName(change.target) !== key) continue;
    // The Rank is the scroll's, fixed.
    if (change.targetType === "skillRank") continue;
    applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx, sourceItemType);
  }
  return { skillEntry: skills[key], conditionalModifiers: ctx.conditionalModifiers };
}

/**
 * Seed an owned Skill/Spell/Damage Effect's skill-bag entry. Two of the same
 * name (by slug) share one entry, which counts only one of them: the higher
 * Rank, the first on a tie - never both, so a duplicate doesn't roll its
 * base dice twice or mix Ranks. Every seed runs before any change applies,
 * so a held entry's Rank here is still its item's own.
 * @param {object} skills
 * @param {Item} item
 */
function seedSkillFromItem(skills, item) {
  const key = slugifySkillName(item.name);
  const held = skills[key];
  if (held?.itemId && held.itemId !== item.id) {
    if ((Number(item.system.rank) || 0) <= (Number(held.rank) || 0)) return;
    skills[key] = emptySkillEntry(item.name);
  }
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
    entry.damage.baseDice.push({
      formula: item.system.baseDamage.dice,
      label: item.name,
      mode: "add",
    });
  }
}

/**
 * For a duplicate the skill bag doesn't count (seedSkillFromItem), a test
 * for its changes to its own name (Rank, damage), which would land on the
 * counted copy's entry - skipped. Null for any other item.
 * @param {object} skills  The seeded skill bag.
 * @param {Item} item
 * @returns {((change: object) => boolean)|null}
 */
function uncountedSelfChange(skills, item) {
  if (!RANKED_TYPES.has(item.type)) return null;
  const key = slugifySkillName(item.name);
  if (!skills[key] || skills[key].itemId === item.id) return null;
  return (change) =>
    (change.targetType === "skillRank" || change.targetType === "skillDamage") &&
    slugifySkillName(change.target) === key;
}

/**
 * Apply one ChangeEntry. Unconditional changes are baked directly into the
 * skills bag / actor stat-and-resource fields / bonuses bag. Changes that
 * carry `conditions` are NEVER auto-applied - they're pushed into
 * `conditionalModifiers` instead, for a roll dialog to offer as checkboxes
 * (see module/dice/roll-parts.mjs, Milestone 2) and apply only if checked.
 */
export function applyOneChange(
  change,
  sourceLabel,
  sourceItemId,
  sourceItemRank,
  ctx,
  sourceItemType,
) {
  const {
    skills,
    bonuses,
    rollData,
    conditionalModifiers,
    caps,
    resistances,
    advancementBonuses,
    rankCaps,
    actorSystem,
  } = ctx;
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
  const isBakedGrant =
    (sourceItemType === "class" || sourceItemType === "race") &&
    (change.targetType === "skillRank" ||
      (change.targetType === "stat" && !!CARLRPG.statAbbreviations[change.target]));
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
    const entry = {
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
    };
    // A damage term resolves its kind the way the unconditional one below
    // does, so a ticked box rolls the same thing: a Rank damage die from
    // its own item's Rank (Skullcracker Rank 10: "add 1 Rank damage die"),
    // a multiplier's factor (`@rank` included).
    if (change.targetType === "skillDamage") {
      entry.damageDiceKind = skillDamageKind(change);
      if (change.mode === "multiply") entry.factor = resolveValue(change.value, scopedRollData);
      else if (entry.damageDiceKind === "rankDie") entry.value = getRankDamageDie(sourceItemRank);
    }
    conditionalModifiers.push(entry);
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
        if (typeof cap === "number")
          rankCaps[key] = key in rankCaps ? Math.max(rankCaps[key], cap) : cap;
      }
      break;
    }
    case "skillDamage": {
      const entry = getOrCreateSkill(skills, change.target);
      const kind = skillDamageKind(change);
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
      const term = {
        formula: resolvedFormula,
        label,
        mode: change.mode,
        damageType: change.damageType || "",
      };
      if (change.mode === "multiply") {
        // "base": scales the base damage dice only (Powerful Strike); any
        // other kind, the total damage (Choke Out) - buildDamageRollParts.
        entry.damage.multipliers.push({
          ...term,
          kind,
          factor: resolveValue(change.value, scopedRollData),
        });
      } else if (change.mode === "override") {
        entry.damage.overrides.push(term);
      } else {
        if (kind === "rankDie") {
          if (resolvedFormula) entry.damage.rankDice.push(term);
        } else if (kind === "base") entry.damage.baseDice.push(term);
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
        accumulateBonus(
          bonuses,
          `stats.${change.target}`,
          change,
          scopedRollData,
          typeof statBase === "number" ? statBase : undefined,
        );
      }
      accumulateCap(caps, `stats.${change.target}`, change, scopedRollData);
      break;
    }
    case "resource": {
      // Same reasoning as "stat" - e.g. target "hb.max" must never be
      // written directly, since that's the editable base field too.
      //
      // DR "multiply" (an Iron Skin Potion's "DR x2") scales the whole DR -
      // base plus every add - so it's kept apart as a multiplier and applied
      // by deriveDefenses (data/shared/derive-creature.mjs). Several combine
      // as 1 + the sum of (factor - 1), the same no-compounding rule
      // accumulateBonus documents: two x2s make x3.
      if (change.target === "dr" && change.mode === "multiply") {
        const factor = resolveValue(change.value, scopedRollData);
        if (typeof factor === "number") {
          ctx.multipliers ??= {};
          ctx.multipliers.dr = (ctx.multipliers.dr ?? 0) + (factor - 1);
          recordSource(ctx, change.target, label, factor, change.mode);
        }
        accumulateCap(caps, change.target, change, scopedRollData);
        break;
      }
      // Move and Step "multiply" scale the Character's editable base
      // (details.move/step). "hb.max" is a real editable base for Character
      // but is fully recomputed from level/tier EVERY pass for Mob (see
      // mob.mjs's hbSlotsRule) - and "mana.max" is fully derived from
      // stats.int.effective + bonus (never a real base at all, computed AFTER
      // this aggregation pass even runs). Neither is safe to read here as
      // "the base", so multiply on those two falls back to the old
      // (documented) no-op-for-a-single-item behavior rather than silently
      // reading a stale/wrong number.
      const resourceBase = RESOURCE_BASES[change.target]?.(actorSystem);
      const value = accumulateBonus(
        bonuses,
        change.target,
        change,
        scopedRollData,
        typeof resourceBase === "number" ? resourceBase : undefined,
      );
      if (value !== null) recordSource(ctx, change.target, label, value, change.mode);
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
      if (change.target) {
        resistances[change.target] = change.value;
        // Who granted it, for the sheet's Resistances dialog.
        if (ctx.resistanceSources) ctx.resistanceSources[change.target] = sourceLabel ?? "";
      }
      break;
    }
    case "advancementBonus": {
      // A flat bonus to CarlDice.rollAdvancementCheck's d20, scoped to one
      // named Skill/Spell/Damage Effect (e.g. "at the end of each floor, add
      // 1 to your Skill Advancement Checks for Alchemy"). Keyed by slugified
      // name, same convention as the skills bag itself.
      const key = slugifySkillName(change.target);
      const value = resolveValue(change.value, scopedRollData);
      if (typeof value === "number")
        advancementBonuses[key] = (advancementBonuses[key] ?? 0) + value;
      break;
    }
    default: {
      // Dice added to Evade Checks ("Add 1d4 to Evade Checks") are a list,
      // not a sum: CarlDice.rollEvadeCheck adds each as its own term.
      if (change.targetType === "rollMode" && change.target === "evadeDice") {
        const formula = String(change.value ?? "").trim();
        if (formula && change.mode !== "multiply") {
          const signed = change.mode === "subtract" ? `-(${formula})` : formula;
          (ctx.evadeDice ??= []).push({ formula: signed, label });
          recordSource(ctx, change.target, label, signed, change.mode);
        }
        break;
      }
      // rollMode / custom: a generic dotted-key accumulator for roll-time
      // lookups by convention (e.g. "evadeBonus", "aiFavor"). These target
      // keys are never schema fields, so direct accumulation is always safe.
      const value = accumulateBonus(bonuses, change.target, change, scopedRollData);
      if (value !== null) recordSource(ctx, change.target, label, value, change.mode);
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
 *
 * @returns {number|null}  The change's resolved value, or null if it wasn't
 *   a number (and so added nothing).
 */
export function accumulateBonus(bonuses, key, change, rollData, baseValue) {
  const value = resolveValue(change.value, rollData);
  if (typeof value !== "number") return null;
  const current = bonuses[key] ?? 0;
  if (change.mode === "multiply" && typeof baseValue === "number") {
    bonuses[key] = current + baseValue * (value - 1);
    return value;
  }
  bonuses[key] = applyScalarChange(current, change.mode, value);
  return value;
}

/**
 * The editable base a "resource" multiply scales, per target (see
 * applyOneChange). DR isn't here: its multiplier scales the whole total.
 */
const RESOURCE_BASES = {
  move: (sys) => sys?.details?.move,
  step: (sys) => sys?.details?.step,
};

/** The targets whose sources the sheet lists in a tooltip (actorSystem.bonusSources). */
const SOURCED_TARGETS = new Set(["dr", "move", "step", "evadeBonus", "evadeDice"]);

/**
 * Note who changed one of the SOURCED_TARGETS, for the sheet's tooltips
 * ("Base 20 · Tigran +10 · Running (Rank 5) +5").
 * @param {object} ctx
 * @param {string} target
 * @param {string} label
 * @param {number|string} value  The number, factor or dice formula.
 * @param {string} mode
 */
function recordSource(ctx, target, label, value, mode) {
  if (!SOURCED_TARGETS.has(target)) return;
  ctx.bonusSources ??= {};
  (ctx.bonusSources[target] ??= []).push({ label: label ?? "", value, mode });
}

/**
 * An armor piece's own DR bonus: an unconditional "dr" add or subtract.
 * Only these compete between pieces (supersededArmorIds); a conditional
 * DR row, or a multiply/override, always applies as it would on any item.
 * @param {object} change
 * @returns {boolean}
 */
function isArmorDrBonus(change) {
  return (
    change.targetType === "resource" &&
    change.target === "dr" &&
    (change.mode === "add" || change.mode === "subtract") &&
    !change.conditions?.length
  );
}

/**
 * The DR an armor piece adds right now: its armor DR bonuses
 * (isArmorDrBonus) that apply at the crawler's Level (levelGate), resolved
 * as applyOneChange resolves them (@rank is the piece's own).
 * @param {Item} item
 * @param {object} rollData
 * @returns {number}
 */
function armorDr(item, rollData) {
  return shieldDrParts(item, rollData).dr;
}

/**
 * The total of armor DR bonuses (isArmorDrBonus) among these changes that
 * apply at the wearer's Level (levelGate), each resolved as applyOneChange
 * resolves it (@rank is its item's).
 * @param {{change: object, rank: number}[]} entries
 * @param {object} rollData
 * @returns {number}
 */
function armorDrTotal(entries, rollData) {
  let total = 0;
  for (const { change, rank } of entries) {
    if (!isArmorDrBonus(change)) continue;
    if (change.levelGate && Number(change.levelGate) > (rollData.lvl ?? 1)) continue;
    const value = resolveValue(change.value, { ...rollData, rank });
    if (typeof value !== "number") continue;
    total += change.mode === "add" ? value : -value;
  }
  return total;
}

/**
 * A piece's armor DR before and after Shield damage: a Shield's DR is
 * lowered by its `shieldDamage` (Shield Block, p.198), to no less than 0 -
 * "It breaks at 0 DR". Other gear is unaffected.
 * @param {Item} item
 * @param {object} rollData
 * @returns {{base: number, damage: number, dr: number}}
 */
function shieldDrParts(item, rollData) {
  const base = armorDrTotal(
    collectItemChanges(item).map(({ change, sourceItemRank }) => ({
      change,
      rank: sourceItemRank,
    })),
    rollData,
  );
  const damage = item?.system?.shield ? Math.max(0, Number(item.system.shieldDamage) || 0) : 0;
  if (!damage) return { base, damage: 0, dr: base };
  return { base, damage, dr: Math.max(0, Math.min(base, base - damage)) };
}

/**
 * The DR a damaged Shield has lost, as a change taking it off: its armor
 * DR bonuses apply as written (aggregateActorBonuses), then this subtracts
 * what its Shield damage has cost - never more than it gave.
 * @param {Item} item
 * @param {object} rollData
 * @returns {object|null}  A ChangeEntry, or null if it has lost none.
 */
function shieldDamageChange(item, rollData) {
  const { base, dr } = shieldDrParts(item, rollData);
  const lost = base - dr;
  if (!(lost > 0)) return null;
  return {
    targetType: "resource",
    target: "dr",
    mode: "subtract",
    value: String(lost),
    label: game.i18n.format("CARLRPG.ShieldBlock.DamageSource", { name: item.name }),
  };
}

/**
 * A Shield's DR and whether it's broken (Shield Block, p.198): its armor DR
 * less its Shield damage. Broken once its damage has taken all of its DR -
 * a Shield that never had any DR ("With no DR, this shield is useless")
 * isn't broken by damage it has nowhere to take. Read as its wearer would
 * get it (their Stats and Level), whether or not it's worn now - an
 * unequipped Shield's own changes are skipped by collectItemChanges, so
 * this reads its bonuses as if equipped.
 * @param {Item} item  A gear item.
 * @returns {{base: number, damage: number, dr: number, broken: boolean}}
 */
export function shieldDrState(item) {
  const rollData = makeAggregationContext(item?.actor?.system ?? {}).rollData;
  const rank = item?.system?.rank ?? 0;
  const base = armorDrTotal(
    (item?.system?.changes ?? []).map((change) => ({ change, rank })),
    rollData,
  );
  const damage = Math.max(0, Number(item?.system?.shieldDamage) || 0);
  const dr = Math.max(0, base - damage);
  return { base, damage, dr, broken: damage > 0 && base > 0 && dr <= 0 };
}

/**
 * Worn gear's DR stacks across slot types - gloves with boots with a torso
 * piece - but not within one: "Armor on hands, feet, arms, and legs each
 * provides a single DR value... you don't get extra bonuses for each limb"
 * (p.225), so a creature with extra limbs can't stack a second pair of
 * gloves (ruled 2026-11-17, docs/gear-slots.md). Per slot type (gear.mjs
 * drGroupOf: the doll slot, both hands as one, else its slot), only the
 * equipped piece adding the most DR counts (the first, on a tie); these are
 * the ids of the rest, whose DR bonuses (isArmorDrBonus) are skipped.
 * Their other changes still apply, and so does DR from a Race, Class,
 * Skill, Spell or Buff. Accessories each count.
 * @param {Item[]} items
 * @param {object} rollData
 * @param {object} [actorSystem]  The wearer's system data (its doll slots).
 * @returns {Set<string>}
 */
export function supersededArmorIds(items, rollData, actorSystem = null) {
  const best = new Map();
  const superseded = new Set();
  for (const item of items) {
    if (item.type !== "item" || !givesBonuses(item)) continue;
    // Gear with a DR bonus competes even when it gives none right now (a
    // Level-gated one): it loses to the piece that does.
    if (!(item.system.changes ?? []).some(isArmorDrBonus)) continue;
    const dr = armorDr(item, rollData);
    const group = drGroupOf(item, actorSystem);
    if (group === null) continue;
    const current = best.get(group);
    if (!current) best.set(group, { id: item.id, dr });
    else if (dr > current.dr) {
      superseded.add(current.id);
      best.set(group, { id: item.id, dr });
    } else superseded.add(item.id);
  }
  return superseded;
}

/** Records a ChangeEntry's optional `capMax` (an effective-value ceiling) into the caps bag, keeping the most restrictive (lowest) value per key. */
export function accumulateCap(caps, key, change, rollData) {
  if (!change.capMax) return;
  const cap = resolveValue(change.capMax, rollData);
  if (typeof cap !== "number") return;
  caps[key] = key in caps ? Math.min(caps[key], cap) : cap;
}

/**
 * A fresh set of bags for one aggregation pass (applyOneChange's ctx), with
 * the roll data its formulas read (@stats, @lvl, @floor). Shared by the
 * actor-wide pass and a Scroll's single-item pass (buildItemSkillEntry).
 * @param {object} actorSystem
 * @returns {object}
 */
function makeAggregationContext(actorSystem) {
  return {
    skills: {},
    bonuses: {},
    rollData: {
      stats: actorSystem.stats ? foundry.utils.deepClone(actorSystem.stats) : {},
      lvl: actorSystem.attributes?.level?.value ?? 1,
      floor: currentFloor(),
    },
    conditionalModifiers: [],
    caps: {},
    resistances: {},
    resistanceSources: {},
    advancementBonuses: {},
    rankCaps: {},
    // DR multipliers, kept apart from the adds (applyOneChange's "resource").
    multipliers: {},
    // Who changed DR, Move, Step and Evade (recordSource).
    bonusSources: {},
    // Dice added to Evade Checks.
    evadeDice: [],
    actorSystem,
  };
}

/**
 * Each owned Skill/Spell/Damage Effect's live Rank (effectiveRank), for
 * aggregateActorBonuses to unlock Upgrade tiers at: its own Rank plus every
 * unconditional "skillRank" change - worn gear's "+1 Dagger", a Buff's,
 * another item's - as the main pass would apply them, with tiers here
 * gated at each item's own Rank. A "+N" that a tier only grants once
 * another bonus has unlocked it doesn't chain into this.
 * @param {Item[]} items
 * @param {object} actorSystem
 * @returns {Map<string, number>}  By item id.
 */
function previewLiveRanks(items, actorSystem) {
  const ctx = makeAggregationContext(actorSystem);
  for (const item of items) {
    if (RANKED_TYPES.has(item.type)) seedSkillFromItem(ctx.skills, item);
  }
  const deity = actorSystem.deity;
  const rankChange = (change) => change.targetType === "skillRank";
  for (const item of items) {
    if (deity && !deityBenefitApplies(item, deity)) continue;
    const skipSelf = uncountedSelfChange(ctx.skills, item);
    for (const {
      change,
      sourceLabel,
      sourceItemId,
      sourceItemRank,
      sourceItemType,
    } of collectItemChanges(item)) {
      if (skipSelf?.(change)) continue;
      if (rankChange(change))
        applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx, sourceItemType);
    }
  }
  for (const condition of actorSystem.conditions ?? []) {
    for (const change of condition.changes ?? []) {
      if (rankChange(change))
        applyOneChange(
          change,
          condition.label || condition.source || "",
          null,
          0,
          ctx,
          "condition",
        );
    }
  }
  const ranks = new Map();
  for (const item of items) {
    const entry = RANKED_TYPES.has(item.type) ? ctx.skills[slugifySkillName(item.name)] : null;
    if (entry?.itemId === item.id && Number.isFinite(entry.rank)) ranks.set(item.id, entry.rank);
  }
  return ranks;
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

  const ctx = makeAggregationContext(actorSystem);
  const { skills, bonuses, conditionalModifiers, caps, resistances, advancementBonuses, rankCaps } =
    ctx;

  for (const item of items) {
    if (RANKED_TYPES.has(item.type)) seedSkillFromItem(skills, item);
  }

  // A Character's church benefits (Boons with a Tier) apply only at or
  // below its worship Tier and not while worship is suspended (pp.163,
  // 312) - module/helpers/worship.mjs. Only a Character has a deity.
  const deity = actorSystem.deity;
  // Upgrade tiers unlock at each Skill's live Rank (effectiveRank).
  const liveRanks = previewLiveRanks(items, actorSystem);
  // Within one slot type, only the best piece of worn gear adds its DR (p.225).
  const superseded = supersededArmorIds(items, ctx.rollData, actorSystem);
  for (const item of items) {
    if (deity && !deityBenefitApplies(item, deity)) continue;
    const rank = liveRanks.get(item.id) ?? item.system.rank ?? 0;
    const skipSelf = uncountedSelfChange(skills, item);
    for (const {
      change,
      sourceLabel,
      sourceItemId,
      sourceItemRank,
      sourceItemType,
    } of collectItemChanges(item, rank)) {
      if (skipSelf?.(change)) continue;
      if (superseded.has(item.id) && isArmorDrBonus(change)) continue;
      applyOneChange(change, sourceLabel, sourceItemId, sourceItemRank, ctx, sourceItemType);
    }
    // A damaged Shield's lost DR (Shield Block, p.198) - only where its DR
    // counts at all (worn, not outclassed in its slot type).
    if (
      item.type === "item" &&
      item.system.shield &&
      givesBonuses(item) &&
      !superseded.has(item.id)
    ) {
      const lost = shieldDamageChange(item, ctx.rollData);
      if (lost) applyOneChange(lost, lost.label, item.id, item.system.rank ?? 0, ctx, item.type);
    }
  }
  // The DR an Armor-Piercing hit still meets: Anti-Piercing gear's own
  // armor DR (p.95: "The DR of a piece of armor with this quality applies
  // against Armor-Piercing damage") - each piece that counts at all (not
  // outclassed in its slot type). deriveDefenses (derive-creature.mjs)
  // scales it like the rest of DR and keeps it within drEffective.
  let antiPiercingDr = 0;
  for (const item of items) {
    if (
      item.type !== "item" ||
      !item.system.antiPiercing ||
      superseded.has(item.id) ||
      !givesBonuses(item)
    )
      continue;
    antiPiercingDr += armorDr(item, ctx.rollData);
  }
  actorSystem.drAntiPiercingBase = antiPiercingDr;
  // A condition entry carrying its own changes (a timed Buff such as an
  // Iron Skin Potion's "DR x2" - module/helpers/consumables.mjs) applies
  // them like a worn item, for as long as the entry lasts.
  for (const condition of actorSystem.conditions ?? []) {
    for (const change of condition.changes ?? []) {
      applyOneChange(change, condition.label || condition.source || "", null, 0, ctx, "condition");
    }
  }

  actorSystem.skills = skills;
  actorSystem.bonuses = bonuses;
  actorSystem.conditionalModifiers = conditionalModifiers;
  actorSystem.caps = caps;
  actorSystem.grantedResistances = resistances;
  actorSystem.grantedResistanceSources = ctx.resistanceSources;
  actorSystem.advancementBonuses = advancementBonuses;
  actorSystem.rankCaps = rankCaps;
  actorSystem.drMultiplier = 1 + (ctx.multipliers.dr ?? 0);
  actorSystem.bonusSources = ctx.bonusSources;
  actorSystem.evadeDice = ctx.evadeDice;
}
