import {
  autofillMagicDraft,
  describeLoot,
  generateLoot,
  grantLoot,
  lootItemData,
  postLootCard,
} from "./loot.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { confirmUndoable } from "./confirm.mjs";
import { esc } from "./html.mjs";

/**
 * Boxes (data/box.mjs; docs/loot-and-achievements.md): giving a crawler an
 * unopened loot box, the GM preparing what's in it, and opening it. Every
 * write is the GM's - a player can't change a Box (documents/item.mjs).
 */

/** A tier's place, Bronze first (the order boxes are shown and opened in). */
export function boxTierRank(tierKey) {
  const rank = Object.keys(CONFIG.CARLRPG.lootBoxTiers).indexOf(tierKey);
  return rank < 0 ? Infinity : rank;
}

/**
 * A crawler's unopened boxes, Bronze to Celestial, then by name.
 * @param {Actor} actor
 * @returns {Item[]}
 */
export function boxesOf(actor) {
  return (actor?.items ?? [])
    .filter((i) => i.type === "box")
    .sort(
      (a, b) =>
        boxTierRank(a.system.tier) - boxTierRank(b.system.tier) || a.name.localeCompare(b.name),
    );
}

/**
 * A box's default title: "Bronze Box", or "Bronze Boss Box" for a Boss's
 * (p.22).
 * @param {string} tierKey
 * @param {string} [kind]  The box's source kind.
 * @returns {string}
 */
export function boxName(tierKey, kind = "") {
  const tier = game.i18n.localize(CONFIG.CARLRPG.lootBoxTiers[tierKey]?.label ?? tierKey);
  return game.i18n.format(kind === "boss" ? "CARLRPG.Box.BossName" : "CARLRPG.Box.Name", {
    tier,
  });
}

/**
 * Give a crawler a box (GM).
 * @param {Actor} actor  A Character.
 * @param {object} options
 * @param {string} options.tierKey
 * @param {string} [options.name]  Its title; default boxName.
 * @param {{kind?: string, uuid?: string}} [options.source]
 * @param {string} [options.description]
 * @returns {Promise<Item|null>}
 */
export async function giveBox(actor, { tierKey, name = "", source = {}, description = "" }) {
  if (!game.user.isGM || actor?.type !== "character") return null;
  const kind = source.kind ?? "gift";
  const [box] = await actor.createEmbeddedDocuments("Item", [
    {
      name: name || boxName(tierKey, kind),
      type: "box",
      img: CONFIG.CARLRPG.lootBoxTiers[tierKey]?.img,
      system: { tier: tierKey, description, source: { kind, uuid: source.uuid ?? "" } },
    },
  ]);
  return box ?? null;
}

/**
 * What a box's sheet shows: everyone sees its art, title, tier and
 * description; only the GM sees where it came from and what's in it
 * (ruled 2026-11-19).
 * @param {Item} box
 * @param {boolean} isGM
 * @returns {{name: string, img: string, tierLabel: string, description: string, gm: object|null}}
 */
export function boxView(box, isGM) {
  const sys = box.system;
  const view = {
    name: box.name,
    img: box.img,
    tierLabel: CONFIG.CARLRPG.lootBoxTiers[sys.tier]?.label ?? sys.tier,
    description: sys.description,
    gm: null,
  };
  if (!isGM) return view;
  const prepared = sys.contents.mode === "prepared";
  view.gm = {
    prepared,
    contentsHTML: prepared
      ? describeLoot({ tierKey: sys.tier, gold: sys.contents.gold, entries: sys.contents.entries })
      : "",
    sourceLabel: sys.source.kind ? `CARLRPG.Box.Source.${sys.source.kind}` : "",
    sourceUuid: sys.source.uuid,
    canOpen: box.parent?.type === "character",
  };
  return view;
}

/**
 * The box's contents as a LootDraft to prepare in the Loot Forge: what the
 * GM prepared, or a fresh roll for its crawler.
 * @param {Item} box
 * @returns {Promise<{tierKey: string, gold: number, entries: object[]}|null>}
 */
export async function boxDraftForForge(box) {
  const sys = box.system;
  if (sys.contents.mode === "prepared") {
    return {
      tierKey: sys.tier,
      gold: sys.contents.gold,
      entries: foundry.utils.deepClone(sys.contents.entries),
    };
  }
  const owner = box.parent?.type === "character" ? box.parent : null;
  return generateLoot(sys.tier, { recipient: owner });
}

/**
 * Store a LootDraft as the box's prepared contents (GM); the draft's tier
 * becomes the box's (and its art, documents/item.mjs).
 * @param {Item} box
 * @param {{tierKey: string, gold?: number, entries: object[]}} draft
 * @returns {Promise<Item>}
 */
export function prepareBox(box, draft) {
  return box.update({
    "system.tier": draft.tierKey,
    "system.contents": {
      mode: "prepared",
      gold: Math.max(0, Math.floor(Number(draft.gold) || 0)),
      entries: draft.entries,
    },
  });
}

/**
 * Ask before a box's prepared contents are thrown away for "Roll When
 * Opened" (ruled 2026-11-27); Shift-click skips it (helpers/confirm.mjs).
 * @param {Event} event  The click.
 * @param {string} name  The crawler the box is for.
 * @returns {Promise<boolean>}
 */
export function confirmClearBox(event, name) {
  return confirmUndoable(event, {
    title: game.i18n.localize("CARLRPG.Box.RandomizeTitle"),
    content: `<p>${game.i18n.format("CARLRPG.Box.RandomizeText", { name: esc(name) })}</p>`,
  });
}

/**
 * Back to random contents, rolled when it's opened (GM).
 * @param {Item} box
 * @returns {Promise<Item>}
 */
export function clearBoxContents(box) {
  return box.update({ "system.contents": { mode: "random", gold: 0, entries: [] } });
}

/**
 * Open a crawler's box (GM): its contents - prepared, or rolled now for the
 * crawler (generateLoot) - go on their sheet, the gold to theirs (ruled
 * 2026-11-19: all of it to the crawler who opens it), the box is deleted,
 * and a card is posted. Runs in the crawler's queue and checks the box is
 * still there, so it can't be opened twice. If anything in it can't be
 * found (a prepared item deleted since), nothing is given and the box stays.
 * @param {Item} box  A Box on a Character.
 * @returns {Promise<{boxName: string, tierKey: string, img: string, gold: number,
 *   items: {name: string, img: string, quantity: number}[]}|null>}
 *   What came out, as plain data (the opening session shows it to everyone).
 */
export function openBox(box) {
  const actor = box?.parent;
  if (!game.user.isGM || box?.type !== "box" || actor?.type !== "character") {
    return Promise.resolve(null);
  }
  return queueForActor(actor.uuid, async () => {
    const live = actor.items.get(box.id);
    if (!live) return null;
    const sys = live.system;
    let draft;
    if (sys.contents.mode === "prepared") {
      draft = {
        tierKey: sys.tier,
        gold: sys.contents.gold,
        entries: foundry.utils.deepClone(sys.contents.entries),
      };
      // Prepared in the sidebar, it had no one to fill its choices in for.
      for (const entry of draft.entries) {
        if (entry.kind === "magic") await autofillMagicDraft(entry, { recipient: actor });
      }
    } else {
      draft = await generateLoot(sys.tier, { recipient: actor });
    }
    if (!draft) return null;
    const itemData = await lootItemData(draft);
    if (itemData.length !== draft.entries.length) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Box.MissingContents", { name: live.name }));
      return null;
    }
    const { gold } = await grantLoot(draft, actor, { itemData });
    const summary = {
      boxName: live.name,
      tierKey: sys.tier,
      img: live.img,
      gold,
      items: itemData.map((d) => ({
        name: d.name,
        img: d.img,
        quantity: Number(d.system?.quantity) || 1,
      })),
    };
    await markRewarded(live);
    await live.delete();
    await postLootCard(draft, {
      actor,
      title: game.i18n.format("CARLRPG.Box.OpenedTitle", {
        name: actor.name,
        box: summary.boxName,
      }),
    });
    return summary;
  });
}

/**
 * The achievement a box came from is rewarded once the box is opened
 * (data/achievement.mjs `rewarded`).
 * @param {Item} box
 * @returns {Promise<void>}
 */
async function markRewarded(box) {
  const { kind, uuid } = box.system.source;
  if (kind !== "achievement" || !uuid) return;
  const copy = await fromUuid(uuid);
  if (copy?.type === "achievement" && !copy.system.rewarded) {
    await copy.update({ "system.rewarded": true });
  }
}
