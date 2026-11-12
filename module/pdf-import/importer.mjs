/**
 * Write parsed rulebook content into the world: gear and spells as Items,
 * stat blocks as Mob Actors, achievements as one Journal Entry, maps as
 * Scenes. Everything lands in a folder named after the book. Importing the
 * same book again updates documents of the same name in that folder rather
 * than making copies, so a GM can re-run it after a parser fix - except a
 * document the GM has edited since it was imported, which is left alone
 * (see importHash) and reported as skipped.
 *
 * Nothing here is written to the system's compendiums: the books are not
 * ours to redistribute, so their content only ever lives in the GM's world.
 */

import { canvasToBlob, mapSceneData, renderMap, uploadMap } from "./maps.mjs";
import { slugify } from "./scan.mjs";

const FLAG = "pdfImport";

async function getFolder(type, name) {
  return (
    game.folders.find((f) => f.type === type && f.name === name && !f.folder) ??
    Folder.implementation.create({ name, type })
  );
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
 * The parts of a document's stored data that the importer wrote: `shape`
 * is the imported data, and only its keys are read back from `source`
 * (array entries by position). Fields the importer never sets - and new
 * fields a later system version adds - don't count.
 */
function projectImported(source, shape) {
  if (Array.isArray(shape)) {
    return (Array.isArray(source) ? source : []).map((value, i) =>
      i < shape.length ? projectImported(value, shape[i]) : value,
    );
  }
  if (shape && typeof shape === "object") {
    const out = {};
    for (const key of Object.keys(shape).sort()) {
      if (key === "_id" || key === "folder" || key === "flags") continue;
      out[key] = projectImported(source?.[key], shape[key]);
    }
    return out;
  }
  return source;
}

/** A short fingerprint of what the importer wrote, as it was stored. */
function importHash(doc, shape) {
  const text = JSON.stringify(projectImported(doc._source, shape)) ?? "";
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * Whether the GM has changed this document since it was last imported. A
 * document imported before fingerprints existed counts as unedited.
 */
function editedSinceImport(doc, shape) {
  const stored = doc.getFlag("carl-rpg", FLAG)?.hash;
  return !!stored && stored !== importHash(doc, shape);
}

/**
 * Fingerprint freshly written documents (see editedSinceImport). Matched
 * back to their imported data by key, not position: a create can drop an
 * invalid entry and an update leaves out documents that didn't change.
 * @param {Document[]} written
 * @param {object[]} shapes  The data that was written.
 * @param {(data: object) => string} keyOf
 * @param {(stamps: object[]) => Promise<unknown>} update
 */
async function stampHashes(written, shapes, keyOf, update) {
  const byKey = new Map(shapes.map((shape) => [keyOf(shape), shape]));
  const stamps = (written ?? [])
    .map((doc) => {
      const shape = byKey.get(keyOf(doc));
      return shape && { _id: doc.id, [`flags.carl-rpg.${FLAG}.hash`]: importHash(doc, shape) };
    })
    .filter(Boolean);
  if (stamps.length) await update(stamps);
}

/** Create or update world documents of one class inside `folder`. */
async function upsert(cls, folder, docs, book) {
  const existing = new Map(folder.contents.map((d) => [`${d.type}:${d.name}`, d]));
  const creates = [];
  const updates = [];
  const skipped = [];
  for (const doc of dedupe(docs)) {
    const data = {
      ...doc.data,
      folder: folder.id,
      flags: { "carl-rpg": { [FLAG]: { book, page: doc.page } } },
    };
    const old = existing.get(`${data.type}:${data.name}`);
    if (old && editedSinceImport(old, doc.data)) skipped.push(old.name);
    else if (old) updates.push({ ...data, _id: old.id });
    else creates.push(data);
  }
  const update = (stamps) => cls.updateDocuments(stamps);
  const keyOf = (d) => `${d.type}:${d.name}`;
  if (creates.length) await stampHashes(await cls.createDocuments(creates), creates, keyOf, update);
  if (updates.length) await stampHashes(await cls.updateDocuments(updates), updates, keyOf, update);
  return { created: creates.length, updated: updates.length, skipped };
}

async function importAchievements(folder, pages, book) {
  const name = game.i18n.localize("CARLRPG.PdfImport.Achievements");
  let entry = folder.contents.find((e) => e.name === name);
  entry ??= await JournalEntry.implementation.create({
    name,
    folder: folder.id,
    flags: { "carl-rpg": { [FLAG]: { book } } },
  });
  const existing = new Map(entry.pages.map((p) => [p.name, p]));
  const creates = [];
  const updates = [];
  const skipped = [];
  for (const page of dedupe(pages)) {
    const old = existing.get(page.name);
    if (old && editedSinceImport(old, page.data)) skipped.push(old.name);
    else if (old) updates.push({ ...page.data, _id: old.id });
    else creates.push(page.data);
  }
  const update = (stamps) => entry.updateEmbeddedDocuments("JournalEntryPage", stamps);
  const keyOf = (d) => d.name;
  if (creates.length) {
    await stampHashes(await entry.createEmbeddedDocuments("JournalEntryPage", creates), creates, keyOf, update);
  }
  if (updates.length) {
    await stampHashes(await entry.updateEmbeddedDocuments("JournalEntryPage", updates), updates, keyOf, update);
  }
  return { created: creates.length, updated: updates.length, skipped };
}

async function importMaps(folder, maps, { pdfDoc, bookSlug, onProgress }) {
  let created = 0;
  let updated = 0;
  for (const [n, map] of maps.entries()) {
    onProgress?.(n, maps.length);
    const page = await pdfDoc.getPage(map.page);
    const canvas = await renderMap(page, map.image);
    const blob = await canvasToBlob(canvas);
    if (blob?.type !== "image/webp")
      throw new Error(game.i18n.localize("CARLRPG.PdfImport.NoWebp"));
    // Names like "The Over City Map (p. 357)" already carry the page.
    const slug = slugify(map.name);
    const path = await uploadMap(
      blob,
      bookSlug,
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
 * @param {string} options.title      Book title (folder name).
 * @param {object} options.found      From scan.mjs parseBook, maps already resolved.
 * @param {string[]} options.kinds    Which of gear/spells/mobs/achievements to import.
 * @param {object[]} options.maps     Chosen maps: {page, name, image}.
 * @param {object} options.pdfDoc
 * @param {(message: string, pct: number) => void} [options.onProgress]
 * @returns {Promise<Record<string, {created: number, updated: number, skipped?: string[]}>>}
 *   skipped: names of documents left alone because the GM edited them.
 */
export async function importBook({ title, found, kinds, maps, pdfDoc, onProgress }) {
  const book = slugify(title);
  const results = {};
  const step = (key) => onProgress?.(game.i18n.localize(`CARLRPG.PdfImport.Kind.${key}`), 0);

  const items = [
    ...(kinds.includes("gear") ? found.gear : []),
    ...(kinds.includes("spells") ? found.spells : []),
  ];
  if (items.length) {
    step("gear");
    const res = await upsert(Item.implementation, await getFolder("Item", title), items, book);
    results.items = res;
  }
  if (kinds.includes("mobs") && found.mobs.length) {
    step("mobs");
    results.mobs = await upsert(
      Actor.implementation,
      await getFolder("Actor", title),
      found.mobs,
      book,
    );
  }
  if (kinds.includes("achievements") && found.achievements.length) {
    step("achievements");
    results.achievements = await importAchievements(
      await getFolder("JournalEntry", title),
      found.achievements,
      book,
    );
  }
  if (maps.length) {
    const label = game.i18n.localize("CARLRPG.PdfImport.Kind.maps");
    results.maps = await importMaps(await getFolder("Scene", title), maps, {
      pdfDoc,
      bookSlug: book,
      onProgress: (n, total) => onProgress?.(`${label} ${n + 1}/${total}`, n / total),
    });
  }
  return results;
}
