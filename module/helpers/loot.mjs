import { createCardMessage } from "../chat/chat-card.mjs";
import { copyData, PACKS } from "./packs.mjs";
import { currentFloor } from "./floor.mjs";
import { esc } from "./html.mjs";
import { changeEntry } from "../pdf-import/shared.mjs";
import { enchantmentKind, itemTypeKind, lootRowQuantity, lootRowSpecial } from "./enchantments.mjs";

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

const ITEM_TYPE_TABLE_NAME = "Item Type";

/**
 * Roll one Randomized Magic Item and post it as a chat card.
 * @param {string} tierKey  A key into CONFIG.CARLRPG.lootBoxTiers.
 * @returns {Promise<ChatMessage|null>}
 */
export async function rollMagicItem(tierKey) {
  const result = await generateMagicItem(tierKey);
  if (!result) return null;
  return createCardMessage({
    title: game.i18n.localize("CARLRPG.Toolbox.LootCardTitle"),
    subtitle: game.i18n.localize(result.tier.label),
    body: describeMagicItem(result),
  });
}

/**
 * Roll one Randomized Magic Item without posting anything.
 * @param {string} tierKey  A key into CONFIG.CARLRPG.lootBoxTiers.
 * @returns {Promise<{tierKey: string, tier: object, itemType: string, properties: {unique: boolean, multiplier?: number, text: string}[]}|null>}
 *   itemType is "" for a mundane (Bronze) item. Null when the tier is
 *   unknown or the roll tables are missing.
 */
export async function generateMagicItem(tierKey) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[tierKey];
  if (!tier) return null;
  if (tier.rolls === 0) return { tierKey, tier, itemType: "", properties: [] };

  const pack = game.packs.get(PACKS.rollTables);
  const index = await pack?.getIndex();
  const itemTypeEntry = index?.find((e) => e.name === ITEM_TYPE_TABLE_NAME);
  const itemTypeTable = itemTypeEntry ? await pack.getDocument(itemTypeEntry._id) : null;
  if (!itemTypeTable) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.LootNoItemTypeTable"));
    return null;
  }

  const { results: itemTypeResults } = await itemTypeTable.roll({ recursive: false });
  const itemType = itemTypeResults.find((r) => r.type === "text")?.name ?? "";
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
      const uniqueResult = uniqueTable
        ? (await uniqueTable.roll({ recursive: false })).results[0]
        : null;
      properties.push({ unique: true, multiplier, text: uniqueResult?.name ?? "" });
      break;
    }
    const textResult = results.find((r) => r.type === "text");
    properties.push({ unique: false, text: textResult?.name ?? "" });
  }

  return { tierKey, tier, itemType, properties };
}

/**
 * HTML body for a rolled item: its type, one line per property, and the
 * tier's X values when a "+X" property came up.
 * @param {Awaited<ReturnType<typeof generateMagicItem>>} result
 * @returns {string}
 */
export function describeMagicItem({ tier, itemType, properties }) {
  if (tier.rolls === 0) return `<p>${game.i18n.localize("CARLRPG.Toolbox.LootMundane")}</p>`;

  const rows = properties
    .map((p) =>
      p.unique
        ? game.i18n.format("CARLRPG.Toolbox.LootSomethingUnique", {
            multiplier: p.multiplier,
            result: p.text,
          })
        : p.text,
    )
    .map((line) => `<li>${line}</li>`)
    .join("");

  const showXValues =
    tier.xValues &&
    properties.some(
      (p) => !p.unique && (p.text === "+X Stat Bonus" || p.text === "+X Skill Bonus"),
    );
  const xValuesHtml = showXValues
    ? `<p><em>${game.i18n.format("CARLRPG.Toolbox.LootXValues", { values: game.i18n.localize(tier.xValues) })}</em></p>`
    : "";

  return `<p>${game.i18n.format("CARLRPG.Toolbox.LootItemType", { name: itemType })}</p><ol>${rows}</ol>${xValuesHtml}`;
}

/**
 * Turn a rolled item into gear Item data, named for its tier and type
 * ("Gold Enchanted Accessory") so the GM has a starting point to rename and
 * rebalance before handing it out.
 * @param {Awaited<ReturnType<typeof generateMagicItem>>} result
 * @returns {object}  Item creation data.
 */
export function buildLootItemData(result) {
  const tierLabel = game.i18n.localize(result.tier.label);
  const typeLabel = result.itemType || game.i18n.localize("CARLRPG.LootBox.MundaneItem");
  return {
    name: `${tierLabel} ${typeLabel}`,
    type: "item",
    system: { description: describeMagicItem(result) },
    flags: { "carl-rpg": { lootTier: result.tierKey } },
  };
}

/* -------------------------------------------- */
/*  The loot generator (0.8.0)                  */
/* -------------------------------------------- */

/**
 * What a loot box holds, rolled (docs/loot-and-achievements.md; Loot,
 * pp.215-220). One draft serves every way loot is made - the GM Toolbox's
 * Roll Loot, a Loot Box actor, a Box item's contents, opening a box:
 *
 * LootDraft = {tierKey, gold, entries: LootEntry[]}, where a LootEntry is
 *  - {kind: "item", uuid, name, img, quantity}: a compendium or world item;
 *  - {kind: "spellScroll"|"spellbook", spellUuid, spellName, rank, img}: of a
 *    random Spell (Table 27);
 *  - {kind: "text", name, img, quantity}: a table row naming no item;
 *  - {kind: "magic", ...}: a magic item draft (generateMagicDraft).
 * Turned into Item data by lootItemData. Tables are read by name, the
 * world's own copy first, so a GM's edits win.
 */

/**
 * A loot Roll Table by name: the world's own copy (a GM's edits) first, else
 * the system's.
 * @param {string} name
 * @returns {Promise<RollTable|null>}
 */
export async function lootTable(name) {
  const world = game.tables?.getName?.(name);
  if (world) return world;
  const pack = game.packs.get(PACKS.rollTables);
  const entry = (await pack?.getIndex())?.find((e) => e.name === name);
  return entry ? pack.getDocument(entry._id) : null;
}

/** A tier key as the tables name it ("bronze" -> "Bronze"). */
function tierName(tierKey) {
  return tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
}

/**
 * A number, or a Roll formula's total; "" or none is 0.
 * @param {number|string|null|undefined} formula
 * @returns {Promise<number>}
 */
async function rollTotal(formula) {
  if (typeof formula === "number") return formula;
  if (!formula) return 0;
  const roll = await new Roll(String(formula)).evaluate({ allowInteractive: false });
  return Math.max(0, Math.floor(roll.total));
}

/** A whole number in {min, max}, both included. */
function randomIn({ min, max }) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** A random member of a list, or null for an empty one. */
function pickFrom(list) {
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/**
 * Roll a box's contents.
 * @param {string} tierKey  A key into CONFIG.CARLRPG.lootBoxTiers.
 * @param {{recipient?: Actor|null, floor?: number}} [options]
 *   recipient: whose box it is - a magic item's percentage Stat and Skill
 *   are worked out for them (autofillMagicDraft).
 * @returns {Promise<{tierKey: string, gold: number, entries: object[]}|null>}  Null for an unknown tier.
 */
export async function generateLoot(tierKey, { recipient = null, floor = currentFloor() } = {}) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[tierKey];
  if (!tier) return null;
  const ctx = { tierKey, recipient, floor };
  const entries = [];
  const draw = async (suffix, count) => {
    const table = count > 0 ? await lootTable(`${tierName(tierKey)} Box: ${suffix}`) : null;
    for (let i = 0; i < (table ? count : 0); i++) {
      const { results } = await table.roll({ recursive: false });
      for (const result of results) {
        const entry = await rowEntry(result, ctx);
        if (entry) entries.push(entry);
      }
    }
  };
  const gold = await rollTotal(tier.gold);
  await draw("Mundane", await rollTotal(tier.mundane));
  await draw("Consumables", await rollTotal(tier.consumables));
  if (tier.weakMagicChance && Math.random() < tier.weakMagicChance) await draw("Weak Magic", 1);
  for (let i = 0; i < (tier.magicItems ?? 0); i++) {
    const magic = await generateMagicDraft(tierKey, { recipient, floor });
    if (magic) entries.push(magic);
  }
  return { tierKey, gold, entries };
}

/**
 * One rolled table row as a LootEntry: its name's quantity ("Torch ×10",
 * "Bandages (1d6)"), and the rows that roll something - a Spell Scroll or
 * Spellbook of a random Spell, or a Magic Item (helpers/enchantments.mjs
 * lootRowSpecial).
 * @param {TableResult} result
 * @param {{tierKey: string, recipient: Actor|null, floor: number}} ctx
 * @returns {Promise<object|null>}
 */
async function rowEntry(result, ctx) {
  const { name, quantity } = lootRowQuantity(result.name);
  const special = lootRowSpecial(name);
  if (special === "magicItem") return generateMagicDraft(ctx.tierKey, ctx);
  if (special) return spellEntry(special, ctx.tierKey);
  const count = Math.max(1, await rollTotal(quantity));
  if (result.type === "document" && result.documentUuid) {
    return { kind: "item", uuid: result.documentUuid, name, img: result.img, quantity: count };
  }
  return { kind: "text", name, img: result.img || "icons/svg/item-bag.svg", quantity: count };
}

/**
 * A Spell Scroll or Spellbook of a random Spell (Table 27, Random Spells) at
 * the tier's Spell Rank.
 * @param {"spellScroll"|"spellbook"} kind
 * @param {string} tierKey
 * @returns {Promise<object|null>}
 */
async function spellEntry(kind, tierKey) {
  const spell = await randomSpell();
  if (!spell) return null;
  const rank = Math.max(1, await rollTotal(CONFIG.CARLRPG.lootBoxTiers[tierKey].spellRank));
  const img =
    kind === "spellScroll"
      ? "icons/sundries/scrolls/scroll-bound-blue-red.webp"
      : "icons/sundries/books/book-backed-wood-tan.webp";
  return { kind, spellUuid: spell.uuid, spellName: spell.name, rank, img };
}

/**
 * A random Spell from Table 27 (Random Spells).
 * @returns {Promise<{uuid: string, name: string}|null>}
 */
async function randomSpell() {
  const table = await lootTable("Random Spells");
  if (!table) return null;
  const { results } = await table.roll({ recursive: false });
  const linked = results.find((r) => r.type === "document" && r.documentUuid);
  return linked ? { uuid: linked.documentUuid, name: linked.name } : null;
}

/**
 * Roll a magic item (Randomized Magic Items, pp.219-220): Item Type (Table
 * 38), then its effect table (39-41) the tier's number of times - stopping
 * at Something Unique (Table 42), which is stronger for each roll it cut
 * short. Each effect becomes a typed enchantment
 * (helpers/enchantments.mjs enchantmentKind), then filled in
 * (autofillMagicDraft).
 * @param {string} tierKey
 * @param {{recipient?: Actor|null, floor?: number}} [options]
 * @returns {Promise<object|null>}  A magic draft:
 *   {kind: "magic", tierKey, itemType: "mundane"|"clothing"|"accessory", typeLabel,
 *    enchantments: {kind, text, value?, target?, percent?, multiplier?}[], name, slots, accessoryKind}.
 *   Null for a tier with no rolls (Bronze) or missing tables.
 */
export async function generateMagicDraft(
  tierKey,
  { recipient = null, floor = currentFloor() } = {},
) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[tierKey];
  if (!tier?.rolls) return null;
  const itemTypeTable = await lootTable(ITEM_TYPE_TABLE_NAME);
  if (!itemTypeTable) return null;
  const { results } = await itemTypeTable.roll({ recursive: false });
  const typeLabel = results.find((r) => r.type === "text")?.name ?? "";
  const link = results.find((r) => r.type === "document")?.documentUuid;
  const linked = link ? await fromUuid(link) : null;
  // The world's own copy of the effect table, if the GM made one.
  const effects = linked ? ((await lootTable(linked.name)) ?? linked) : null;
  if (!effects) return null;

  const enchantments = [];
  for (let i = 1; i <= tier.rolls; i++) {
    const rolled = (await effects.roll({ recursive: false })).results;
    const unique = rolled.find((r) => r.type === "document" && r.documentUuid);
    if (unique) {
      const uniqueTable =
        (await lootTable((await fromUuid(unique.documentUuid))?.name ?? "")) ??
        (await fromUuid(unique.documentUuid));
      const text = uniqueTable
        ? ((await uniqueTable.roll({ recursive: false })).results[0]?.name ?? "")
        : "";
      enchantments.push({ kind: "unique", text, multiplier: tier.rolls - i + 1 });
      break;
    }
    const text = rolled.find((r) => r.type === "text")?.name ?? "";
    enchantments.push({ kind: enchantmentKind(text), text });
  }
  const draft = {
    kind: "magic",
    tierKey,
    itemType: itemTypeKind(typeLabel),
    typeLabel,
    enchantments,
    name: "",
    slots: [],
    accessoryKind: "",
  };
  return autofillMagicDraft(draft, { recipient, floor });
}

/**
 * Fill in a magic draft's choices so it can be handed out as it is (ruled
 * 2026-11-19: auto-filled, the GM edits after): each X in the tier's range
 * (p.220); a Stat, a Skill the recipient owns, an uncommon damage type
 * (Table 10) - a repeat goes to a different one (p.219); a Passive Skill's
 * Rank is the Floor; an Inherent Spell is a random Spell at the Skill X;
 * a name and where it's worn (CONFIG.CARLRPG.magicItemNames). A percentage
 * Stat is worked out from the recipient's Stat, rounded down (p.220); with
 * no recipient it stays a percentage for the GM to set. Choices already made
 * are kept.
 * @param {object} draft  A magic draft (changed in place).
 * @param {{recipient?: Actor|null, floor?: number}} [options]
 * @returns {Promise<object>}  The draft.
 */
export async function autofillMagicDraft(draft, { recipient = null, floor = currentFloor() } = {}) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[draft.tierKey];
  const used = { stat: new Set(), skill: new Set(), resistance: new Set() };
  for (const e of draft.enchantments) if (e.target) used[e.kind]?.add(e.target);
  const fresh = (kind, list) => {
    const choice = pickFrom(list.filter((x) => !used[kind].has(x))) ?? pickFrom(list);
    if (choice) used[kind].add(choice);
    return choice ?? "";
  };
  const ownSkills = recipient
    ? recipient.items
        .filter((i) => i.type === "skill" && i.system.category !== "passive")
        .map((i) => i.name)
    : [];
  for (const e of draft.enchantments) {
    switch (e.kind) {
      case "stat":
        e.target ||= fresh("stat", Object.keys(CONFIG.CARLRPG.stats));
        if (e.value === undefined || e.value === null)
          Object.assign(e, statBonus(tier.statX, recipient, e.target));
        break;
      case "skill":
        e.target ||= fresh("skill", ownSkills);
        e.value ??= tier.skillX ? randomIn(tier.skillX) : 1;
        break;
      case "resistance":
        e.target ||= fresh("resistance", CONFIG.CARLRPG.uncommonDamageTypes);
        break;
      case "dr":
        e.value ??= 1;
        break;
      case "passiveSkill":
        e.value ??= Math.max(1, Number(floor) || 1);
        e.target ??= "";
        break;
      case "inherentSpell": {
        if (!e.target) {
          const spell = await randomSpell();
          e.target = spell?.name ?? "";
          e.spellUuid = spell?.uuid ?? "";
        }
        e.value ??= tier.skillX ? randomIn(tier.skillX) : 1;
        break;
      }
    }
  }
  if (!draft.name || !draft.slots?.length) {
    const names = CONFIG.CARLRPG.magicItemNames;
    const thing = pickFrom(names.things[draft.itemType] ?? names.things.mundane);
    draft.slots = draft.slots?.length ? draft.slots : [thing.slot];
    draft.accessoryKind ||= thing.accessoryKind ?? "";
    draft.name ||= magicItemName(draft.tierKey, thing.name);
  }
  return draft;
}

/**
 * What "+X Stat Bonus" is worth at a tier (p.220): a number in the tier's
 * range, or a percentage of the recipient's Stat - rounded down, never under
 * the tier's `min` - fixed now. With no recipient a percentage stays one.
 * @param {{min?: number, max?: number, percent?: number}|null} statX
 * @param {Actor|null} recipient
 * @param {string} statKey
 * @returns {{value: number|null, percent: number|null}}
 */
export function statBonus(statX, recipient, statKey) {
  if (!statX) return { value: 2, percent: null };
  if (!statX.percent) return { value: randomIn(statX), percent: null };
  const stat = recipient?.system?.stats?.[statKey]?.value;
  if (!Number.isFinite(stat)) return { value: null, percent: statX.percent };
  return {
    value: Math.max(statX.min ?? 1, Math.floor((stat * statX.percent) / 100)),
    percent: statX.percent,
  };
}

/**
 * A rolled item's name (p.220): "The [thing] of the [adjective] [creator]",
 * with "Enchanted" in front at Gold, Platinum and Legendary.
 * @param {string} tierKey
 * @param {string} thing
 * @returns {string}
 */
export function magicItemName(tierKey, thing) {
  const names = CONFIG.CARLRPG.magicItemNames;
  const enchanted = names.enchantedTiers.includes(tierKey) ? "Enchanted " : "";
  return `${enchanted}${thing} of the ${pickFrom(names.adjectives)} ${pickFrom(names.creators)}`;
}

/**
 * One enchantment as a line of the item's description.
 * @param {object} e
 * @returns {string}  Plain text.
 */
export function enchantmentLine(e) {
  const i18n = game.i18n;
  const stat = (key) => (key ? i18n.localize(CONFIG.CARLRPG.stats[key] ?? key) : "");
  const key = `CARLRPG.Loot.Enchantment.${e.kind}`;
  switch (e.kind) {
    case "stat":
      return e.value === null || e.value === undefined
        ? i18n.format(`${key}Percent`, { percent: e.percent, stat: stat(e.target) })
        : i18n.format(key, { value: e.value, stat: stat(e.target) });
    case "skill":
      return e.target
        ? i18n.format(key, { value: e.value, skill: e.target })
        : i18n.format(`${key}Choice`, { value: e.value });
    case "passiveSkill":
      return e.target
        ? i18n.format(key, { value: e.value, skill: e.target })
        : i18n.format(`${key}Choice`, { value: e.value });
    case "resistance":
      return i18n.format(key, {
        type: i18n.localize(CONFIG.CARLRPG.damageTypes[e.target] ?? e.target ?? ""),
      });
    case "dr":
      return i18n.format(key, { value: e.value ?? 1 });
    case "inherentSpell":
      return i18n.format(key, {
        spell: e.target || "?",
        rank: e.value,
        hours: 2 * (Number(e.value) || 1),
      });
    case "unique":
      return i18n.format(key, { multiplier: e.multiplier ?? 1, text: e.text });
    default:
      return e.text ?? "";
  }
}

/**
 * A magic draft as gear Item data: its Bonuses (a Stat, a Skill's Rank, a
 * Passive Skill at its Rank, a Resistance, DR - module/data/shared/
 * change-entry.mjs) and every enchantment listed in the description. The
 * draft rides along (flags.carl-rpg.magicDraft) so the Item Forge can edit
 * it again.
 * @param {object} draft
 * @returns {object}  Item creation data.
 */
export function buildMagicItemData(draft) {
  const label = draft.name;
  const changes = [];
  for (const e of draft.enchantments) {
    const v = Number(e.value);
    if (e.kind === "stat" && e.target && Number.isFinite(v) && e.value !== null) {
      changes.push(changeEntry({ label, targetType: "stat", target: e.target, value: String(v) }));
    } else if (
      (e.kind === "skill" || e.kind === "passiveSkill") &&
      e.target &&
      Number.isFinite(v)
    ) {
      changes.push(
        changeEntry({ label, targetType: "skillRank", target: e.target, value: String(v) }),
      );
    } else if (e.kind === "resistance" && e.target) {
      changes.push(
        changeEntry({
          label,
          targetType: "resistance",
          target: e.target,
          mode: "override",
          value: "resist",
        }),
      );
    } else if (e.kind === "dr") {
      changes.push(
        changeEntry({
          label,
          targetType: "resource",
          target: "dr",
          value: String(Number.isFinite(v) ? v : 1),
        }),
      );
    }
  }
  const lines = draft.enchantments.map((e) => `<li>${esc(enchantmentLine(e))}</li>`).join("");
  return {
    name: draft.name,
    type: "item",
    img: "icons/svg/item-bag.svg",
    system: {
      description: `<p>${esc(draft.typeLabel)}</p><ul>${lines}</ul>`,
      slots: [...(draft.slots ?? [])],
      accessoryKind: draft.accessoryKind ?? "",
      changes,
    },
    flags: { "carl-rpg": { lootTier: draft.tierKey, magicDraft: foundry.utils.deepClone(draft) } },
  };
}

/**
 * A LootDraft's entries as Item creation data, ready to put on an actor or
 * in the world.
 * @param {{entries: object[]}} draft
 * @returns {Promise<object[]>}
 */
export async function lootItemData(draft) {
  const out = [];
  for (const entry of draft?.entries ?? []) {
    const data = await entryItemData(entry);
    if (data) out.push(data);
  }
  return out;
}

/**
 * One LootEntry as Item creation data.
 * @param {object} entry
 * @returns {Promise<object|null>}  Null when its item can't be found.
 */
export async function entryItemData(entry) {
  switch (entry.kind) {
    case "magic":
      return buildMagicItemData(entry);
    case "item": {
      const doc = await fromUuid(entry.uuid);
      if (!doc) return null;
      const data = copyData(doc);
      if (entry.quantity > 1) foundry.utils.setProperty(data, "system.quantity", entry.quantity);
      return data;
    }
    case "spellScroll":
    case "spellbook": {
      const scroll = entry.kind === "spellScroll";
      const name = game.i18n.format(
        scroll ? "CARLRPG.Loot.ScrollName" : "CARLRPG.Loot.SpellbookName",
        {
          spell: entry.spellName,
          rank: entry.rank,
        },
      );
      return {
        name,
        type: "item",
        img: entry.img,
        system: {
          description: `<p>${esc(
            game.i18n.format(scroll ? "CARLRPG.Loot.ScrollText" : "CARLRPG.Loot.SpellbookText", {
              spell: entry.spellName,
              rank: entry.rank,
            }),
          )}</p>`,
          consumable: {
            kind: scroll ? "scroll" : "spellbook",
            spell: { name: entry.spellName, uuid: entry.spellUuid, rank: entry.rank },
          },
        },
      };
    }
    case "text":
      return {
        name: entry.name,
        type: "item",
        img: entry.img,
        system: { description: "", quantity: entry.quantity ?? 1 },
      };
    default:
      return null;
  }
}
