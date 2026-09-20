import { createCardMessage } from "../chat/chat-card.mjs";

/**
 * Randomized Magic Items (Skills, Spells & Gear, p.219-220), driven from the
 * GM Toolbox's "Roll Loot" button. Pick a loot box tier, roll Item Type
 * (Table 38) once to decide which sub-table applies, then roll that same
 * sub-table the tier's number of times to build up one item's properties -
 * stopping early (with a power multiplier) if "Something Unique" comes up.
 *
 * Every RollTable#roll() call below passes { recursive: false } - Foundry's
 * default (true) would otherwise auto-follow a document-linked result
 * (e.g. Item Type -> a sub-table, or a sub-table -> Something Unique)
 * before this code gets to inspect it, which would break the manual
 * Something-Unique detection this whole feature depends on. .draw()/
 * .toMessage() are never called on any of these tables - roll() is silent,
 * non-mutating, and posts nothing; the one card built at the end is the
 * only chat output.
 */

const ROLL_TABLES_PACK = `${game.system?.id ?? "carl-rpg"}.roll-tables`;
const ITEM_TYPE_TABLE_NAME = "Item Type";

/**
 * @param {string} tierKey  A key into CONFIG.CARLRPG.lootBoxTiers.
 * @returns {Promise<ChatMessage|null>}
 */
export async function rollMagicItem(tierKey) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[tierKey];
  if (!tier) return null;

  if (tier.rolls === 0) {
    return createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.LootCardTitle"),
      subtitle: game.i18n.localize(tier.label),
      body: `<p>${game.i18n.localize("CARLRPG.Toolbox.LootMundane")}</p>`,
    });
  }

  const pack = game.packs.get(ROLL_TABLES_PACK);
  const index = await pack?.getIndex();
  const itemTypeEntry = index?.find((e) => e.name === ITEM_TYPE_TABLE_NAME);
  const itemTypeTable = itemTypeEntry ? await pack.getDocument(itemTypeEntry._id) : null;
  if (!itemTypeTable) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.LootNoItemTypeTable"));
    return null;
  }

  const { results: itemTypeResults } = await itemTypeTable.roll({ recursive: false });
  const itemTypeLabel = itemTypeResults.find((r) => r.type === "text")?.name ?? "";
  const subTableLink = itemTypeResults.find((r) => r.type === "document");
  const subTable = subTableLink ? await fromUuid(subTableLink.documentUuid) : null;
  if (!subTable) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.LootNoItemTypeTable"));
    return null;
  }

  const properties = [];
  for (let i = 1; i <= tier.rolls; i++) {
    const { results } = await subTable.roll({ recursive: false });
    const uniqueLink = results.find((r) => r.type === "document");
    if (uniqueLink) {
      const multiplier = tier.rolls - i + 1;
      const uniqueTable = await fromUuid(uniqueLink.documentUuid);
      const uniqueResult = uniqueTable ? (await uniqueTable.roll({ recursive: false })).results[0] : null;
      properties.push({ unique: true, multiplier, text: uniqueResult?.name ?? "" });
      break;
    }
    const textResult = results.find((r) => r.type === "text");
    properties.push({ unique: false, text: textResult?.name ?? "" });
  }

  const rows = properties
    .map((p) =>
      p.unique
        ? game.i18n.format("CARLRPG.Toolbox.LootSomethingUnique", { multiplier: p.multiplier, result: p.text })
        : p.text
    )
    .map((line) => `<li>${line}</li>`)
    .join("");

  const showXValues = tier.xValues && properties.some((p) => !p.unique && (p.text === "+X Stat Bonus" || p.text === "+X Skill Bonus"));
  const xValuesHtml = showXValues
    ? `<p><em>${game.i18n.format("CARLRPG.Toolbox.LootXValues", { values: game.i18n.localize(tier.xValues) })}</em></p>`
    : "";

  const body = `<p>${game.i18n.format("CARLRPG.Toolbox.LootItemType", { name: itemTypeLabel })}</p><ol>${rows}</ol>${xValuesHtml}`;

  return createCardMessage({
    title: game.i18n.localize("CARLRPG.Toolbox.LootCardTitle"),
    subtitle: game.i18n.localize(tier.label),
    body,
  });
}
