/**
 * Preview what the in-Foundry PDF importer would pull out of a rulebook,
 * without Foundry. Runs the same parsers (module/pdf-import/) over the
 * user's own copy of a book and writes one JSON file per document.
 *
 * The books are copyrighted and this repo is public, so the output goes to a
 * gitignored folder (pdf_local/<book>/ by default) and is never committed.
 *
 * It also prints how many Mobs go in each Floor and Neighborhood or Quest
 * folder, counts of the structured data (Mob Attack Debuffs by
 * trigger, Armor-Piercing, Debuffs left as text) and how many Spells, gear
 * and gear bonus Skills match the system's own packs (packs-source/) - the
 * importer's other match sources exist only in a Foundry world.
 *
 * Like the importer, it refuses a book's low-quality (LQ) edition
 * (module/pdf-import/quality.mjs) and exits with code 2.
 *
 * Usage:
 *   node tools/pdf-import/extract-rulebook.mjs <rulebook.pdf> [outDir] [--maps]
 *
 * --maps also writes each map candidate's embedded image (as the importer
 * extracts it, module/pdf-import/maps.mjs) to <outDir>/maps/ as PNG.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// The modern pdf.js build needs built-ins Node may lack; in place before it loads.
import "../../module/pdf-import/pdf-polyfills.mjs";
import { imageToRGBA, imageTransform, loadMapImage, orientRGBA } from "../../module/pdf-import/maps.mjs";
import { buildMatcher, MATCH_TYPES, matchKind, SYSTEM_PACKS, TIERS } from "../../module/pdf-import/compendium-match.mjs";
import { parseDebuffText } from "../../module/pdf-import/debuff-text.mjs";
import { sectionFolders } from "../../module/pdf-import/sections.mjs";
import { checkImageQuality } from "../../module/pdf-import/quality.mjs";
import {
  bookTitleFromFilename,
  parseBook,
  readPages,
  slugify,
} from "../../module/pdf-import/scan.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A lang/en.json string, with {placeholders} filled in. */
function localize(key, data = {}) {
  const lang = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8"));
  const text = key.split(".").reduce((o, k) => o?.[k], lang) ?? key;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA pixels as a PNG file. */
function encodePng({ width, height, data }) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function writeMaps(pdfDoc, OPS, maps, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const map of maps) {
    const page = await pdfDoc.getPage(map.page);
    const found = await loadMapImage(page, OPS);
    if (!found) {
      page.cleanup();
      continue;
    }
    const { img, ctm } = found;
    const t = imageTransform(ctm, img.width, img.height);
    const upright = orientRGBA(imageToRGBA(img), img.width, img.height, t);
    const file = path.join(dir, `p${String(map.page).padStart(3, "0")}-${slugify(map.name)}.png`);
    fs.writeFileSync(file, encodePng(upright));
    console.log(`  p${map.page} ${upright.width}x${upright.height} (stored ${img.width}x${img.height}, kind ${img.kind}) -> ${path.basename(file)}`);
    page.cleanup();
  }
}

/**
 * The system's own packs as match candidates (compendium-match.mjs), from
 * packs-source/. The world's other tiers (other books' compendiums, world
 * Items, modules) exist only in Foundry.
 */
function systemPackCandidates() {
  const out = [];
  SYSTEM_PACKS.forEach((id, order) => {
    const dir = path.join(ROOT, "packs-source", id.split(".")[1]);
    for (const file of fs.readdirSync(dir)) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (String(doc._key ?? "").startsWith("!folders!")) continue;
      out.push({
        name: doc.name,
        type: doc.type,
        tier: TIERS.system,
        order,
        source: id,
        consumable: !!doc.system?.consumable?.kind,
      });
    }
  });
  return out;
}

/** Counts of what the structured-data parsers and the compendium match make of a book. */
function summarize(found) {
  const attacks = found.mobs.flatMap((m) => m.data.system.attacks ?? []);
  const byTrigger = {};
  for (const te of attacks.flatMap((a) => a.targetEffects ?? [])) byTrigger[te.trigger] = (byTrigger[te.trigger] ?? 0) + 1;
  const textOnly = {};
  for (const a of attacks) {
    for (const t of parseDebuffText(a.effect).textOnly) textOnly[t.reason] = (textOnly[t.reason] ?? 0) + 1;
  }
  console.log(`attacks: ${attacks.length}; with Debuffs: ${attacks.filter((a) => a.targetEffects?.length).length}`);
  console.log(`  Debuffs by trigger: ${JSON.stringify(byTrigger)}`);
  console.log(`  Armor-Piercing attacks: ${attacks.filter((a) => a.armorPiercing).length}`);
  const total = Object.values(textOnly).reduce((s, n) => s + n, 0);
  console.log(`  text-only Debuffs: ${total} ${JSON.stringify(textOnly)}`);
  const gearDebuffs = found.gear.flatMap((g) => g.data.system.targetEffects ?? []);
  const upgradeDebuffs = found.spells.flatMap((s) => s.data.system.upgrades.flatMap((u) => u.targetEffects ?? []));
  console.log(`gear Debuffs: ${gearDebuffs.length}; spell upgrade Debuffs: ${upgradeDebuffs.length}`);

  // Where the importer files each Mob (sections.mjs), in book order.
  const labels = {
    floor: (n) => localize("CARLRPG.PdfImport.FloorFolder", { n }),
    other: localize("CARLRPG.PdfImport.OtherMobs"),
    neighborhood: localize("CARLRPG.PdfImport.Neighborhood"),
    quest: localize("CARLRPG.PdfImport.Quest"),
  };
  const filed = new Map();
  for (const mob of found.mobs) {
    const key = sectionFolders(mob.section, labels).map((f) => f.name).join(" / ");
    if (!filed.has(key)) filed.set(key, []);
    filed.get(key).push(mob.page);
  }
  console.log("mob folders:");
  for (const [key, pages] of filed)
    console.log(`  ${String(pages.length).padStart(3)}  ${key}  (pp. ${Math.min(...pages)}-${Math.max(...pages)})`);

  const match = buildMatcher(systemPackCandidates());
  const matched = { spells: 0, skills: 0, consumables: 0, gear: 0 };
  const of = { spells: found.spells.length, gear: found.gear.length, skills: 0 };
  const unmatched = [];
  for (const doc of [...found.spells, ...found.gear]) {
    const hit = match(doc.name, MATCH_TYPES[doc.data.type] ?? []);
    if (hit) matched[matchKind(hit)]++;
    else {
      if (doc.data.type === "spell") unmatched.push(doc.name);
      for (const c of doc.data.system.changes ?? []) {
        if (c.targetType !== "skillRank") continue;
        of.skills++;
        if (match(c.target, MATCH_TYPES.skill)) matched.skills++;
      }
    }
  }
  console.log(
    `system-pack matches: spells ${matched.spells}/${of.spells}, gear ${matched.gear} + consumables ${matched.consumables} of ${of.gear} gear entries, gear bonus Skills ${matched.skills}/${of.skills}`,
  );
  if (unmatched.length) console.log(`  spells not matched: ${unmatched.join(", ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  const withMaps = args.includes("--maps");
  const [pdf, outArg] = args.filter((a) => a !== "--maps");
  if (!pdf || !fs.existsSync(pdf)) {
    console.error("Usage: node tools/pdf-import/extract-rulebook.mjs <rulebook.pdf> [outDir] [--maps]");
    process.exit(1);
  }
  const book = bookTitleFromFilename(path.basename(pdf));
  const outDir = path.resolve(outArg ?? path.join(ROOT, "pdf_local", slugify(book)));

  const pdfjs = await import("../../module/vendor/pdfjs/pdf.mjs");
  const pdfDoc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdf)),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const quality = await checkImageQuality(pdfDoc, pdfjs.OPS);
  console.log(`image quality: median ${quality.ppi === null ? "n/a" : Math.round(quality.ppi)} ppi over ${quality.images} pictures`);
  if (quality.lowQuality) {
    console.error(localize("CARLRPG.PdfImport.LowQuality", { title: book, ppi: Math.round(quality.ppi) }));
    process.exit(2);
  }

  const found = parseBook(await readPages(pdfDoc));

  for (const [kind, docs] of Object.entries(found)) {
    if (kind === "maps") continue;
    const dir = path.join(outDir, kind);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of docs) {
      const file = path.join(dir, `p${String(doc.page).padStart(3, "0")}-${slugify(doc.name)}.json`);
      fs.writeFileSync(file, JSON.stringify(doc.data, null, 2) + "\n");
    }
    console.log(`${kind}: ${docs.length}`);
  }
  summarize(found);
  console.log(`maps (candidate pages): ${found.maps.length}`);
  for (const map of found.maps)
    console.log(`  p${map.page} ${map.likely ? "[x]" : "[ ]"} ${map.name}`);
  if (withMaps) {
    console.log("map images:");
    await writeMaps(pdfDoc, pdfjs.OPS, found.maps, path.join(outDir, "maps"));
  }
  console.log(`Wrote ${outDir}`);
}

await main();
