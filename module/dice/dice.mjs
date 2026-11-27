/**
 * CarlDice: every roll flow - Stat, Skill, Opposed and Evade Checks; Attacks
 * (+ Damage) and Mob Attacks; Heals, toggled Spells, and Skill Advancement -
 * built from RollParts (module/dice/roll-parts.mjs) and posted via the chat
 * card factory (module/chat/chat-card.mjs). Pattern adapted from
 * foundryvtt-wwn's module/dice/dice.mjs.
 */
import { RollParts } from "./roll-parts.mjs";
import {
  promptRollOptions,
  promptParentSkillChoice,
  collectApplicableConditionalModifiers,
  buildStatChoice,
  chosenStat,
  offStatNote,
} from "./roll-prompt.mjs";
import { createRollMessage, createCardMessage } from "../chat/chat-card.mjs";
import { buildHealFooter } from "../chat/heal-card.mjs";
import {
  chooseHealRecipient,
  healsMode,
  resolveHealRecipients,
  userHealTargets,
} from "../helpers/heal-targets.mjs";
import { buildTauntLinkFooter } from "../chat/taunt-card.mjs";
import { buildAttackTargetsFooter } from "../chat/attack-targets-card.mjs";
import {
  activeRows,
  crawlerAttackDifficulty,
  crawlerAttackRow,
  mobAttackRow,
} from "../helpers/attack-targets.mjs";
import { aiRerollFlags, keptD20 } from "../helpers/ai-favor.mjs";
import { buildScrollCast } from "../helpers/scroll-cast.mjs";
import { isAreaItem } from "../helpers/area.mjs";
import { mobAttackFor, rollMobDamage } from "../helpers/mob-attacks.mjs";
import { buildMarkChoiceFooter } from "../chat/mark-choice-card.mjs";
import {
  buildDifficultyPresets,
  degreeBadge,
  degreeLabel,
  getDegreeOfSuccess,
  interventionTotal,
  isHitDegree,
  isUntrained,
  selectedPresetValue,
} from "../helpers/rules.mjs";
import {
  attackIsArmorPiercing,
  attackTargetEffects,
  computeActiveShieldSlots,
  damageEffectFits,
  effectiveRank,
  ownedRank,
  skillRankCap,
  slugifySkillName,
  tiersHighestFirst,
} from "../helpers/modifiers.mjs";
import { resolveCombatantFor } from "../helpers/token-resolution.mjs";
import { splitDamageEvenly } from "../helpers/damage-pipeline.mjs";
import { damageTypeLabel, normalizeDamageType } from "../helpers/damage-types.mjs";
import { CARLRPG } from "../helpers/config.mjs";
import {
  collectDebuffRows,
  collectAdvantageAgainstRows,
  decorateRows,
  resolveRollerRows,
  resolveDifficultyRows,
  buildDebuffNote,
  consumedConditionIds,
  endedConditionIds,
  getActionBlockReason,
} from "../helpers/debuff-effects.mjs";
import { removeConditionsById } from "../helpers/conditions.mjs";
import { currentPhase, phasedCombatFor } from "../helpers/combat-phases.mjs";
import { describeDeclaration, recordDeclaration } from "../helpers/declarations.mjs";
import {
  canAct,
  combatantInFight,
  evadeIsFree,
  evadesWithoutAction,
  noteUndo,
  passiveContext,
  takeAction,
} from "../helpers/actions.mjs";
import { isPet, isVehicle, rollsLikeCrawler } from "../helpers/actor-kinds.mjs";
import { collectVehicleRows } from "../helpers/vehicle-rows.mjs";
import { attackDifficultyParts, mobVsVehicleRows } from "../helpers/attack-targets.mjs";
import { outsideHotlist, refuseOutsideHotlist, swapForAttack } from "../helpers/hotlist.mjs";
import { attackChoices, attackReadiness, warnNoWeapon } from "../helpers/weapons.mjs";
import { takesDamageEffects } from "../helpers/hand-to-hand.mjs";
import { earlyUseNote, passCooldown, passCooldowns, startCooldown } from "../helpers/cooldowns.mjs";
import { SPELL_TIMER_PATH, spellTimerFor } from "../helpers/spell-timers.mjs";
import { currentFloor } from "../helpers/floor.mjs";
import { esc } from "../helpers/html.mjs";
import { applyFavoredClassSurcharge, effectiveManaCost } from "../helpers/mana-cost.mjs";
import { dayNightAdvantage } from "../helpers/day-night.mjs";
import { buildOpposedChoice, hardestTarget, opposedNote } from "./opposed.mjs";

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
export function resolveD20Formula(
  inherentDisadvantage,
  selection,
  { advantageCount = 0, disadvantageCount = 0 } = {},
) {
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
function applyCheckedConditionalModifiers(
  partsOrResolver,
  conditionalModifiers,
  checkedIds,
  allowedTargetTypes,
) {
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
 * damage"). Gated by the item's live Rank (effectiveRank), same convention
 * as collectItemTargetEffects (module/helpers/modifiers.mjs).
 * @param {Item|null} item
 * @returns {string[]} Non-blank damage-type keys, highest-unlocked tier wins; empty = no override.
 */
function resolveDamageTypeSplit(item) {
  if (!item) return [];
  const tier = tiersHighestFirst(item).find((u) => (u.damageTypes ?? []).some(Boolean));
  return (tier?.damageTypes ?? []).filter(Boolean);
}

/** Localized "Damage" or "Damage (Fire)" / "Damage (Force/Fire, split evenly)" row label. */
function damageRowLabel(types) {
  const base = game.i18n.localize("CARLRPG.Roll.Damage");
  if (!types.length) return base;
  const names = types.map((t) => damageTypeLabel(t));
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
      else if (out[i] === "(" && --depth === 0) {
        open = i;
        break;
      }
    }
    if (open < 0) continue;
    while (open > 0 && /[\w.]/.test(out[open - 1])) open--;
    groups.push(`(2*${out.slice(open, close + 1)})`);
    out = `${out.slice(0, open)}\u0000${groups.length - 1}\u0000${out.slice(close + 1)}`;
  }
  // Literal counts ("1d10", "d8").
  out = out.replace(
    /(^|[^\w@.)\u0000])(\d*)d(\d+)/gi,
    (match, lead, count, faces) => `${lead}${2 * (Number(count) || 1)}d${faces}`,
  );
  while (/\u0000\d+\u0000/.test(out))
    out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => groups[Number(i)]);
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
 * Multipliers come in two kinds (modifiers.mjs skillDamageKind):
 *  - "base" scales the base damage dice result only, after a Critical Hit
 *    doubles them: "Multiply your base damage dice result by your Rank in
 *    this Skill, then add your modifiers and buffs" (Powerful Strike,
 *    p.180) - Pugilism 1d6+STR at Rank 5, a 3 and STR 4: 3x5+4 = 19.
 *  - any other kind scales the total damage, every type and every
 *    addition: "deals x2 the total damage" (Choke Out, Smush). An Amazing
 *    Success's +Floor is part of that total too - the caller scales it by
 *    the returned `totalFactor` (p.79: a "total damage" multiplier also
 *    takes in a Critical Hit's extra dice, which it does here).
 * A multiplier with its own damageType scales only that type's terms.
 *
 * @returns {{groups: Map<string, RollParts>, skillDefaultType: string, splitTypes: string[], totalFactor: number}}
 *   groups is keyed by resolved damage type ("" = no type declared at all);
 *   totalFactor is the untyped total-damage multiplier (1 = none).
 */
function buildDamageRollParts({
  skillItem,
  skillEntry,
  damageEffectItem,
  damageEffectEntry,
  isCrit,
  rollData,
  conditionalModifiers,
  checked,
}) {
  /** @type {Map<string, RollParts>} */
  const groups = new Map();
  const getGroup = (type) => {
    const key = type || "";
    if (!groups.has(key)) groups.set(key, new RollParts(rollData));
    return groups.get(key);
  };

  const skillDefaultType = skillEntry?.baseDamage?.damageType || "";
  const effectDefaultType = damageEffectEntry?.baseDamage?.damageType || skillDefaultType;

  // The ticked damage boxes (already narrowed to this Attack's Skill and
  // Damage Effect). Each carries its kind resolved as an unconditional
  // change's is (modifiers.mjs): a Rank damage die already turned into its
  // die, a multiplier's factor.
  const ticked = (conditionalModifiers ?? []).filter(
    (cm) => checked?.has(cm.id) && cm.targetType === "skillDamage",
  );

  // Every multiplier, each with the default type of the item it came from.
  const multipliers = [
    ...(skillEntry?.damage?.multipliers ?? []).map((m) => ({
      ...m,
      defaultType: skillDefaultType,
    })),
    ...(damageEffectEntry?.damage?.multipliers ?? []).map((m) => ({
      ...m,
      defaultType: effectDefaultType,
    })),
    ...ticked
      .filter((cm) => cm.mode === "multiply")
      .map((cm) => ({
        factor: cm.factor ?? cm.value,
        label: cm.label,
        kind: cm.damageDiceKind,
        damageType: cm.damageType || "",
      })),
  ]
    .map((m) => ({ ...m, factor: Number(m.factor) }))
    .filter((m) => Number.isFinite(m.factor) && m.factor !== 1);
  const baseMultipliers = multipliers.filter((m) => m.kind === "base");
  const totalMultipliers = multipliers.filter((m) => m.kind !== "base");

  /** A base dice term: doubled on a Critical Hit, then scaled by "base" multipliers. */
  function addBaseTerm(formula, label, type) {
    const rolled = isCrit ? doubleDiceCount(formula) : formula;
    const scaling = baseMultipliers.filter((m) => !m.damageType || m.damageType === type);
    const factor = scaling.reduce((product, m) => product * m.factor, 1);
    if (factor === 1) return getGroup(type).add(rolled, label);
    const names = scaling
      .map((m) => m.label)
      .filter(Boolean)
      .join(", ");
    const scaled = /^[\w@.]+$/.test(String(rolled).trim())
      ? `${rolled}*${factor}`
      : `(${rolled})*${factor}`;
    getGroup(type).add(scaled, `${label} ×${factor}${names ? ` (${names})` : ""}`);
  }

  function addDamageTerms(damage, defaultType) {
    if (!damage) return;
    for (const term of damage.baseDice)
      addBaseTerm(term.formula, term.label, term.damageType || defaultType);
    for (const term of damage.rankDice)
      getGroup(term.damageType || defaultType).add(term.formula, term.label);
    for (const term of damage.flatBonuses)
      getGroup(term.damageType || defaultType).add(term.formula, term.label);
  }

  addDamageTerms(skillEntry?.damage, skillDefaultType);

  const statKey = skillEntry?.baseDamage?.stat;
  if (statKey) {
    const mod = rollData.stats?.[statKey]?.mod ?? 0;
    getGroup(skillDefaultType).add(
      mod,
      game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey),
    );
  }

  addDamageTerms(damageEffectEntry?.damage, effectDefaultType);

  // A ticked term can carry its own damageType override the same way an
  // unconditional change can - routed into its own resolved group, falling
  // back to the skill's default-type pool. A base one doubles on a Critical
  // Hit (p.79) like any base die; a Rank damage die never does.
  for (const cm of ticked) {
    const type = cm.damageType || skillDefaultType;
    if (cm.mode === "multiply") continue;
    if (cm.mode === "override") getGroup(type).override(cm.value, cm.label);
    else if (cm.mode === "subtract") {
      const n = Number(cm.value);
      getGroup(type).add(Number.isFinite(n) ? -n : `-(${cm.value})`, cm.label);
    } else if (cm.damageDiceKind === "base") addBaseTerm(cm.value, cm.label, type);
    else getGroup(type).add(cm.value, cm.label);
  }

  for (const o of skillEntry?.damage?.overrides ?? [])
    getGroup(o.damageType || skillDefaultType).override(o.formula, o.label);
  for (const o of damageEffectEntry?.damage?.overrides ?? [])
    getGroup(o.damageType || effectDefaultType).override(o.formula, o.label);

  // The total damage: every group that has something in it (an empty one
  // would only add a stray 0 row).
  let totalFactor = 1;
  for (const m of totalMultipliers) {
    for (const [type, parts] of groups) {
      if (parts.isEmpty || (m.damageType && m.damageType !== type)) continue;
      parts.multiply(m.factor, m.label);
    }
    if (!m.damageType) totalFactor *= m.factor;
  }

  const splitTypes = resolveDamageTypeSplit(skillItem);

  return { groups, skillDefaultType, splitTypes, totalFactor };
}

/**
 * Evaluate every damage-type group and produce parallel `rolls`/`rollMeta`
 * entries for the chat card, plus the final per-type numeric subtotal map
 * (post multi-type split, pre-resistance-pipeline - the resistance pipeline
 * itself runs later, at "Apply Damage" click time, against the target's
 * then-current resistances/dr; see module/chat/damage-card.mjs).
 * @returns {{rolls: Roll[], rollMeta: object[], damageByType: Record<string, number>, totalFactor: number}}
 */
async function evaluateDamageGroups({ groups, skillDefaultType, splitTypes, totalFactor = 1 }) {
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

  return { rolls, rollMeta, damageByType, totalFactor };
}

/**
 * Note an Attack's "total damage" multiplier (Choke Out x2) on its target
 * rows, so each row's Amazing Success +Floor is scaled with the rest of the
 * damage (module/helpers/attack-targets.mjs rowOutcome). 1 leaves them be.
 * @param {object[]} rows
 * @param {number} factor
 */
function setRowDamageFactor(rows, factor) {
  if (factor === 1) return;
  for (const row of rows) row.damageFactor = factor;
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
function buildManaCostChoices(spellItem, actor = null) {
  const variants = spellItem.system.manaCostVariants ?? [];
  if (!variants.length) return [];
  // shownCost: what this caster pays for it (helpers/mana-cost.mjs).
  const choice = (manaCost, description, isBase) => ({
    manaCost,
    shownCost: effectiveManaCost(spellItem, actor, manaCost),
    description,
    isBase,
  });
  return [
    choice(spellItem.system.manaCost, game.i18n.localize("CARLRPG.Dialog.ManaCostBase"), true),
    ...variants.map((v) => choice(v.manaCost, v.description, false)),
  ];
}

// The Favored-Class +1 (p.201) lives with the rest of a Spell's cost now
// (helpers/mana-cost.mjs); still exported from here for older callers.
export { applyFavoredClassSurcharge };

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
  return { ...chosen, manaCost: effectiveManaCost(spellItem, actor, chosen.manaCost) };
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
  const value = Math.max(0, current - manaCost);
  // Given back if the Action is undone (helpers/action-undo.mjs).
  noteUndo(actor, { t: "mana", uuid: actor.uuid, amount: current - value });
  await actor.update({ "system.mana.value": value });
}

/**
 * A Check card's subtitle: the Degree of Success and the Difficulty it was
 * rolled against, so the GM can check it. No Difficulty (or a bad one from
 * an old card's flags) shows the Degree alone.
 * @param {string} degree
 * @param {number|null} difficulty
 * @returns {string}
 */
export function checkSubtitle(degree, difficulty) {
  const label = degreeLabel(degree);
  if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) return label;
  return `${label} · ${game.i18n.format("CARLRPG.Roll.VsDifficulty", { difficulty })}`;
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
  if (item?.type !== "spell" || !isUntrained(rank)) return false;
  ui.notifications.warn(
    game.i18n.format("CARLRPG.Warning.CannotCastUntrained", { name: item.name }),
  );
  return true;
}

/**
 * Difficulty presets for a Skill Check (p.59): Opposed when the Skill names
 * an opposed Stat and a token is targeted (10 + its Mod + Floor; several
 * targets, the hardest of them - ruled 2026-11-20), otherwise Unopposed
 * (10 + 2xFloor).
 * @param {Item} skillItem
 * @returns {ReturnType<typeof buildDifficultyPresets>}
 */
function buildSkillCheckPresets(skillItem) {
  const statKey = skillItem.system.opposedStat;
  const targets = Array.from(game.user.targets ?? []).filter((t) => t.actor);
  // Several targets: the hardest to beat (dice/opposed.mjs, the same rule).
  const hardest = statKey ? hardestTarget(targets, statKey) : null;
  const opposed = hardest
    ? {
        name: hardest.name,
        stat: game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey),
        mod: hardest.actor.system.stats?.[statKey]?.mod ?? 0,
      }
    : null;
  return buildDifficultyPresets({
    floor: currentFloor(),
    selected: opposed ? "opposed" : "unopposed",
    opposed,
  });
}

/** Add each Debuff penalty (Minor Injury -2, Woozy's lost DEX Mod, ...) as its own labeled roll term. */
function addDebuffPenalties(parts, penalties) {
  for (const p of penalties) parts.add(p.value, p.label);
}

/**
 * The Difficulty presets for a Difficulty the caller already has ("given"),
 * or - with none - the dialog's own default preset (`otherwise`).
 * @param {number|null} difficulty
 * @param {{otherwise?: string}} [options]
 * @returns {ReturnType<typeof buildDifficultyPresets>}
 */
function givenPresets(difficulty, { otherwise = "custom" } = {}) {
  const given =
    difficulty === null
      ? null
      : { label: game.i18n.localize("CARLRPG.Dialog.Preset.Given"), value: difficulty };
  return buildDifficultyPresets({
    floor: currentFloor(),
    selected: given ? "given" : otherwise,
    given,
  });
}

/**
 * A Skill Check's own terms after the d20: the Rank (none untrained - it
 * rolls with Disadvantage instead) and the Stat Mod.
 * @param {object} sys  The roller's system data.
 * @param {number} rank
 * @param {boolean} untrained
 * @param {string|null} statKey  The Stat rolled with (Off-Stat or the Skill's own).
 * @returns {Array<[number, string]>}
 */
function skillTerms(sys, rank, untrained, statKey) {
  const terms = [];
  if (!untrained) terms.push([rank, game.i18n.localize("CARLRPG.Roll.SkillRank")]);
  if (statKey)
    terms.push([
      sys.stats?.[statKey]?.mod ?? 0,
      game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey),
    ]);
  return terms;
}

/**
 * Roll a d20 Check (p.55-60): the d20 - Disadvantage when untrained, the
 * dialog's Advantage choice and the Debuffs' net, never more than one extra
 * die - then the Check's own terms, each Debuff penalty, the dialog's
 * situational modifier and the ticked conditional modifiers; graded against
 * the Difficulty.
 * @param {object} args
 * @param {object} args.rollData
 * @param {boolean} [args.untrained]
 * @param {string} args.advantage  The dialog's "advantage"|"normal"|"disadvantage".
 * @param {object} args.effect  resolveRollerRows' result.
 * @param {Array<[number|string, string]>} [args.terms]  [value, label] after the d20.
 * @param {number} [args.modifier]  The dialog's situational modifier.
 * @param {{modifiers: object[], checked: Set<string>, types: string[]}|null} [args.conditionals]
 * @param {number|null} args.difficulty
 * @returns {Promise<{roll: Roll, total: number, breakdown: string, naturalRoll: number|null, degree: string, dieFormula: string, formula: string|null}>}
 *   dieFormula: the d20 expression asked for; formula: the one rolled (d20Formula).
 */
async function rollD20Check({
  rollData,
  untrained = false,
  advantage,
  effect,
  terms = [],
  modifier,
  conditionals = null,
  difficulty,
}) {
  const dieFormula = resolveD20Formula(untrained, advantage, effect);
  const parts = new RollParts(rollData);
  parts.add(dieFormula, game.i18n.localize("CARLRPG.Roll.Die"));
  for (const [value, label] of terms) parts.add(value, label);
  addDebuffPenalties(parts, effect.penalties);
  parts.add(modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
  if (conditionals)
    applyCheckedConditionalModifiers(
      parts,
      conditionals.modifiers,
      conditionals.checked,
      conditionals.types,
    );
  const { roll, total, breakdown } = await parts.evaluate();
  const naturalRoll = extractNaturalD20(roll);
  return {
    roll,
    total,
    breakdown,
    naturalRoll,
    degree: getDegreeOfSuccess(naturalRoll, total, difficulty),
    dieFormula,
    formula: d20Formula(roll),
  };
}

/**
 * The note on a rerolled card ("Rerolled with 1 AI Favor.").
 * @param {string} [key]  The lang key of what it was rerolled with.
 * @returns {string}  HTML.
 */
export function rerollNote(key = "CARLRPG.Reroll.Note") {
  return `<p class="carl-reroll-note">${esc(game.i18n.localize(key))}</p>`;
}

/**
 * What an Evade's Major or Critical Fail costs (p.81), as a card note; ""
 * for any other Degree.
 * @param {string} degree
 * @returns {string}  HTML.
 */
export function evadeFailNote(degree) {
  if (degree === "majorFail") return `<p>${game.i18n.localize("CARLRPG.Roll.EvadeMajorFail")}</p>`;
  if (degree === "criticalFail")
    return `<p>${game.i18n.localize("CARLRPG.Roll.EvadeCriticalFail")}</p>`;
  return "";
}

/**
 * The d20s an Attack's rows read (p.60): the first die, and a second one -
 * the roll's own second d20, else one rolled now - when a row's own
 * Advantage or Disadvantage needs it (a formula other than "1d20").
 * @param {Roll} roll  The Attack's to-hit roll.
 * @param {number|null} natural  Its natural d20, if the roll has no d20 results.
 * @param {string[]} formulas  Each row's d20 formula.
 * @returns {Promise<{firstDie: number|null, secondDie: number|null, extraD20Rolls: Roll[]}>}
 */
async function rowD20s(roll, natural, formulas) {
  const results = (roll.dice ?? []).find((d) => d.faces === 20)?.results ?? [];
  const firstDie = results[0]?.result ?? natural;
  let secondDie = results[1]?.result ?? null;
  const extraD20Rolls = [];
  if (secondDie === null && formulas.some((f) => f !== "1d20")) {
    const extra = await new Roll("1d20").evaluate();
    extraD20Rolls.push(extra);
    secondDie = extra.total;
  }
  return { firstDie, secondDie, extraD20Rolls };
}

/** The conditional modifier types a Skill Check (and an Attack's to-hit) applies. */
const SKILL_CONDITIONAL_TYPES = ["skillRank", "stat", "rollMode", "custom"];

/**
 * A Skill Check that can't be made: a Passive Skill (no Check at all), an
 * untrained Spell, or a Debuff that blocks it. Warns.
 * @param {Actor} actor
 * @param {Item} skillItem
 * @param {number} rank
 * @returns {boolean}  True if refused.
 */
function skillCheckRefused(actor, skillItem, rank) {
  if (skillItem.system.isPassive) {
    ui.notifications.warn(
      game.i18n.format("CARLRPG.Warning.PassiveNoCheck", { name: skillItem.name }),
    );
    return true;
  }
  return (
    isBlockedUntrainedSpell(skillItem, rank) ||
    isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })
  );
}

/**
 * A Check's Debuff rows once its dialog has said whether it's an Action.
 * Queasy is "If your next Action requires a roll, it's made with
 * Disadvantage. At the end of the next Action you take" (Table 11, p.96;
 * Staggered's end, p.97): a Check that isn't one - the "Uses an Action" box
 * unticked, a Check the GM calls for - neither takes that Disadvantage nor
 * ends them. With no box offered (outside a fight, or part of another
 * Action) a Check counts as an Action, as before.
 * @param {object[]} rows  The rows collected for the dialog (as an Action).
 * @param {boolean|null} usesAction  The dialog's box; null when not offered.
 * @returns {{rows: object[], isAction: boolean}}
 */
function checkActionRows(rows, usesAction) {
  const isAction = usesAction !== false;
  if (isAction) return { rows, isAction };
  const actionOnly = (r) =>
    r.kind === "disadvantage" && CARLRPG.debuffs[r.key]?.mechanics?.disadvantage === "nextAction";
  return { rows: rows.filter((r) => !actionOnly(r)), isAction };
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
 * A revised card's Intervene d6s (module/chat/check-revision.mjs): their
 * Rolls and rows, and the "Total" row that follows them.
 * @param {object[]} interventions  [{byName, value, roll}]
 * @returns {{rolls: Roll[], meta: object[], totalRow: (total: number) => object[]}}
 */
export function interventionRolls(interventions = []) {
  const rolls = interventions.map((i) =>
    i.roll
      ? Roll.fromData(i.roll)
      : Roll.fromTerms([new foundry.dice.terms.NumericTerm({ number: i.value })]),
  );
  const meta = interventions.map((i) => ({
    label: game.i18n.format("CARLRPG.Intervene.Row", { name: i.byName }),
    breakdown: "1d6",
  }));
  return {
    rolls,
    meta,
    totalRow: (total) =>
      interventions.length
        ? [
            {
              label: game.i18n.localize("CARLRPG.Intervene.Total"),
              total: String(total),
              insertAt: 1 + interventions.length,
            },
          ]
        : [],
  };
}

/**
 * The roll dialog's "Uses an Action" box (helpers/actions.mjs): offered,
 * ticked or not, only when the roll is a fight's Action of its own - not
 * part of another (a Scroll's cast, boarding a vehicle) and not outside a
 * fight. null hides it.
 * @param {object} ctx  takeAction's context.
 * @param {boolean} ticked  Its default.
 * @returns {boolean|null}
 */
function actionBox(ctx, ticked) {
  return ctx.tracked ? ticked : null;
}

/**
 * Settle a roll's Action from its "Uses an Action" box: ticked, there must
 * be one left; unticked, it's free.
 * @param {object} ctx  takeAction's context.
 * @param {boolean} usesAction
 * @returns {boolean}  False: refused, none left.
 */
function settleAction(ctx, usesAction) {
  if (!usesAction) {
    ctx.free();
    return true;
  }
  return ctx.require();
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
  const general = own.filter(
    (cm) => cm.targetType !== "skillRank" && cm.targetType !== "skillDamage",
  );
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

/**
 * A note for the Attack dialog that the weapon comes out of the Hotlist.
 * @param {Item} weapon
 * @returns {string}
 */
function swapNote(weapon) {
  return game.i18n.format("CARLRPG.Weapon.SwapNote", { weapon: weapon.name });
}

/**
 * An Attack whose weapon is in the Hotlist (CarlDice.rollAttack): the dialog
 * first (it says the weapon will be swapped in), then the free swap into
 * the Main Hand and the roll with the dialog's choices - undone if the roll
 * doesn't happen (module/helpers/hotlist.mjs swapForAttack).
 * @param {Actor} actor
 * @param {Item} skillItem
 * @param {{swap: {index: number, item: Item}}} readiness  attackReadiness's result.
 * @param {{skipDialog?: boolean, damageEffectItem?: Item|null}} options
 * @returns {Promise<ChatMessage|null>}
 */
async function attackWithSwap(
  ctx,
  actor,
  skillItem,
  { swap },
  { skipDialog = false, damageEffectItem = null } = {},
) {
  let presetOptions = null;
  if (!skipDialog) {
    const args = await CarlDice.rollAttack(actor, skillItem, {
      damageEffectItem,
      promptArgsOnly: true,
    });
    if (!args) return null;
    presetOptions = await promptRollOptions({ ...args, weaponNote: swapNote(swap.item) });
    if (!presetOptions) return null;
  }
  // Things may have moved while the dialog was open: swap from where the
  // weapon is now (or not at all, if one's in hand by now).
  const now = attackReadiness(actor, skillItem);
  if (!now.ready) {
    warnNoWeapon(skillItem);
    return null;
  }
  // Still cooling down (helpers/cooldowns.mjs): asked before the weapon
  // moves, so a "no" leaves everything where it was.
  const cooldownAsked = await passCooldowns([
    skillItem,
    chosenDamageEffect(actor, presetOptions, damageEffectItem),
  ]);
  if (!cooldownAsked.ok) return null;
  // Part of this Attack's own Action (ctx), swap and all.
  const attack = () =>
    CarlDice.rollAttack(actor, skillItem, {
      damageEffectItem,
      skipDialog,
      presetOptions,
      within: ctx,
      cooldownAsked,
    });
  return now.swap ? swapForAttack(actor, now.swap, attack) : attack();
}

/**
 * The Damage Effect an Attack dialog's choices picked, else the one passed in.
 * @param {Actor} actor
 * @param {object|null} options  promptRollOptions' result.
 * @param {Item|null} fallback
 * @returns {Item|null}
 */
function chosenDamageEffect(actor, options, fallback = null) {
  return (options?.damageEffectId ? actor.items.get(options.damageEffectId) : null) ?? fallback;
}

export default class CarlDice {
  /**
   * Stat Check: 1d20 + Stat Mod (the sheet's Stats column). Goes through the
   * same Debuff gate/rows/consumption as every other crawler roll, so Minor
   * Injury's -2, Shit-Faced's Disadvantage, Paralyzed's block, etc. apply.
   * @param {Actor} actor
   * @param {string} statKey  e.g. "str", "con".
   * @param {{difficulty?: number|null, skipDialog?: boolean}} [options]
   *   In a fight it offers "Uses an Action", unticked - a Stat Check is
   *   usually one the GM calls for (p.85) - unless it's part of another
   *   Action (boarding a moving vehicle).
   * @returns {Promise<ChatMessage|null>}
   */
  static async rollStatCheck(actor, statKey, options = {}) {
    const stat = actor.system.stats?.[statKey];
    const label = game.i18n.format("CARLRPG.Actions.Label.Check", {
      name: stat?.label || game.i18n.localize(CARLRPG.stats[statKey] ?? statKey),
    });
    return takeAction(
      actor,
      "other",
      label,
      (ctx) => CarlDice._statCheck(ctx, actor, statKey, options),
      { optional: true, within: options.within },
    );
  }

  /** rollStatCheck, inside its Action (helpers/actions.mjs takeAction). */
  static async _statCheck(
    ctx,
    actor,
    statKey,
    { difficulty = null, skipDialog = false, title = null, returnResult = false } = {},
  ) {
    const sys = actor.system;
    const stat = sys.stats?.[statKey];
    if (!stat) return null;
    if (isBlockedByDebuff(actor)) return null;

    const statLabel = stat.label || game.i18n.localize(CARLRPG.stats[statKey] ?? statKey);
    const debuffRows = decorateRows(
      [...collectDebuffRows(sys, "check"), ...collectVehicleRows(actor, "check")],
      "roll",
    );

    const usesActionDefault = actionBox(ctx, false);
    let options = { advantage: "normal", difficulty, modifier: 0, checkedDebuffs: null };
    if (!skipDialog) {
      const difficultyPresets = givenPresets(difficulty, { otherwise: "stat" });
      const base = difficultyPresets.find((p) => p.selected);
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.StatCheckTitle", { name: statLabel }),
        difficulty: selectedPresetValue(difficultyPresets),
        difficultyPresets,
        showDifficulty: true,
        debuffRows,
        usesAction: usesActionDefault,
        // Opposed (p.58: "Difficulty 10 + the Cha of the perv trying to
        // manipulate you"): 10 + their Mod + Floor, with the same Stat.
        // A Difficulty passed in (boarding a vehicle) isn't offered it.
        opposedChoice:
          difficulty === null
            ? buildOpposedChoice({
                statKey,
                base: { value: base?.value ?? null, label: base?.label ?? "" },
                self: actor,
              })
            : null,
      });
      if (!prompted) return null;
      options = prompted;
    }
    const usesAction = skipDialog ? usesActionDefault : options.usesAction;
    if (!settleAction(ctx, !!usesAction)) return null;
    const actionRows = checkActionRows(debuffRows, usesAction);

    const debuffEffect = resolveRollerRows(actionRows.rows, options.checkedDebuffs);
    const { roll, total, breakdown, naturalRoll, degree, formula } = await rollD20Check({
      rollData: actor.getRollData(),
      advantage: options.advantage,
      effect: debuffEffect,
      terms: [[stat.mod ?? 0, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey)]],
      modifier: options.modifier,
      difficulty: options.difficulty,
    });

    await removeConditionsById(
      actor,
      endedConditionIds(sys, debuffEffect.applied, { isAction: actionRows.isAction }),
    );

    const body = opposedNote(options.opposed) + buildDebuffNote(debuffEffect.applied);
    const message = await createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: statLabel, breakdown }],
      title: title ?? statLabel,
      subtitle: checkSubtitle(degree, options.difficulty),
      img: actor.img,
      badge: degreeBadge(degree),
      body,
      actor,
      flags: aiRerollFlags(actor, {
        kind: "check",
        variant: "stat",
        formula,
        natural: naturalRoll,
        total,
        difficulty: options.difficulty,
        title: title ?? statLabel,
        img: actor.img,
        label: statLabel,
        breakdown,
        body,
      }),
    });
    // returnResult: a caller that acts on the outcome (boarding a moving
    // vehicle, module/helpers/vehicles.mjs) gets the Degree too.
    return returnResult ? { message, degree, total } : message;
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
   *   In a fight it offers "Uses an Action", ticked (Make a Check / Cast a
   *   Spell) - unless it's part of another Action (a Scroll's use).
   */
  static async rollSkillCheck(actor, skillItem, options = {}) {
    const key =
      skillItem.type === "spell" ? "CARLRPG.Actions.Label.Cast" : "CARLRPG.Actions.Label.Check";
    return takeAction(
      actor,
      "other",
      game.i18n.format(key, { name: skillItem.name }),
      (ctx) => CarlDice._skillCheck(ctx, actor, skillItem, options),
      { optional: true, within: options.within },
    );
  }

  /** rollSkillCheck, inside its Action (helpers/actions.mjs takeAction). */
  static async _skillCheck(ctx, actor, skillItem, { skipDialog = false, castAs = null } = {}) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    const cast = resolveCastContext(actor, skillItem, castAs);
    const { skillEntry } = cast;
    const rank = castAs ? (skillEntry?.rank ?? skillSys.rank ?? 0) : ownedRank(actor, skillItem);

    if (skillCheckRefused(actor, skillItem, rank)) return null;
    // Still cooling down: warn and ask (helpers/cooldowns.mjs), before
    // anything is spent. A Scroll's Spell isn't the crawler's own.
    const cooldown = castAs ? { ok: true, early: false } : await passCooldown(skillItem);
    if (!cooldown.ok) return null;

    const rollData = actor.getRollData();
    const { conditionalModifiers } = cast;
    const manaCostChoices = cast.payMana ? buildManaCostChoices(skillItem, actor) : [];
    const debuffRows = decorateRows(
      [...collectDebuffRows(sys, "check"), ...collectVehicleRows(actor, "check", { skillItem })],
      "roll",
    );
    // A Night Elf's Hide in Shadows at night (helpers/day-night.mjs).
    const timeAdvantage = dayNightAdvantage(actor, skillItem);

    const usesActionDefault = actionBox(ctx, true);
    let options = {
      advantage: timeAdvantage ? "advantage" : "normal",
      difficulty: null,
      modifier: 0,
      checked: new Set(),
      manaCostChoice: 0,
      checkedDebuffs: null,
    };
    if (!skipDialog) {
      const difficultyPresets = buildDifficultyPresets({
        floor: currentFloor(),
        selected: "unopposed",
      });
      const base = difficultyPresets.find((p) => p.selected);
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.SkillCheckTitle", { name: skillItem.name }),
        defaultAdvantage: timeAdvantage ? "advantage" : null,
        difficulty: selectedPresetValue(difficultyPresets),
        difficultyPresets,
        showDifficulty: true,
        conditionalModifiers,
        manaCostChoices,
        debuffRows,
        usesAction: usesActionDefault,
        // Off-Stat (p.58): rolled with another Stat than its own.
        statChoice: buildStatChoice(skillSys.governingStat ?? ""),
        // Opposed (p.59): any Skill Check can be; one whose Skill names the
        // Stat it's Opposed by opens Opposed at a targeted creature.
        opposedChoice: buildOpposedChoice({
          statKey: skillSys.opposedStat || skillSys.governingStat || "",
          follow: !skillSys.opposedStat,
          opposed: !!skillSys.opposedStat,
          base: { value: base?.value ?? null, label: base?.label ?? "" },
          self: actor,
        }),
      });
      if (!prompted) return null;
      options = prompted;
    }
    const usesAction = skipDialog ? usesActionDefault : options.usesAction;
    if (!settleAction(ctx, !!usesAction)) return null;
    const actionRows = checkActionRows(debuffRows, usesAction);

    const untrained = isUntrained(rank);
    // The Stat picked in the dialog (Off-Stat, p.58), else the Skill's own.
    const statKey = chosenStat(options, skillSys.governingStat);
    const debuffEffect = resolveRollerRows(actionRows.rows, options.checkedDebuffs);
    const { roll, total, breakdown, naturalRoll, degree, formula } = await rollD20Check({
      rollData,
      untrained,
      advantage: options.advantage,
      effect: debuffEffect,
      terms: skillTerms(sys, rank, untrained, statKey),
      modifier: options.modifier,
      conditionals: {
        modifiers: conditionalModifiers,
        checked: options.checked,
        types: SKILL_CONDITIONAL_TYPES,
      },
      difficulty: options.difficulty,
    });

    await removeConditionsById(
      actor,
      endedConditionIds(sys, debuffEffect.applied, { isAction: actionRows.isAction }),
    );
    if (cast.markUse) await CarlDice.markForAdvancement(skillItem);

    const chosenManaCost = cast.payMana
      ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor)
      : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);
    if (!castAs) await startCooldown(skillItem);

    const body =
      (cooldown.early ? earlyUseNote() : "") +
      opposedNote(options.opposed) +
      offStatNote(statKey, skillSys.governingStat) +
      buildDebuffNote(debuffEffect.applied);
    const message = await createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(checkSubtitle(degree, options.difficulty), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      body,
      actor,
      flags: aiRerollFlags(actor, {
        kind: "check",
        formula,
        natural: naturalRoll,
        total,
        difficulty: options.difficulty,
        title: skillItem.name,
        img: skillItem.img,
        label: skillItem.name,
        breakdown,
        body,
        chosenManaCost,
      }),
    });
    return message;
  }

  /**
   * The Combat tab's Attack! button: the Attack dialog with a choice of
   * Attack Skill first - only the ones the crawler can use now, with a
   * weapon in hand or in the Hotlist, or needing none (module/helpers/
   * weapons.mjs). Picking one fills in the rest of the dialog for it (its
   * Damage Effects, conditions...); confirming makes that Attack, swapping
   * a Hotlist weapon into the Main Hand first if that's where it is.
   * @param {Actor} actor
   * @returns {Promise<ChatMessage|null>}
   */
  static async chooseAttack(actor) {
    if (isBlockedByDebuff(actor)) return null;
    if (!canAct(actor, "attack")) return null;
    const choices = attackChoices(actor);
    if (!choices.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Weapon.NoAttacks"));
      return null;
    }
    const rank = (skill) => ownedRank(actor, skill);
    // Highest Rank first; a tie keeps attackChoices' alphabetical order (the
    // sort is stable). The first is picked from the start, so the dialog
    // opens ready to roll.
    choices.sort((a, b) => rank(b.skill) - rank(a.skill));
    const load = async (id) => {
      const choice = choices.find((c) => c.skill.id === id);
      if (!choice) return null;
      const args = await CarlDice.rollAttack(actor, choice.skill, { promptArgsOnly: true });
      return args ? { ...args, weaponNote: choice.swap ? swapNote(choice.swap.item) : "" } : null;
    };
    const selected = choices[0].skill.id;
    const initial = await load(selected);
    if (!initial) return null;
    const prompted = await promptRollOptions({
      ...initial,
      title: game.i18n.localize("CARLRPG.Weapon.AttackTitle"),
      skillPicker: {
        selected,
        load,
        choices: choices.map(({ skill, weapon, swap }) => ({
          id: skill.id,
          label: [
            `${skill.name} (${game.i18n.localize("CARLRPG.Roll.Rank")} ${rank(skill)})`,
            weapon
              ? game.i18n.format(swap ? "CARLRPG.Weapon.FromHotlist" : "CARLRPG.Weapon.InHand", {
                  weapon: weapon.name,
                })
              : "",
          ]
            .filter(Boolean)
            .join(" - "),
        })),
      },
    });
    const skill = prompted?.skillId ? actor.items.get(prompted.skillId) : null;
    if (!skill) return null;
    // Things may have moved while the dialog was open.
    const readiness = attackReadiness(actor, skill);
    if (!readiness.ready) {
      warnNoWeapon(skill);
      return null;
    }
    // Still cooling down (helpers/cooldowns.mjs): asked before anything
    // moves or is spent.
    const cooldownAsked = await passCooldowns([skill, chosenDamageEffect(actor, prompted)]);
    if (!cooldownAsked.ok) return null;
    // One Attack Action: the swap out of the Hotlist is part of it (p.98).
    return takeAction(
      actor,
      "attack",
      game.i18n.format("CARLRPG.Actions.Label.Attack", { name: skill.name }),
      (ctx) => {
        const attack = () =>
          CarlDice.rollAttack(actor, skill, {
            presetOptions: prompted,
            within: ctx,
            cooldownAsked,
          });
        return readiness.swap ? swapForAttack(actor, readiness.swap, attack) : attack();
      },
    );
  }

  /**
   * Attack roll vs. the targeted token's Evade (10 + DEX Mod + Floor) if one
   * is selected, else a manually-entered Difficulty. On a hit, rolls damage
   * in the same card (base dice doubled on a Critical Hit; Rank Damage Dice
   * and flat/multiplier terms are not).
   *
   * A crawler's Attack with a Weapon Skill needs its weapon in hand or in
   * the Hotlist (module/helpers/weapons.mjs): with neither it warns and
   * stops; from the Hotlist, the weapon is swapped into the Main Hand once
   * the dialog is confirmed, as part of the Attack (attackWithSwap).
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{skipDialog?: boolean, damageEffectItem?: Item|null, castAs?: object|null,
   *   promptArgsOnly?: boolean, presetOptions?: object|null, targets?: object[]|null,
   *   cooldownAsked?: {ok: boolean, early: boolean}|null}} [options]
   *   cooldownAsked: the cooldown prompt's answer, when the caller asked
   *   already (the Attack! picker, a Swap and Attack - helpers/cooldowns.mjs).
   *   promptArgsOnly: return what the dialog would show (promptRollOptions'
   *   arguments) without showing it or rolling - the Attack! picker's.
   *   presetOptions: roll with these dialog choices (promptRollOptions'
   *   result) instead of asking - no weapon check, it was made before.
   *   targets: attack these instead of the user's targets - token-like
   *   `{actor, document, name}` (a Shield Bash at the attacker,
   *   helpers/shield-block.mjs).
   *   In a fight it's the Attack Action (helpers/actions.mjs) - refused with
   *   none left, spent once rolled - or part of the Action it's made in (a
   *   Scroll's use, a Swap and Attack).
   */
  static async rollAttack(actor, skillItem, options = {}) {
    if (options.promptArgsOnly)
      return CarlDice._attack(passiveContext(), actor, skillItem, options);
    return takeAction(
      actor,
      "attack",
      game.i18n.format("CARLRPG.Actions.Label.Attack", { name: skillItem.name }),
      (ctx) => CarlDice._attack(ctx, actor, skillItem, options),
      { within: options.within },
    );
  }

  /** rollAttack, inside its Action (helpers/actions.mjs takeAction). */
  static async _attack(
    ctx,
    actor,
    skillItem,
    {
      skipDialog = false,
      damageEffectItem = null,
      castAs = null,
      promptArgsOnly = false,
      presetOptions = null,
      targets: givenTargets = null,
      cooldownAsked = null,
    } = {},
  ) {
    if (!promptArgsOnly && !presetOptions && !castAs) {
      const readiness = attackReadiness(actor, skillItem);
      if (!readiness.ready) {
        warnNoWeapon(skillItem);
        return null;
      }
      if (readiness.swap)
        return attackWithSwap(ctx, actor, skillItem, readiness, { skipDialog, damageEffectItem });
    }
    const sys = actor.system;
    const skillSys = skillItem.system;
    // castAs: a Scroll's cast - see resolveCastContext. It never adds a
    // Damage Effect.
    if (castAs) damageEffectItem = null;
    // Unarmed Combat "Cannot choose a Damage Effect" (p.179) - not even one
    // passed in (a macro).
    if (!takesDamageEffects(skillItem)) damageEffectItem = null;
    const skillEntry = castAs ? castAs.skillEntry : sys.skills?.[slugifySkillName(skillItem.name)];
    const rank = castAs ? (skillEntry?.rank ?? skillSys.rank ?? 0) : ownedRank(actor, skillItem);
    if (isBlockedUntrainedSpell(skillItem, rank)) return null;
    if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;

    // Snapshot targets NOW, at roll time - not at chat-card-click time. The
    // "Apply to Target(s)" button (module/chat/target-effects-card.mjs)
    // reads these back off the chat message's flags, so re-targeting after
    // the roll (or before the GM gets around to clicking the button) can't
    // change who gets hit by this specific roll's target effects.
    const targets = givenTargets ?? Array.from(game.user.targets ?? []);
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
      const floor = currentFloor();
      const ownerName = target.actor.name;
      // A Mob's Evade is a static Difficulty, so every one of its Debuffs
      // that would touch a d20 Evade lowers it instead (p.96 - Disadvantage
      // -5, "-X" -X). A Character target's static Evade only loses its DEX
      // Mod to Woozy; the rest of a crawler's Debuffs apply to their own
      // Evade roll if they actively defend (module/chat/evade-link-card.mjs).
      // A vehicle's is 10 + Move ÷ 5 (module/helpers/attack-targets.mjs).
      const parts = attackDifficultyParts(target.actor, floor);
      targetDifficulty = parts.base;
      targetRows = decorateRows(parts.rows, "difficulty");
      advantageRows = decorateRows(
        collectAdvantageAgainstRows(targetSys, { ownerName, idPrefix: "target" }),
        "roll",
      );
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
    const advantageEntitled = !!(
      advantageVsUuid &&
      targetTokenUuid &&
      advantageVsUuid === targetTokenUuid
    );

    const rollData = actor.getRollData();

    // Candidates are matched by slug against parentSkills (damageEffectFits), same rule the
    // actor sheet uses to list a Skill's Damage Effects (module/sheets/
    // actor-sheet.mjs) - not id/uuid, and not gated by item type, since
    // parentSkills can list Spells too. Rank-0 (untrained) ones are excluded
    // - Damage Effects are Passive Skills, and Passive Skills can't be used
    // untrained.
    // Unarmed Combat "Cannot choose a Damage Effect" (p.179).
    const rankedDamageEffectCandidates =
      castAs || !takesDamageEffects(skillItem)
        ? []
        : (damageEffectItem
            ? [damageEffectItem]
            : actor.items.filter((i) => i.type === "damageEffect" && damageEffectFits(i, skillItem))
          ).filter((de) => !isUntrained(ownedRank(actor, de)));

    // Omitted entirely (dropdown-wise) when a Damage Effect was already
    // supplied by the caller (CarlDice.rollDamageEffect, rolling FROM the
    // Damage Effect's own button) - the player already chose by clicking
    // that row, so re-offering the dropdown (and possibly having them pick a
    // DIFFERENT one, or blank it back out) would be confusing.
    const damageEffectChoices = damageEffectItem
      ? []
      : rankedDamageEffectCandidates.map((de) => ({
          id: de.id,
          name: de.name,
          rank: ownedRank(actor, de),
        }));

    // Surfaces every CANDIDATE Damage Effect's own conditions (e.g. Choke
    // Out/Smush/Skullcracker's grapple-check bonuses target THEMSELVES, not
    // the parent Skill, so they'd never otherwise appear here) - narrowed to
    // only the actually-chosen one below, once damageEffectItem is final.
    const cast = resolveCastContext(
      actor,
      skillItem,
      castAs,
      rankedDamageEffectCandidates.map((de) => de.id),
    );
    const { conditionalModifiers } = cast;

    const manaCostChoices = cast.payMana ? buildManaCostChoices(skillItem, actor) : [];
    // Woozy's "no DEX Mod" row is collected whatever the Stat, marked
    // `dexOnly`: the dialog's Stat (Off-Stat, p.58) decides whether it counts.
    const governingDex = skillSys.governingStat === "dex";
    const allRollerRows = decorateRows(
      [
        ...collectDebuffRows(sys, "attack", { usesDex: true }).map((r) =>
          r.kind === "noDex" ? { ...r, dexOnly: true, defaultOn: r.defaultOn && governingDex } : r,
        ),
        ...collectVehicleRows(actor, "attack", { skillItem, builtIn: !!castAs?.builtIn }),
      ],
      "roll",
    );

    // Area Attack (p.83) - pre-ticked in the dialog when the Skill/Spell (or
    // the Damage Effect passed in) reads as one (module/helpers/area.mjs).
    const detectedArea =
      isAreaItem(skillItem, rank) || isAreaItem(damageEffectItem, effectiveRank(damageEffectItem));

    // Still cooling down: warn and ask (helpers/cooldowns.mjs), before
    // anything is spent - the Skill before its dialog when that's shown
    // here, and the Damage Effect it ends up with once the choices are made.
    // The Attack! picker and a Swap and Attack ask before the weapon moves
    // and pass their answer in (cooldownAsked).
    const skillAskedFirst = !castAs && !promptArgsOnly && !presetOptions && !cooldownAsked;
    let cooldownEarly = !!cooldownAsked?.early;
    if (skillAskedFirst) {
      const pass = await passCooldown(skillItem);
      if (!pass.ok) return null;
      cooldownEarly = pass.early;
    }
    let options = {
      advantage: advantageEntitled ? "advantage" : "normal",
      difficulty: targetDifficulty,
      modifier: 0,
      checked: new Set(),
      manaCostChoice: 0,
      checkedDebuffs: null,
    };
    if (presetOptions) {
      options = presetOptions;
    } else if (!skipDialog || promptArgsOnly) {
      const promptArgs = {
        title: game.i18n.format("CARLRPG.Dialog.AttackTitle", { name: skillItem.name }),
        difficulty: targetDifficulty,
        difficultyLabel: targetRows.length
          ? game.i18n.localize("CARLRPG.Dialog.BaseDifficulty")
          : null,
        defaultAdvantage: advantageEntitled ? "advantage" : null,
        combat: true,
        conditionalModifiers,
        damageEffectChoices,
        manaCostChoices,
        debuffRows: [...allRollerRows, ...advantageRows, ...targetRows],
        areaTargets: targets.map((t) => ({ name: t.actor?.name ?? t.name ?? "?" })),
        isArea: detectedArea,
        // Off-Stat (p.58): rolled with another Stat than its own.
        statChoice: buildStatChoice(skillSys.governingStat ?? ""),
      };
      if (promptArgsOnly) return promptArgs;
      const prompted = await promptRollOptions(promptArgs);
      if (!prompted) return null;
      options = prompted;
    }
    if (options.damageEffectId) {
      damageEffectItem = actor.items.get(options.damageEffectId) ?? damageEffectItem;
    }
    const isArea = targets.length ? (skipDialog ? detectedArea : !!options.isArea) : false;
    const splash = options.splash ?? new Set();
    // The Stat picked in the dialog (Off-Stat), else the Skill's own; the
    // "no DEX Mod" row only with DEX.
    const statKey = chosenStat(options, skillSys.governingStat);
    const rollerRows = allRollerRows.filter((r) => !r.dexOnly || statKey === "dex");
    // The dialog's Difficulty field is the BASE value (still GM-editable,
    // e.g. to type in a printed Evade); the target's Debuff rows ticked in
    // the dialog adjust it from there.
    const rollerEffect = resolveRollerRows(
      [...rollerRows, ...advantageRows],
      options.checkedDebuffs,
    );
    const targetEffect = resolveDifficultyRows(
      options.difficulty ?? targetDifficulty,
      targetRows,
      options.checkedDebuffs,
    );
    const difficulty = targetEffect.difficulty;

    // Defensive re-check: the choices list above already keeps a Rank-0
    // Damage Effect out of the dropdown, but a non-dialog caller could still
    // pass one directly via the damageEffectItem option (skipDialog: true) -
    // Damage Effects are Passive Skills, unusable untrained.
    if (damageEffectItem) {
      const deRank = ownedRank(actor, damageEffectItem);
      if (isUntrained(deRank)) {
        ui.notifications.warn(
          game.i18n.format("CARLRPG.Warning.DamageEffectUntrained", {
            name: damageEffectItem.name,
          }),
        );
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
    const activeConditionalModifiers = narrowConditionalModifiers(
      conditionalModifiers,
      skillItem,
      damageEffectItem,
    );

    if (!castAs && !cooldownAsked) {
      const pass = await passCooldowns([skillAskedFirst ? null : skillItem, damageEffectItem]);
      if (!pass.ok) return null;
      cooldownEarly ||= pass.early;
    }

    const untrained = isUntrained(rank);
    const {
      roll: attackRoll,
      total: attackTotal,
      breakdown: attackBreakdown,
      naturalRoll,
      degree,
      dieFormula: primaryFormula,
    } = await rollD20Check({
      rollData,
      untrained,
      advantage: options.advantage,
      effect: rollerEffect,
      terms: skillTerms(sys, rank, untrained, statKey),
      modifier: options.modifier,
      conditionals: {
        modifiers: activeConditionalModifiers,
        checked: options.checked,
        types: SKILL_CONDITIONAL_TYPES,
      },
      difficulty,
    });
    // "A Nat 1 always misses" (p.92) - even with no Difficulty to roll against.
    const hit = difficulty === null ? degree !== "criticalFail" : isHitDegree(degree);

    // One row per target (module/helpers/attack-targets.mjs). An Area Attack
    // is one roll against the chosen foe (the first target) that lands on
    // everyone or no one (p.83); any other Attack is checked against each
    // target's own Evade. The dialog's Difficulty and Debuff ticks shape the
    // first target's row; the others use their own defaults.
    const floor = currentFloor();
    const shared = isArea ? { hit, amazing: degree === "amazingSuccess" } : null;

    // Per-target Advantage on a non-area Attack: each other target's own
    // Held/Take Down ("Attacks against a Held foe are made with Advantage")
    // with the roller's own Debuffs and the dialog's choice. When targets
    // disagree, one extra d20 is rolled and each row keeps the die its own
    // Advantage/Disadvantage allows; the rest of the total is shared.
    const ownEffect = resolveRollerRows(rollerRows, options.checkedDebuffs);
    const rowFormulas = targets.map((t, i) =>
      i === 0 || isArea || !t.actor
        ? primaryFormula
        : resolveD20Formula(untrained, options.advantage, {
            advantageCount:
              ownEffect.advantageCount + collectAdvantageAgainstRows(t.actor.system).length,
            disadvantageCount: ownEffect.disadvantageCount,
          }),
    );
    const { firstDie, secondDie, extraD20Rolls } = await rowD20s(
      attackRoll,
      naturalRoll,
      rowFormulas,
    );
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
        id,
        target: ref,
        difficulty: rowDifficulty,
        attackTotal: attackTotal - (naturalRoll ?? 0) + (rowNat ?? 0),
        naturalRoll: rowNat,
        zone: isArea && splash.has(i) ? "splash" : "full",
        shared,
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
    if (target?.actor)
      await removeConditionsById(target.actor, consumedConditionIds(targetEffect.applied));
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
      const deMarkable =
        CarlDice.isAdvancedByUse(damageEffectItem) && !damageEffectItem.system.marked;
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
    const chosenManaCost = cast.payMana
      ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor)
      : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);
    // Used: their cooldowns start (the Damage Effect's too, if it was used).
    if (!castAs) {
      await startCooldown(skillItem);
      await startCooldown(damageEffectItem);
    }

    const rolls = [attackRoll, ...extraD20Rolls];
    const rollMeta = [
      {
        label: skillItem.name,
        detail: target?.actor ? `vs. ${target.actor.name}` : "",
        breakdown: attackBreakdown,
      },
      ...extraD20Rolls.map(() => ({
        label: game.i18n.localize("CARLRPG.Targets.ExtraD20"),
        detail: game.i18n.localize("CARLRPG.Targets.ExtraD20Hint"),
      })),
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
    // The damage as rolled (before an Amazing Success's +Floor) and its
    // rows, for a revision of this card (module/chat/check-revision.mjs).
    let damageRaw = null;
    let damageRollMeta = [];
    let damageRollData = [];
    // A "total damage" multiplier (Choke Out x2) - already in damageByType;
    // it scales an Amazing Success's +Floor too (buildDamageRollParts).
    let damageFactor = 1;
    // Rolled for any targeted non-area Attack, even one that missed
    // everyone, so a Taunt redirect onto someone it does hit has damage to
    // apply (module/chat/taunt-card.mjs). The card hides the damage until
    // some row is a hit (module/chat/attack-targets-card.mjs).
    if (anyHit || (targetRowList.length && !isArea)) {
      const isAmazingSuccess = degree === "amazingSuccess";
      const damage = await CarlDice.rollAttackDamage(actor, skillItem, {
        damageEffectItem,
        isCrit: naturalRoll === 20,
        isAmazingSuccess,
        conditionalModifiers: activeConditionalModifiers,
        checked: options.checked,
        skillEntry: cast.scroll ? skillEntry : null,
      });
      rolls.push(...damage.rolls);
      rollMeta.push(...damage.rollMeta);
      damageByType = damage.damageByType;
      damageRaw = foundry.utils.deepClone(damage.damageByType);
      damageRollMeta = damage.rollMeta;
      damageRollData = damage.rolls.map((r) => r.toJSON());
      damageFactor = damage.totalFactor ?? 1;
      setRowDamageFactor(targetRowList, damageFactor);
      // "Success by 10 or more (Amazing Success): the crawler's Attack
      // deals extra damage equal to their current Floor Number" (Degrees
      // of Success table, p.79) - distinct from Critical Hit (which
      // doubles base dice instead), so no double-dip risk between the two.
      // Added as untyped ("") damage, same convention as Evade's own
      // Major-Fail +Floor bonus (module/chat/evade-link-card.mjs).
      // With targets, each row adds it for its own Amazing Success instead
      // (module/helpers/attack-targets.mjs's rowOutcome).
      if (isAmazingSuccess && !targetRowList.length) {
        damageByType[""] = (damageByType[""] ?? 0) + floor * damageFactor;
      }
      // Every Debuff it carries: the Skill's, its Damage Effect's, held or
      // worn gear's (modifiers.mjs attackTargetEffects). With targets, an
      // Amazing-Success-only one waits for each target's own Degree.
      targetEffects = attackTargetEffects(actor, skillItem, {
        damageEffectItem,
        isCrit: naturalRoll === 20,
        isAmazingSuccess: targetRowList.length ? null : isAmazingSuccess,
      });
    }

    const hasDamage = Object.values(damageByType).some((v) => v);
    const flags = {
      attackDice: {
        extraD20: extraD20Rolls.length,
        damageRaw,
        damageRollMeta,
        damageRolls: damageRollData,
        damageFactor,
      },
    };
    const footerParts = [];
    if (markChoicePending) {
      flags.markChoiceSkillUuid = markChoicePending.skillItem.uuid;
      flags.markChoiceDamageEffectUuid = markChoicePending.damageEffectItem.uuid;
      footerParts.push(
        await buildMarkChoiceFooter(
          markChoicePending.skillItem,
          markChoicePending.damageEffectItem,
        ),
      );
    }
    if (targetEffects.length) flags.targetEffects = targetEffects;
    if (hasDamage) {
      flags.damageByType = damageByType;
      // Whichever Skill/Spell was actually rolled governs the whole hit's
      // magic-ness (docs/known-gaps.md 1.4) - a damageEffectItem with a
      // different isMagicDamage is deliberately not tracked per-term.
      flags.damageIsMagic = skillItem.system.isMagicDamage;
    }
    // "Armor-Piercing damage (ignores DR)": from the Skill, its Damage Effect
    // or the weapon it's made with (modifiers.mjs attackIsArmorPiercing).
    // Kept even on a miss, so a revision that turns it into a hit has it.
    const armorPiercing = attackIsArmorPiercing(actor, skillItem, { damageEffectItem });
    if (armorPiercing) flags.armorPiercing = true;
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
      // A Spell can only be Shield Blocked from Rank 5 (helpers/shield-block.mjs).
      if (skillItem.type === "spell") flags.isSpell = true;
    }
    if (targetUuids.length || hasDamage || targetEffects.length) {
      footerParts.push(
        buildAttackTargetsFooter({
          damageByType,
          targetEffects,
          isArea,
          armorPiercing,
          noAmazing: targetRowList.length > 0 && !targetRowList.some((r) => r.amazing),
        }),
      );
    }
    // Taunt (Interrupt, p.81) - a third party may redirect a single-target
    // Attack onto themselves (module/chat/taunt-card.mjs). Not an Area
    // Attack, and only a Mob's: Taunt draws a Mob, not a crawler or Pet.
    if (targetUuids.length && !isArea && !rollsLikeCrawler(actor))
      footerParts.push(await buildTauntLinkFooter());
    const footer = footerParts.length ? footerParts.join("") : undefined;
    const body =
      (cooldownEarly ? earlyUseNote() : "") +
      offStatNote(statKey, skillSys.governingStat) +
      buildDebuffNote([...rollerEffect.applied, ...targetEffect.applied]);

    // AI Favor reroll and Intervene (module/chat/check-revision.mjs): enough
    // to re-resolve this Attack from a new d20 or total - CarlDice.reviseAttack.
    Object.assign(
      flags,
      aiRerollFlags(actor, {
        kind: "attack",
        formula: primaryFormula,
        natural: naturalRoll,
        total: attackTotal,
        difficulty,
        breakdown: attackBreakdown,
        body,
        chosenManaCost,
        detail: target?.actor ? `vs. ${target.actor.name}` : "",
        skillItemId: skillItem.id,
        damageEffectItemId: damageEffectItem?.id ?? null,
        checked: [...(options.checked ?? [])],
        rowFormulas: Object.fromEntries(targetRowList.map((row, i) => [row.id, rowFormulas[i]])),
        // A Scroll's Spell isn't owned - the reroll rebuilds it from this.
        castAs: castAs ? { spellData: castAs.spellData, rank: castAs.rank } : null,
      }),
    );

    const perRowDegrees = targetRowList.length > 1 && !isArea;
    const message = await createRollMessage({
      rolls,
      rollMeta,
      title: skillItem.name,
      // Several targets: each row was rolled against its own Difficulty and
      // shows its own Degree, so the header has none (an Area Attack's one
      // roll was against the first target's).
      subtitle: withManaCostSubtitle(
        perRowDegrees ? "" : checkSubtitle(degree, difficulty),
        chosenManaCost,
      ),
      img: skillItem.img,
      badge: perRowDegrees ? null : degreeBadge(degree),
      body,
      footer,
      flags,
      actor,
    });
    return message;
  }

  /**
   * An Attack's damage roll and on-hit effects - shared by rollAttack and
   * its revisions (reviseAttack), so both roll damage the same way.
   * Each damage row carries rowClass "carl-damage-roll" (hidden while no
   * target is hit - module/chat/attack-targets-card.mjs).
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{damageEffectItem?: Item|null, isCrit?: boolean, isAmazingSuccess?: boolean, conditionalModifiers?: object[], checked?: Set<string>, skillEntry?: object|null}} [options]
   *   skillEntry: use this instead of the actor's own (a Scroll's cast).
   * @returns {Promise<{rolls: Roll[], rollMeta: object[], damageByType: Record<string, number>, totalFactor: number, targetEffects: object[]}>}
   *   totalFactor: the untyped "total damage" multiplier already in damageByType (1 = none).
   */
  static async rollAttackDamage(
    actor,
    skillItem,
    {
      damageEffectItem = null,
      isCrit = false,
      isAmazingSuccess = false,
      conditionalModifiers = [],
      checked = new Set(),
      skillEntry: givenEntry = null,
    } = {},
  ) {
    const sys = actor.system;
    const skillEntry = givenEntry ?? sys.skills?.[slugifySkillName(skillItem.name)];
    const damageEffectEntry = damageEffectItem
      ? sys.skills?.[slugifySkillName(damageEffectItem.name)]
      : null;
    const built = buildDamageRollParts({
      skillItem,
      skillEntry,
      damageEffectItem,
      damageEffectEntry,
      isCrit,
      rollData: actor.getRollData(),
      conditionalModifiers,
      checked,
    });
    const evaluated = await evaluateDamageGroups(built);
    return {
      rolls: evaluated.rolls,
      rollMeta: evaluated.rollMeta.map((meta) => ({ ...meta, rowClass: "carl-damage-roll" })),
      damageByType: evaluated.damageByType,
      totalFactor: evaluated.totalFactor,
      targetEffects: attackTargetEffects(actor, skillItem, {
        damageEffectItem,
        isCrit,
        isAmazingSuccess,
      }),
    };
  }

  /**
   * Re-resolve an Attack card, in place (module/chat/check-revision.mjs):
   * from a new d20 (an AI Favor reroll) and/or with Intervene d6s added to
   * its total. The rest of the total, each target's Difficulty and zone,
   * and the dialog's choices come from the card. Hit/miss, Amazing Success
   * and so the on-hit effects follow the new total.
   *  - A reroll rolls the damage afresh (a new d20 can make or unmake a
   *    Critical Hit; damage is rolled after the d20 at the table too).
   *  - An Intervene never re-rolls dice already shown: the damage stays, and
   *    is rolled only if none was (an Area Attack or one at no one that
   *    missed, now hitting).
   * Nothing the original spent (Mana, the use-mark, consumed Debuffs, the
   * Nat-20 Advantage) is spent again.
   * @param {ChatMessage} message  The Attack card.
   * @param {{interventions: object[], reroll?: {natural: number, total: number, roll: object}|null}} change
   * @returns {Promise<object|null>}  The card's new parts (check-revision.mjs
   *   writes them), or null if its Skill is gone.
   */
  static async reviseAttack(message, { interventions = [], reroll = null }) {
    const flags = message.flags["carl-rpg"] ?? {};
    const spec = foundry.utils.deepClone(flags.aiReroll);
    const actor = spec ? await fromUuid(spec.actorUuid) : null;
    // A Scroll's cast: its Spell was never owned, so rebuild it - before any
    // owned-item lookup, which could hit an unrelated owned copy.
    const scroll =
      actor && spec.castAs?.spellData
        ? buildScrollCast(actor, spec.castAs.spellData, spec.castAs.rank)
        : null;
    const skillItem = scroll ? scroll.item : actor?.items.get(spec.skillItemId);
    if (!skillItem) return null;
    const damageEffectItem =
      !scroll && spec.damageEffectItemId
        ? (actor.items.get(spec.damageEffectItemId) ?? null)
        : null;

    const dice = flags.attackDice ?? { extraD20: 0, damageRaw: null, damageRollMeta: [] };
    const oldRows = activeRows(flags.targetRows);
    const rowFormulas = spec.rowFormulas ?? {};
    const isArea = !!flags.isArea;
    const priorD6 = (flags.interventions ?? []).length;
    // The card's rolls: the d20, its Intervene d6s, any second d20, the damage.
    const oldRolls = message.rolls ?? [];
    let attackRoll = oldRolls[0];
    let extraD20Rolls = oldRolls.slice(1 + priorD6, 1 + priorD6 + dice.extraD20);
    // The damage rolled so far (kept even while the Attack misses, so a
    // later hit shows the same dice).
    let damageRolls = (dice.damageRolls ?? []).map((data) => Roll.fromData(data));
    let rowNaturals = oldRows.map((row) => row.natural ?? spec.natural);

    if (reroll) {
      attackRoll = Roll.fromData(reroll.roll);
      spec.rerolledFrom = { natural: spec.natural, total: spec.total };
      Object.assign(spec, { natural: reroll.natural, total: reroll.total, used: true });
      // Each row's kept d20 from the new dice (a second d20 if a row needs one).
      const dice20 = await rowD20s(
        attackRoll,
        spec.natural,
        oldRows.map((row) => rowFormulas[row.id] ?? spec.formula),
      );
      const { firstDie, secondDie } = dice20;
      extraD20Rolls = dice20.extraD20Rolls;
      rowNaturals = oldRows.map((row, i) => {
        const formula = rowFormulas[row.id] ?? spec.formula;
        return i === 0 || isArea || formula === spec.formula
          ? spec.natural
          : keptD20(formula, firstDie, secondDie);
      });
      damageRolls = [];
    }

    const naturalRoll = spec.natural;
    const bonus = interventionTotal(interventions);
    const attackTotal = spec.total + bonus;
    const difficulty = spec.difficulty;
    const degree = getDegreeOfSuccess(naturalRoll, attackTotal, difficulty);
    const hit = difficulty === null ? degree !== "criticalFail" : isHitDegree(degree);
    const shared = isArea ? { hit, amazing: degree === "amazingSuccess" } : null;
    const targetRowList = oldRows.map((row, i) =>
      crawlerAttackRow({
        id: row.id,
        target: {
          uuid: row.uuid,
          actor: {
            name: row.name,
            type: row.isVehicle ? "vehicle" : row.isCharacter ? "character" : "mob",
          },
        },
        difficulty: row.difficulty,
        attackTotal: attackTotal - (naturalRoll ?? 0) + (rowNaturals[i] ?? 0),
        naturalRoll: rowNaturals[i],
        zone: row.zone,
        shared,
        // The vehicle the target was riding when first rolled (a Near Miss
        // still hits it).
        vehicle: row.vehicleUuid ? { uuid: row.vehicleUuid, name: row.vehicleName } : null,
      }),
    );
    const anyHit = targetRowList.length ? targetRowList.some((row) => row.hit) : hit;
    const isAmazingSuccess = degree === "amazingSuccess";

    let damageRaw = reroll ? null : dice.damageRaw;
    let damageRollMeta = reroll ? [] : (dice.damageRollMeta ?? []);
    let damageFactor = reroll ? 1 : (dice.damageFactor ?? 1);
    let targetEffects = [];
    // As at the roll: damage for any targeted single-target Attack, else
    // only on a hit.
    const needsDamage = anyHit || (targetRowList.length && !isArea);
    if (needsDamage) {
      if (!damageRaw) {
        const cast = resolveCastContext(
          actor,
          skillItem,
          scroll?.castAs ?? null,
          damageEffectItem ? [damageEffectItem.id] : [],
        );
        const conditionalModifiers = narrowConditionalModifiers(
          cast.conditionalModifiers,
          skillItem,
          damageEffectItem,
        );
        const damage = await CarlDice.rollAttackDamage(actor, skillItem, {
          damageEffectItem,
          isCrit: naturalRoll === 20,
          isAmazingSuccess,
          conditionalModifiers,
          checked: new Set(spec.checked ?? []),
          skillEntry: scroll?.castAs.skillEntry ?? null,
        });
        damageRolls = damage.rolls;
        damageRollMeta = damage.rollMeta;
        damageRaw = foundry.utils.deepClone(damage.damageByType);
        damageFactor = damage.totalFactor ?? 1;
      }
      setRowDamageFactor(targetRowList, damageFactor);
      // The on-hit effects follow the Degree (some only on an Amazing Success).
      targetEffects = attackTargetEffects(actor, skillItem, {
        damageEffectItem,
        isCrit: naturalRoll === 20,
        isAmazingSuccess: targetRowList.length ? null : isAmazingSuccess,
      });
    }
    const damageByType = needsDamage ? foundry.utils.deepClone(damageRaw ?? {}) : {};
    // Amazing Success's +Floor: per row with targets (rowOutcome), else here.
    if (needsDamage && damageRaw && isAmazingSuccess && !targetRowList.length) {
      damageByType[""] = (damageByType[""] ?? 0) + (flags.floor ?? currentFloor()) * damageFactor;
    }
    const hasDamage = Object.values(damageByType).some((v) => v);

    const d6 = interventionRolls(interventions);
    const shownDamage = needsDamage ? damageRolls : [];
    const rolls = [attackRoll, ...d6.rolls, ...extraD20Rolls, ...shownDamage];
    const rollMeta = [
      {
        label: skillItem.name,
        detail: spec.used ? game.i18n.localize("CARLRPG.Reroll.Detail") : (spec.detail ?? ""),
        breakdown: spec.breakdown,
      },
      ...d6.meta,
      ...extraD20Rolls.map(() => ({
        label: game.i18n.localize("CARLRPG.Targets.ExtraD20"),
        detail: game.i18n.localize("CARLRPG.Targets.ExtraD20Hint"),
      })),
      ...(needsDamage ? damageRollMeta : []),
    ];

    const newFlags = {
      aiReroll: spec,
      interventions,
      attackDice: {
        extraD20: extraD20Rolls.length,
        damageRaw,
        damageRollMeta,
        damageRolls: damageRolls.map((r) => r.toJSON()),
        damageFactor,
      },
    };
    const unset = [];
    const footerParts = [];
    // A Skill-or-Damage-Effect mark choice still open stays on the card.
    if (flags.markChoiceSkillUuid && !flags.markChoiceDone) {
      const skillChoice = await fromUuid(flags.markChoiceSkillUuid);
      const effectChoice = await fromUuid(flags.markChoiceDamageEffectUuid);
      if (skillChoice && effectChoice)
        footerParts.push(await buildMarkChoiceFooter(skillChoice, effectChoice));
    }
    if (targetEffects.length) newFlags.targetEffects = targetEffects;
    else unset.push("targetEffects");
    if (hasDamage) {
      newFlags.damageByType = damageByType;
      newFlags.damageIsMagic = skillItem.system.isMagicDamage;
    } else {
      unset.push("damageByType");
    }
    if (targetRowList.length) {
      Object.assign(newFlags, {
        targetRows: Object.fromEntries(targetRowList.map((row) => [row.id, row])),
        attackTotal,
        naturalRoll,
      });
    }
    if (targetRowList.length || hasDamage || targetEffects.length) {
      footerParts.push(
        buildAttackTargetsFooter({
          damageByType,
          targetEffects,
          isArea,
          armorPiercing: !!flags.armorPiercing,
          noAmazing: targetRowList.length > 0 && !targetRowList.some((r) => r.amazing),
        }),
      );
    }
    if (targetRowList.length && !isArea && !rollsLikeCrawler(flags.attackerType))
      footerParts.push(await buildTauntLinkFooter());

    const perRowDegrees = targetRowList.length > 1 && !isArea;
    return {
      rolls,
      rollMeta,
      extraRollRows: d6.totalRow(attackTotal),
      title: skillItem.name,
      subtitle: withManaCostSubtitle(
        perRowDegrees ? "" : checkSubtitle(degree, difficulty),
        spec.chosenManaCost,
      ),
      img: skillItem.img,
      badge: perRowDegrees ? null : degreeBadge(degree),
      body: `${spec.body ?? ""}${spec.used ? rerollNote() : ""}`,
      footer: footerParts.length ? footerParts.join("") : undefined,
      flags: newFlags,
      unset,
    };
  }

  /**
   * A Mob's Attack (a `mobAttack` item - module/data/mob-attack.mjs) against
   * the targeted crawler(s). "Mobs are player-facing; they never roll"
   * (p.267): the "to hit" value IS the Difficulty of the target's Evade
   * Check, and the GM rolls only the damage (Step 3: Mob Action Resolution,
   * p.82). The Difficulty is adjusted by the attacking Mob's own Debuffs and
   * by a Held/Taken-Down defender (p.60/p.96 - module/helpers/
   * debuff-effects.mjs), and a net-Disadvantaged Attack gives the target a
   * free Evade Check (the `freeEvade` flag - module/chat/
   * evade-link-card.mjs). The card carries the same flag shape rollAttack
   * does, so Roll Evade / Taunt / Apply Damage work on it unchanged.
   * @param {Actor} actor  The attacking Mob (or a GM-crewed Vehicle).
   * @param {string|number} ref  The Attack item's id - or (tests, macros) its
   *   place in the Mob's Attacks; a Vehicle's weapon by its place in its
   *   list (module/helpers/mob-attacks.mjs mobAttackFor).
   * @param {{skipDialog?: boolean}} [options]
   * @returns {Promise<ChatMessage|null>}
   */
  static async rollMobAttack(actor, ref, options = {}) {
    const attack = mobAttackFor(actor, ref);
    const name = attack?.name || game.i18n.localize("CARLRPG.MobAttack.Unnamed");
    // Checked once its targets are known: a preview at no one is free.
    return takeAction(
      actor,
      "attack",
      game.i18n.format("CARLRPG.Actions.Label.Attack", { name }),
      (ctx) => CarlDice._mobAttack(ctx, actor, attack, options),
      { optional: true },
    );
  }

  /** rollMobAttack, inside its Action (helpers/actions.mjs takeAction). */
  static async _mobAttack(ctx, actor, attack, { skipDialog = false } = {}) {
    if (!attack) return null;
    if (isBlockedByDebuff(actor)) return null;

    const targets = Array.from(game.user.targets ?? []);
    const target = targets[0] ?? null;
    const targetUuids = targets.map((t) => t.document?.uuid).filter(Boolean);
    const floor = currentFloor();
    const baseToHit = evaluateMobConstant(attack.toHit, floor);
    const attackName = attack.name || game.i18n.localize("CARLRPG.MobAttack.Unnamed");

    // In a phased fight's Declaration the Attack is declared against its
    // targets (below) - with none there's nothing to declare.
    const phasedCombat = phasedCombatFor(actor);
    const declaring = currentPhase(phasedCombat) === "declare" ? phasedCombat : null;
    if (declaring && !targetUuids.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Declare.NoTargets"));
      return null;
    }
    // An Attack against someone is one of the Mob's Actions (helpers/
    // actions.mjs) - not its Move-only one. A preview with no target is free.
    if (!settleAction(ctx, targetUuids.length > 0)) return null;

    // The stat block doesn't say whether a to-hit includes the DEX Mod, so
    // Woozy is offered but left unticked here.
    const ownRows = [
      ...collectDebuffRows(actor.system, "attack", {
        usesDex: true,
        ownerName: actor.name,
        idPrefix: "self",
      }).map((r) => (r.kind === "noDex" ? { ...r, defaultOn: false } : r)),
      // A Mob driving a vehicle: the driver's Disadvantage (p.72).
      ...collectVehicleRows(actor, "attack"),
    ];
    // Against a vehicle: the "head-on" row that raises the to-hit (it's
    // compared with the vehicle's Difficulty - module/helpers/attack-targets.mjs).
    const defenderRows = target?.actor
      ? [
          ...collectAdvantageAgainstRows(target.actor.system, {
            ownerName: target.actor.name,
            idPrefix: "target",
          }),
          ...mobVsVehicleRows(target.actor),
        ]
      : [];
    const debuffRows = decorateRows([...ownRows, ...defenderRows], "difficulty");

    // Area Attack (p.83): marked on the Attack; the dialog can still change it.
    const detectedArea = attack.isArea;
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
    const ownApplied = resolveDifficultyRows(mobBase, ownRows, options.checkedDebuffs).applied.map(
      (r) => ({ ...r, defaultOn: true }),
    );
    const targetRowList = targets.map(
      (t, i) =>
        mobAttackRow({
          id: `t${i}`,
          target: { uuid: t.document?.uuid ?? t.actor?.uuid, actor: t.actor },
          base: mobBase,
          ownRows: i === 0 ? ownRows : ownApplied,
          checked: i === 0 ? options.checkedDebuffs : null,
          zone: isArea && splash.has(i) ? "splash" : "full",
        }).row,
    );
    const freeEvade = !!targetRowList[0]?.freeEvade;

    // A phased fight's Mob Action Declaration (p.81): the Attack is recorded
    // for the Reaction card, not rolled - no card, no damage yet
    // (module/helpers/declarations.mjs). Any other step resolves it at once.
    if (declaring) {
      if (!game.user.isGM) {
        ui.notifications.warn(game.i18n.localize("CARLRPG.Declare.GMOnly"));
        return null;
      }
      const token = resolveActorToken(actor);
      // The Mob's one-shot Debuffs are spent on the Attack it declares, and
      // kept with it so withdrawing the declaration gives them back.
      const spentIds = new Set(endedConditionIds(actor.system, resolved.applied));
      const spentConditions = (actor.system.toObject().conditions ?? []).filter((c) =>
        spentIds.has(c.id),
      );
      // The Action it spends goes with it: withdrawing the declaration refunds
      // it. (If the spend is refused - another declaration took the last
      // Action meanwhile - takeAction takes the declaration back.)
      const fight = ctx.tracked ? combatantInFight(actor) : null;
      const declaration = await recordDeclaration(declaring, {
        mobUuid: token?.uuid ?? actor.uuid,
        tokenId: token?.id ?? null,
        sceneId: token?.parent?.id ?? null,
        mobName: token?.name ?? actor.name,
        mobImg: actor.img,
        attackId: attack.id,
        attackName,
        damage: attack.damage?.trim() ?? "",
        damageType: attack.damageType || "",
        damageIsMagic: !!attack.damageType && !PHYSICAL_DAMAGE_TYPES.has(attack.damageType),
        armorPiercing: !!attack.armorPiercing,
        isArea,
        floor,
        difficulty,
        mobBase,
        mobOwnRows: ownApplied,
        targetRows: Object.fromEntries(targetRowList.map((row) => [row.id, row])),
        effect: attack.effect ?? "",
        range: attack.range ?? "",
        // The Debuffs it gives, each with when it lands (docs/mob-sheet.md).
        targetEffects: attack.targetEffects,
        spentConditions,
        action: fight ? { combatantId: fight.combatant.id, id: ctx.id } : null,
      });
      await removeConditionsById(actor, [...spentIds]);
      // Noted last, so it's undone first: withdrawing gives the Debuffs back
      // (their own record then finds them there already).
      noteUndo(actor, { t: "declaration", combatId: declaring.id, id: declaration.id });
      ui.notifications.info(
        game.i18n.format("CARLRPG.Declare.Recorded", {
          mob: declaration.mobName,
          summary: describeDeclaration(declaration),
        }),
      );
      ctx.use();
      return null;
    }

    // Damage: the printed formula, "+F" resolved to the current Floor.
    const rolls = [];
    const rollMeta = [];
    const damageByType = {};
    const damageType = attack.damageType || "";
    if (attack.damage?.trim()) {
      const evaluated = await rollMobDamage(actor.getRollData(), attack.damage, attackName);
      if (!evaluated) return null;
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
    if (targetUuids.length)
      await removeConditionsById(actor, endedConditionIds(actor.system, resolved.applied));

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
    // "..., Armor-Piercing" on the stat block (module/data/mob-attack.mjs).
    if (attack.armorPiercing) flags.armorPiercing = true;
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
    // Its Debuffs, each landed by its trigger when a row is applied
    // (attack-targets-card.mjs landDebuffs; docs/mob-sheet.md).
    const targetEffects = attack.targetEffects ?? [];
    if (targetEffects.length) flags.targetEffects = targetEffects;
    if (targetUuids.length || hasDamage || targetEffects.length) {
      footerParts.push(
        buildAttackTargetsFooter({
          damageByType,
          isArea,
          targetEffects,
          armorPiercing: !!attack.armorPiercing,
        }),
      );
    }
    if (targetUuids.length && !isArea) footerParts.push(await buildTauntLinkFooter());

    const esc = foundry.utils.escapeHTML;
    let body = "";
    if (attack.effect)
      body += `<p class="carl-mob-attack-effect"><em>${esc(attack.effect)}</em></p>`;
    if (attack.range)
      body += `<p class="carl-mob-attack-range">${esc(game.i18n.localize("CARLRPG.Attack.Range"))}: ${esc(attack.range)}</p>`;
    body += buildDebuffNote(resolved.applied);
    if (targetRowList.some((r) => r.freeEvade))
      body += `<p class="carl-free-evade-note"><i class="fas fa-person-running"></i> ${game.i18n.localize("CARLRPG.MobAttack.FreeEvadeNote")}</p>`;

    const subtitle =
      difficulty === null
        ? game.i18n.localize("CARLRPG.MobAttack.NoToHit")
        : game.i18n.format("CARLRPG.MobAttack.Subtitle", { difficulty });

    const message = await createRollMessage({
      rolls,
      rollMeta,
      title: attackName,
      subtitle,
      img: actor.img,
      body,
      footer: footerParts.length ? footerParts.join("") : undefined,
      flags,
      actor,
    });
    return message;
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
    // Same untrained gate rollAttack applies defensively when a
    // damageEffectItem is passed in directly - checked here too so a
    // DE-initiated roll fails fast with a clear reason instead of silently
    // rolling the parent Skill/Spell alone (rollAttack's own fallback,
    // appropriate for the Skill-initiated dropdown, would be confusing here
    // since the whole point of this button IS the Damage Effect).
    const deRank = ownedRank(actor, damageEffectItem);
    if (isUntrained(deRank)) {
      ui.notifications.warn(
        game.i18n.format("CARLRPG.Warning.DamageEffectUntrained", { name: damageEffectItem.name }),
      );
      return null;
    }

    const candidates = actor.items.filter(
      (i) => (i.type === "skill" || i.type === "spell") && damageEffectFits(damageEffectItem, i),
    );
    if (!candidates.length) {
      ui.notifications.warn(
        game.i18n.format("CARLRPG.Warning.DamageEffectNoParentSkill", {
          name: damageEffectItem.name,
        }),
      );
      return null;
    }
    // Unarmed Combat "Cannot choose a Damage Effect" (p.179).
    const allowed = candidates.filter((c) => takesDamageEffects(c));
    if (!allowed.length) {
      ui.notifications.warn(
        game.i18n.format("CARLRPG.Warning.NoDamageEffects", {
          skill: candidates[0].name,
          name: damageEffectItem.name,
        }),
      );
      return null;
    }

    // A Spell parent is a Spell cast: in a fight, only from the Hotlist
    // (p.86) - one that isn't there isn't offered.
    const usable = allowed.filter((c) => !outsideHotlist(actor, c));
    if (!usable.length) {
      refuseOutsideHotlist(actor, allowed[0]);
      return null;
    }

    let skillItem = usable[0];
    if (usable.length > 1) {
      const chosenId = await promptParentSkillChoice(damageEffectItem, usable);
      if (!chosenId) return null;
      skillItem = usable.find((c) => c.id === chosenId) ?? skillItem;
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
   * This rolls the currently-unlocked tier's `healDice` - or heals to full
   * with no dice: at a `healToFull` tier (with a Short Rest's benefits, Heal
   * Self Rank 15), or when the item itself heals to full (Heal Critter, the
   * Health Bar only) - and posts an "Apply Healing" chat-card button
   * (module/chat/heal-card.mjs). The roll itself never touches `hb.value`;
   * only clicking that button does, mirroring rollAttack's
   * roll-now/apply-on-click shape for target effects above.
   *
   * Upgrade-tier gating uses the item's live Rank (effectiveRank - its own
   * plus worn gear's and Buffs' "+N"), matching
   * `collectItemTargetEffects`'s convention (module/helpers/modifiers.mjs);
   * a Scroll's Spell keeps the scroll's Rank.
   *
   * Who it heals is decided now, before anything is spent (module/helpers/
   * heal-targets.mjs): the targeted token(s) its "Heals" allows, or the
   * caster with none targeted - refused with a warning otherwise. The card
   * names them and snapshots each (`healRecipients`).
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{castAs?: object|null, within?: object|null, skipDialog?: boolean}} [options]
   *   skipDialog: with one other creature targeted by a heal that could
   *   take the caster too, heal it without asking.
   */
  static async rollHeal(actor, skillItem, options = {}) {
    // In a fight this is the Heal Action (an Interrupt, p.82) - refused with
    // none left - or part of the Action it's cast in (a Scroll's use).
    return takeAction(
      actor,
      "other",
      game.i18n.format("CARLRPG.Actions.Label.Cast", { name: skillItem.name }),
      () => CarlDice._heal(actor, skillItem, options),
      { within: options.within },
    );
  }

  /** rollHeal, inside its Action (helpers/actions.mjs takeAction). */
  static async _heal(actor, skillItem, { castAs = null, skipDialog = false } = {}) {
    // castAs: a Scroll's cast (module/helpers/scroll-cast.mjs) - its Rank is
    // the scroll's (already on the item), no Mana, no use-mark.
    const skillSys = skillItem.system;
    const rank = effectiveRank(skillItem);
    if (isBlockedUntrainedSpell(skillItem, rank)) return null;
    if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;

    // Who it heals - refused before any Mana, use-mark or Action is spent.
    const resolved = resolveHealRecipients(actor, skillItem, userHealTargets());
    if (resolved.refusal) {
      ui.notifications.warn(resolved.refusal);
      return null;
    }
    let recipients = resolved.recipients;
    // Foundry keeps the last Attack's target: a heal that could take the
    // caster asks before going to someone else, as a potion does.
    const other = recipients.length === 1 && recipients[0].actor !== actor ? recipients[0] : null;
    if (other && !skipDialog && healsMode(skillItem) === "anyone") {
      const chosen = await chooseHealRecipient(skillItem, actor, other);
      if (!chosen) return null;
      recipients = [chosen];
    }
    // Still cooling down: warn and ask (helpers/cooldowns.mjs), before
    // anything is spent. A Scroll's Spell isn't the crawler's own.
    const cooldown = castAs ? { ok: true, early: false } : await passCooldown(skillItem);
    if (!cooldown.ok) return null;
    const body = cooldown.early ? earlyUseNote() : "";

    const unlocked = tiersHighestFirst(skillItem, rank);
    const fullTier = unlocked.find((u) => u.healToFull);
    const diceTier = unlocked.find((u) => u.healDice);
    const canMend = unlocked.some((u) => u.healMend);
    const formula = diceTier?.healDice || skillSys.healDice || "1d4";
    // A tier's "heal to full" also grants a Short Rest's benefits (Heal Self
    // Rank 15); the item's own is the Health Bar only (Heal Critter).
    const full = !!fullTier || !!skillSys.healToFull;
    const rest = !!fullTier;

    const cast = resolveCastContext(actor, skillItem, castAs);
    await removeConditionsById(actor, endedConditionIds(actor.system, []));
    if (cast.markUse) await CarlDice.markForAdvancement(skillItem);

    // Casting always spends Mana, whether or not the tier rolls dice
    // (docs/known-gaps.md 1.6) - no picker here: no heal spell currently has
    // manaCostVariants. A Scroll pays none.
    const chosenManaCost = cast.payMana
      ? { manaCost: effectiveManaCost(skillItem, actor, skillSys.manaCost), isBase: true }
      : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);
    if (!castAs) await startCooldown(skillItem);

    // healActorUuid: the caster. Each recipient a row (heal-card.mjs).
    const flags = {
      healActorUuid: actor.uuid,
      healRecipients: Object.fromEntries(
        recipients.map((r, i) => [`r${i}`, { uuid: r.uuid, name: r.name, applied: false }]),
      ),
    };
    const names = recipients.map((r) => r.name);

    if (full) {
      flags.healFull = true;
      flags.healRest = rest;
      const label = withManaCostSubtitle(
        game.i18n.localize("CARLRPG.Heal.SubtitleFull"),
        chosenManaCost,
      );
      const message = await createCardMessage({
        title: skillItem.name,
        img: skillItem.img,
        subtitle: label,
        badge: { label: game.i18n.localize("CARLRPG.Heal.SubtitleFull"), type: "hit" },
        body,
        footer: await buildHealFooter({ full: true, rest, canMend, names }),
        flags,
        actor,
      });
      return message;
    }

    const rollData = actor.getRollData();
    const parts = new RollParts(rollData);
    parts.add(formula, game.i18n.localize("CARLRPG.Roll.Heal"));
    const { roll, total, breakdown } = await parts.evaluate();

    flags.healAmount = total;

    const message = await createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(
        game.i18n.format("CARLRPG.Heal.Subtitle", { amount: total }),
        chosenManaCost,
      ),
      img: skillItem.img,
      badge: { label: `+${total}`, type: "hit" },
      body,
      footer: await buildHealFooter({ amount: total, canMend, names }),
      flags,
      actor,
    });
    return message;
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
    // Casting it is the Cast a Spell Action; switching it off is free.
    if (skillItem.system.active) return CarlDice._toggleSpell(actor, skillItem);
    return takeAction(
      actor,
      "other",
      game.i18n.format("CARLRPG.Actions.Label.Cast", { name: skillItem.name }),
      () => CarlDice._toggleSpell(actor, skillItem),
    );
  }

  /** rollToggleSpell, inside its Action when switching on (helpers/actions.mjs takeAction). */
  static async _toggleSpell(actor, skillItem) {
    const skillSys = skillItem.system;
    const turningOn = !skillSys.active;
    let manaCostSpent = null;
    let cooldown = { ok: true, early: false };

    if (turningOn) {
      if (isBlockedByDebuff(actor, { isSpell: skillItem.type === "spell" })) return null;
      if (isBlockedUntrainedSpell(skillItem, effectiveRank(skillItem))) return null;
      // Still cooling down: warn and ask (helpers/cooldowns.mjs), before
      // anything is spent.
      cooldown = await passCooldown(skillItem);
      if (!cooldown.ok) return null;
      // Undone: off again (its timer gone), and the Shield back where it was.
      noteUndo(actor, {
        t: "set",
        uuid: skillItem.uuid,
        data: { "system.active": false, [SPELL_TIMER_PATH]: null },
      });
      if (skillSys.shieldSlots)
        noteUndo(actor, {
          t: "set",
          uuid: actor.uuid,
          data: { "system.shield.value": actor.system.shield?.value ?? 0 },
        });
      manaCostSpent = effectiveManaCost(skillItem, actor, skillSys.manaCost);
      await applyManaCost(actor, manaCostSpent);
      await removeConditionsById(actor, endedConditionIds(actor.system, []));
    }

    // Its duration, worked out now (helpers/spell-timers.mjs): the active
    // GM switches it off when that's up. Off by hand clears it.
    await skillItem.update({
      "system.active": turningOn,
      [SPELL_TIMER_PATH]: turningOn ? spellTimerFor(actor, skillItem) : null,
    });
    if (turningOn) await startCooldown(skillItem);

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
      ? withManaCostSubtitle(game.i18n.localize("CARLRPG.Toggle.Activated"), {
          manaCost: manaCostSpent,
          isBase: true,
        })
      : game.i18n.localize("CARLRPG.Toggle.Deactivated");

    const message = await createCardMessage({
      title: skillItem.name,
      img: skillItem.img,
      subtitle: toggleSubtitle,
      body: turningOn
        ? (cooldown.early ? earlyUseNote() : "") + (skillItem.system.description ?? "")
        : "",
      actor,
    });
    return message;
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
  static async rollEvadeCheck(actor, options = {}) {
    const { post = true, isAction = true, preset = null } = options;
    // Only the sheet's own Evade can be the Evade Action (one covers every
    // Attack this round, p.81); a card's Evade pays for itself.
    if (!post || !isAction || preset) return CarlDice._evadeCheck(passiveContext(), actor, options);
    return takeAction(
      actor,
      "other",
      game.i18n.localize("CARLRPG.Roll.Evade"),
      (ctx) => CarlDice._evadeCheck(ctx, actor, options),
      { tag: "evade", optional: true },
    );
  }

  /** rollEvadeCheck, inside its Action (helpers/actions.mjs takeAction). */
  static async _evadeCheck(
    ctx,
    actor,
    { difficulty = null, skipDialog = false, post = true, isAction = true, preset = null } = {},
  ) {
    const sys = actor.system;
    if (isBlockedByDebuff(actor)) return null;
    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, "evade");
    const debuffRows = decorateRows(
      [
        ...collectDebuffRows(sys, "evade", { ownAction: isAction }),
        ...collectVehicleRows(actor, "evade"),
      ],
      "roll",
    );

    let options = {
      advantage: "normal",
      difficulty,
      modifier: 0,
      checked: new Set(),
      checkedDebuffs: null,
    };
    if (preset) {
      // The choices of an earlier dialog (one Evade Action rolled against
      // several Attacks - module/chat/reaction-card.mjs), or a fixed
      // Advantage for an automatic free Evade; this Check's own Difficulty.
      options = { ...options, ...preset, difficulty };
    } else if (!skipDialog) {
      const difficultyPresets = difficulty === null ? [] : givenPresets(difficulty);
      const prompted = await promptRollOptions({
        title: game.i18n.localize("CARLRPG.Dialog.EvadeTitle"),
        combat: true,
        difficulty,
        difficultyPresets,
        conditionalModifiers,
        debuffRows,
        // Unticked once they have Evaded this round: one Evade Action covers
        // every Attack (p.81). Hidden for an uncommanded Pet, whose Evade is free.
        usesAction: evadesWithoutAction(actor) ? null : actionBox(ctx, !evadeIsFree(actor)),
      });
      if (!prompted) return null;
      options = prompted;
    }
    // The sheet's Evade button in a fight: the Evade Action, unless unticked.
    const usesAction =
      ctx.tracked &&
      !evadesWithoutAction(actor) &&
      (skipDialog ? !evadeIsFree(actor) : !!options.usesAction);
    if (!settleAction(ctx, usesAction)) return null;

    const debuffEffect = resolveRollerRows(debuffRows, options.checkedDebuffs);
    const evadeLabel = game.i18n.localize("CARLRPG.Roll.EvadeBonus");
    const { roll, total, breakdown, naturalRoll, degree, formula } = await rollD20Check({
      rollData,
      advantage: options.advantage,
      effect: debuffEffect,
      terms: [
        [sys.stats?.dex?.mod ?? 0, game.i18n.localize(CARLRPG.statAbbreviations.dex)],
        [sys.bonuses?.evadeBonus ?? 0, evadeLabel],
        // Dice "added to Evade Checks" (Elf (High)'s 1d4) - modifiers.mjs.
        ...(sys.evadeDice ?? []).map(({ formula: dice, label }) => [dice, label || evadeLabel]),
      ],
      modifier: options.modifier,
      conditionals: {
        modifiers: conditionalModifiers,
        checked: options.checked,
        types: ["stat", "rollMode", "custom"],
      },
      difficulty: options.difficulty,
    });
    const debuffNote = buildDebuffNote(debuffEffect.applied);

    await removeConditionsById(actor, endedConditionIds(sys, debuffEffect.applied, { isAction }));

    if (!post)
      return {
        roll,
        total,
        breakdown,
        naturalRoll,
        degree,
        debuffNote,
        formula,
        difficulty: options.difficulty,
        options,
      };

    const body = debuffNote + evadeFailNote(degree);

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: game.i18n.localize("CARLRPG.Roll.Evade"), breakdown }],
      title: game.i18n.localize("CARLRPG.Roll.Evade"),
      subtitle: checkSubtitle(degree, options.difficulty),
      img: actor.img,
      badge: degreeBadge(degree),
      body,
      actor,
      flags: {
        evadeDegree: degree,
        evadeTotal: total,
        ...aiRerollFlags(actor, {
          kind: "check",
          variant: "evade",
          formula,
          natural: naturalRoll,
          total,
          difficulty: options.difficulty,
          title: game.i18n.localize("CARLRPG.Roll.Evade"),
          img: actor.img,
          label: game.i18n.localize("CARLRPG.Roll.Evade"),
          breakdown,
          body: debuffNote,
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
   * @param {{difficulty?: number|null, opponent?: Actor|null, skipDialog?: boolean, post?: boolean, markUse?: boolean, isAction?: boolean}} [options]
   *   isAction (default true): whether the Check is an Action of its own
   *   (Taunt, Shield Block, Command Pet). One that isn't - a Party Skill
   *   Check, a Driving Check, a ram - neither takes Queasy's Disadvantage nor
   *   ends Queasy/Staggered (checkActionRows; ruled 2026-11-19).
   *   opponent: the creature whose static number `difficulty` is. When it's
   *   a Mob (not a crawler or Pet, who roll their own side - actor-kinds.mjs
   *   rollsLikeCrawler), its Debuffs adjust that Difficulty (p.96 - module/helpers/
   *   debuff-effects.mjs), offered as dialog rows like rollAttack's target.
   *   post (default true): when false, return the raw roll data instead of
   *   posting a ChatMessage, so a caller can fold this roll into its own
   *   follow-up handling (see rollEvadeCheck's identical option).
   * @returns {Promise<ChatMessage|{roll: Roll, total: number, breakdown: string, naturalRoll: number|null, degree: string}|null>}
   *   null if the roll-options dialog was cancelled, regardless of `post`.
   */
  static async rollOpposedSkillCheck(
    actor,
    skillItem,
    {
      difficulty = null,
      opponent = null,
      skipDialog = false,
      post = true,
      markUse = true,
      isAction = true,
      combat = false,
    } = {},
  ) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    const rank = ownedRank(actor, skillItem);

    if (skillCheckRefused(actor, skillItem, rank)) return null;
    // Still cooling down: warn and ask (helpers/cooldowns.mjs), before
    // anything is spent. A stand-in Skill that isn't saved has none.
    const cooldown = await passCooldown(skillItem);
    if (!cooldown.ok) return null;

    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, skillItem.name);
    // An opposed Spell is still cast - it costs Mana like any other (p.173).
    const manaCostChoices =
      skillItem.type === "spell" ? buildManaCostChoices(skillItem, actor) : [];
    const rollerRows = checkActionRows(
      decorateRows(
        [...collectDebuffRows(sys, "check"), ...collectVehicleRows(actor, "check", { skillItem })],
        "roll",
      ),
      isAction ? null : false,
    ).rows;
    // A Mob's Debuffs lower its static Difficulty; a crawler or Pet rolls
    // its own side, with its own Debuffs.
    const opponentRows =
      opponent && !rollsLikeCrawler(opponent)
        ? decorateRows(
            collectDebuffRows(opponent.system, "check", {
              ownerName: opponent.name,
              idPrefix: "opp",
              ownAction: false,
            }),
            "difficulty",
          )
        : [];

    let options = {
      // A Night Elf's Hide in Shadows at night (helpers/day-night.mjs).
      advantage: dayNightAdvantage(actor, skillItem) ? "advantage" : "normal",
      difficulty,
      modifier: 0,
      checked: new Set(),
      manaCostChoice: 0,
      checkedDebuffs: null,
    };
    if (!skipDialog) {
      const difficultyPresets =
        difficulty === null ? buildSkillCheckPresets(skillItem) : givenPresets(difficulty);
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.OpposedCheckTitle", { name: skillItem.name }),
        defaultAdvantage: dayNightAdvantage(actor, skillItem) ? "advantage" : null,
        combat,
        difficulty: difficulty ?? selectedPresetValue(difficultyPresets),
        difficultyPresets,
        difficultyLabel: opponentRows.length
          ? game.i18n.localize("CARLRPG.Dialog.BaseDifficulty")
          : null,
        conditionalModifiers,
        manaCostChoices,
        debuffRows: [...rollerRows, ...opponentRows],
        // Off-Stat (p.58): rolled with another Stat than its own.
        statChoice: buildStatChoice(skillSys.governingStat ?? ""),
      });
      if (!prompted) return null;
      options = prompted;
    }
    const rollerEffect = resolveRollerRows(rollerRows, options.checkedDebuffs);
    const opponentEffect = resolveDifficultyRows(
      options.difficulty ?? difficulty,
      opponentRows,
      options.checkedDebuffs,
    );
    const finalDifficulty = opponentEffect.difficulty;

    const untrained = isUntrained(rank);
    const statKey = chosenStat(options, skillSys.governingStat);
    const { roll, total, breakdown, naturalRoll, degree, formula } = await rollD20Check({
      rollData,
      untrained,
      advantage: options.advantage,
      effect: rollerEffect,
      terms: skillTerms(sys, rank, untrained, statKey),
      modifier: options.modifier,
      conditionals: {
        modifiers: conditionalModifiers,
        checked: options.checked,
        types: SKILL_CONDITIONAL_TYPES,
      },
      difficulty: finalDifficulty,
    });
    // A caller folding this roll into its own card (Taunt, Command Pet, a
    // Driving Check) shows this note, the early-use one included.
    const debuffNote =
      (cooldown.early ? earlyUseNote() : "") +
      offStatNote(statKey, skillSys.governingStat) +
      buildDebuffNote([...rollerEffect.applied, ...opponentEffect.applied]);

    await removeConditionsById(actor, endedConditionIds(sys, rollerEffect.applied, { isAction }));
    if (opponent)
      await removeConditionsById(opponent, consumedConditionIds(opponentEffect.applied));
    // markUse: false for a stand-in Skill that isn't saved on the actor (an
    // untrained Command Pet roll - module/helpers/pet-command.mjs).
    if (markUse) await CarlDice.markForAdvancement(skillItem);

    // Spent before the post: false return, so a caller folding this roll
    // into its own card (Taunt) pays too.
    const chosenManaCost =
      skillItem.type === "spell"
        ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor)
        : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);
    await startCooldown(skillItem);

    // A caller folding this roll into its own card (Taunt, Command Pet, a
    // Driving Check) gets what a reroll needs, and which rows applied.
    if (!post) {
      return {
        roll,
        total,
        breakdown,
        naturalRoll,
        degree,
        debuffNote,
        chosenManaCost,
        statKey: statKey ?? "",
        formula,
        difficulty: finalDifficulty,
        applied: rollerEffect.applied,
      };
    }

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(checkSubtitle(degree, finalDifficulty), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      body: debuffNote,
      actor,
      flags: aiRerollFlags(actor, {
        kind: "check",
        formula,
        natural: naturalRoll,
        total,
        difficulty: finalDifficulty,
        title: skillItem.name,
        img: skillItem.img,
        label: skillItem.name,
        breakdown,
        body: debuffNote,
        chosenManaCost,
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
  static async rollAdvancementCheck(
    actor,
    skillItem,
    { apply = true, silent = false, debuffs = false, floorBonus = true, clearMark = true } = {},
  ) {
    const currentRank = skillItem.system.rank ?? 0;
    if (isPet(actor)) {
      if (!silent) ui.notifications.warn(game.i18n.localize("CARLRPG.Pet.NoAdvancement"));
      return { success: false, roll: null, newRank: currentRank };
    }
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
    const formula = [
      resolveD20Formula(false, "normal", debuffEffect),
      bonus ? `${bonus}` : null,
      penalty ? `(${penalty})` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    const roll = new Roll(formula);
    await roll.evaluate();
    const success = roll.total >= currentRank;
    const newRank = success ? Math.min(currentRank + 1, rankCap) : currentRank;

    if (apply) {
      await skillItem.update(
        clearMark ? { "system.rank": newRank, "system.marked": false } : { "system.rank": newRank },
      );
    }

    if (!silent) {
      await createRollMessage({
        rolls: [roll],
        rollMeta: [
          {
            label: skillItem.name,
            detail: `${game.i18n.localize("CARLRPG.Roll.Rank")} ${currentRank}`,
          },
        ],
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
    if (item.system.marked) return;
    noteUndo(item.parent, { t: "set", uuid: item.uuid, data: { "system.marked": false } });
    await item.update({ "system.marked": true });
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
    // A Pet's Ranks are the Floor; they "don't improve via the normal ways:
    // grinding, training, potions, or the like" (p.231).
    if (isPet(item.actor)) return false;
    if (item.system.advancementGate === "magic-only") return false;
    if (item.system.advancementGate === "passive-until-5" && (item.system.rank ?? 0) >= 5)
      return false;
    if (item.type === "spell" && item.system.castingKeywords?.includes("passive")) return false;
    // "You can attempt to use Skills untrained on the Third Floor and lower,
    // but you won't gain any new Skills this way like you would on the
    // Tutorial Floors" (p.58): an untrained use marks only on Floors 1-2.
    // The item's own Rank - a "+1" from gear doesn't make the Skill one the
    // crawler has learned, and its Advancement Check against Rank 0 would
    // always succeed.
    if ((item.system.rank ?? 0) === 0 && currentFloor() >= 3) return false;
    return true;
  }
}
