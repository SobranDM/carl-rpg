/**
 * Write parsed rulebook content into the world (ruled 2026-11-18, Q1):
 * each book gets world compendiums of its own, one per document type it
 * imports - Mobs (Actors, filed by Floor, then Neighborhood or Quest), gear
 * and Spells (Items, in a Gear and a Spells folder), achievements (one
 * Journal Entry) - grouped in a sidebar folder
 * named after the book. Maps stay world Scenes, in a Scenes folder named
 * after the book, so they're ready to play.
 *
 * A book is known by its fixed id (books.mjs: "core", "toolkit"), read from
 * its title page; its compendiums, folders and flags carry that id. Stored
 * ids are always read through books.mjs bookIdOf, so an earlier development
 * import, keyed by a slug of its file name, is found and updated too.
 *
 * A Spell or piece of gear that a compendium already has is written as that
 * copy instead of the parse (compendium-match.mjs). Importing the same book
 * again updates its documents rather than making copies, except ones the GM
 * has edited since (fingerprint.mjs) - reported as skipped. A Mob's Attacks
 * are refreshed the same way, each on its own.
 *
 * Nothing here is written to the system's compendiums: the books are not
 * ours to redistribute, so their content only ever lives in the GM's world.
 * Documents an earlier version imported into world folders stay there; a
 * re-import into the compendiums doesn't see them.
 */

import { buildMatcher, MATCH_TYPES, matchKind, SYSTEM_PACKS, TIERS } from "./compendium-match.mjs";
import { importStamp, importState } from "./fingerprint.mjs";
import { canvasToBlob, mapImageCanvas, mapSceneData, uploadMap } from "./maps.mjs";
import { getPdfJs } from "./pdf-loader.mjs";
import { bookIdOf } from "./books.mjs";
import { slugify } from "./scan.mjs";
import { sectionFolders } from "./sections.mjs";
import { LEGACY_FLAG, legacyAttackItems, MOB_ATTACK_TYPE } from "../helpers/mob-attacks.mjs";
import { copyData, withUnlockedPack } from "../helpers/packs.mjs";

const SCOPE = "carl-rpg";
const FLAG = "pdfImport";

/** A book's compendium for each document type: its name suffix and label. */
// JournalEntry: the achievements journal of an import before 0.8.0 (they're
// Achievement items now), still found by findBookPack.
const PACK_KINDS = { Actor: "mobs", Item: "items", JournalEntry: "achievements" };

/** The flags every imported document carries (its stamp is added after the write). */
const importFlags = (book, page) => ({ [SCOPE]: { [FLAG]: { book, ...(page ? { page } : {}) } } });

/** The book id an import flag names (books.mjs bookIdOf). */
const bookOfFlag = (flag) => bookIdOf(flag?.book);

/**
 * The book's top-level Scenes folder: by its flag, else by the book's title,
 * else (an earlier import's, which had no flag) by a name whose slug the
 * book was once keyed by. Flagged when found without one, so a GM may
 * rename it; made if missing.
 */
async function sceneFolder(book, title) {
  const top = game.folders.filter((f) => f.type === "Scene" && !f.folder);
  const found =
    top.find((f) => bookOfFlag(f.getFlag(SCOPE, FLAG)) === book) ??
    top.find((f) => f.name === title) ??
    top.find(
      (f) =>
        !f.getFlag(SCOPE, FLAG) && slugify(f.name) !== book && bookIdOf(slugify(f.name)) === book,
    );
  if (found) {
    if (!found.getFlag(SCOPE, FLAG)) await found.setFlag(SCOPE, FLAG, { book });
    return found;
  }
  return Folder.implementation.create({ name: title, type: "Scene", flags: importFlags(book) });
}

/**
 * A book's world compendium for one document type, if it has one: by the
 * flag the import gave it, else by its name - each read as a book id
 * (books.mjs bookIdOf), so an earlier import's file-name key still counts.
 * @param {string} book  The book's id.
 * @param {"Actor"|"Item"|"JournalEntry"} documentName
 * @returns {CompendiumCollection|null}
 */
export function findBookPack(book, documentName) {
  // No book, no pack (an unflagged pack's undefined would match).
  if (!book) return null;
  const world = game.packs.filter(
    (p) => p.metadata.packageType === "world" && p.documentName === documentName,
  );
  const named = (p) => {
    const m = p.metadata.name.match(/^pdf-import-(.+)-([a-z]+)$/);
    return !!m && m[2] === PACK_KINDS[documentName] && bookIdOf(m[1]) === book;
  };
  return (
    world.find((p) => bookOfFlag(p.metadata.flags?.[SCOPE]?.[FLAG]) === book) ??
    world.find(named) ??
    null
  );
}

function packName(book, documentName) {
  return `pdf-import-${book}-${PACK_KINDS[documentName]}`;
}

/**
 * A book's world compendium for one document type, made if it has none.
 * GM-only, as the world folders were (players see none of the book).
 */
async function bookPack(book, title, documentName) {
  const found = findBookPack(book, documentName);
  if (found) return found;
  const kind = game.i18n.localize(`CARLRPG.PdfImport.Kind.${PACK_KINDS[documentName]}`);
  const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
    type: documentName,
    name: packName(book, documentName),
    label: game.i18n.format("CARLRPG.PdfImport.PackLabel", { title, kind }),
    flags: importFlags(book),
    ownership: { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "OWNER" },
  });
  // Grouped in the Compendiums sidebar under the book's name.
  const folder =
    game.folders.find(
      (f) => f.type === "Compendium" && bookOfFlag(f.getFlag(SCOPE, FLAG)) === book,
    ) ??
    (await Folder.implementation.create({
      name: title,
      type: "Compendium",
      flags: importFlags(book),
    }));
  await pack.configure({ folder: folder.id });
  return pack;
}

/** A top-level folder of the pack by name, made if missing. */
async function packFolder(pack, name) {
  return (
    pack.folders.find((f) => f.name === name && !f.folder) ??
    Folder.implementation.create({ name, type: pack.documentName }, { pack: pack.collection })
  );
}

/**
 * The book's Mobs by where they're found (sections.mjs): a folder per Floor
 * ("Floor 3: The Over City"), in it one per Neighborhood or Quest, and one
 * for Mobs on no Floor. Folders are found again by their flag (a GM may
 * rename them), else by name, else made, in the book's order; their Mobs
 * sort by Level, then name.
 * @param {CompendiumCollection} pack
 * @param {object[]} mobs  Parsed entries (deduped), with their `section`.
 * @param {string} book
 * @returns {Promise<Map<string, {folder: string, sort: number}>>}  By "type:name".
 */
async function mobPlaces(pack, mobs, book) {
  const labels = {
    floor: (n) => game.i18n.format("CARLRPG.PdfImport.FloorFolder", { n }),
    other: game.i18n.localize("CARLRPG.PdfImport.OtherMobs"),
    neighborhood: game.i18n.localize("CARLRPG.PdfImport.Neighborhood"),
    quest: game.i18n.localize("CARLRPG.PdfImport.Quest"),
  };
  const ids = new Map();
  const folderId = async (path) => {
    let parent = null;
    for (const step of path) {
      if (!ids.has(step.key)) {
        const found =
          pack.folders.find((f) => f.getFlag(SCOPE, FLAG)?.section === step.key) ??
          pack.folders.find((f) => f.name === step.name && (f._source.folder ?? null) === parent);
        const folder =
          found ??
          (await Folder.implementation.create(
            {
              name: step.name,
              type: "Actor",
              folder: parent,
              sort: step.sort,
              sorting: "m",
              flags: { [SCOPE]: { [FLAG]: { book, section: step.key } } },
            },
            { pack: pack.collection },
          ));
        ids.set(step.key, folder.id);
      }
      parent = ids.get(step.key);
    }
    return parent;
  };
  const byFolder = new Map();
  for (const mob of mobs) {
    const folder = await folderId(sectionFolders(mob.section, labels));
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(mob);
  }
  const places = new Map();
  for (const [folder, list] of byFolder) {
    list
      .sort(
        (a, b) =>
          (a.data.system?.level ?? 0) - (b.data.system?.level ?? 0) || a.name.localeCompare(b.name),
      )
      .forEach((mob, i) =>
        places.set(`${mob.data.type}:${mob.name}`, { folder, sort: (i + 1) * 1000 }),
      );
  }
  return places;
}

/**
 * The same name can appear twice in one book (a Mob reprinted in an
 * appendix with other stats). The first keeps its name; later ones get
 * their page added, so neither overwrites the other.
 */
function dedupe(docs) {
  const seen = new Set();
  return docs.map((doc) => {
    const key = `${doc.data.type}:${doc.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      return doc;
    }
    const name = `${doc.name} (p. ${doc.page})`;
    return { ...doc, name, data: { ...doc.data, name } };
  });
}

/**
 * Stamp freshly written documents with what was written (fingerprint.mjs).
 * Matched back to their data by key, never by position: createDocuments
 * doesn't return in input order.
 * @param {Document[]} written
 * @param {(doc: Document) => object|undefined} dataOf  The data written to it.
 * @param {(stamps: object[]) => Promise<unknown>} update
 */
async function stamp(written, dataOf, update) {
  const stamps = written
    .map((doc) => {
      const data = dataOf(doc);
      return data && { _id: doc.id, [`flags.${SCOPE}.${FLAG}`]: importStamp(doc._source, data) };
    })
    .filter(Boolean);
  if (stamps.length) await update(stamps);
}

/**
 * Create or update a book's documents of one type in its compendium.
 * @param {CompendiumCollection} pack
 * @param {object[]} docs  Parsed entries: {name, page, data, createData?}.
 * @param {string} book
 * @param {object} [options]
 * @param {(entry: object) => Promise<{folder?: string|null, sort?: number}>} [options.place]  Where
 *   a new one goes (its folder, and its place in it).
 * @param {boolean} [options.moveExisting]  Also put an unedited one there on
 *   re-import (a Mob into its Floor's folder); else it stays where the GM keeps it.
 * @param {(doc: Document, entry: object) => Promise<void>} [options.afterWrite]  Run for
 *   each document created or updated (an unchanged one too), with its entry.
 * @returns {Promise<{created: number, updated: number, skipped: string[]}>}
 */
async function upsert(
  pack,
  docs,
  book,
  { place = async () => ({}), moveExisting = false, afterWrite = null } = {},
) {
  const cls = pack.documentClass;
  const options = { pack: pack.collection };
  const keyOf = (d) => `${d.type}:${d.name}`;
  const existing = new Map((await pack.getDocuments()).map((d) => [keyOf(d), d]));
  const creates = [];
  const updates = [];
  const updated = [];
  const skipped = [];
  const entries = new Map();
  for (const doc of dedupe(docs)) {
    const key = keyOf(doc.data);
    entries.set(key, doc);
    const flags = foundry.utils.mergeObject(doc.data.flags ?? {}, importFlags(book, doc.page), {
      inplace: false,
    });
    const old = existing.get(key);
    if (old) {
      // Only what the import made and the GM left alone; a GM's own
      // document of the same name isn't touched either.
      if (importState(old._source, old.flags?.[SCOPE]?.[FLAG]) !== "untouched") {
        skipped.push(old.name);
        continue;
      }
      // A copy's source (_stats) is set when it's made. Folder and sort
      // aren't part of the fingerprint, so moving it isn't an edit.
      const { _stats, ...data } = doc.data;
      updates.push({ ...data, ...(moveExisting ? await place(doc) : {}), flags, _id: old.id });
      updated.push(old);
    } else {
      const data = { ...doc.data, folder: null, ...(await place(doc)), flags };
      // createData (a Boss's linked token) is sent on create only; it isn't
      // part of what's fingerprinted.
      creates.push(
        doc.createData ? foundry.utils.mergeObject(data, doc.createData, { inplace: false }) : data,
      );
    }
  }
  const made = creates.length ? ((await cls.createDocuments(creates, options)) ?? []) : [];
  // An update that changed nothing isn't returned: the existing document is current.
  const changed = updates.length ? ((await cls.updateDocuments(updates, options)) ?? []) : [];
  const byId = new Map(changed.map((d) => [d.id, d]));
  const written = [...made, ...updated.map((d) => byId.get(d.id) ?? d)];
  await stamp(
    written,
    (d) => entries.get(keyOf(d))?.data,
    (stamps) => cls.updateDocuments(stamps, options),
  );
  if (afterWrite) {
    for (const doc of written) {
      const entry = entries.get(keyOf(doc));
      if (entry) await afterWrite(doc, entry);
    }
  }
  return { created: creates.length, updated: updates.length, skipped };
}

/** An Attack item's data as written (and fingerprinted): not its id, place or flags. */
function attackData(item) {
  const { _id, sort, flags, ...data } = item;
  return data;
}

/**
 * Give an imported Mob its printed Attacks, and refresh them on a
 * re-import (Q5): an Attack the import made and the GM didn't edit is
 * updated in place (its place in the list kept); one the GM edited stays as
 * it is; one the book no longer prints is removed; a missing one (never
 * made, or deleted) is made. Attacks the GM added are never touched.
 * Matched by their place in the printed list (mob-attacks.mjs LEGACY_FLAG).
 * @param {Actor} actor
 * @param {object[]} attacks  The printed list, as parsed.
 * @returns {Promise<{created: number, updated: number, kept: number, deleted: number}>}
 */
export async function syncAttacks(actor, attacks) {
  const startSort = Math.max(0, ...actor.items.map((i) => i.sort ?? 0));
  const fresh = legacyAttackItems(attacks ?? [], { startSort });
  const indexOf = (item) =>
    item.getFlag ? item.getFlag(SCOPE, LEGACY_FLAG) : item.flags?.[SCOPE]?.[LEGACY_FLAG];
  const freshByIndex = new Map(fresh.map((item) => [indexOf(item), item]));
  const listed = actor.items.filter(
    (i) => i.type === MOB_ATTACK_TYPE && Number.isInteger(indexOf(i)),
  );
  const taken = new Set();
  const updates = [];
  const deletes = [];
  // Edited ones first, so an unedited duplicate of the same place goes.
  const edited = (item) => importState(item._source, item.getFlag(SCOPE, FLAG) ?? {}) === "edited";
  const ordered = [...listed].sort((a, b) => edited(b) - edited(a));
  let kept = 0;
  for (const item of ordered) {
    const index = indexOf(item);
    if (edited(item)) {
      taken.add(index);
      kept++;
      continue;
    }
    const replacement = freshByIndex.get(index);
    if (!replacement || taken.has(index)) {
      deletes.push(item.id);
      continue;
    }
    taken.add(index);
    updates.push({ _id: item.id, ...attackData(replacement) });
  }
  const creates = fresh.filter((item) => !taken.has(indexOf(item)));
  if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (creates.length) await actor.createEmbeddedDocuments("Item", creates, { keepId: true });
  // Stamp what was written, by place in the list.
  const written = new Set([...updates.map((u) => u._id), ...creates.map((c) => c._id)]);
  await stamp(
    actor.items.filter((i) => written.has(i.id)),
    (item) => {
      const data = freshByIndex.get(indexOf(item));
      return data && attackData(data);
    },
    (stamps) => actor.updateEmbeddedDocuments("Item", stamps),
  );
  return { created: creates.length, updated: updates.length, kept, deleted: deletes.length };
}

/**
 * A parsed Mob's data with its Attacks taken off (`legacyAttacks`): they're
 * written as `mobAttack` items after the Mob (syncAttacks).
 * @param {object} doc
 * @returns {object}
 */
function withAttacksApart(doc) {
  const { attacks = [], ...system } = doc.data?.system ?? {};
  return { ...doc, legacyAttacks: attacks, data: { ...doc.data, system } };
}

/**
 * Where a parsed Spell, gear or Skill name may come from instead (Q2),
 * best first (compendium-match.mjs). Never this book's own compendiums or
 * its earlier world-folder import.
 * @param {string|null} [book]  The book's id; none (CrawlerForge): nothing is left out.
 * @returns {Promise<import("./compendium-match.mjs").MatchCandidate[]>}
 */
export async function matchCandidates(book) {
  const out = [];
  const own = book ? findBookPack(book, "Item")?.collection : null;
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    const ofBook = pack.metadata.flags?.[SCOPE]?.[FLAG]?.book;
    if (book && (bookIdOf(ofBook) === book || pack.collection === own)) continue;
    const system = SYSTEM_PACKS.indexOf(pack.collection);
    // Another book's import (by its flag, else its name, as findBookPack),
    // else anything else (a module's, the GM's own).
    const rulebook =
      !!ofBook ||
      (pack.metadata.packageType === "world" && pack.metadata.name.startsWith("pdf-import-"));
    const tier = system >= 0 ? TIERS.system : rulebook ? TIERS.rulebook : TIERS.other;
    let index;
    try {
      index = await pack.getIndex({
        fields: [
          "type",
          "system.consumable.kind",
          "system.weaponSkill",
          "system.category",
          "system.isHandToHand",
          "system.noWeapon",
        ],
      });
    } catch (err) {
      console.warn(`CarlRPG | rulebook import: couldn't read ${pack.collection}`, err);
      continue;
    }
    for (const entry of index) {
      if (!entry.type) continue;
      out.push({
        name: entry.name,
        type: entry.type,
        tier,
        order: Math.max(system, 0),
        source: pack.collection,
        consumable: !!entry.system?.consumable?.kind,
        weaponSkill: entry.system?.weaponSkill ?? "",
        category: entry.system?.category ?? "",
        handToHand: !!entry.system?.isHandToHand,
        noWeapon: !!entry.system?.noWeapon,
        ref: entry.uuid ?? pack.getUuid(entry._id),
      });
    }
  }
  for (const item of game.items) {
    if (book && bookOfFlag(item.getFlag(SCOPE, FLAG)) === book) continue;
    out.push({
      name: item.name,
      type: item.type,
      tier: TIERS.world,
      source: "world",
      consumable: !!item.system?.consumable?.kind,
      weaponSkill: item.system?.weaponSkill ?? "",
      category: item.system?.category ?? "",
      handToHand: !!item.system?.isHandToHand,
      noWeapon: !!item.system?.noWeapon,
      ref: item.uuid,
    });
  }
  return out;
}

/**
 * Swap each parsed Spell and piece of gear for its compendium copy, where
 * there is one (the copy's Debuffs and bonuses are authored, Q2), keeping
 * the book's name and page. A gear bonus's Skill takes a matched Skill's
 * name. Counted by kind for the report.
 * @param {object[]} entries  Parsed {name, page, data}.
 * @param {string} book
 * @returns {Promise<{entries: object[], matched: Record<string, number>}>}
 */
async function preferCompendiumCopies(entries, book) {
  const match = buildMatcher(await matchCandidates(book));
  const matched = { spells: 0, skills: 0, consumables: 0, gear: 0 };
  const out = [];
  for (const entry of entries) {
    const found = match(entry.name, MATCH_TYPES[entry.data.type] ?? []);
    const source = found && (await fromUuid(found.ref));
    if (!source) {
      out.push(withSkillNames(entry, match, matched));
      continue;
    }
    matched[matchKind(found)]++;
    const data = copyData(source);
    if (!data.effects?.length) delete data.effects;
    if (data.flags?.[SCOPE]) delete data.flags[SCOPE][FLAG];
    data.name = entry.name;
    out.push({ ...entry, data });
  }
  return { entries: out, matched };
}

/** A parsed gear entry with its bonus Skills named as a matched Skill is. */
function withSkillNames(entry, match, matched) {
  const changes = entry.data.system?.changes;
  if (!Array.isArray(changes) || !changes.some((c) => c.targetType === "skillRank")) return entry;
  const named = changes.map((c) => {
    if (c.targetType !== "skillRank") return c;
    const skill = match(c.target, MATCH_TYPES.skill);
    if (!skill) return c;
    matched.skills++;
    return { ...c, target: skill.name };
  });
  return { ...entry, data: { ...entry.data, system: { ...entry.data.system, changes: named } } };
}

async function importMaps(folder, maps, { pdfDoc, book, onProgress }) {
  let created = 0;
  let updated = 0;
  const { OPS } = await getPdfJs();
  for (const [n, map] of maps.entries()) {
    onProgress?.(n, maps.length);
    const page = await pdfDoc.getPage(map.page);
    // The embedded picture itself, not a render of the page (maps.mjs).
    const canvas = await mapImageCanvas(page, OPS);
    page.cleanup();
    if (!canvas) continue;
    const blob = await canvasToBlob(canvas);
    if (blob?.type !== "image/webp")
      throw new Error(game.i18n.localize("CARLRPG.PdfImport.NoWebp"));
    // Names like "The Over City Map (p. 357)" already carry the page.
    const slug = slugify(map.name);
    const path = await uploadMap(
      blob,
      book,
      `${slug.endsWith(`p-${map.page}`) ? slug : `${slug}-p${map.page}`}.webp`,
    );
    if (!path) continue;
    const data = mapSceneData({
      name: map.name,
      path,
      width: canvas.width,
      height: canvas.height,
      folder: folder.id,
    });
    const old = folder.contents.find((s) => s.name === map.name);
    if (old) {
      await old.update({ width: data.width, height: data.height });
      const level = old.firstLevel;
      if (level) await level.update({ "background.src": path });
      else await old.createEmbeddedDocuments("Level", data.levels);
      updated++;
    } else {
      await Scene.implementation.create(data);
      created++;
    }
  }
  return { created, updated };
}

/**
 * @param {object} options
 * @param {string} options.book       The book's id (books.mjs BOOKS, or a test's own).
 * @param {string} options.title      Book title (compendium and folder name).
 * @param {object} options.found      From scan.mjs parseBook, maps already resolved.
 * @param {string[]} options.kinds    Which of gear/spells/mobs/achievements to import.
 * @param {object[]} options.maps     Chosen maps: {page, name, image}.
 * @param {object} options.pdfDoc
 * @param {(message: string, pct: number) => void} [options.onProgress]
 * @returns {Promise<Record<string, {created: number, updated: number, skipped?: string[], matched?: Record<string, number>}>>}
 *   skipped: names of documents left alone because the GM edited them (or
 *   made one of the same name); matched: items written as a compendium's
 *   copy, by kind.
 */
export async function importBook({ book, title, found, kinds, maps, pdfDoc, onProgress }) {
  const results = {};
  const step = (key) => onProgress?.(game.i18n.localize(`CARLRPG.PdfImport.Kind.${key}`), 0);

  const items = [
    ...(kinds.includes("gear") ? found.gear : []),
    ...(kinds.includes("spells") ? found.spells : []),
  ];
  if (items.length) {
    step("gear");
    const pack = await bookPack(book, title, "Item");
    const { entries, matched } = await preferCompendiumCopies(items, book);
    const folders = {};
    const folderFor = async (kind) =>
      (folders[kind] ??= (
        await packFolder(pack, game.i18n.localize(`CARLRPG.PdfImport.Kind.${kind}`))
      ).id);
    results.items = await withUnlockedPack(pack, () =>
      upsert(pack, entries, book, {
        place: async (doc) => ({
          folder: await folderFor(doc.data.type === "spell" ? "spells" : "gear"),
        }),
      }),
    );
    results.items.matched = matched;
  }
  if (kinds.includes("mobs") && found.mobs.length) {
    step("mobs");
    const pack = await bookPack(book, title, "Actor");
    const mobs = dedupe(found.mobs.map(withAttacksApart));
    results.mobs = await withUnlockedPack(pack, async () => {
      const places = await mobPlaces(pack, mobs, book);
      return upsert(pack, mobs, book, {
        place: async (doc) => places.get(`${doc.data.type}:${doc.name}`) ?? {},
        // An unedited Mob is filed too, so the first re-import organises an
        // earlier one.
        moveExisting: true,
        afterWrite: (actor, entry) => syncAttacks(actor, entry.legacyAttacks ?? []),
      });
    });
  }
  if (kinds.includes("achievements") && found.achievements.length) {
    step("achievements");
    // Achievement items (data/achievement.mjs) in the book's Item compendium,
    // in their own folder - the GM's Achievements grid lists them from there.
    const pack = await bookPack(book, title, "Item");
    results.achievements = await withUnlockedPack(pack, async () => {
      const folder = (
        await packFolder(pack, game.i18n.localize("CARLRPG.PdfImport.Kind.achievements"))
      ).id;
      return upsert(pack, found.achievements, book, { place: async () => ({ folder }) });
    });
  }
  if (maps.length) {
    const label = game.i18n.localize("CARLRPG.PdfImport.Kind.maps");
    results.maps = await importMaps(await sceneFolder(book, title), maps, {
      pdfDoc,
      book,
      onProgress: (n, total) => onProgress?.(`${label} ${n + 1}/${total}`, n / total),
    });
  }
  return results;
}
