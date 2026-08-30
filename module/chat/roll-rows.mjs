/**
 * Builds the per-roll row data consumed by templates/chat/roll-row.hbs.
 * Adapted from foundryvtt-wwn's module/chat/roll-rows.mjs.
 */

export function defaultRollRowLabel() {
  return game.i18n.localize("CARLRPG.Roll.Formula");
}

/**
 * @param {Roll[]} rolls
 * @param {Array<{label?: string, detail?: string, breakdown?: string}>} rollMeta  Per-index row metadata.
 * @param {{isPrivate?: boolean}} [options]
 * @returns {Promise<object[]>}
 */
export async function buildRollRows(rolls = [], rollMeta = [], { isPrivate = false } = {}) {
  const rows = [];
  for (let i = 0; i < rolls.length; i++) {
    const roll = rolls[i];
    const meta = rollMeta[i] ?? {};
    const evaluated = !!roll?._evaluated;
    let tooltipHtml = "";
    if (evaluated && !isPrivate && typeof roll.getTooltip === "function") {
      tooltipHtml = await roll.getTooltip();
    }
    rows.push({
      label: meta.label || defaultRollRowLabel(),
      detail: meta.detail ?? "",
      breakdown: isPrivate ? "" : (meta.breakdown ?? ""),
      formula: isPrivate ? "???" : String(roll?._formula ?? roll?.formula ?? ""),
      total: isPrivate ? "?" : (evaluated && roll?.total != null ? String(roll.total) : ""),
      tooltipHtml,
    });
  }
  return rows;
}
