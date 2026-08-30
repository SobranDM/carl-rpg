/**
 * CarlDice: the four roll flows described in the system design plan -
 * Skill Check, Attack (+ Damage), Evade Check, and Skill Advancement Check -
 * built from RollParts (module/dice/roll-parts.mjs) and posted via the chat
 * card factory (module/chat/chat-card.mjs). Pattern adapted from
 * foundryvtt-wwn's module/dice/dice.mjs.
 */
import { RollParts } from "./roll-parts.mjs";
import { promptRollOptions, collectApplicableConditionalModifiers } from "./roll-prompt.mjs";
import { createRollMessage, createCardMessage } from "../chat/chat-card.mjs";
import { buildTargetEffectsFooter } from "../chat/target-effects-card.mjs";
import { buildHealFooter } from "../chat/heal-card.mjs";
import { buildDamageFooter } from "../chat/damage-card.mjs";
import { getDegreeOfSuccess } from "../helpers/rules.mjs";
import { slugifySkillName, collectItemTargetEffects, computeActiveShieldSlots } from "../helpers/modifiers.mjs";
import { splitDamageEvenly } from "../helpers/damage-pipeline.mjs";
import { CARLRPG } from "../helpers/config.mjs";

/**
 * Net Advantage/Disadvantage don't stack (Playing the Game, p. 60): an
 * inherent Disadvantage (untrained Attack/Utility Skill) and a
 * player-selected Advantage cancel 1-for-1.
 * @param {boolean} inherentDisadvantage
 * @param {"normal"|"advantage"|"disadvantage"} selection
 * @returns {string} "1d20" | "2d20kh" | "2d20kl"
 */
export function resolveD20Formula(inherentDisadvantage, selection) {
  let net = 0;
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

function degreeBadge(degree) {
  const label = game.i18n.localize(CARLRPG.degreesOfSuccess[degree] ?? degree);
  const type = ["criticalHit", "amazingSuccess", "standardSuccess"].includes(degree)
    ? "hit"
    : ["criticalFail", "majorFail"].includes(degree)
      ? "miss"
      : "warn";
  return { label, type };
}

function isHitDegree(degree) {
  return ["criticalHit", "amazingSuccess", "standardSuccess"].includes(degree);
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
      getGroup(term.damageType || defaultType).add(isCrit ? `2 * (${term.formula})` : term.formula, term.label);
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

  for (const [typeKey, parts] of groups) {
    if (parts.isEmpty) continue;
    const { roll, total, breakdown } = await parts.evaluate();
    rolls.push(roll);

    if (typeKey === skillDefaultType && splitTypes.length) {
      rollMeta.push({ label: damageRowLabel(splitTypes), breakdown });
      const split = splitDamageEvenly(total, splitTypes);
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
 * The actor's active Class name (module/data/character.mjs's
 * system.class/classItem), used only for the Favored-Class Mana surcharge
 * below. Null for NPCs and for Characters with no Class selected yet.
 * @param {Actor} actor
 * @returns {string|null}
 */
function getActorClassName(actor) {
  return actor.system.classItem?.name ?? null;
}

/**
 * "If a Spell is Favored by any particular Classes, other Classes pay 1
 * additional Mana to cast it" (module/data/spell.mjs's favoredClasses field).
 * A Spell with no favoredClasses at all charges everyone the same; a caster
 * with no Class selected is never "favored", so pays the surcharge like any
 * other non-favored Class.
 * @param {Item} spellItem
 * @param {Actor} actor
 * @param {number} manaCost
 * @returns {number}
 */
function applyFavoredClassSurcharge(spellItem, actor, manaCost) {
  const favored = spellItem.system.favoredClasses ?? [];
  if (!favored.length) return manaCost;
  const className = getActorClassName(actor);
  return className && favored.includes(className) ? manaCost : manaCost + 1;
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
function withManaCostSubtitle(subtitle, chosen) {
  if (!chosen?.manaCost) return subtitle;
  const label = game.i18n.format("CARLRPG.Dialog.ManaCostSpent", { cost: chosen.manaCost });
  const full = chosen.isBase ? label : `${label} (${chosen.description})`;
  return subtitle ? `${subtitle} · ${full}` : full;
}

export default class CarlDice {
  /**
   * Skill Check: 1d20 (2d20kl if untrained Attack/Utility) + Rank + Stat Mod.
   * Passive Skills can't be Checked at all; Spells can't be attempted
   * untrained (Skills, Spells & Gear, p. 173).
   * @param {Actor} actor
   * @param {Item} skillItem  A skill|spell|damageEffect item owned by actor.
   * @param {{skipDialog?: boolean}} [options]
   */
  static async rollSkillCheck(actor, skillItem, { skipDialog = false } = {}) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    const skillEntry = sys.skills?.[slugifySkillName(skillItem.name)];
    const rank = skillEntry?.rank ?? skillSys.rank ?? 0;

    if (skillSys.isPassive) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Warning.PassiveNoCheck", { name: skillItem.name }));
      return null;
    }
    if (rank === 0 && skillItem.type === "spell") {
      ui.notifications.warn(game.i18n.format("CARLRPG.Warning.CannotCastUntrained", { name: skillItem.name }));
      return null;
    }

    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, skillItem.name);
    const manaCostChoices = skillItem.type === "spell" ? buildManaCostChoices(skillItem) : [];

    let options = { advantage: "normal", difficulty: null, modifier: 0, checked: new Set(), manaCostChoice: 0 };
    if (!skipDialog) {
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.SkillCheckTitle", { name: skillItem.name }),
        showDifficulty: true,
        conditionalModifiers,
        manaCostChoices,
      });
      if (!prompted) return null;
      options = prompted;
    }

    const untrained = rank === 0;
    const statKey = skillSys.governingStat;
    const statMod = statKey ? (sys.stats?.[statKey]?.mod ?? 0) : 0;

    const parts = new RollParts(rollData);
    parts.add(resolveD20Formula(untrained, options.advantage), game.i18n.localize("CARLRPG.Roll.Die"));
    if (!untrained) parts.add(rank, game.i18n.localize("CARLRPG.Roll.SkillRank"));
    if (statKey) parts.add(statMod, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
    parts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(parts, conditionalModifiers, options.checked, ["skillRank", "stat", "rollMode", "custom"]);

    const { roll, total, breakdown } = await parts.evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const degree = getDegreeOfSuccess(naturalRoll, total, options.difficulty);

    await CarlDice.#markForAdvancement(skillItem);

    const chosenManaCost = skillItem.type === "spell" ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor) : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: skillItem.name, breakdown }],
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      actor,
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
  static async rollAttack(actor, skillItem, { skipDialog = false, damageEffectItem = null } = {}) {
    const sys = actor.system;
    const skillSys = skillItem.system;
    const skillEntry = sys.skills?.[slugifySkillName(skillItem.name)];
    const rank = skillEntry?.rank ?? skillSys.rank ?? 0;

    // Snapshot targets NOW, at roll time - not at chat-card-click time. The
    // "Apply to Target(s)" button (module/chat/target-effects-card.mjs)
    // reads these back off the chat message's flags, so re-targeting after
    // the roll (or before the GM gets around to clicking the button) can't
    // change who gets hit by this specific roll's target effects.
    const targets = Array.from(game.user.targets ?? []);
    const target = targets[0] ?? null;
    const targetUuids = targets.map((t) => t.document?.uuid).filter(Boolean);
    let targetDifficulty = null;
    if (target?.actor) {
      const targetSys = target.actor.system;
      const dexMod = targetSys.stats?.dex?.mod ?? 0;
      const floor = game.settings.get("carl-rpg", "currentFloor");
      targetDifficulty = 10 + dexMod + floor;
    }

    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, skillItem.name);

    // Candidates are matched by name against parentSkills, same rule the
    // actor sheet uses to list a Skill's Damage Effects (module/sheets/
    // actor-sheet.mjs) - not id/uuid, and not gated by item type, since
    // parentSkills can list Spells too. Rank-0 (untrained) ones are excluded
    // here so they never even appear in the dropdown (docs/known-gaps.md
    // 1.5) - Damage Effects are Passive Skills, and Passive Skills can't be
    // used untrained.
    const damageEffectChoices = actor.items
      .filter((i) => i.type === "damageEffect" && (i.system.parentSkills ?? []).includes(skillItem.name))
      .map((de) => ({ id: de.id, name: de.name, rank: sys.skills?.[slugifySkillName(de.name)]?.rank ?? de.system.rank ?? 0 }))
      .filter((de) => de.rank > 0);

    const manaCostChoices = skillItem.type === "spell" ? buildManaCostChoices(skillItem) : [];

    let options = { advantage: "normal", difficulty: targetDifficulty, modifier: 0, checked: new Set(), manaCostChoice: 0 };
    if (!skipDialog) {
      const prompted = await promptRollOptions({
        title: game.i18n.format("CARLRPG.Dialog.AttackTitle", { name: skillItem.name }),
        difficulty: targetDifficulty,
        conditionalModifiers,
        damageEffectChoices,
        manaCostChoices,
      });
      if (!prompted) return null;
      options = prompted;
      if (prompted.damageEffectId) {
        damageEffectItem = actor.items.get(prompted.damageEffectId) ?? damageEffectItem;
      }
    }
    const difficulty = options.difficulty ?? targetDifficulty;

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

    const untrained = rank === 0;
    const statKey = skillSys.governingStat;
    const statMod = statKey ? (sys.stats?.[statKey]?.mod ?? 0) : 0;

    const attackParts = new RollParts(rollData);
    attackParts.add(resolveD20Formula(untrained, options.advantage), game.i18n.localize("CARLRPG.Roll.Die"));
    if (!untrained) attackParts.add(rank, game.i18n.localize("CARLRPG.Roll.SkillRank"));
    if (statKey) attackParts.add(statMod, game.i18n.localize(CARLRPG.statAbbreviations[statKey] ?? statKey));
    attackParts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(attackParts, conditionalModifiers, options.checked, ["skillRank", "stat", "rollMode", "custom"]);

    const { roll: attackRoll, total: attackTotal, breakdown: attackBreakdown } = await attackParts.evaluate();
    const naturalRoll = extractNaturalD20(attackRoll);
    const degree = getDegreeOfSuccess(naturalRoll, attackTotal, difficulty);
    const hit = difficulty === null || isHitDegree(degree);

    // "When you make an Attack that adds a Damage Effect, place a mark for
    // later Skill Advancement in either the Attack Skill or the Damage
    // Effect, not both." (Skills, Spells & Gear)
    await CarlDice.#markForAdvancement(damageEffectItem ?? skillItem);

    // Mana is spent for casting, not the outcome - deduct/surface regardless
    // of hit/miss (docs/known-gaps.md 1.6).
    const chosenManaCost = skillItem.type === "spell" ? resolveManaCost(skillItem, manaCostChoices, options.manaCostChoice, actor) : null;
    if (chosenManaCost) await applyManaCost(actor, chosenManaCost.manaCost);

    const rolls = [attackRoll];
    const rollMeta = [{ label: skillItem.name, detail: target?.actor ? `vs. ${target.actor.name}` : "", breakdown: attackBreakdown }];

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
    if (hit) {
      const damageEffectEntry = damageEffectItem
        ? sys.skills?.[slugifySkillName(damageEffectItem.name)]
        : null;
      const isCrit = naturalRoll === 20;
      const built = buildDamageRollParts({
        skillItem, skillEntry, damageEffectItem, damageEffectEntry, isCrit, rollData, conditionalModifiers, checked: options.checked,
      });
      const evaluated = await evaluateDamageGroups(built);
      rolls.push(...evaluated.rolls);
      rollMeta.push(...evaluated.rollMeta);
      damageByType = evaluated.damageByType;
      targetEffects = [
        ...collectItemTargetEffects(skillItem, { isCrit }),
        ...(damageEffectItem ? collectItemTargetEffects(damageEffectItem, { isCrit }) : []),
      ];
    }

    const hasDamage = Object.values(damageByType).some((v) => v);
    const flags = {};
    const footerParts = [];
    // Both buttons key off the same snapshotted targetUuids (see rollAttack's
    // top-of-function comment) - set once if either footer needs it.
    if (targetEffects.length || hasDamage) flags.targetUuids = targetUuids;
    if (targetEffects.length) {
      flags.targetEffects = targetEffects;
      footerParts.push(await buildTargetEffectsFooter(targetEffects));
    }
    if (hasDamage) {
      flags.damageByType = damageByType;
      // Whichever Skill/Spell was actually rolled governs the whole hit's
      // magic-ness (docs/known-gaps.md 1.4) - a damageEffectItem with a
      // different isMagicDamage is deliberately not tracked per-term.
      flags.damageIsMagic = skillItem.system.isMagicDamage;
      footerParts.push(await buildDamageFooter(damageByType));
    }
    const footer = footerParts.length ? footerParts.join("") : undefined;

    return createRollMessage({
      rolls, rollMeta,
      title: skillItem.name,
      subtitle: withManaCostSubtitle(game.i18n.localize(CARLRPG.degreesOfSuccess[degree]), chosenManaCost),
      img: skillItem.img,
      badge: degreeBadge(degree),
      footer,
      flags,
      actor,
    });
  }

  /**
   * Heal roll: Heal Self and similar Heal-type Spells (`castingKeywords`
   * includes `"heal"`) aren't Skill Checks - no d20, no to-hit, no Rank
   * bonus applied to the roll itself. Skills, Spells & Gear's Heal Self text
   * is just "you heal N Health Bar slots" at increasing dice tiers per Rank
   * (see packs-source/spells/heal-self.json's `healDice`/`healToFull`/
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
  static async rollHeal(actor, skillItem) {
    const skillSys = skillItem.system;
    const rank = skillSys.rank ?? 0;

    const unlocked = (skillSys.upgrades ?? [])
      .filter((u) => rank >= u.rankThreshold)
      .sort((a, b) => b.rankThreshold - a.rankThreshold);
    const fullTier = unlocked.find((u) => u.healToFull);
    const diceTier = unlocked.find((u) => u.healDice);
    const canMend = unlocked.some((u) => u.healMend);
    const formula = diceTier?.healDice || skillSys.healDice || "1d4";

    await CarlDice.#markForAdvancement(skillItem);

    // Casting always spends Mana, whether or not the tier rolls dice
    // (docs/known-gaps.md 1.6) - no picker here, per this function's own
    // "not built ahead of a real use case" precedent above: no heal spell
    // currently has manaCostVariants.
    const chosenManaCost = skillItem.type === "spell"
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
      const rank = skillSys.rank ?? 0;
      if (rank === 0) {
        ui.notifications.warn(game.i18n.format("CARLRPG.Warning.CannotCastUntrained", { name: skillItem.name }));
        return null;
      }
      manaCostSpent = applyFavoredClassSurcharge(skillItem, actor, skillSys.manaCost);
      await applyManaCost(actor, manaCostSpent);
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
   * @param {{difficulty?: number|null, skipDialog?: boolean}} [options]
   */
  static async rollEvadeCheck(actor, { difficulty = null, skipDialog = false } = {}) {
    const sys = actor.system;
    const rollData = actor.getRollData();
    const conditionalModifiers = collectApplicableConditionalModifiers(sys, "evade");

    let options = { advantage: "normal", difficulty, modifier: 0, checked: new Set() };
    if (!skipDialog) {
      const prompted = await promptRollOptions({
        title: game.i18n.localize("CARLRPG.Dialog.EvadeTitle"),
        difficulty,
        conditionalModifiers,
      });
      if (!prompted) return null;
      options = prompted;
    }

    const dexMod = sys.stats?.dex?.mod ?? 0;
    const evadeBonus = sys.bonuses?.evadeBonus ?? 0;

    const parts = new RollParts(rollData);
    parts.add(resolveD20Formula(false, options.advantage), game.i18n.localize("CARLRPG.Roll.Die"));
    parts.add(dexMod, game.i18n.localize(CARLRPG.statAbbreviations.dex));
    parts.add(evadeBonus, game.i18n.localize("CARLRPG.Roll.EvadeBonus"));
    parts.add(options.modifier, game.i18n.localize("CARLRPG.Roll.Situational"));
    applyCheckedConditionalModifiers(parts, conditionalModifiers, options.checked, ["stat", "rollMode", "custom"]);

    const { roll, total, breakdown } = await parts.evaluate();
    const naturalRoll = extractNaturalD20(roll);
    const degree = getDegreeOfSuccess(naturalRoll, total, options.difficulty);

    let body = "";
    if (degree === "majorFail") body = `<p>${game.i18n.localize("CARLRPG.Roll.EvadeMajorFail")}</p>`;
    else if (degree === "criticalFail") body = `<p>${game.i18n.localize("CARLRPG.Roll.EvadeCriticalFail")}</p>`;

    return createRollMessage({
      rolls: [roll],
      rollMeta: [{ label: game.i18n.localize("CARLRPG.Roll.Evade"), breakdown }],
      title: game.i18n.localize("CARLRPG.Roll.Evade"),
      subtitle: game.i18n.localize(CARLRPG.degreesOfSuccess[degree]),
      img: actor.img,
      badge: degreeBadge(degree),
      body,
      actor,
    });
  }

  /**
   * Skill Advancement Check: 1d20 vs. the Skill's current Rank. Success
   * grants +1 Rank (capped at 15 via this mechanic, per the rules text) and
   * clears the mark. This is the roll the GM Toolbox calls in bulk.
   * @param {Actor} actor
   * @param {Item} skillItem
   * @param {{apply?: boolean, silent?: boolean}} [options]  apply: write the
   *   Rank/mark changes back to the item. silent: skip the chat card.
   * @returns {Promise<{success: boolean, roll: Roll, newRank: number}>}
   */
  static async rollAdvancementCheck(actor, skillItem, { apply = true, silent = false } = {}) {
    const currentRank = skillItem.system.rank ?? 0;
    const roll = new Roll("1d20");
    await roll.evaluate();
    const success = roll.total >= currentRank;
    const newRank = success ? Math.min(currentRank + 1, 15) : currentRank;

    if (apply) {
      await skillItem.update({ "system.rank": newRank, "system.marked": false });
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
   * Passive-skills-rarely-mark rule for that specific case - and rollHeal
   * calls this unconditionally for isPassive Heal spells (Heal Self), since
   * casting is itself the qualifying action there, not a Skill Check. So
   * this only needs to respect advancementGate, including the Dodge-style
   * "marks only below Rank 5".
   */
  static async #markForAdvancement(item) {
    if (!item) return;
    if (item.system.advancementGate === "magic-only") return;
    if (item.system.advancementGate === "passive-until-5" && (item.system.rank ?? 0) >= 5) return;
    if (!item.system.marked) await item.update({ "system.marked": true });
  }
}
