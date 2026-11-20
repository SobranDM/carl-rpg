import { createCardMessage } from "../chat/chat-card.mjs";
import { copyData, PACKS } from "./packs.mjs";
import { currentFloor } from "./floor.mjs";
import { esc } from "./html.mjs";
import { changeEntry } from "../pdf-import/shared.mjs";
import { enchantmentKind, itemTypeKind, lootRowQuantity, lootRowSpecial } from "./enchantments.mjs";

/** Table 38's name (Randomized Magic Items, p.219). */
const ITEM_TYPE_TABLE_NAME = "Item Type";

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
    effectsTable: effects.name,
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

/**
 * Roll one effect of a magic draft again (the Loot Forge's per-effect
 * reroll): its effect table once more (Tables 39-41); Something Unique here
 * is worth one roll (p.219). The new effect is filled in for the recipient
 * (autofillMagicDraft).
 * @param {object} draft  A magic draft (changed in place).
 * @param {number} index  Which enchantment.
 * @param {{recipient?: Actor|null, floor?: number}} [options]
 * @returns {Promise<object>}  The draft.
 */
export async function rerollEnchantment(
  draft,
  index,
  { recipient = null, floor = currentFloor() } = {},
) {
  const table = draft.effectsTable ? await lootTable(draft.effectsTable) : null;
  if (!table || !draft.enchantments[index]) return draft;
  const rolled = (await table.roll({ recursive: false })).results;
  const unique = rolled.find((r) => r.type === "document" && r.documentUuid);
  let next;
  if (unique) {
    const linked = await fromUuid(unique.documentUuid);
    const uniqueTable = (await lootTable(linked?.name ?? "")) ?? linked;
    const text = uniqueTable
      ? ((await uniqueTable.roll({ recursive: false })).results[0]?.name ?? "")
      : "";
    next = { kind: "unique", text, multiplier: 1 };
  } else {
    const text = rolled.find((r) => r.type === "text")?.name ?? "";
    next = { kind: enchantmentKind(text), text };
  }
  draft.enchantments.splice(index, 1, next);
  return autofillMagicDraft(draft, { recipient, floor });
}

/**
 * Give a LootDraft to an actor: its items created on them, its gold added
 * to theirs (system.details.gold; an actor with none just gets the items).
 * @param {{gold?: number, entries: object[]}} draft
 * @param {Actor} actor
 * @param {{itemData?: object[]|null}} [options]  The draft's Item data, if
 *   already made (lootItemData).
 * @returns {Promise<{items: Item[], gold: number}>}
 */
export async function grantLoot(draft, actor, { itemData = null } = {}) {
  const data = itemData ?? (await lootItemData(draft));
  const items = data.length ? await actor.createEmbeddedDocuments("Item", data) : [];
  const gold = Math.max(0, Math.floor(Number(draft?.gold) || 0));
  const hasGold = foundry.utils.hasProperty(actor.system ?? {}, "details.gold");
  if (gold && hasGold)
    await actor.update({ "system.details.gold": (actor.system.details.gold ?? 0) + gold });
  return { items, gold: hasGold ? gold : 0 };
}

/**
 * A LootDraft's items made in the world's Items directory, in a "Loot"
 * folder (made if missing). Gold isn't an item, so it isn't made.
 * @param {{entries: object[]}} draft
 * @returns {Promise<Item[]>}
 */
export async function createLootInWorld(draft) {
  const data = await lootItemData(draft);
  if (!data.length) return [];
  const name = game.i18n.localize("CARLRPG.Loot.Folder");
  const folder =
    game.folders.find((f) => f.type === "Item" && f.name === name && !f.folder) ??
    (await Folder.implementation.create({ name, type: "Item" }));
  return Item.implementation.createDocuments(data.map((d) => ({ ...d, folder: folder.id })));
}

/**
 * A LootDraft as HTML: its gold, then each entry (a magic item with its
 * enchantments).
 * @param {{gold?: number, entries: object[]}} draft
 * @returns {string}
 */
export function describeLoot(draft) {
  const lines = [];
  if (draft.gold)
    lines.push(`<li>${esc(game.i18n.format("CARLRPG.Loot.Gold", { gold: draft.gold }))}</li>`);
  for (const entry of draft.entries ?? []) lines.push(`<li>${entryLine(entry)}</li>`);
  return lines.length
    ? `<ul class="carl-loot-lines">${lines.join("")}</ul>`
    : `<p>${esc(game.i18n.localize("CARLRPG.Loot.Nothing"))}</p>`;
}

/** One LootEntry as an HTML line. */
function entryLine(entry) {
  const qty = entry.quantity > 1 ? ` ×${entry.quantity}` : "";
  switch (entry.kind) {
    case "magic": {
      const effects = entry.enchantments.map((e) => `<li>${esc(enchantmentLine(e))}</li>`).join("");
      return `<strong>${esc(entry.name)}</strong><ul>${effects}</ul>`;
    }
    case "spellScroll":
    case "spellbook":
      return esc(
        game.i18n.format(
          entry.kind === "spellScroll" ? "CARLRPG.Loot.ScrollName" : "CARLRPG.Loot.SpellbookName",
          {
            spell: entry.spellName,
            rank: entry.rank,
          },
        ),
      );
    default:
      return `${esc(entry.name)}${qty}`;
  }
}

/**
 * Post a LootDraft to chat: what it holds, and who it went to.
 * @param {{tierKey: string, gold?: number, entries: object[]}} draft
 * @param {{actor?: Actor|null, title?: string|null}} [options]
 * @returns {Promise<ChatMessage>}
 */
export function postLootCard(draft, { actor = null, title = null } = {}) {
  const tier = CONFIG.CARLRPG.lootBoxTiers[draft.tierKey];
  return createCardMessage({
    title:
      title ??
      (actor
        ? game.i18n.format("CARLRPG.Loot.CardTitleFor", { name: actor.name })
        : game.i18n.localize("CARLRPG.Loot.CardTitle")),
    subtitle: tier ? game.i18n.localize(tier.label) : "",
    img: tier?.img,
    body: describeLoot(draft),
  });
}

/**
 * The update that makes an existing item a magic draft (the Loot Forge's
 * Reforge, a Loot Box's reroll): its name, Bonuses, description and where
 * it's worn; its image and anything else are kept.
 * @param {object} draft  A magic draft.
 * @returns {object}  An Item update.
 */
export function magicItemUpdate(draft) {
  const data = buildMagicItemData(draft);
  return {
    name: data.name,
    "system.description": data.system.description,
    "system.slots": data.system.slots,
    "system.accessoryKind": data.system.accessoryKind,
    "system.changes": data.system.changes,
    "flags.carl-rpg.lootTier": draft.tierKey,
    // Every draft has the same keys, and its enchantments array is replaced
    // whole, so a merge leaves nothing of the old one.
    "flags.carl-rpg.magicDraft": data.flags["carl-rpg"].magicDraft,
  };
}
