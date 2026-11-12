/**
 * Small helpers shared by the content parsers. Pure, so they run in Node too.
 */

/** Foundry's randomID when it is there, a plain 16-char id otherwise (Node). */
export function randomId() {
  const id = globalThis.foundry?.utils?.randomID?.();
  if (id) return id;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * A complete ChangeEntry (module/data/shared/change-entry.mjs) with a fresh
 * id. Also used by the CrawlerForge importer (helpers/crawlerforge-import.mjs).
 */
export function changeEntry(data) {
  return {
    id: randomId(),
    label: "",
    targetType: "stat",
    target: "",
    mode: "add",
    value: "0",
    capMax: "",
    levelGate: 0,
    damageDiceKind: "",
    damageType: "",
    conditions: [],
    ...data,
  };
}

/**
 * Split lines into paragraphs and bullets. A bullet ("•") or a wide gap
 * starts a new block; so does an indented first line in prose. A wrapped
 * bullet's indented continuation stays with its bullet. A paragraph that
 * runs on into the next column or page stays whole.
 * @param {{text: string, x: number, size: number, col: number, page: number, gap: number|null}[]} lines
 * @returns {object[][]}
 */
export function toBlocks(lines) {
  const blocks = [];
  let prev = null;
  for (const line of lines) {
    const block = blocks.at(-1);
    const sameColumn = prev && prev.col === line.col && prev.page === line.page;
    const inBullet = block?.[0].text.startsWith("•");
    const newBlock =
      !block ||
      line.text.startsWith("•") ||
      (sameColumn && line.gap !== null && line.gap > line.size * 1.6) ||
      (sameColumn && !inBullet && line.x > prev.x + 4);
    if (newBlock) blocks.push([line]);
    else block.push(line);
    prev = line;
  }
  return blocks;
}
