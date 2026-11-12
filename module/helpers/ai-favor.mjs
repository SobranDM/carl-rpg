/**
 * AI Favor rerolls (p.61): "During play, you can spend 1 point of AI Favor
 * to: Once per Check, reroll a d20 before the GM announces the result. You
 * can't spend AI Favor to reroll a Natural 1, because that's an automatic
 * Critical Fail." The new roll stands (Racing & Chasing's example: "he spends an AI
 * Favor to reroll, and ends up with a 28").
 *
 * Only a crawler's own d20 Checks carry one: Stat, Skill, Opposed, Attack
 * and Evade Checks. Mobs never roll (p.267) and have no AI Favor. Damage,
 * healing and initiative aren't Checks. Skill Advancement Checks are
 * rolled in bulk by the GM Toolbox, and the book never ties AI Favor to
 * them, so they're left out.
 *
 * A Check that offers the reroll stores what it needs on its chat card
 * (`flags.carl-rpg.aiReroll`): the d20 expression it rolled ("1d20",
 * "2d20kh", "2d20kl" - Advantage and Disadvantage carry over) and the rest
 * of its total. A reroll swaps only the d20: the Rank, Stat Mod, Debuff
 * penalties and any bonus dice keep what they rolled, and nothing the
 * original roll already spent (Mana, a use-mark, a consumed Debuff) is
 * spent again. See module/chat/ai-favor-reroll.mjs for the button.
 */

/**
 * The reroll data for a Check's chat card, or {} when its roller can't
 * reroll (anyone but a crawler).
 * @param {Actor} actor  Whoever rolled the Check.
 * @param {object} spec
 * @param {"check"|"attack"|"rowEvade"} spec.kind
 * @param {string} spec.formula     The d20 expression, e.g. "2d20kh".
 * @param {number|null} spec.natural  The kept d20.
 * @param {number} spec.total
 * @param {number|null} spec.difficulty
 * @returns {{aiReroll?: object}}
 */
export function aiRerollFlags(actor, { kind, formula, natural, total, difficulty = null, ...rest }) {
  if (actor?.type !== "character" || !formula || natural === null || natural === undefined) return {};
  return {
    aiReroll: {
      kind, actorUuid: actor.uuid, formula, natural, total, difficulty, used: false, ...rest,
    },
  };
}

/**
 * The Roll formula for a reroll: the same d20 expression plus the rest of
 * the original total, so the new Roll's total is the new Check total.
 * @param {{formula: string, natural: number, total: number}} spec
 * @returns {string}
 */
export function rerollFormula({ formula, natural, total }) {
  const rest = (Number(total) || 0) - (Number(natural) || 0);
  if (!rest) return formula;
  return `${formula} ${rest < 0 ? "-" : "+"} ${Math.abs(rest)}`;
}

/**
 * Whether a card's reroll is still on offer, before looking at who's
 * viewing it: unused, not a Natural 1, and not already replaced.
 * @param {object|undefined} spec  flags.carl-rpg.aiReroll
 * @returns {boolean}
 */
export function rerollOpen(spec) {
  return !!spec && !spec.used && spec.natural !== 1;
}

/**
 * The kept die for one d20 expression from a pair of raw dice - shared by
 * an Attack's per-target rows (module/dice/dice.mjs).
 * @param {string} formula  "1d20" | "2d20kh" | "2d20kl"
 * @param {number} first
 * @param {number|null} second
 * @returns {number}
 */
export function keptD20(formula, first, second) {
  if (second === null || second === undefined) return first;
  if (formula === "2d20kh") return Math.max(first, second);
  if (formula === "2d20kl") return Math.min(first, second);
  return first;
}
