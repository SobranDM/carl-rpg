/**
 * The damage-type reduction pipeline (Playing the Game, p. 93, see
 * docs/known-gaps.md 1.3): raw damage -> Shield (non-magic only, see
 * docs/known-gaps.md 1.4/reduceViaShield below) -> DR (flat reduction) ->
 * Resistance (half) -> Vulnerability (double) -> Immunity (zero, no
 * secondary effects) -> remainder applied to HB in whole slots. Multi-type damage (an attack
 * that "deals Force and Fire damage", module/dice/dice.mjs's
 * buildDamageRollParts) splits evenly across the represented types BEFORE
 * this pipeline runs - but DR is a single flat reduction applied ONCE to the
 * pre-split total, not independently per type-portion (confirmed by the
 * user against the book, resolving what was previously flagged here as an
 * open content-accuracy question). Concretely: sum the roll-time per-type
 * subtotals, subtract DR once, then re-split the DR-reduced total across the
 * same types (same deterministic remainder distribution as the original
 * roll-time split) before running Resistance/Vulnerability/Immunity on each
 * of those portions.
 *
 * Never writes anything to a Document - this is pure math. The caller
 * (module/chat/damage-card.mjs's "Apply Damage" button) applies the result.
 */

/** @typedef {"none"|"resist"|"vulnerable"|"immune"} ResistanceState */

/**
 * Split a total amount evenly across N damage types. Any remainder (from
 * non-divisible totals) is distributed one point at a time to the first
 * types in the given order, so every point of the original total is
 * accounted for (deterministic, no fractional/partial points).
 * @param {number} total
 * @param {string[]} types  Damage-type keys - "" (untyped) is a valid,
 *   meaningful key here (see computeDamageApplication below), so this only
 *   drops genuinely missing entries (null/undefined), never blank strings.
 * @returns {Record<string, number>}
 */
export function splitDamageEvenly(total, types) {
  const out = {};
  const list = (types ?? []).filter((type) => type !== null && type !== undefined);
  if (!list.length) return out;
  const amount = Math.max(0, Number(total) || 0);
  const base = Math.floor(amount / list.length);
  let remainder = amount - base * list.length;
  for (const type of list) {
    out[type] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return out;
}

/**
 * Run Resistance -> Vulnerability -> Immunity on one type-portion of damage.
 * DR is NOT applied here - it's a single flat reduction applied once to the
 * pre-split total by the caller (computeDamageApplication), before this
 * function ever runs.
 * @param {number} amount  This portion's damage, already DR-reduced and re-split.
 * @param {ResistanceState} state
 * @returns {{amount: number, state: ResistanceState, final: number}}
 */
export function reduceDamagePortion(amount, state = "none") {
  const value = Math.max(0, Number(amount) || 0);
  if (state === "immune") return { amount: value, state, final: 0 };
  let final = value;
  if (state === "resist") final = Math.floor(value / 2);
  else if (state === "vulnerable") final = value * 2;
  return { amount: value, state, final };
}

/**
 * Whole-slot HB consumption (Playing the Game, p. 93-94): accumulate
 * `slotValue` (CON Mod, see module/data/character.mjs's hb.slotValue) one
 * slot at a time until the running total would exceed the remaining
 * damage; that many slots are marked off. Any leftover damage under one
 * slot's value is lost - it does NOT chip a partial slot, and does NOT
 * carry over (confirmed by the user against the book's own worked example -
 * "that 2 extra damage is ignored"). Written as an explicit accumulation
 * loop (rather than a bare `Math.floor(damage / slotValue)`) specifically to
 * mirror the rulebook's own stepwise description; the two are numerically
 * identical.
 * @param {number} totalDamage
 * @param {number} slotValue
 * @returns {number} Whole slots consumed.
 */
export function computeSlotsLost(totalDamage, slotValue) {
  const value = Number(slotValue) || 0;
  const damage = Math.max(0, Number(totalDamage) || 0);
  if (value <= 0 || damage <= 0) return 0;
  let running = 0;
  let slots = 0;
  while (running + value <= damage) {
    running += value;
    slots += 1;
  }
  return slots;
}

/**
 * Whole-slot Shield absorption (docs/known-gaps.md 1.4) - identical
 * "accumulate slotValue, sub-slot leftover is lost" math as computeSlotsLost,
 * applied against the target's OWN shield pool instead of its HB, ahead of
 * DR. If the hit would deplete the shield's remaining slots, the leftover
 * raw damage that doesn't fit any more shield slots carries forward to the
 * normal DR pipeline (confirmed against the book with the project owner) -
 * this function reports both halves so the caller can continue the
 * pipeline with `remaining` as the new starting total.
 * @param {number} rawTotal
 * @param {{value: number, slotValue: number}} shield
 * @returns {{remaining: number, slotsLost: number, absorbed: number}}
 */
export function reduceViaShield(rawTotal, shield) {
  const slotValue = Number(shield?.slotValue) || 0;
  const value = Math.max(0, Number(shield?.value) || 0);
  if (slotValue <= 0 || value <= 0) return { remaining: Math.max(0, rawTotal), slotsLost: 0, absorbed: 0 };
  const slotsLost = Math.min(computeSlotsLost(rawTotal, slotValue), value);
  const absorbed = slotsLost * slotValue;
  return { remaining: Math.max(0, rawTotal - absorbed), slotsLost, absorbed };
}

/**
 * Run the full pipeline for a set of {type: amount} portions against a
 * target actor's `system.resistances`/`system.dr`, then compute whole-slot
 * HB consumption from the summed final damage. Non-magic damage first passes
 * through the target's own Shield pool (docs/known-gaps.md 1.4,
 * reduceViaShield above) - only the overflow that doesn't fit any remaining
 * shield slot continues into DR/Resistance/Vulnerability/Immunity. Magic
 * damage (the default - see isMagic below) skips the Shield pool entirely.
 * @param {Record<string, number>} damageByType  Raw per-type subtotals from the
 *   roll-time split (blank type key "" allowed - untyped damage).
 * @param {Actor} target
 * @param {boolean} [isMagic]  Whether the attacking Skill/Spell's damage is
 *   magical (module/dice/dice.mjs's damageIsMagic flag). Defaults true so an
 *   omitted/unspecified flag never lets Shield intercept damage it shouldn't.
 * @returns {{
 *   perType: Array<{type: string, raw: number, afterDr: number, state: ResistanceState, final: number}>,
 *   totalFinalDamage: number,
 *   slotsLost: number,
 *   slotValue: number,
 *   shieldSlotsLost: number,
 *   shieldAbsorbed: number,
 * }}
 */
export function computeDamageApplication(damageByType, target, isMagic = true) {
  const sys = target?.system ?? {};
  // drEffective/resistancesEffective (module/data/character.mjs,mob.mjs) fold
  // in any Race/Class/feature-granted DR bonus or Resistance/Immunity
  // override on top of the flat GM-set base - fall back to the raw base
  // fields for a plain data object that never went through prepareDerivedData.
  const dr = Number(sys.drEffective ?? sys.dr) || 0;
  const resistances = sys.resistancesEffective ?? sys.resistances ?? {};
  const slotValue = sys.hb?.slotValue ?? 0;

  const types = Object.keys(damageByType ?? {}).filter((type) => damageByType[type]);
  const rawTotal = types.reduce((sum, type) => sum + (damageByType[type] || 0), 0);

  const shieldResult = !isMagic
    ? reduceViaShield(rawTotal, sys.shield)
    : { remaining: rawTotal, slotsLost: 0, absorbed: 0 };

  const totalAfterDr = Math.max(0, shieldResult.remaining - dr);
  // Re-split the DR-reduced total across the same types the roll-time split
  // produced - DR is a flat, un-typed reduction on the whole hit, not
  // type-gated, so it doesn't matter which type's portion "absorbs" it;
  // redistributing evenly keeps this consistent with how the original
  // (also even) roll-time split worked.
  const splitAfterDr = splitDamageEvenly(totalAfterDr, types);

  const perType = [];
  let totalFinalDamage = 0;
  for (const type of types) {
    const afterDr = splitAfterDr[type] ?? 0;
    // An untyped ("") portion has no matching resistances key - it still
    // took its share of DR above but never Resist/Vulnerable/Immune.
    const state = resistances[type] || "none";
    const result = reduceDamagePortion(afterDr, state);
    perType.push({ type, raw: damageByType[type] || 0, afterDr, state, final: result.final });
    totalFinalDamage += result.final;
  }

  const slotsLost = computeSlotsLost(totalFinalDamage, slotValue);

  return {
    perType, totalFinalDamage, slotsLost, slotValue,
    shieldSlotsLost: shieldResult.slotsLost, shieldAbsorbed: shieldResult.absorbed,
  };
}
