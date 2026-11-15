/**
 * The Combat tab's DR, Move, Step and Evade (abilities.hbs): the value each
 * shows, and a tooltip naming where it comes from - "Base 20 · Tigran +10 ·
 * Running (Rank 5) +5". The sources are recorded by the modifier engine
 * (modifiers.mjs, actorSystem.bonusSources); the values are derived in
 * data/shared/derive-creature.mjs.
 */

/**
 * One source, as the tooltip shows it: "Tigran +10", "Iron Skin x2",
 * "Elf (High) +1d4".
 * @param {{label: string, value: number|string, mode: string}} source
 * @returns {string}
 */
export function formatSource({ label, value, mode }) {
  const name = label || game.i18n.localize("CARLRPG.Actor.SourceUnnamed");
  if (mode === "multiply") return `${name} ×${value}`;
  if (mode === "override") return `${name} = ${value}`;
  if (typeof value === "string") return `${name} ${value.startsWith("-") ? value : `+${value}`}`;
  const signed = mode === "subtract" ? -value : value;
  return `${name} ${signed >= 0 ? "+" : ""}${signed}`;
}

/**
 * A tooltip: the base, then each source, joined with " · ".
 * @param {string} baseText  "Base 20", "DEX Mod +2".
 * @param {object[]} [sources]
 * @param {string[]} [notes]  Anything after the sources ("Fatigued: halved").
 * @returns {string}
 */
export function sourcesTooltip(baseText, sources = [], notes = []) {
  return [baseText, ...sources.map(formatSource), ...notes.filter(Boolean)].join(" · ");
}

/**
 * The Combat tab's defenses for one Character.
 * @param {object} sys  A Character's prepared system data.
 * @returns {{evade: object, dr: object, move: object, step: object}}  The
 *   Evade number itself is the sheet's evadeTotal (rules.mjs evadeModifier).
 */
export function describeDefenses(sys) {
  const src = sys.bonusSources ?? {};
  const base = (value) => game.i18n.format("CARLRPG.Actor.SourceBase", { value });
  const blocked = (name) => (name ? game.i18n.format("CARLRPG.Actor.BlockedBy", { name }) : "");
  const details = sys.details ?? {};

  const dexMod = sys.stats?.dex?.mod ?? 0;
  const dice = (sys.evadeDice ?? []).map((d) => d.formula);
  const evade = {
    // " +1d4" after the number on the Evade button.
    dice: dice.map((f) => (f.startsWith("-") ? ` ${f}` : ` +${f}`)).join(""),
    tooltip: sourcesTooltip(
      game.i18n.format("CARLRPG.Actor.SourceDexMod", { value: `${dexMod >= 0 ? "+" : ""}${dexMod}` }),
      [...(src.evadeBonus ?? []), ...(src.evadeDice ?? [])],
    ),
  };

  // A crawler's DR is shown as its total (its base is 0, character.mjs).
  const dr = { tooltip: sourcesTooltip(base(sys.dr), src.dr) };

  const move = {
    shown: sys.moveEffective !== undefined && sys.moveEffective !== details.move,
    blocked: blocked(sys.moveBlockedBy),
    tooltip: sourcesTooltip(base(details.move), src.move, [
      sys.moveHalvedBy ? game.i18n.format("CARLRPG.Actor.MoveHalvedBy", { name: sys.moveHalvedBy }) : "",
    ]),
  };
  const step = {
    shown: sys.stepEffective !== undefined && sys.stepEffective !== details.step,
    blocked: blocked(sys.stepBlockedBy),
    tooltip: sourcesTooltip(base(details.step), src.step),
  };
  for (const field of [move, step]) {
    if (field.blocked) field.tooltip = `${field.blocked} · ${field.tooltip}`;
  }
  return { evade, dr, move, step };
}
