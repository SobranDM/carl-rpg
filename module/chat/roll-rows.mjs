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
 * @param {{isPrivate?: boolean, extraRows?: Array<{label?: string, detail?: string, breakdown?: string, total?: string, insertAt?: number}>}} [options]
 *   extraRows are non-Roll-backed rows spliced into the result at `insertAt`
 *   (defaults to the end) - e.g. a supplemental context row with no dice
 *   behind it. Ported from foundryvtt-wwn's roll-rows.mjs for factory parity;
 *   no current caller passes one, kept as reusable infrastructure.
 * @returns {Promise<object[]>}
 */
export async function buildRollRows(rolls = [], rollMeta = [], { isPrivate = false, extraRows = [] } = {}) {
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
  for (const extra of extraRows) {
    const row = {
      label: extra.label ?? "",
      detail: extra.detail ?? "",
      breakdown: extra.breakdown ?? "",
      formula: "",
      total: extra.total ?? "",
      tooltipHtml: "",
    };
    const at = Number.isInteger(extra.insertAt) ? extra.insertAt : rows.length;
    rows.splice(Math.min(Math.max(at, 0), rows.length), 0, row);
  }
  return rows;
}
