/**
 * RollParts: builds a Check/Attack/Damage roll from labeled parts, and
 * produces the tooltip breakdown shown behind the fa-circle-question icon
 * on chat cards.
 *
 * This is adapted from the foundryvtt-wwn sibling system's
 * module/dice/roll-parts.mjs, which already solves the "labels never desync
 * from values" problem (both render from the same structure) and the
 * tooltip-icon chat pattern this system reuses (see module/chat/roll-rows.mjs,
 * templates/chat/roll-row.hbs).
 *
 * Extension beyond WWN's purely-additive model: WWN's own aggregate bonuses
 * are all flat adds (pre-summed before RollParts ever sees them). Carl
 * RPG's structured ChangeEntry modifier engine (module/helpers/modifiers.mjs)
 * also produces "multiply"/"override" changes directly (e.g. Dagger Rank 15
 * "attacks targeting the back of a foe deal x2 damage", Powerful Strike
 * "Multiply your base damage dice result by your Rank"). Per the rules text,
 * these scale the ALREADY-ROLLED additive subtotal, not fresh dice - so they
 * don't need their own Roll term; they're applied arithmetically after the
 * additive Roll evaluates, and the breakdown records each one's actual
 * computed result (e.g. "x2 (Attacking from Behind) -> 14") rather than a
 * bare "x2", per this system's tooltip convention.
 */

/** Coerce "+1" / "-2" strings to numbers for roll assembly. */
export function normalizeRollPart(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const unsigned = trimmed.replace(/^\+/, "");
  if (/^-?\d+(\.\d+)?$/.test(unsigned)) return Number(unsigned);
  return trimmed;
}

export class RollParts {
  /** @type {Array<{value: number|string, label: string}>} Additive dice/flat parts. */
  parts = [];
  /** @type {Array<{kind: "multiply"|"override", value: number|string, label: string}>} */
  postRollParts = [];

  /** @param {object|null} [rollData] Actor roll data used to resolve `@refs` in part values. */
  constructor(rollData = null) {
    this.rollData = rollData;
  }

  /**
   * Add an additive dice/flat part. Zero numeric values and blank strings
   * are skipped so labels never desync from values.
   * @param {number|string} value
   * @param {string} label   Localized label shown in the tooltip
   * @returns {this}
   */
  add(value, label) {
    if (value === null || value === undefined) return this;
    value = normalizeRollPart(value);
    value = this.#resolveAtRefs(value);
    if (typeof value === "number" && value === 0) return this;
    if (typeof value === "string" && !value.trim()) return this;
    this.parts.push({ value, label });
    return this;
  }

  /**
   * Scale the running additive subtotal by `factor`, applied once the Roll
   * has been evaluated (not a fresh dice term).
   * @param {number|string} factor
   * @param {string} label
   * @returns {this}
   */
  multiply(factor, label) {
    const value = this.#resolveAtRefs(normalizeRollPart(factor));
    if (typeof value === "number" && (value === 1 || Number.isNaN(value))) return this;
    if (value === null || value === undefined || value === "") return this;
    this.postRollParts.push({ kind: "multiply", value, label });
    return this;
  }

  /**
   * Override the running subtotal outright, applied once the Roll has been
   * evaluated.
   * @param {number|string} value
   * @param {string} label
   * @returns {this}
   */
  override(value, label) {
    value = this.#resolveAtRefs(normalizeRollPart(value));
    if (value === null || value === undefined || value === "") return this;
    this.postRollParts.push({ kind: "override", value, label });
    return this;
  }

  /** Substitute `@attr` from roll data so tooltips show numbers, not `@stats.str.mod`. */
  #resolveAtRefs(value) {
    if (typeof value !== "string" || !value.includes("@") || !this.rollData) return value;
    const ReplaceFn = foundry?.dice?.Roll?.replaceFormulaData ?? globalThis.Roll?.replaceFormulaData;
    if (typeof ReplaceFn !== "function") return value;
    const replaced = ReplaceFn(value, this.rollData, { missing: "0" });
    return normalizeRollPart(replaced);
  }

  /** Wrap formula fragments that already contain operators. */
  #formatPart(value, isFirst) {
    const text = String(value);
    if (isFirst) return text;
    if (typeof value === "string" && /[+\-]/.test(text)) return `(${text})`;
    return text;
  }

  /** The additive dice/flat formula only (before any multiply/override). */
  formula() {
    let formula = "";
    for (const part of this.parts) {
      const fragment = this.#formatPart(part.value, !formula);
      if (!formula) {
        formula = fragment;
        continue;
      }
      if (typeof part.value === "number" && part.value < 0) {
        formula += ` - ${Math.abs(part.value)}`;
      } else {
        formula += ` + ${fragment}`;
      }
    }
    return formula || "0";
  }

  /** Flavor breakdown of the additive parts, e.g. "1d20 + 2 (Attack Bonus) - 2 (Armor Penalty)". */
  additiveBreakdown() {
    let out = "";
    for (const p of this.parts) {
      const labeled =
        typeof p.value === "number" && p.value < 0
          ? `${Math.abs(p.value)}${p.label ? ` (${p.label})` : ""}`
          : p.label
            ? `${p.value} (${p.label})`
            : `${p.value}`;
      if (!out) {
        out = typeof p.value === "number" && p.value < 0 ? `-${labeled}` : labeled;
        continue;
      }
      if (typeof p.value === "number" && p.value < 0) out += ` - ${labeled}`;
      else out += ` + ${labeled}`;
    }
    return out;
  }

  get isEmpty() {
    return this.parts.length === 0 && this.postRollParts.length === 0;
  }

  /**
   * Evaluate the additive Roll, then apply multiply/override parts in order
   * against the resulting total. Both automatic modifiers and optional
   * roll-dialog-selected modifiers (see module/dice/roll-prompt.mjs) are
   * expected to already be baked into this same instance via .add()/
   * .multiply()/.override() before calling evaluate() - there is no
   * distinction between "automatic" and "optional-but-checked" once rolled.
   * @returns {Promise<{roll: Roll, total: number, breakdown: string}>}
   */
  async evaluate() {
    const roll = new Roll(this.formula() || "0", this.rollData ?? {});
    await roll.evaluate();

    let total = roll.total;
    let breakdown = this.additiveBreakdown();

    for (const part of this.postRollParts) {
      if (part.kind === "multiply") {
        const factor = Number(part.value) || 1;
        total = total * factor;
        breakdown += `${breakdown ? " " : ""}×${factor}${part.label ? ` (${part.label})` : ""} → ${total}`;
      } else if (part.kind === "override") {
        const overridden = Number(part.value);
        if (Number.isFinite(overridden)) total = overridden;
        breakdown += `${breakdown ? " " : ""}→ ${total}${part.label ? ` (${part.label})` : ""}`;
      }
    }

    return { roll, total, breakdown };
  }
}
