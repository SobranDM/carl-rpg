/**
 * CarlDice: every roll flow - Stat, Skill, Opposed and Evade Checks; Attacks
 * (+ Damage) and Mob Attacks; Heals, toggled Spells, and Skill Advancement -
 * built from RollParts (module/dice/roll-parts.mjs) and posted via the chat
 * card factory (module/chat/chat-card.mjs). Pattern adapted from
 * foundryvtt-wwn's module/dice/dice.mjs.
 */
import { RollParts } from "./roll-parts.mjs";
import { promptRollOptions, promptParentSkillChoice, collectApplicableConditionalModifiers } from "./roll-prompt.mjs";
import { createRollMessage, createCardMessage } from "../chat/chat-card.mjs";
import { buildHealFooter } from "../chat/heal-card.mjs";
import { buildTauntLinkFooter } from "../chat/taunt-card.mjs";
import { buildAttackTargetsFooter } from "../chat/attack-targets-card.mjs";
import { activeRows, crawlerAttackDifficulty, crawlerAttackRow, mobAttackRow } from "../helpers/attack-targets.mjs";
import { aiRerollFlags, keptD20, rerollFormula } from "../helpers/ai-favor.mjs";
import { buildScrollCast } from "../helpers/scroll-cast.mjs";
import { isAreaItem, isAreaMobAttack } from "../helpers/area.mjs";
import { buildMarkChoiceFooter } from "../chat/mark-choice-card.mjs";
import { getDegreeOfSuccess, degreeBadge, isHitDegree, staticEvade, buildDifficultyPresets, selectedPresetValue } from "../helpers/rules.mjs";
import { slugifySkillName, collectItemTargetEffects, computeActiveShieldSlots, skillRankCap } from "../helpers/modifiers.mjs";
import { resolveCombatantFor } from "../helpers/token-resolution.mjs";
import { splitDamageEvenly } from "../helpers/damage-pipeline.mjs";
import { normalizeDamageType } from "../helpers/damage-types.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import {
  collectDebuffRows, collectAdvantageAgainstRows, decorateRows, resolveRollerRows, resolveDifficultyRows,
  buildDebuffNote, consumedConditionIds, endedConditionIds, getActionBlockReason,
} from "../helpers/debuff-effects.mjs";
import { removeConditionsById } from "../helpers/conditions.mjs";

/**
 * Net Advantage/Disadvantage don't stack (Playing the Game, p. 60): an
 * inherent Disadvantage (untrained Attack/Utility Skill) and a
 * player-selected Advantage cancel 1-for-1. Extra sources - a Debuff such
 * as Shit-Faced, or a target that's Held (module/helpers/
 * debuff-effects.mjs) - count the same way: "If you have two reasons to roll
 * with Advantage and one for Disadvantage, one Advantage cancels out the
 * Disadvantage, leaving you with Advantage" - but never more than one extra
 * die either way.
 * @param {boolean} inherentDisadvantage
 * @param {"normal"|"advantage"|"disadvantage"} selection
 * @param {{advantageCount?: number, disadvantageCount?: number}} [extra]
 * @returns {string} "1d20" | "2d20kh" | "2d20kl"
 */
export function resolveD20Formula(inherentDisadvantage, selection, { advantageCount = 0, disadvantageCount = 0 } = {}) {
  let net = advantageCount - disadvantageCount;
  if (inherentDisadvantage) net -= 1;
  if (selection === "advantage") net += 1;
  if (selection === "disadvantage") net -= 1;
  if (net > 0) return "2d20kh";
  if (net < 0) return "2d20kl";
  return "1d20";
}

/** The face value of the kept d20 (post keep-modifier), for crit/fumble detection. */
export function extractNaturalD20(roll) {
  const d20Term = roll.dice?.find((d) => d.faces === 20);
  if (!d20Term) return null;
  const active = d20Term.results.filter((r) => r.active);
  if (!active.length) return null;
  return active[0].result;
}

/**
 * Apply every checked conditional-modifier checkbox into a RollParts
 * instance, restricted to the given targetTypes (e.g. a damage roll only
 * wants "skillDamage"-targeted checks; a to-hit roll wants everything else).
 * @param {RollParts|((cm: object) => RollParts)} partsOrResolver  Either a
 *   single fixed RollParts (every non-damage caller - there's only ever one
 *   group), or a resolver function picking the right damage-type group per
 *   modifier (damage rolls, since a checked skillDamage modifier can carry
 *   its own `damageType` override the same way an unconditional change can -
 *   see module/helpers/modifiers.mjs's conditionalModifiers entries).
 * @param {object[]} conditionalModifiers
 * @param {Set<string>} checkedIds
 * @param {string[]} allowedTargetTypes
 */
function applyCheckedConditionalModifiers(partsOrResolver, conditionalModifiers, checkedIds, allowedTargetTypes) {
  const resolve = typeof partsOrResolver === "function" ? partsOrResolver : () => partsOrResolver;
  for (const cm of conditionalModifiers) {
    if (!checkedIds.has(cm.id)) continue;
    if (!allowedTargetTypes.includes(cm.targetType)) continue;
    const parts = resolve(cm);
    if (cm.mode === "multiply") parts.multiply(cm.value, cm.label);
    else if (cm.mode === "override") parts.override(cm.value, cm.label);
    else if (cm.mode === "subtract") {
      const n = Number(cm.value);
      parts.add(Number.isFinite(n) ? -n : `-(${cm.value})`, cm.label);
    } else parts.add(cm.value, cm.label);
  }
}

/**
 * Attack-capable items (Skill/Spell/Damage Effect) can carry an unlocked
 * Upgrade tier that overrides/splits their own default damage-type pool
 * (module/data/shared/upgrade-tier.mjs's `damageTypes`, docs/known-gaps.md
 * 1.3/1.7 - e.g. Magic Missile Rank 10: "the missiles deal Force and Fire
 * damage"). Gated by the item's own `system.rank`, same convention as
 * collectItemTargetEffects (module/helpers/modifiers.mjs).
 * @param {Item|null} item
 * @returns {string[]} Non-blank damage-type keys, highest-unlocked tier wins; empty = no override.
 */
function resolveDamageTypeSplit(item) {
  if (!item) return [];
  const unlocked = (item.system?.upgrades ?? [])
    .filter((u) => (item.system.rank ?? 0) >= u.rankThreshold)
    .filter((u) => (u.damageTypes ?? []).some(Boolean))
    .sort((a, b) => b.rankThreshold - a.rankThreshold);
  return (unlocked[0]?.damageTypes ?? []).filter(Boolean);
}

/** Localized "Damage" or "Damage (Fire)" / "Damage (Force/Fire, split evenly)" row label. */
function damageRowLabel(types) {
  const base = game.i18n.localize("CARLRPG.Roll.Damage");
  if (!types.length) return base;
  const names = types.map((t) => game.i18n.localize(CARLRPG.damageTypes[t] ?? t));
  if (types.length === 1) return `${base} (${names[0]})`;
  return `${base} (${names.join("/")}, ${game.i18n.localize("CARLRPG.Roll.SplitEvenly")})`;
}

/**
 * "A Critical Hit... roll twice as many base damage dice" (p.79/p.92) - the
 * dice COUNT doubles (1d10 -> 2d10, 3d6 -> 6d6), so the result has the
 * spread of the larger pool. A computed count doubles too ("(@rank)d6" ->
 * "(2*(@rank))d6"). Flat numbers in the same term aren't dice and stay as
 * they are.
 * @param {string} formula
 * @returns {string}
 */
export function doubleDiceCount(formula) {
  let out = String(formula ?? "");
  // Computed counts - "(@rank)d6", "floor(@rank/2)d6", "(1d4)d6" - right to
  // left, each whole count (function name included) wrapped in 2*(...) and
  // parked behind a placeholder so the literal pass below can't double the
  // dice inside it too.
  const groups = [];
  const closes = [...out.matchAll(/\)d\d/gi)].map((m) => m.index).reverse();
  for (const close of closes) {
    if (out[close] !== ")") continue;
    let depth = 0;
    let open = -1;
    for (let i = close; i >= 0; i--) {
      if (out[i] === ")") depth++;
      else if (out[i] === "(" && --depth === 0) { open = i; break; }
    }
    if (open < 0) continue;
    while (open > 0 && /[\w.]/.test(out[open - 1])) open--;
    groups.push(`(2*${out.slice(open, close + 1)})`);
    out = `${out.slice(0, open)}\u0000${groups.length - 1}\u0000${out.slice(close + 1)}`;
  }
  // Literal counts ("1d10", "d8").
  out = out.replace(/(^|[^\w@.)\u0000])(\d*)d(\d+)/gi, (match, lead, count, faces) =>
    `${lead}${2 * (Number(count) || 1)}d${faces}`);
  while (/\u0000\d+\u0000/.test(out)) out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => groups[Number(i)]);
  return out;
}

/**
 * Build the damage RollParts for an Attack Skill/Spell, grouped by
 * *effective damage type* (docs/known-gaps.md 1.3/1.7) rather than one flat
 * total: a term's own damageType override (ChangeEntry.damageType) wins,
 * falling back to whichever item's damage pool it landed in (the skill's own
 * baseDamage.damageType, or the selected Damage Effect's - which itself
 * falls back to the skill's, e.g. Iron Punch has no type of its own and
 * inherits Pugilism's Bludgeoning). Critical Hit only doubles "base" dice -
 * Rank Damage Dice and flat/multiplier terms are explicitly excluded
 * (Playing the Game, p. 79; Table 37) - unaffected by the grouping change.
 *
 * Each RollParts group is evaluated independently by the caller so a
 * per-type subtotal can be recovered for the resistance pipeline
 * (module/helpers/damage-pipeline.mjs) - RollParts itself has no built-in
 * type-tracking, so this groups into multiple instances rather than
 * retrofitting type-tagging into one shared instance.
 *
 * @returns {{groups: Map<string, RollParts>, skillDefaultType: string, splitTypes: string[]}}
 *   groups is keyed by resolved damage type ("" = no type declared at all).
 */
function buildDamageRollParts({ skillItem, skillEntry, damageEffectItem, damageEffectEntry, isCrit, rollData, conditionalModifiers, checked }) {
  /** @type {Map<string, RollParts>} */
  const groups = new Map();
  const getGroup = (type) => {
    const key = type || "";
    if (!groups.has(key)) groups.set(key, new RollParts(rollData));
    return groups.get(key);
  };

  const skillDefaultType = skillEntry?.baseDamage?.damageType || "";
  const effectDefaultType = damageEffectEntry?.baseDamage?.damageType || skillDefaultType;

  function addDamageTerms(damage, defaultType) {
    if (!damage) return;
    for (const term of damage.baseDice) {
      getGroup(term.damageType || defaultType).add(isCrit ? doubleDiceCount(term.formula) : term.formula, term.label);
    }
    for (const term of damage.rankDice) getGroup(term.damageType || defaultType).add(term.formula, term.label);
    for (const term of damage.flatBonuses) getGroup(term.damageType || defaultType).add(term.formula, term.label);
  }

  addDamageTerms(skillEntry?.damage, skillDefaultType);

  const statKey = skillEntry?.baseDamage?.stat;
  if (statKey) {
    const mod = rollData.stats?.[statKey]?.mod ?? 0;
    getGroup(skillDefaultType).add(mod, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
  }

  addDamageTerms(damageEffectEntry?.damage, effectDefaultType);

  // A checked skillDamage modifier can carry its own damageType override the
  // same way an unconditional change can (module/helpers/modifiers.mjs
  // copies it onto the conditionalModifiers entry) - route each into its
  // own resolved group, falling back to the skill's default-type pool.
  applyCheckedConditionalModifiers(
    (cm) => getGroup(cm.damageType || skillDefaultType),
    conditionalModifiers, checked, ["skillDamage"]
  );

  if (skillEntry?.damage) {
    for (const m of skillEntry.damage.multipliers) getGroup(m.damageType || skillDefaultType).multiply(m.factor, m.label);
    for (const o of skillEntry.damage.overrides) getGroup(o.damageType || skillDefaultType).override(o.formula, o.label);
  }
  if (damageEffectEntry?.damage) {
    for (const m of damageEffectEntry.damage.multipliers) getGroup(m.damageType || effectDefaultType).multiply(m.factor, m.label);
    for (const o of damageEffectEntry.damage.overrides) getGroup(o.damageType || effectDefaultType).override(o.formula, o.label);
  }

  const splitTypes = resolveDamageTypeSplit(skillItem);

  return { groups, skillDefaultType, splitTypes };
}

/**
 * Evaluate every damage-type group and produce parallel `rolls`/`rollMeta`
 * entries for the chat card, plus the final per-type numeric subtotal map
 * (post multi-type split, pre-resistance-pipeline - the resistance pipeline
 * itself runs later, at "Apply Damage" click time, against the target's
 * then-current resistances/dr; see module/chat/damage-card.mjs).
 * @returns {{rolls: Roll[], rollMeta: object[], damageByType: Record<string, number>}}
 */
async function evaluateDamageGroups({ groups, skillDefaultType, splitTypes }) {
  const rolls = [];
  const rollMeta = [];
  const damageByType = {};

  // Another spelling of a book type ("cold" on an imported Spell) rolls as
  // that type, so Resistances keyed by the book's types apply to it.
  const canonical = (type) => normalizeDamageType(type) || type;
  for (const [groupKey, parts] of groups) {
    if (parts.isEmpty) continue;
    const { roll, total, breakdown } = await parts.evaluate();
    rolls.push(roll);
    const typeKey = canonical(groupKey);

    if (groupKey === skillDefaultType && splitTypes.length) {
      const types = [...new Set(splitTypes.map(canonical))];
      rollMeta.push({ label: damageRowLabel(types), breakdown });
      const split = splitDamageEvenly(total, types);
      for (const [type, amount] of Object.entries(split)) {
        damageByType[type] = (damageByType[type] ?? 0) + amount;
      }
    } else {
      rollMeta.push({ label: damageRowLabel(typeKey ? [typeKey] : []), breakdown });
      damageByType[typeKey] = (damageByType[typeKey] ?? 0) + total;
    }
  }

  return { rolls, rollMeta, damageByType };
}

/**
 * Alternate Mana-cost/damage tradeoffs for a Spell (docs/known-gaps.md 1.6,
 * e.g. Magic Missile's "3 Mana: -4 damage / 4 Mana: -2 damage / 6 Mana: Add
 * 1 Rank damage die"). Index 0 is always the base cost. The damage/effect
 * delta stays purely descriptive - no structured formula field - applied by
 * GM/player judgment once surfaced on the chat card (see withManaCostSubtitle).
 * @param {Item} spellItem
 * @returns {{manaCost: number, description: string, isBase: boolean}[]} Empty if the spell has no variants.
 */
function buildManaCostChoices(spellItem) {
  const variants = spellItem.system.manaCostVariants ?? [];
  if (!variants.length) return [];
  return [
    { manaCost: spellItem.system.manaCost, description: game.i18n.localize("CARLRPG.Dialog.ManaCostBase"), isBase: true },
    ...variants.map((v) => ({ manaCost: v.manaCost, description: v.description, isBase: false })),
  ];
}

/**
 * "If a Spell is Favored by any particular Classes, other Classes pay 1
 * additional Mana to cast it" (p.201; module/data/spell.mjs's
 * favoredClasses). A Spell lists Class CATEGORIES ("Mage", "Cleric"...),
 * which a Class item carries as `classTypes` - "Boring Ol' Mage" is a Mage
 * - so the match is against those (and the Class's own name, for a Spell
 * that names one). A Spell with no favoredClasses charges everyone the
 * same, and a caster with no Class yet isn't an "other Class", so pays no
 * surcharge either.
 * @param {Item} spellItem
 * @param {Actor} actor
 * @param {number} manaCost
 * @returns {number}
 */
export function applyFavoredClassSurcharge(spellItem, actor, manaCost) {
  const favored = spellItem.system.favoredClasses ?? [];
  if (!favored.length) return manaCost;
  const classItem = actor.system.classItem;
  if (!classItem) return manaCost;
  const categories = [...(classItem.system?.classTypes ?? []), classItem.name];
  return categories.some((c) => favored.includes(c)) ? manaCost : manaCost + 1;
}

/**
 * @param {Item} spellItem
 * @param {{manaCost: number, description: string, isBase: boolean}[]} manaCostChoices
 * @param {number} chosenIndex
 * @param {Actor} actor
 * @returns {{manaCost: number, description: string|null, isBase: boolean}}
 */
function resolveManaCost(spellItem, manaCostChoices, chosenIndex, actor) {
  const chosen = manaCostChoices.length
    ? (manaCostChoices[chosenIndex] ?? manaCostChoices[0])
    : { manaCost: spellItem.system.manaCost, description: null, isBase: true };
  return { ...chosen, manaCost: applyFavoredClassSurcharge(spellItem, actor, chosen.manaCost) };
}

/**
 * Mana is spent for casting, not for the outcome - deducted regardless of
 * hit/miss or success/failure (docs/known-gaps.md 1.6). Clamped at 0;
 * insufficient Mana does NOT block casting, deliberately out of scope.
 * @param {Actor} actor
 * @param {number} manaCost
 */
async function applyManaCost(actor, manaCost) {
  if (!manaCost) return;
  const current = actor.system.mana?.value ?? 0;
  await actor.update({ "system.mana.value": Math.max(0, current - manaCost) });
}

/** Append the spent Mana (and, for a non-base variant, its descriptive delta) to a subtitle. */
export function withManaCostSubtitle(subtitle, chosen) {
  if (!chosen?.manaCost) return subtitle;
  const label = game.i18n.format("CARLRPG.Dialog.ManaCostSpent", { cost: chosen.manaCost });
  const full = chosen.isBase ? label : `${label} (${chosen.description})`;
  return subtitle ? `${subtitle} · ${full}` : full;
}

/**
 * Shared pre-roll gate: "You can't take any Actions" (Paralyzed, Dying) and
 * "You can't speak or cast Spells" (Muted) block the roll outright, with a
 * toast naming the Debuff. Delete the condition to roll anyway.
 * @param {Actor} actor
 * @param {{isSpell?: boolean}} [options]
 * @returns {boolean} true if blocked.
 */
export function isBlockedByDebuff(actor, { isSpell = false } = {}) {
  const reason = getActionBlockReason(actor, { isSpell });
  if (!reason) return false;
  ui.notifications.warn(reason);
  return true;
}

/**
 * "You can't cast a Spell you have no Ranks in" (p.58/p.201) - unlike an
 * untrained Attack/Utility Skill, which rolls with Disadvantage. Warns and
 * returns true when the roll must not proceed.
 * @param {Item} item
 * @param {number} rank
 * @returns {boolean}
 */
function isBlockedUntrainedSpell(item, rank) {
  if (item?.type !== "spell" || rank > 0) return false;
  ui.notifications.warn(game.i18n.format("CARLRPG.Warning.CannotCastUntrained", { name: item.name }));
  return true;
}

/**
 * Difficulty presets for a Skill Check (p.59): Opposed when the Skill names
 * an opposed Stat and a token is targeted (10 + its Mod + Floor), otherwise
 * Unopposed (10 + 2xFloor).
 * @param {Item} skillItem
 * @returns {ReturnType<typeof buildDifficultyPresets>}
 */
function buildSkillCheckPresets(skillItem) {
  const statKey = skillItem.system.opposedStat;
  const targetActor = Array.from(game.user.targets ?? [])[0]?.actor ?? null;
  const opposed = statKey && targetActor
    ? {
      name: targetActor.name,
      stat: game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey),
      mod: targetActor.system.stats?.[statKey]?.mod ?? 0,
    }
    : null;
  return buildDifficultyPresets({
    floor: game.settings.get("carl-rpg", "currentFloor"),
    selected: opposed ? "opposed" : "unopposed",
    opposed,
  });
}

/** Add each Debuff penalty (Minor Injury -2, Woozy's lost DEX Mod, ...) as its own labeled roll term. */
function addDebuffPenalties(parts, penalties) {
  for (const p of penalties) parts.add(p.value, p.label);
}

/**
 * A Mob stat block's constant "to hit" value (p.267: "Remember to add the
 * current Floor Number to values with '+F'"), e.g. "16+F" -> 16 + Floor.
 * @param {string} text
 * @param {number} floor
 * @returns {number|null} null if blank or not a plain arithmetic expression.
 */
export function evaluateMobConstant(text, floor) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const expr = trimmed.replace(/\bF\b/g, `(${Number(floor) || 0})`);
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
  try {
    const value = Roll.safeEval(expr);
    return Number.isFinite(value) ? Math.round(value) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Damage types a Shield pool can intercept on a Mob Attack. A blank type
 * (most stat blocks' claws and bites) counts as physical too; every other
 * named type counts as magical.
 */
const PHYSICAL_DAMAGE_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

/**
 * An actor's own token, when it has one - same resolution order as
 * module/chat/chat-card.mjs's getCarlSpeaker, so the uuid this produces
 * matches whatever a chat card's speaker already points at. Used for
 * attackerUuid (below) and for resolving the acting Combatant for the
 * Nat-20/Amazing-Success Advantage entitlement.
 * @param {Actor} actor
 * @returns {TokenDocument|null}
 */
function resolveActorToken(actor) {
  return actor?.token ?? actor?.getActiveTokens?.(true, true)?.[0] ?? null;
}

/**
 * Narrow an Attack's conditional modifiers to what's eligible for the roll
 * as resolved: the rolled Skill's own, plus - only if a Damage Effect ended
 * up chosen - that one Damage Effect's. Every other candidate Damage
 * Effect's conditions were surfaced in the dialog too, so a box ticked for
 * one that isn't used is dropped rather than leaking its bonus.
 * @param {object[]} conditionalModifiers
 * @param {Item} skillItem
 * @param {Item|null} damageEffectItem
 * @returns {object[]}
 */
function narrowConditionalModifiers(conditionalModifiers, skillItem, damageEffectItem) {
  const skillKey = slugifySkillName(skillItem.name);
  return conditionalModifiers.filter((cm) => {
    if (cm.targetType !== "skillRank" && cm.targetType !== "skillDamage") return true;
    if (slugifySkillName(cm.target) === skillKey) return true;
    return !!damageEffectItem && cm.sourceItemId === damageEffectItem.id;
  });
}

/**
 * What a cast reads, in one place. Normally the caster's own: their skill
 * bag entry for the Skill/Spell, its conditional bonuses, Mana and the
 * Advancement use-mark. For a Scroll's cast (castAs - module/helpers/
 * scroll-cast.mjs) the Spell's own entry and bonuses at the scroll's fixed
 * Rank, no Mana, no use-mark and no Damage Effect - but the caster's general
 * conditional bonuses (gear's "+2 while flanking") still apply, since a
 * scroll "casts the Spell as though the crawler cast it themselves" (p.99).
 * @param {Actor} actor
 * @param {Item} skillItem
 * @param {object|null} castAs
 * @param {string[]} [damageEffectIds]  Candidate Damage Effects whose own conditions to offer.
 * @returns {{skillEntry: object|undefined, conditionalModifiers: object[], scroll: boolean, payMana: boolean, markUse: boolean}}
 */
export function resolveCastContext(actor, skillItem, castAs, damageEffectIds = []) {
  const sys = actor.system;
  const own = collectApplicableConditionalModifiers(sys, skillItem.name, damageEffectIds);
  if (!castAs) {
    return {
      skillEntry: sys.skills?.[slugifySkillName(skillItem.name)],
      conditionalModifiers: own,
      scroll: false,
      payMana: skillItem.type === "spell",
      markUse: true,
    };
  }
  const general = own.filter((cm) => cm.targetType !== "skillRank" && cm.targetType !== "skillDamage");
  return {
    skillEntry: castAs.skillEntry,
    conditionalModifiers: [...general, ...(castAs.conditionalModifiers ?? [])],
    scroll: true,
    payMana: false,
    markUse: false,
  };
}

/** The d20 expression a RollParts check rolled ("1d20", "2d20kh", ...). */
function d20Formula(roll) {
  const term = roll.dice?.find((d) => d.faces === 20);
  return term ? `${term.number}d20${(term.modifiers ?? []).join("")}` : null;
}

export default class CarlDice {
  /**
   * Stat Check: 1d20 + Stat Mod (the sheet's Stats column). Goes through the
   * same Debuff gate/rows/consumption as every other crawler roll, so Minor
   * Injury's -2, Shit-Faced's Disadvantage, Paralyzed's block, etc. apply.
   * @param {Actor} actor
   * @param {string} statKey  e.g. "str", "con".
   * @param {{difficulty?: number|null, skipDialog?: boolean}} [options]
   * @returns {Promise<ChatMessage|null>}
   */
  static async rollStatCheck(actor, statKey, { difficulty = null, skipDialog = false } = {}) {
    const sys = actor.system;
    const stat = sys.stats?.[statKey];
    if (!stat) return null;
    if (isBlockedByDebuff(actor)) return null;

    const statLabel = stat.label || game.i18n.localize(CARLRPG.stats[statKey] ?? statKey);
    const debuffRows = decorateRows(collectDebuffRows(sys, "check"), "roll");

    let options = { advantage: "normal", difficulty, modifier: 0, checkedDebuffs: null };
    if (!skipDialog) {
      const difficultyPresets = buildDifficultyPresets({
        floor: game.settings.get("carl-rpg", "currentFloor"),
        selected: difficulty === null ? "stat" : "given",
        given: difficulty === null ? null : { label: game.i18n.localize("CARLRPG.Dialog.Preset.Given"), value: difficulty },
      });
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.StatCheckTitle", { name: statLabel }),
        difficulty: selectedPresetValue(difficultyPresets),
        difficultyPresets,
        showDifficulty: true,
        debuffRows,
      });
      if (!prompted) return null;
      options = prompted;
    }

    const debuffEffect = resolveRollerRows(debuffRows, options.checkedDebuffs);
    const parts = new RollParts(actor.getRollData());
    parts.add(resolveD20Formula(false, options.advantage, debuffEffect), game.i18n.localize("CARLRPG.Roll.Die"));
    parts.add(stat.mod ?? 0, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
    addDebuffPenalties(parts, debuffEffect.penalties);
    parts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));

    const { roll, total, breakdown } = await parts.evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const degree = getDegreeOfSuccess(naturalRoll, total, options.difficulty);

    await removeConditionsById(actor, endedConditionIds(sys, debuffEffect.applied));

    const body = buildDebuffNote(debuffEffect.applied);
    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: statLabel, breakdown }],
      title: statLabel,
      subtitle: game.i18n.localize(CARLRPG.degreesOfSuccess[degree]),
      img: actor.img,
      badge: degreeBadge(degree),
      body,
      actor,
      flags: aiRerollFlags(actor, {
        kind: "check", formula: d20Formula(roll), natural: naturalRoll, total, difficulty: options.difficulty,
        title: statLabel, img: actor.img, label: statLabel, breakdown, body,
      }),
    });
  }

  /**
   * Skill Check: 1d20 (2d20kl if untrained Attack/Utility) + Rank + Stat Mod.
   * Passive Skills can't be Checked at all; Spells can't be attempted
   * untrained (Skills, Spells & Gear, p. 173).
   * @param {Actor} actor
   * @param {Item} skillItem  A skill|spell|damageEffect item owned by actor.
   * @param {{skipDialog?: boolean, castAs?: object|null}} [options]
   *   castAs: a Scroll's cast (module/helpers/scroll-cast.mjs) - its own
   *   skill entry and fixed Rank, no Mana, no use-mark.
   */
  static async rollSkillCheck(actor, skillItem, { skipDialog = false, castAs = null } = {}) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    const cast = resolveCastContext(actor, skillItem, castAs);
    const { skillEntry } = cast;
    const rank = skillEntry?.rank ?? skillSys.rank ?? 0;

    if (skillSys.isPassive) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Warning.PassiveNoCheck", { name: skillItem.name }));
      return null;
    }
    if (isBlockedUntrainedSpell(skillItem, rank)) return null;
    if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;

    const rollData = actor.getRollData();
    const { conditionalModifiers } = cast;
    const manaCostChoices = cast.payMana ? buildManaCostChoices(skillItem) : [];
    const debuffRows = decorateRows(collectDebuffRows(sys, "check"), "roll");

    let options = { advantage: "normal", difficulty: null, modifier: 0, checked: new Set(), manaCostChoice: 0, checkedDebuffs: null };
    if (!skipDialog) {
      const difficultyPresets = buildSkillCheckPresets(skillItem);
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.SkillCheckTitle", { name: skillItem.name }),
        difficulty: selectedPresetValue(difficultyPresets),
        difficultyPresets,
        showDifficulty: true,
        conditionalModifiers,
        manaCostChoices,
        debuffRows,
      });
      if (!prompted) return null;
      options = prompted;
    }

    const untrained = rank === 0;
    const statKey = skillSys.governingStat;
    const statMod = statKey ? (sys.stats?.[statKey]?.mod ?? 0) : 0;
    const debuffEffect = resolveRollerRows(debuffRows, options.checkedDebuffs);

    const parts = new RollParts(rollData);
    parts.add(resolveD20Formula(untrained, options.advantage, debuffEffect), game.i18n.localize("CARLRPG.Roll.Die"));
    if (!untrained) parts.add(rank, game.i18n.localize("CARLRPG.Roll.SkillRank"));
    if (statKey) parts.add(statMod, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
    addDebuffPenalties(parts, debuffEffect.penalties);
    parts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(parts, conditionalModifiers, options.checked, ["skillRank", "stat", "rollMode", "custom"]);

    const { roll, total, breakdown } = await parts.evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const degree = getDegreeOfSuccess(naturalRoll, total, options.difficulty);

    await removeConditionsById(actor, endedConditionIds(sys, debuffEffect.applied));
    if (cast.markUse) await CarlDice.markForAdvancement(skillItem);

    const chosenManaCost = cast.payMana ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor) : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);

    const body = buildDebuffNote(debuffEffect.applied);
    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      body,
      actor,
      flags: aiRerollFlags(actor, {
        kind: "check", formula: d20Formula(roll), natural: naturalRoll, total, difficulty: options.difficulty,
        title: skillItem.name, img: skillItem.img, label: skillItem.name, breakdown, body, chosenManaCost,
      }),
    });
  }

  /**
   * Attack roll vs. the targeted token's Evade (10 + DEX Mod + Floor) if one
   * is selected, else a manually-entered Difficulty. On a hit, rolls damage
   * in the same card (base dice doubled on a Critical Hit; Rank Damage Dice
   * and flat/multiplier terms are not).
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{skipDialog?: boolean, damageEffectItem?: Item|null}} [options]
   */
  static async rollAttack(actor, skillItem, { skipDialog = false, damageEffectItem = null, castAs = null } = {}) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    // castAs: a Scroll's cast - see resolveCastContext. It never adds a
    // Damage Effect.
    if (castAs) damageEffectItem = null;
    const skillEntry = castAs ? castAs.skillEntry : sys.skills?.[slugifySkillName(skillItem.name)];
    const rank = skillEntry?.rank ?? skillSys.rank ?? 0;
    if (isBlockedUntrainedSpell(skillItem, rank)) return null;
    if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;

    // Snapshot targets NOW, at roll time - not at chat-card-click time. The
    // "Apply to Target(s)" button (module/chat/target-effects-card.mjs)
    // reads these back off the chat message's flags, so re-targeting after
    // the roll (or before the GM gets around to clicking the button) can't
    // change who gets hit by this specific roll's target effects.
    const targets = Array.from(game.user.targets ?? []);
    const target = targets[0] ?? null;
    const targetUuids = targets.map((t) => t.document?.uuid).filter(Boolean);
    let targetDifficulty = null;
    // Debuff rows (module/helpers/debuff-effects.mjs): the target's own
    // Debuffs adjust the Difficulty this Attack rolls against, and a Held/
    // Taken Down target gives this Attack Advantage.
    let targetRows = [];
    let advantageRows = [];
    if (target?.actor) {
      const targetSys = target.actor.system;
      const floor = game.settings.get("carl-rpg", "currentFloor");
      targetDifficulty = staticEvade(targetSys) + floor;
      const ownerName = target.actor.name;
      // A Mob's Evade is a static Difficulty, so every one of its Debuffs
      // that would touch a d20 Evade lowers it instead (p.96 - Disadvantage
      // -5, "-X" -X). A Character target's static Evade only loses its DEX
      // Mod to Woozy; the rest of a crawler's Debuffs apply to their own
      // Evade roll if they actively defend (module/chat/evade-link-card.mjs).
      const evadeRows = collectDebuffRows(targetSys, "evade", { ownerName, idPrefix: "target", ownAction: false });
      targetRows = decorateRows(
        target.actor.type === "character" ? evadeRows.filter((r) => r.kind === "noDex") : evadeRows,
        "difficulty",
      );
      advantageRows = decorateRows(collectAdvantageAgainstRows(targetSys, { ownerName, idPrefix: "target" }), "roll");
    }

    // The attacking token's own uuid (same convention as targetUuids above) -
    // lets a defending token's later Evade roll record "Advantage vs. THIS
    // specific Mob-instance" (module/chat/evade-link-card.mjs), and lets a
    // Taunt roll (module/chat/taunt-card.mjs) resolve the attacking Mob back
    // off the chat card without re-snapshotting anything of its own.
    const actingToken = resolveActorToken(actor);
    const attackerUuid = actingToken?.uuid ?? actor.uuid;

    // Nat-20/Amazing-Success Evade grants Advantage vs. that specific Mob on
    // the evader's NEXT Attack against them (Degrees of Success table, p.79)
    // - tracked as a flag on the ACTOR's own Combatant (set by
    // evade-link-card.mjs), since it must survive from one roll to a later,
    // separate roll within the same Combat. Combat-only by design: no
    // game.combat at all means no entitlement to look up.
    const actingCombatant = resolveCombatantFor({ actor, token: actingToken });
    const advantageVsUuid = actingCombatant?.getFlag("carl-rpg", "advantageVsUuid") ?? null;
    const targetTokenUuid = target?.document?.uuid ?? null;
    const advantageEntitled = !!(advantageVsUuid && targetTokenUuid && advantageVsUuid === targetTokenUuid);

    const rollData = actor.getRollData();

    // Candidates are matched by name against parentSkills, same rule the
    // actor sheet uses to list a Skill's Damage Effects (module/sheets/
    // actor-sheet.mjs) - not id/uuid, and not gated by item type, since
    // parentSkills can list Spells too. Rank-0 (untrained) ones are excluded
    // - Damage Effects are Passive Skills, and Passive Skills can't be used
    // untrained.
    const rankedDamageEffectCandidates = castAs ? [] : (damageEffectItem ? [damageEffectItem] : actor.items
      .filter((i) => i.type === "damageEffect" && (i.system.parentSkills ?? []).includes(skillItem.name)))
      .filter((de) => (sys.skills?.[slugifySkillName(de.name)]?.rank ?? de.system.rank ?? 0) > 0);

    // Omitted entirely (dropdown-wise) when a Damage Effect was already
    // supplied by the caller (CarlDice.rollDamageEffect, rolling FROM the
    // Damage Effect's own button) - the player already chose by clicking
    // that row, so re-offering the dropdown (and possibly having them pick a
    // DIFFERENT one, or blank it back out) would be confusing.
    const damageEffectChoices = damageEffectItem ? [] : rankedDamageEffectCandidates
      .map((de) => ({ id: de.id, name: de.name, rank: sys.skills?.[slugifySkillName(de.name)]?.rank ?? de.system.rank ?? 0 }));

    // Surfaces every CANDIDATE Damage Effect's own conditions (e.g. Choke
    // Out/Smush/Skullcracker's grapple-check bonuses target THEMSELVES, not
    // the parent Skill, so they'd never otherwise appear here) - narrowed to
    // only the actually-chosen one below, once damageEffectItem is final.
    const cast = resolveCastContext(actor, skillItem, castAs, rankedDamageEffectCandidates.map((de) => de.id));
    const { conditionalModifiers } = cast;

    const manaCostChoices = cast.payMana ? buildManaCostChoices(skillItem) : [];
    const rollerRows = decorateRows(collectDebuffRows(sys, "attack", { usesDex: skillSys.governingStat === "dex" }), "roll");

    // Area Attack (p.83) - pre-ticked in the dialog when the Skill/Spell (or
    // the Damage Effect passed in) reads as one (module/helpers/area.mjs).
    const detectedArea = isAreaItem(skillItem, rank) || isAreaItem(damageEffectItem);
    let options = {
      advantage: advantageEntitled ? "advantage" : "normal",
      difficulty: targetDifficulty, modifier: 0, checked: new Set(), manaCostChoice: 0, checkedDebuffs: null,
    };
    if (!skipDialog) {
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.AttackTitle", { name: skillItem.name }),
        difficulty: targetDifficulty,
        difficultyLabel: targetRows.length ? game.i18n.localize("CARLRPG.Dialog.BaseDifficulty") : null,
        defaultAdvantage: advantageEntitled ? "advantage" : null,
        conditionalModifiers,
        damageEffectChoices,
        manaCostChoices,
        debuffRows: [...rollerRows, ...advantageRows, ...targetRows],
        areaTargets: targets.map((t) => ({ name: t.actor?.name ?? t.name ?? "?" })),
        isArea: detectedArea,
      });
      if (!prompted) return null;
      options = prompted;
      if (prompted.damageEffectId) {
        damageEffectItem = actor.items.get(prompted.damageEffectId) ?? damageEffectItem;
      }
    }
    const isArea = targets.length ? (skipDialog ? detectedArea : !!options.isArea) : false;
    const splash = options.splash ?? new Set();
    // The dialog's Difficulty field is the BASE value (still GM-editable,
    // e.g. to type in a printed Evade); the target's Debuff rows ticked in
    // the dialog adjust it from there.
    const rollerEffect = resolveRollerRows([...rollerRows, ...advantageRows], options.checkedDebuffs);
    const targetEffect = resolveDifficultyRows(options.difficulty ?? targetDifficulty, targetRows, options.checkedDebuffs);
    const difficulty = targetEffect.difficulty;

    // Defensive re-check: the choices list above already keeps a Rank-0
    // Damage Effect out of the dropdown, but a non-dialog caller could still
    // pass one directly via the damageEffectItem option (skipDialog: true) -
    // Damage Effects are Passive Skills, unusable untrained.
    if (damageEffectItem) {
      const deRank = sys.skills?.[slugifySkillName(damageEffectItem.name)]?.rank ?? damageEffectItem.system.rank ?? 0;
      if (deRank === 0) {
        ui.notifications.warn(game.i18n.format("CARLRPG.Warning.DamageEffectUntrained", { name: damageEffectItem.name }));
        damageEffectItem = null;
      }
    }

    // Narrow to only what's actually eligible for THIS resolved roll: the
    // rolled Skill's own conditions (already scoped by name above) plus,
    // only if a Damage Effect ended up chosen, that ONE Damage Effect's own
    // conditions - every OTHER candidate's conditions were surfaced in the
    // dialog too (see conditionalModifiers/damageEffectChoices above), so a
    // checked box for a Damage Effect that isn't the one actually used here
    // is silently dropped rather than leaking its bonus onto this attack.
    const activeConditionalModifiers = narrowConditionalModifiers(conditionalModifiers, skillItem, damageEffectItem);

    const untrained = rank === 0;
    const statKey = skillSys.governingStat;
    const statMod = statKey ? (sys.stats?.[statKey]?.mod ?? 0) : 0;

    const primaryFormula = resolveD20Formula(untrained, options.advantage, rollerEffect);
    const attackParts = new RollParts(rollData);
    attackParts.add(primaryFormula, game.i18n.localize("CARLRPG.Roll.Die"));
    if (!untrained) attackParts.add(rank, game.i18n.localize("CARLRPG.Roll.SkillRank"));
    if (statKey) attackParts.add(statMod, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
    addDebuffPenalties(attackParts, rollerEffect.penalties);
    attackParts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(attackParts, activeConditionalModifiers, options.checked, ["skillRank", "stat", "rollMode", "custom"]);

    const { roll: attackRoll, total: attackTotal, breakdown: attackBreakdown } = await attackParts.evaluate();
    const naturalRoll = extractNaturalD20(attackRoll);
    const degree = getDegreeOfSuccess(naturalRoll, attackTotal, difficulty);
    // "A Nat 1 always misses" (p.92) - even with no Difficulty to roll against.
    const hit = difficulty === null ? degree !== "criticalFail" : isHitDegree(degree);

    // One row per target (module/helpers/attack-targets.mjs). An Area Attack
    // is one roll against the chosen foe (the first target) that lands on
    // everyone or no one (p.83); any other Attack is checked against each
    // target's own Evade. The dialog's Difficulty and Debuff ticks shape the
    // first target's row; the others use their own defaults.
    const floor = game.settings.get("carl-rpg", "currentFloor");
    const shared = isArea ? { hit, amazing: degree === "amazingSuccess" } : null;

    // Per-target Advantage on a non-area Attack: each other target's own
    // Held/Take Down ("Attacks against a Held foe are made with Advantage")
    // with the roller's own Debuffs and the dialog's choice. When targets
    // disagree, one extra d20 is rolled and each row keeps the die its own
    // Advantage/Disadvantage allows; the rest of the total is shared.
    const ownEffect = resolveRollerRows(rollerRows, options.checkedDebuffs);
    const rowFormulas = targets.map((t, i) => (i === 0 || isArea || !t.actor ? primaryFormula
      : resolveD20Formula(untrained, options.advantage, {
        advantageCount: ownEffect.advantageCount + collectAdvantageAgainstRows(t.actor.system).length,
        disadvantageCount: ownEffect.disadvantageCount,
      })));
    const d20Results = (attackRoll.dice ?? []).find((d) => d.faces === 20)?.results ?? [];
    const firstDie = d20Results[0]?.result ?? naturalRoll;
    let secondDie = d20Results[1]?.result ?? null;
    const extraD20Rolls = [];
    if (secondDie === null && rowFormulas.some((f) => f !== "1d20")) {
      const extra = await new Roll("1d20").evaluate();
      extraD20Rolls.push(extra);
      secondDie = extra.total;
    }
    const rowNatural = (formula) => keptD20(formula, firstDie, secondDie);

    const extraConsumed = [];
    const targetRowList = targets.map((t, i) => {
      const id = `t${i}`;
      const ref = { uuid: t.document?.uuid ?? t.actor?.uuid, actor: t.actor };
      let rowDifficulty = difficulty;
      let rowNat = naturalRoll;
      if (i > 0 && t.actor) {
        const other = crawlerAttackDifficulty(t.actor, floor);
        rowDifficulty = other.difficulty;
        if (!isArea) {
          extraConsumed.push([t.actor, consumedConditionIds(other.applied)]);
          rowNat = rowFormulas[i] === primaryFormula ? naturalRoll : rowNatural(rowFormulas[i]);
        }
      }
      return crawlerAttackRow({
        id, target: ref, difficulty: rowDifficulty,
        attackTotal: attackTotal - (naturalRoll ?? 0) + (rowNat ?? 0), naturalRoll: rowNat,
        zone: isArea && splash.has(i) ? "splash" : "full", shared,
      });
    });
    const anyHit = targetRowList.length ? targetRowList.some((r) => r.hit) : hit;

    // The Advantage entitlement is consumed by attempting the roll against
    // that Mob, not by hitting - clear regardless of this attack's own
    // outcome. Only touched here because it was actually consulted for THIS
    // target above; attacking a different Mob first left advantageEntitled
    // false, so this is a no-op and the flag survives for later.
    if (advantageEntitled && actingCombatant?.canUserModify(game.user, "update")) {
      await actingCombatant.unsetFlag("carl-rpg", "advantageVsUuid");
    }

    // One-shot Debuffs that just shaped this roll are spent (Stunned's
    // "once you make a Check", Staggered's "your next Action") - on the
    // attacker, and on a Mob target whose Difficulty they lowered.
    await removeConditionsById(actor, endedConditionIds(sys, rollerEffect.applied));
    if (target?.actor) await removeConditionsById(target.actor, consumedConditionIds(targetEffect.applied));
    for (const [other, ids] of extraConsumed) await removeConditionsById(other, ids);

    // "When you make an Attack that adds a Damage Effect, place a mark for
    // later Skill Advancement in either the Attack Skill or the Damage
    // Effect, not both." (Skills, Spells & Gear) - if only one of the two is
    // currently eligible-and-unmarked, there's no real choice to make, so
    // mark it automatically same as always; if BOTH still are, don't guess -
    // defer to the chat card's mark-choice buttons below instead (see
    // markChoicePending, resolved once flags/footerParts exist).
    let markChoicePending = null;
    if (!cast.markUse) {
      // A Scroll's Spell isn't the caster's own - nothing to mark.
    } else if (damageEffectItem) {
      const skillMarkable = CarlDice.isAdvancedByUse(skillItem) && !skillItem.system.marked;
      const deMarkable = CarlDice.isAdvancedByUse(damageEffectItem) && !damageEffectItem.system.marked;
      if (skillMarkable && deMarkable) {
        markChoicePending = { skillItem, damageEffectItem };
      } else if (skillMarkable) {
        await CarlDice.markForAdvancement(skillItem);
      } else if (deMarkable) {
        await CarlDice.markForAdvancement(damageEffectItem);
      }
    } else {
      await CarlDice.markForAdvancement(skillItem);
    }

    // Mana is spent for casting, not the outcome - deduct/surface regardless
    // of hit/miss (docs/known-gaps.md 1.6).
    const chosenManaCost = cast.payMana ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor) : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);

    const rolls = [attackRoll, ...extraD20Rolls];
    const rollMeta = [
      { label: skillItem.name, detail: target?.actor ? `vs. ${target.actor.name}` : "", breakdown: attackBreakdown },
      ...extraD20Rolls.map(() => ({ label: game.i18n.localize("CARLRPG.Targets.ExtraD20"), detail: game.i18n.localize("CARLRPG.Targets.ExtraD20Hint") })),
    ];

    // "On hit, the target gains Debuff X" (see docs/known-gaps.md 1.1's
    // original writeup, now resolved). Only ever collected on a hit - never
    // auto-applied here, just reported for the chat card's button.
    let targetEffects = [];
    // Per-damage-type subtotals (docs/known-gaps.md 1.3/1.7) - the raw
    // numbers only. DR/Resistance/Vulnerability/Immunity are NOT applied
    // here: that pipeline runs later, at "Apply Damage" click time
    // (module/chat/damage-card.mjs), against the target's then-current
    // system.resistances/system.dr, same roll-now/apply-on-click shape as
    // the target-effect and heal flows above.
    let damageByType = {};
    // Rolled for any targeted non-area Attack, even one that missed
    // everyone, so a Taunt redirect onto someone it does hit has damage to
    // apply (module/chat/taunt-card.mjs). The card hides the damage until
    // some row is a hit (module/chat/attack-targets-card.mjs).
    if (anyHit || (targetRowList.length && !isArea)) {
      const isAmazingSuccess = degree === "amazingSuccess";
      const damage = await CarlDice.rollAttackDamage(actor, skillItem, {
        damageEffectItem, isCrit: naturalRoll === 20, isAmazingSuccess,
        conditionalModifiers: activeConditionalModifiers, checked: options.checked,
        skillEntry: cast.scroll ? skillEntry : null,
      });
      rolls.push(...damage.rolls);
      rollMeta.push(...damage.rollMeta);
      damageByType = damage.damageByType;
      // "Success by 10 or more (Amazing Success): the crawler's Attack
      // deals extra damage equal to their current Floor Number" (Degrees
      // of Success table, p.79) - distinct from Critical Hit (which
      // doubles base dice instead), so no double-dip risk between the two.
      // Added as untyped ("") damage, same convention as Evade's own
      // Major-Fail +Floor bonus (module/chat/evade-link-card.mjs).
      // With targets, each row adds it for its own Amazing Success instead
      // (module/helpers/attack-targets.mjs's rowOutcome).
      if (isAmazingSuccess && !targetRowList.length) {
        damageByType[""] = (damageByType[""] ?? 0) + floor;
      }
      targetEffects = damage.targetEffects;
    }

    const hasDamage = Object.values(damageByType).some((v) => v);
    const flags = {};
    const footerParts = [];
    if (markChoicePending) {
      flags.markChoiceSkillUuid = markChoicePending.skillItem.uuid;
      flags.markChoiceDamageEffectUuid = markChoicePending.damageEffectItem.uuid;
      footerParts.push(await buildMarkChoiceFooter(markChoicePending.skillItem, markChoicePending.damageEffectItem));
    }
    if (targetEffects.length) flags.targetEffects = targetEffects;
    if (hasDamage) {
      flags.damageByType = damageByType;
      // Whichever Skill/Spell was actually rolled governs the whole hit's
      // magic-ness (docs/known-gaps.md 1.4) - a damageEffectItem with a
      // different isMagicDamage is deliberately not tracked per-term.
      flags.damageIsMagic = skillItem.system.isMagicDamage;
    }
    if (targetUuids.length) {
      // Per-target rows (module/chat/attack-targets-card.mjs): each target's
      // own hit/miss, Roll Evade and Apply. targetDifficulty is the first
      // target's (the GM may have overridden it in the dialog). attackTotal
      // and attackerType feed the PvP Evade rule (p.87); attackerUuid lets
      // an Evade record "Advantage vs. this attacker" and a Taunt find the
      // attacker (module/chat/taunt-card.mjs).
      flags.targetUuids = targetUuids;
      flags.targetRows = Object.fromEntries(targetRowList.map((row) => [row.id, row]));
      flags.isArea = isArea;
      flags.floor = floor;
      flags.attackTotal = attackTotal;
      flags.naturalRoll = naturalRoll;
      flags.targetDifficulty = difficulty;
      flags.attackerType = actor.type;
      flags.attackerUuid = attackerUuid;
    }
    if (targetUuids.length || hasDamage || targetEffects.length) {
      footerParts.push(buildAttackTargetsFooter({ damageByType, targetEffects, isArea }));
    }
    // Taunt (Interrupt, p.81) - a third party may redirect a single-target
    // Attack onto themselves (module/chat/taunt-card.mjs). Not an Area Attack.
    if (targetUuids.length && !isArea) footerParts.push(await buildTauntLinkFooter());
    const footer = footerParts.length ? footerParts.join("") : undefined;
    const body = buildDebuffNote([...rollerEffect.applied, ...targetEffect.applied]);

    // AI Favor reroll (module/helpers/ai-favor.mjs): enough to re-resolve
    // this Attack from a new d20 - see CarlDice.rerollAttack.
    Object.assign(flags, aiRerollFlags(actor, {
      kind: "attack", formula: primaryFormula, natural: naturalRoll, total: attackTotal, difficulty,
      breakdown: attackBreakdown, body, chosenManaCost,
      detail: target?.actor ? `vs. ${target.actor.name}` : "",
      skillItemId: skillItem.id, damageEffectItemId: damageEffectItem?.id ?? null,
      checked: [...(options.checked ?? [])],
      rowFormulas: Object.fromEntries(targetRowList.map((row, i) => [row.id, rowFormulas[i]])),
      // A Scroll's Spell isn't owned - the reroll rebuilds it from this.
      castAs: castAs ? { spellData: castAs.spellData, rank: castAs.rank } : null,
    }));

    return createRollMessage({
      rolls, rollMeta,
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      body,
      footer,
      flags,
      actor,
    });
  }

  /**
   * An Attack's damage roll and on-hit effects - shared by rollAttack and
   * its AI Favor reroll (rerollAttack), so both roll damage the same way.
   * Each damage row carries rowClass "carl-damage-roll" (hidden while no
   * target is hit - module/chat/attack-targets-card.mjs).
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{damageEffectItem?: Item|null, isCrit?: boolean, isAmazingSuccess?: boolean, conditionalModifiers?: object[], checked?: Set<string>, skillEntry?: object|null}} [options]
   *   skillEntry: use this instead of the actor's own (a Scroll's cast).
   * @returns {Promise<{rolls: Roll[], rollMeta: object[], damageByType: Record<string, number>, targetEffects: object[]}>}
   */
  static async rollAttackDamage(actor, skillItem, {
    damageEffectItem = null, isCrit = false, isAmazingSuccess = false, conditionalModifiers = [], checked = new Set(),
    skillEntry: givenEntry = null,
  } = {}) {
    const sys = actor.system;
    const skillEntry = givenEntry ?? sys.skills?.[slugifySkillName(skillItem.name)];
    const damageEffectEntry = damageEffectItem ? sys.skills?.[slugifySkillName(damageEffectItem.name)] : null;
    const built = buildDamageRollParts({
      skillItem, skillEntry, damageEffectItem, damageEffectEntry, isCrit,
      rollData: actor.getRollData(), conditionalModifiers, checked,
    });
    const evaluated = await evaluateDamageGroups(built);
    return {
      rolls: evaluated.rolls,
      rollMeta: evaluated.rollMeta.map((meta) => ({ ...meta, rowClass: "carl-damage-roll" })),
      damageByType: evaluated.damageByType,
      targetEffects: [
        ...collectItemTargetEffects(skillItem, { isCrit, isAmazingSuccess }),
        ...(damageEffectItem ? collectItemTargetEffects(damageEffectItem, { isCrit, isAmazingSuccess }) : []),
      ],
    };
  }

  /**
   * Re-resolve an Attack card from a new d20 (an AI Favor reroll, module/
   * chat/ai-favor-reroll.mjs) and post the result as a new card. Only the
   * d20 changes: the rest of the total, each target's Difficulty and zone,
   * and the dialog's choices come from the original card. Hit/miss, Critical
   * Hit, Amazing Success and so the damage and on-hit effects follow the new
   * die - damage is rolled after the d20 at the table too, so it's rolled
   * afresh. Nothing the original spent (Mana, the use-mark, consumed
   * Debuffs, the Nat-20 Advantage) is spent again.
   * @param {ChatMessage} message  The original Attack card.
   * @returns {Promise<ChatMessage|null>}
   */
  static async rerollAttack(message) {
    const flags = message.flags["carl-rpg"] ?? {};
    const spec = flags.aiReroll;
    const actor = spec ? await fromUuid(spec.actorUuid) : null;
    // A Scroll's cast: its Spell was never owned, so rebuild it - before any
    // owned-item lookup, which could hit an unrelated owned copy.
    const scroll = actor && spec.castAs?.spellData ? buildScrollCast(actor, spec.castAs.spellData, spec.castAs.rank) : null;
    const skillItem = scroll ? scroll.item : actor?.items.get(spec.skillItemId);
    if (!skillItem) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Reroll.Missing"));
      return null;
    }
    const damageEffectItem = !scroll && spec.damageEffectItemId ? (actor.items.get(spec.damageEffectItemId) ?? null) : null;

    const roll = await new Roll(rerollFormula(spec)).evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const attackTotal = roll.total;
    const difficulty = spec.difficulty;
    const degree = getDegreeOfSuccess(naturalRoll, attackTotal, difficulty);
    const hit = difficulty === null ? degree !== "criticalFail" : isHitDegree(degree);

    const isArea = !!flags.isArea;
    const shared = isArea ? { hit, amazing: degree === "amazingSuccess" } : null;
    const oldRows = activeRows(flags.targetRows);
    const rowFormulas = spec.rowFormulas ?? {};
    const d20Results = (roll.dice ?? []).find((d) => d.faces === 20)?.results ?? [];
    const firstDie = d20Results[0]?.result ?? naturalRoll;
    let secondDie = d20Results[1]?.result ?? null;
    const extraD20Rolls = [];
    if (secondDie === null && oldRows.some((row) => (rowFormulas[row.id] ?? spec.formula) !== "1d20")) {
      const extra = await new Roll("1d20").evaluate();
      extraD20Rolls.push(extra);
      secondDie = extra.total;
    }
    const targetRowList = oldRows.map((row, i) => {
      const formula = rowFormulas[row.id] ?? spec.formula;
      const rowNat = (i === 0 || isArea || formula === spec.formula) ? naturalRoll : keptD20(formula, firstDie, secondDie);
      return crawlerAttackRow({
        id: row.id,
        target: { uuid: row.uuid, actor: { name: row.name, type: row.isCharacter ? "character" : "mob" } },
        difficulty: row.difficulty,
        attackTotal: attackTotal - (naturalRoll ?? 0) + (rowNat ?? 0), naturalRoll: rowNat,
        zone: row.zone, shared,
      });
    });
    const anyHit = targetRowList.length ? targetRowList.some((row) => row.hit) : hit;

    const rolls = [roll, ...extraD20Rolls];
    const rollMeta = [
      { label: skillItem.name, detail: game.i18n.localize("CARLRPG.Reroll.Detail"), breakdown: spec.breakdown },
      ...extraD20Rolls.map(() => ({ label: game.i18n.localize("CARLRPG.Targets.ExtraD20"), detail: game.i18n.localize("CARLRPG.Targets.ExtraD20Hint") })),
    ];
    let damageByType = {};
    let targetEffects = [];
    if (anyHit || (targetRowList.length && !isArea)) {
      const cast = resolveCastContext(actor, skillItem, scroll?.castAs ?? null, damageEffectItem ? [damageEffectItem.id] : []);
      const conditionalModifiers = narrowConditionalModifiers(cast.conditionalModifiers, skillItem, damageEffectItem);
      const isAmazingSuccess = degree === "amazingSuccess";
      const damage = await CarlDice.rollAttackDamage(actor, skillItem, {
        damageEffectItem, isCrit: naturalRoll === 20, isAmazingSuccess,
        conditionalModifiers, checked: new Set(spec.checked ?? []),
        skillEntry: scroll?.castAs.skillEntry ?? null,
      });
      rolls.push(...damage.rolls);
      rollMeta.push(...damage.rollMeta);
      damageByType = damage.damageByType;
      if (isAmazingSuccess && !targetRowList.length) {
        damageByType[""] = (damageByType[""] ?? 0) + (flags.floor ?? game.settings.get("carl-rpg", "currentFloor"));
      }
      targetEffects = damage.targetEffects;
    }

    const hasDamage = Object.values(damageByType).some((v) => v);
    const newFlags = { aiReroll: { ...spec, used: true } };
    const footerParts = [];
    // A Skill-or-Damage-Effect mark choice still open on the old card moves
    // to the new one.
    if (flags.markChoiceSkillUuid && !flags.markChoiceDone) {
      const skillChoice = await fromUuid(flags.markChoiceSkillUuid);
      const effectChoice = await fromUuid(flags.markChoiceDamageEffectUuid);
      if (skillChoice && effectChoice) {
        newFlags.markChoiceSkillUuid = flags.markChoiceSkillUuid;
        newFlags.markChoiceDamageEffectUuid = flags.markChoiceDamageEffectUuid;
        footerParts.push(await buildMarkChoiceFooter(skillChoice, effectChoice));
      }
    }
    if (targetEffects.length) newFlags.targetEffects = targetEffects;
    if (hasDamage) {
      newFlags.damageByType = damageByType;
      newFlags.damageIsMagic = skillItem.system.isMagicDamage;
    }
    if (targetRowList.length) {
      Object.assign(newFlags, {
        targetUuids: flags.targetUuids,
        targetRows: Object.fromEntries(targetRowList.map((row) => [row.id, row])),
        isArea,
        floor: flags.floor,
        attackTotal,
        naturalRoll,
        targetDifficulty: difficulty,
        attackerType: flags.attackerType,
        attackerUuid: flags.attackerUuid,
      });
    }
    if (targetRowList.length || hasDamage || targetEffects.length) {
      footerParts.push(buildAttackTargetsFooter({ damageByType, targetEffects, isArea }));
    }
    if (targetRowList.length && !isArea) footerParts.push(await buildTauntLinkFooter());

    return createRollMessage({
      rolls, rollMeta,
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), spec.chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      body: `${spec.body ?? ""}<p class="carl-reroll-note">${game.i18n.localize("CARLRPG.Reroll.Note")}</p>`,
      footer: footerParts.length ? footerParts.join("") : undefined,
      flags: newFlags,
      actor,
    });
  }

  /**
   * A Mob's printed Attack (module/data/mob.mjs's `attacks` list) against
   * the targeted crawler(s). "Mobs are player-facing; they never roll"
   * (p.267): the "to hit" value IS the Difficulty of the target's Evade
   * Check, and the GM rolls only the damage (Step 3: Mob Action Resolution,
   * p.82). The Difficulty is adjusted by the attacking Mob's own Debuffs and
   * by a Held/Taken-Down defender (p.60/p.96 - module/helpers/
   * debuff-effects.mjs), and a net-Disadvantaged Attack gives the target a
   * free Evade Check (the `freeEvade` flag - module/chat/
   * evade-link-card.mjs). The card carries the same flag shape rollAttack
   * does, so Roll Evade / Taunt / Apply Damage work on it unchanged.
   * @param {Actor} actor  The attacking Mob.
   * @param {number} attackIndex  Index into actor.system.attacks.
   * @param {{skipDialog?: boolean}} [options]
   * @returns {Promise<ChatMessage|null>}
   */
  static async rollMobAttack(actor, attackIndex, { skipDialog = false } = {}) {
    const attack = actor.system.attacks?.[attackIndex];
    if (!attack) return null;
    if (isBlockedByDebuff(actor)) return null;

    const targets = Array.from(game.user.targets ?? []);
    const target = targets[0] ?? null;
    const targetUuids = targets.map((t) => t.document?.uuid).filter(Boolean);
    const floor = game.settings.get("carl-rpg", "currentFloor");
    const baseToHit = evaluateMobConstant(attack.toHit, floor);
    const attackName = attack.name || game.i18n.localize("CARLRPG.MobAttack.Unnamed");

    // The stat block doesn't say whether a to-hit includes the DEX Mod, so
    // Woozy is offered but left unticked here.
    const ownRows = collectDebuffRows(actor.system, "attack", { usesDex: true, ownerName: actor.name, idPrefix: "self" })
      .map((r) => (r.kind === "noDex" ? { ...r, defaultOn: false } : r));
    const defenderRows = target?.actor
      ? collectAdvantageAgainstRows(target.actor.system, { ownerName: target.actor.name, idPrefix: "target" })
      : [];
    const debuffRows = decorateRows([...ownRows, ...defenderRows], "difficulty");

    // Area Attack (p.83): "30ft Cone", "15ft Burst radius"... in the stat line.
    const detectedArea = isAreaMobAttack(attack);
    let options = { difficulty: baseToHit, modifier: 0, checkedDebuffs: null };
    if (!skipDialog) {
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.MobAttack.DialogTitle", { name: attackName }),
        difficulty: baseToHit,
        difficultyLabel: game.i18n.localize("CARLRPG.MobAttack.ToHitLabel"),
        showRollMode: false,
        debuffRows,
        areaTargets: targets.map((t) => ({ name: t.actor?.name ?? t.name ?? "?" })),
        isArea: detectedArea,
      });
      if (!prompted) return null;
      options = prompted;
    }
    const isArea = targets.length ? (skipDialog ? detectedArea : !!options.isArea) : false;
    const splash = options.splash ?? new Set();
    const base = options.difficulty ?? baseToHit;
    const mobBase = base === null ? null : base + (options.modifier || 0);
    const resolved = resolveDifficultyRows(mobBase, debuffRows, options.checkedDebuffs);
    const difficulty = resolved.difficulty;

    // One row per defender (module/helpers/attack-targets.mjs): the to-hit
    // adjusted by the Mob's own Debuffs and by that defender's Held/Take
    // Down, and a free Evade when that nets Disadvantage (p.96). The first
    // target uses the dialog's ticks; the others, the Mob's ticked rows
    // plus their own defaults.
    const ownApplied = resolveDifficultyRows(mobBase, ownRows, options.checkedDebuffs).applied
      .map((r) => ({ ...r, defaultOn: true }));
    const targetRowList = targets.map((t, i) => mobAttackRow({
      id: `t${i}`,
      target: { uuid: t.document?.uuid ?? t.actor?.uuid, actor: t.actor },
      base: mobBase,
      ownRows: i === 0 ? ownRows : ownApplied,
      checked: i === 0 ? options.checkedDebuffs : null,
      zone: isArea && splash.has(i) ? "splash" : "full",
    }).row);
    const freeEvade = !!targetRowList[0]?.freeEvade;

    // Damage: the printed formula, "+F" resolved to the current Floor.
    const rolls = [];
    const rollMeta = [];
    const damageByType = {};
    const damageType = attack.damageType || "";
    if (attack.damage?.trim()) {
      const parts = new RollParts(actor.getRollData());
      parts.add(attack.damage.replace(/\bF\b/g, "@floor"), attackName);
      let evaluated;
      try {
        evaluated = await parts.evaluate();
      } catch (err) {
        ui.notifications.warn(game.i18n.format("CARLRPG.MobAttack.BadDamage", { formula: attack.damage }));
        return null;
      }
      rolls.push(evaluated.roll);
      rollMeta.push({
        label: damageRowLabel(damageType ? [damageType] : []),
        detail: target?.actor ? `vs. ${target.actor.name}` : "",
        breakdown: evaluated.breakdown,
      });
      damageByType[damageType] = evaluated.total;
    }

    // With nothing targeted this is a preview (no Evade button, no free
    // Evade), so the Mob's one-shot Debuffs aren't spent on it.
    if (targetUuids.length) await removeConditionsById(actor, endedConditionIds(actor.system, resolved.applied));

    const hasDamage = Object.values(damageByType).some((v) => v);
    const flags = {};
    const footerParts = [];
    if (hasDamage) {
      flags.damageByType = damageByType;
      // Mob stat blocks don't mark an Attack magical or not; blank and
      // physical damage types are treated as non-magic (a Shield pool can
      // absorb them - docs/known-gaps.md 1.4), every other type as magic.
      flags.damageIsMagic = !!damageType && !PHYSICAL_DAMAGE_TYPES.has(damageType);
    }
    if (targetUuids.length) {
      flags.targetUuids = targetUuids;
      flags.targetRows = Object.fromEntries(targetRowList.map((row) => [row.id, row]));
      flags.isArea = isArea;
      flags.floor = floor;
      flags.attackTotal = difficulty;
      flags.targetDifficulty = difficulty;
      flags.attackerType = actor.type;
      flags.attackerUuid = resolveActorToken(actor)?.uuid ?? actor.uuid;
      // What a Taunt redirect re-resolves against (module/chat/taunt-card.mjs).
      flags.mobBase = mobBase;
      flags.mobOwnRows = ownApplied;
      if (freeEvade) flags.freeEvade = true;
    }
    if (targetUuids.length || hasDamage) footerParts.push(buildAttackTargetsFooter({ damageByType, isArea }));
    if (targetUuids.length && !isArea) footerParts.push(await buildTauntLinkFooter());

    const esc = foundry.utils.escapeHTML;
    let body = "";
    if (attack.effect) body += `<p class="carl-mob-attack-effect"><em>${esc(attack.effect)}</em></p>`;
    if (attack.range) body += `<p class="carl-mob-attack-range">${esc(game.i18n.localize("CARLRPG.Attack.Range"))}: ${esc(attack.range)}</p>`;
    body += buildDebuffNote(resolved.applied);
    if (targetRowList.some((r) => r.freeEvade)) body += `<p class="carl-free-evade-note"><i class="fas fa-person-running"></i> ${game.i18n.localize("CARLRPG.MobAttack.FreeEvadeNote")}</p>`;

    const subtitle = difficulty === null
      ? game.i18n.localize("CARLRPG.MobAttack.NoToHit")
      : game.i18n.format("CARLRPG.MobAttack.Subtitle", { difficulty });

    return createRollMessage({
      rolls, rollMeta,
      title: attackName,
      subtitle,
      img: actor.img,
      body,
      footer: footerParts.length ? footerParts.join("") : undefined,
      flags,
      actor,
    });
  }

  /**
   * Roll a Damage Effect directly (its own "roll" button, module/documents/
   * item.mjs's CarlRPGItem#roll): "choose one available Damage Effect
   * before you make the Attack Skill Check" (Playing the Game) - resolve
   * which owned Skill/Spell it's attached to (its `parentSkills`), prompting
   * only when there's more than one candidate, then delegate to the exact
   * same rollAttack every Skill/Spell-initiated Attack uses, with this
   * Damage Effect pre-supplied.
   * @param {Actor} actor
   * @param {Item} damageEffectItem
   * @returns {Promise<ChatMessage|null>} null if there's no usable parent
   *   Skill/Spell, the untrained-DE check fails, or a dialog was cancelled.
   */
  static async rollDamageEffect(actor, damageEffectItem) {
    const sys = actor.system;
    // Same untrained gate rollAttack applies defensively when a
    // damageEffectItem is passed in directly - checked here too so a
    // DE-initiated roll fails fast with a clear reason instead of silently
    // rolling the parent Skill/Spell alone (rollAttack's own fallback,
    // appropriate for the Skill-initiated dropdown, would be confusing here
    // since the whole point of this button IS the Damage Effect).
    const deRank = sys.skills?.[slugifySkillName(damageEffectItem.name)]?.rank ?? damageEffectItem.system.rank ?? 0;
    if (deRank === 0) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Warning.DamageEffectUntrained", { name: damageEffectItem.name }));
      return null;
    }

    const parentNames = damageEffectItem.system.parentSkills ?? [];
    const candidates = actor.items.filter((i) => (i.type === "skill" || i.type === "spell") && parentNames.includes(i.name));
    if (!candidates.length) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Warning.DamageEffectNoParentSkill", { name: damageEffectItem.name }));
      return null;
    }

    let skillItem = candidates[0];
    if (candidates.length > 1) {
      const chosenId = await promptParentSkillChoice(damageEffectItem, candidates);
      if (!chosenId) return null;
      skillItem = candidates.find((c) => c.id === chosenId) ?? skillItem;
    }

    return CarlDice.rollAttack(actor, skillItem, { damageEffectItem });
  }

  /**
   * Heal roll: Heal Self and similar Heal-type Spells (`castingKeywords`
   * includes `"heal"`) aren't Skill Checks - no d20, no to-hit, no Rank
   * bonus applied to the roll itself. Skills, Spells & Gear's Heal Self text
   * is just "you heal N Health Bar slots" at increasing dice tiers per Rank
   * (see packs-source/skills-and-spells/heal-self.json's `healDice`/`healToFull`/
   * `healMend` upgrade-tier fields, module/data/shared/upgrade-tier.mjs).
   * This rolls the currently-unlocked tier's `healDice` - or, at a
   * `healToFull` tier, skips dice entirely, per docs/known-gaps.md 1.2's
   * instruction that "heal to full" isn't a dice roll - and posts an "Apply
   * Healing" chat-card button (module/chat/heal-card.mjs). The roll itself
   * never touches `hb.value`; only clicking that button does, mirroring
   * rollAttack's roll-now/apply-on-click shape for target effects above.
   *
   * Upgrade-tier gating uses the item's own `system.rank`, matching
   * `collectItemTargetEffects`'s convention (module/helpers/modifiers.mjs),
   * not the actor's skills-bag rank.
   *
   * Heal Self's `range` is "Self only", so only the caster's own UUID is
   * snapshotted (`healActorUuid`) - unlike rollAttack, this does NOT
   * snapshot `game.user.targets`. A future ally-targeting Heal spell would
   * need its own targeting snapshot and an actor picker on the Apply
   * button; not built ahead of a real use case.
   * @param {Actor} actor
   * @param {Item} skillItem
   */
  static async rollHeal(actor, skillItem, { castAs = null } = {}) {
    // castAs: a Scroll's cast (module/helpers/scroll-cast.mjs) - its Rank is
    // the scroll's (already on the item), no Mana, no use-mark.
    const skillSys = skillItem.system;
    const rank = skillSys.rank ?? 0;
    if (isBlockedUntrainedSpell(skillItem, rank)) return null;
    if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;

    const unlocked = (skillSys.upgrades ?? [])
      .filter((u) => rank >= u.rankThreshold)
      .sort((a, b) => b.rankThreshold - a.rankThreshold);
    const fullTier = unlocked.find((u) => u.healToFull);
    const diceTier = unlocked.find((u) => u.healDice);
    const canMend = unlocked.some((u) => u.healMend);
    const formula = diceTier?.healDice || skillSys.healDice || "1d4";

    const cast = resolveCastContext(actor, skillItem, castAs);
    await removeConditionsById(actor, endedConditionIds(actor.system, []));
    if (cast.markUse) await CarlDice.markForAdvancement(skillItem);

    // Casting always spends Mana, whether or not the tier rolls dice
    // (docs/known-gaps.md 1.6) - no picker here, per this function's own
    // "not built ahead of a real use case" precedent above: no heal spell
    // currently has manaCostVariants. A Scroll pays none.
    const chosenManaCost = cast.payMana
      ? { manaCost: applyFavoredClassSurcharge(skillItem, actor, skillSys.manaCost), isBase: true }
      : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);

    const flags = { healActorUuid: actor.uuid };

    if (fullTier) {
      flags.healFull = true;
      const label = withManaCostSubtitle(game.i18n.localize("CARLRPG.Heal.SubtitleFull"), chosenManaCost);
      return createCardMessage({
        title: skillItem.name,
        img: skillItem.img,
        subtitle: label,
        badge: { label: game.i18n.localize("CARLRPG.Heal.SubtitleFull"), type: "hit" },
        footer: await buildHealFooter({ full: true, canMend }),
        flags,
        actor,
      });
    }

    const rollData = actor.getRollData();
    const parts = new RollParts(rollData);
    parts.add(formula, game.i18n.localize("CARLRPG.Roll.Heal"));
    const { roll, total, breakdown } = await parts.evaluate();

    flags.healAmount = total;

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.format("CARLRPG.Heal.Subtitle", { amount: total }), chosenManaCost),
      img: skillItem.img,
      badge: { label: `+${total}`, type: "hit" },
      footer: await buildHealFooter({ amount: total, canMend }),
      flags,
      actor,
    });
  }

  /**
   * Toggle an ongoing spell effect on/off (docs/known-gaps.md 1.4) - e.g.
   * Shield, Bang Bro. Turning ON pays the Spell's Mana cost (untrained Rank-0
   * casters are blocked, same as rollSkillCheck/rollHeal); turning OFF is
   * free (no Mana refund - the effect just ends). No manaCostVariants support
   * here (none of these spells currently have any, and there's no roll/dialog
   * for a toggle-cast to begin with - it's not a Skill Check).
   * @param {Actor} actor
   * @param {Item} skillItem
   */
  static async rollToggleSpell(actor, skillItem) {
    const skillSys = skillItem.system;
    const turningOn = !skillSys.active;
    let manaCostSpent = null;

    if (turningOn) {
      if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;
      if (isBlockedUntrainedSpell(skillItem, skillSys.rank ?? 0)) return null;
      manaCostSpent = applyFavoredClassSurcharge(skillItem, actor, skillSys.manaCost);
      await applyManaCost(actor, manaCostSpent);
      await removeConditionsById(actor, endedConditionIds(actor.system, []));
    }

    await skillItem.update({ "system.active": turningOn });

    // Shield-style pools (docs/known-gaps.md 1.4) refill to full on
    // (re)activation - "you can't heal a Shield" means recasting is the only
    // way to restore it. Recomputed straight from the actor's own items
    // rather than read back off actor.system.shield.effectiveMax, since that
    // depends on prepareDerivedData having already re-run off this same
    // update by the time this line executes - not worth relying on.
    if (turningOn && skillSys.shieldSlots) {
      const effectiveMax = computeActiveShieldSlots(actor.items ? Array.from(actor.items) : []);
      await actor.update({ "system.shield.value": effectiveMax });
    }

    const toggleSubtitle = turningOn
      ? withManaCostSubtitle(game.i18n.localize("CARLRPG.Toggle.Activated"), { manaCost: manaCostSpent, isBase: true })
      : game.i18n.localize("CARLRPG.Toggle.Deactivated");

    return createCardMessage({
      title: skillItem.name,
      img: skillItem.img,
      subtitle: toggleSubtitle,
      body: turningOn ? (skillItem.system.description ?? "") : "",
      actor,
    });
  }

  /**
   * Evade Check (Interrupt) vs. a supplied Difficulty (the attacking Mob's
   * total). Surfaces Major/Critical Fail consequences as GM-facing text -
   * NOT auto-applied, per this project's "GM judgment call" instruction.
   * @param {Actor} actor
   * @param {{difficulty?: number|null, skipDialog?: boolean, post?: boolean, isAction?: boolean}} [options]
   *   isAction (default true): false for a free Evade (p.96), which neither
   *   triggers nor ends a "next Action" Debuff (Queasy, Staggered).
   *   post (default true): when false, don't post a ChatMessage - return the
   *   raw roll data instead, so a caller (module/chat/evade-link-card.mjs)
   *   can fold this roll into ITS OWN combined roll+outcome card instead of
   *   posting two separate messages for one click. The standalone
   *   actor-sheet Evade button always uses the default (post: true) and
   *   sees no behavior change.
   * @returns {Promise<ChatMessage|{roll: Roll, total: number, breakdown: string, naturalRoll: number|null, degree: string}|null>}
   *   null if the roll-options dialog was cancelled, regardless of `post`.
   */
  static async rollEvadeCheck(actor, { difficulty = null, skipDialog = false, post = true, isAction = true } = {}) {
    const sys = actor.system;
    if (isBlockedByDebuff(actor)) return null;
    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, "evade");
    const debuffRows = decorateRows(collectDebuffRows(sys, "evade", { ownAction: isAction }), "roll");

    let options = { advantage: "normal", difficulty, modifier: 0, checked: new Set(), checkedDebuffs: null };
    if (!skipDialog) {
      const difficultyPresets = difficulty === null ? [] : buildDifficultyPresets({
        floor: game.settings.get("carl-rpg", "currentFloor"),
        selected: "given",
        given: { label: game.i18n.localize("CARLRPG.Dialog.Preset.Given"), value: difficulty },
      });
      const prompted = await promptRollOptions({
        title: game.i18n.localize("CARLRPG.Dialog.EvadeTitle"),
        difficulty,
        difficultyPresets,
        conditionalModifiers,
        debuffRows,
      });
      if (!prompted) return null;
      options = prompted;
    }

    const dexMod = sys.stats?.dex?.mod ?? 0;
    const evadeBonus = sys.bonuses?.evadeBonus ?? 0;
    const debuffEffect = resolveRollerRows(debuffRows, options.checkedDebuffs);

    const parts = new RollParts(rollData);
    parts.add(resolveD20Formula(false, options.advantage, debuffEffect), game.i18n.localize("CARLRPG.Roll.Die"));
    parts.add(dexMod, game.i18n.localize(CARLRPG.statAbbreviations.dex));
    parts.add(evadeBonus, game.i18n.localize("CARLRPG.Roll.EvadeBonus"));
    addDebuffPenalties(parts, debuffEffect.penalties);
    parts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(parts, conditionalModifiers, options.checked, ["stat", "rollMode", "custom"]);

    const { roll, total, breakdown } = await parts.evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const degree = getDegreeOfSuccess(naturalRoll, total, options.difficulty);
    const debuffNote = buildDebuffNote(debuffEffect.applied);

    await removeConditionsById(actor, endedConditionIds(sys, debuffEffect.applied, { isAction }));

    const formula = d20Formula(roll);
    if (!post) return { roll, total, breakdown, naturalRoll, degree, debuffNote, formula, difficulty: options.difficulty };

    let body = debuffNote;
    if (degree === "majorFail") body += `<p>${game.i18n.localize("CARLRPG.Roll.EvadeMajorFail")}</p>`;
    else if (degree === "criticalFail") body += `<p>${game.i18n.localize("CARLRPG.Roll.EvadeCriticalFail")}</p>`;

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: game.i18n.localize("CARLRPG.Roll.Evade"), breakdown }],
      title: game.i18n.localize("CARLRPG.Roll.Evade"),
      subtitle: game.i18n.localize(CARLRPG.degreesOfSuccess[degree]),
      img: actor.img,
      badge: degreeBadge(degree),
      body,
      actor,
      flags: {
        evadeDegree: degree, evadeTotal: total,
        ...aiRerollFlags(actor, {
          kind: "check", variant: "evade", formula, natural: naturalRoll, total, difficulty: options.difficulty,
          title: game.i18n.localize("CARLRPG.Roll.Evade"), img: actor.img,
          label: game.i18n.localize("CARLRPG.Roll.Evade"), breakdown, body: debuffNote,
        }),
      },
    });
  }

  /**
   * Opposed Skill Check: a plain Skill Check (d20 + Rank + governingStat
   * Mod, same shape as rollSkillCheck) but against an explicit Difficulty
   * supplied by the caller instead of one only entered by hand in the
   * dialog - rollSkillCheck has no such override (confirmed by reading its
   * full body - see docs/taunt-and-nat20-advantage-prompt.md's research), so
   * this mirrors rollEvadeCheck's shape instead. Built standalone/generic
   * (Taunt is the first caller - module/chat/taunt-card.mjs - but nothing
   * here is Taunt-specific) rather than duplicated per-Skill, matching this
   * project's precedent for reusable infrastructure (resolveActingActor).
   * @param {Actor} actor
   * @param {Item} skillItem  An Opposed-Check Skill (e.g. Taunt).
   * @param {{difficulty?: number|null, opponent?: Actor|null, skipDialog?: boolean, post?: boolean}} [options]
   *   opponent: the creature whose static number `difficulty` is. When it's
   *   a Mob, its Debuffs adjust that Difficulty (p.96 - module/helpers/
   *   debuff-effects.mjs), offered as dialog rows like rollAttack's target.
   *   post (default true): when false, return the raw roll data instead of
   *   posting a ChatMessage, so a caller can fold this roll into its own
   *   follow-up handling (see rollEvadeCheck's identical option).
   * @returns {Promise<ChatMessage|{roll: Roll, total: number, breakdown: string, naturalRoll: number|null, degree: string}|null>}
   *   null if the roll-options dialog was cancelled, regardless of `post`.
   */
  static async rollOpposedSkillCheck(actor, skillItem, { difficulty = null, opponent = null, skipDialog = false, post = true } = {}) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    const skillEntry = sys.skills?.[slugifySkillName(skillItem.name)];
    const rank = skillEntry?.rank ?? skillSys.rank ?? 0;

    if (skillSys.isPassive) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Warning.PassiveNoCheck", { name: skillItem.name }));
      return null;
    }
    if (isBlockedUntrainedSpell(skillItem, rank)) return null;
    if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;

    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, skillItem.name);
    // An opposed Spell is still cast - it costs Mana like any other (p.173).
    const manaCostChoices = skillItem.type === "spell" ? buildManaCostChoices(skillItem) : [];
    const rollerRows = decorateRows(collectDebuffRows(sys, "check"), "roll");
    const opponentRows = opponent && opponent.type !== "character"
      ? decorateRows(collectDebuffRows(opponent.system, "check", { ownerName: opponent.name, idPrefix: "opp", ownAction: false }), "difficulty")
      : [];

    let options = { advantage: "normal", difficulty, modifier: 0, checked: new Set(), manaCostChoice: 0, checkedDebuffs: null };
    if (!skipDialog) {
      const difficultyPresets = difficulty === null ? buildSkillCheckPresets(skillItem) : buildDifficultyPresets({
        floor: game.settings.get("carl-rpg", "currentFloor"),
        selected: "given",
        given: { label: game.i18n.localize("CARLRPG.Dialog.Preset.Given"), value: difficulty },
      });
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.OpposedCheckTitle", { name: skillItem.name }),
        difficulty: difficulty ?? selectedPresetValue(difficultyPresets),
        difficultyPresets,
        difficultyLabel: opponentRows.length ? game.i18n.localize("CARLRPG.Dialog.BaseDifficulty") : null,
        conditionalModifiers,
        manaCostChoices,
        debuffRows: [...rollerRows, ...opponentRows],
      });
      if (!prompted) return null;
      options = prompted;
    }
    const rollerEffect = resolveRollerRows(rollerRows, options.checkedDebuffs);
    const opponentEffect = resolveDifficultyRows(options.difficulty ?? difficulty, opponentRows, options.checkedDebuffs);
    const finalDifficulty = opponentEffect.difficulty;

    const untrained = rank === 0;
    const statKey = skillSys.governingStat;
    const statMod = statKey ? (sys.stats?.[statKey]?.mod ?? 0) : 0;

    const parts = new RollParts(rollData);
    parts.add(resolveD20Formula(untrained, options.advantage, rollerEffect), game.i18n.localize("CARLRPG.Roll.Die"));
    if (!untrained) parts.add(rank, game.i18n.localize("CARLRPG.Roll.SkillRank"));
    if (statKey) parts.add(statMod, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
    addDebuffPenalties(parts, rollerEffect.penalties);
    parts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(parts, conditionalModifiers, options.checked, ["skillRank", "stat", "rollMode", "custom"]);

    const { roll, total, breakdown } = await parts.evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const degree = getDegreeOfSuccess(naturalRoll, total, finalDifficulty);
    const debuffNote = buildDebuffNote([...rollerEffect.applied, ...opponentEffect.applied]);

    await removeConditionsById(actor, endedConditionIds(sys, rollerEffect.applied));
    if (opponent) await removeConditionsById(opponent, consumedConditionIds(opponentEffect.applied));
    await CarlDice.markForAdvancement(skillItem);

    // Spent before the post: false return, so a caller folding this roll
    // into its own card (Taunt) pays too.
    const chosenManaCost = skillItem.type === "spell" ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor) : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);

    if (!post) return { roll, total, breakdown, naturalRoll, degree, debuffNote, chosenManaCost };

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      body: debuffNote,
      actor,
      flags: aiRerollFlags(actor, {
        kind: "check", formula: d20Formula(roll), natural: naturalRoll, total, difficulty: finalDifficulty,
        title: skillItem.name, img: skillItem.img, label: skillItem.name, breakdown, body: debuffNote, chosenManaCost,
      }),
    });
  }

  /**
   * Skill Advancement Check: 1d20 vs. the Skill's current Rank. Success
   * grants +1 Rank (capped at 15 via this mechanic, per the rules text) and
   * clears the mark. This is the roll the GM Toolbox calls in bulk.
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{apply?: boolean, silent?: boolean, debuffs?: boolean, floorBonus?: boolean, clearMark?: boolean}} [options]
   *   apply: write the Rank/mark changes back to the item. silent: skip the
   *   chat card. The rest exist for grinding's check (module/helpers/
   *   grinding.mjs): debuffs applies the actor's Debuff penalties (p.170);
   *   floorBonus: false drops the Race/Class "at the end of each floor, add
   *   1" bonus, which only belongs to end-of-floor checks; clearMark: false
   *   leaves the use-mark for that end-of-floor check.
   * @returns {Promise<{success: boolean, roll: Roll, newRank: number}>}
   */
  static async rollAdvancementCheck(actor, skillItem, {
    apply = true, silent = false, debuffs = false, floorBonus = true, clearMark = true,
  } = {}) {
    const currentRank = skillItem.system.rank ?? 0;
    const slug = slugifySkillName(skillItem.name);
    // "At the end of each floor, add 1 to your Skill Advancement Checks for
    // X" (a Race/Class grant, targetType "advancementBonus") and "X Skill can
    // be raised to Rank 20" (targetType "skillRank"'s capMax) both key off
    // the actor's per-skill bags rather than the Skill item itself, since
    // both are granted by a separate owned Race/Class item, not the Skill.
    const bonus = floorBonus ? (actor.system.advancementBonuses?.[slug] ?? 0) : 0;
    const rankCap = skillRankCap(actor.system, skillItem.name);

    // Already at the ceiling - don't roll at all, and don't report a
    // cosmetic "success" that can't actually raise the Rank any further
    // (the old behavior rolled anyway, always showed "+1 Rank 15", and
    // still cleared the mark, which reads as progress when nothing moved).
    if (currentRank >= rankCap) {
      if (!silent) {
        await createCardMessage({
          title: game.i18n.format("CARLRPG.Roll.AdvancementTitle", { name: skillItem.name }),
          body: `<p>${game.i18n.format("CARLRPG.Roll.AdvancementAtCap", { rank: rankCap })}</p>`,
          img: skillItem.img,
          actor,
        });
      }
      return { success: false, roll: null, newRank: currentRank };
    }

    // Grinding's check: "Any penalties from Debuffs (Fatigued is common)
    // apply to this check" (p.170) - the actor's Check-scoped Debuff rows,
    // as an automatic roll (not an Action, nothing is consumed).
    const debuffEffect = debuffs
      ? resolveRollerRows(collectDebuffRows(actor.system, "check", { ownAction: false }))
      : { penalties: [], advantageCount: 0, disadvantageCount: 0, applied: [] };
    const penalty = debuffEffect.penalties.reduce((sum, p) => sum + p.value, 0);
    const formula = [resolveD20Formula(false, "normal", debuffEffect), bonus ? `${bonus}` : null, penalty ? `(${penalty})` : null]
      .filter(Boolean).join(" + ");
    const roll = new Roll(formula);
    await roll.evaluate();
    const success = roll.total >= currentRank;
    const newRank = success ? Math.min(currentRank + 1, rankCap) : currentRank;

    if (apply) {
      await skillItem.update(clearMark ? { "system.rank": newRank, "system.marked": false } : { "system.rank": newRank });
    }

    if (!silent) {
      await createRollMessage({
        rolls: [roll],
        rollMeta: [{ label: skillItem.name, detail: `${game.i18n.localize("CARLRPG.Roll.Rank")} ${currentRank}` }],
        title: game.i18n.format("CARLRPG.Roll.AdvancementTitle", { name: skillItem.name }),
        subtitle: success
          ? game.i18n.format("CARLRPG.Roll.AdvancementSuccess", { rank: newRank })
          : game.i18n.localize("CARLRPG.Roll.AdvancementFail"),
        img: skillItem.img,
        badge: { label: success ? "+1" : "—", type: success ? "hit" : "warn" },
        body: buildDebuffNote(decorateRows(debuffEffect.applied, "roll")),
        actor,
      });
    }

    return { success, roll, newRank };
  }

  /**
   * Mark a Skill/Spell/Damage Effect for Skill Advancement. Callers only
   * invoke this for things the rules actually allow to mark: rollSkillCheck
   * blocks pure-Passive Skills upstream (they never reach here via that
   * path), Damage Effects are a deliberate rules exception - "When you make
   * an Attack that adds a Damage Effect, place a mark... in either the
   * Attack Skill or the Damage Effect" overrides the general
   * Passive-skills-rarely-mark rule for that specific case. isAdvancedByUse
   * below covers the rest: advancementGate (including the Dodge-style
   * "marks only below Rank 5") and Passive Spells, which never mark (p.202). Public (not #-private) because module/chat/
   * mark-choice-card.mjs's chat-card button also calls this directly, with
   * its own fresh !marked re-check at click time (the item's state can
   * change between roll time and click time).
   */
  static async markForAdvancement(item) {
    if (!item || !CarlDice.isAdvancedByUse(item)) return;
    if (!item.system.marked) await item.update({ "system.marked": true });
  }

  /**
   * Whether this item's Rank can rise through use - marking it on a Check,
   * or grinding it (module/helpers/grinding.mjs). Not when advancementGate
   * says otherwise, and not for a Passive Spell: "Spells that don't require
   * a Check... are tagged as Passive and simply happen, but those are not
   * marked for Skill Advancement... their Ranks must be raised via magical
   * means or trained at a guild" (p.202).
   * @param {Item} item
   * @returns {boolean}
   */
  static isAdvancedByUse(item) {
    if (!item) return false;
    if (item.system.advancementGate === "magic-only") return false;
    if (item.system.advancementGate === "passive-until-5" && (item.system.rank ?? 0) >= 5) return false;
    if (item.type === "spell" && item.system.castingKeywords?.includes("passive")) return false;
    return true;
  }
}
