/**
 * "Import Rulebook PDF": the GM picks their own copy of a Dungeon Crawler
 * Carl RPG book, the importer reads it in the browser, shows what it found
 * (with thumbnails of the pages that look like maps), and writes the chosen
 * content into the world. See importer.mjs for what lands where.
 */

import { cancelButton, showCarlDialog } from "../apps/carl-dialog.mjs";
import { importBook } from "./importer.mjs";
import { canvasToBlob, mapImageCanvas } from "./maps.mjs";
import { loadPdfDocument } from "./pdf-loader.mjs";
import { checkImageQuality, LowQualityPdfError } from "./quality.mjs";
import { bookTitleFromFilename, parseBook, readPages } from "./scan.mjs";

const KINDS = ["gear", "spells", "mobs", "achievements"];
// A thumbnail's longest side, in pixels.
const THUMB_SIZE = 320;

async function pickFile() {
  return showCarlDialog({
    title: game.i18n.localize("CARLRPG.PdfImport.Title"),
    template: "systems/carl-rpg/templates/dialog/pdf-import-pick.hbs",
    buttons: [
      {
        action: "read",
        icon: "fa-solid fa-file-pdf",
        label: "CARLRPG.PdfImport.Read",
        default: true,
        callback: (event, button) => button.form.elements.pdf.files?.[0] ?? null,
      },
      cancelButton(),
    ],
  });
}

/**
 * Find each candidate page's map image and make a thumbnail of it - of the
 * embedded image the import will save (maps.mjs), not of the page.
 */
async function resolveMaps(pdfDoc, pdfjs, candidates, progress) {
  const maps = [];
  for (const [n, candidate] of candidates.entries()) {
    progress.update({
      pct: n / candidates.length,
      message: game.i18n.format("CARLRPG.PdfImport.CheckingMaps", {
        n: n + 1,
        total: candidates.length,
      }),
    });
    const page = await pdfDoc.getPage(candidate.page);
    const thumb = await mapImageCanvas(page, pdfjs.OPS, { maxPixels: THUMB_SIZE });
    page.cleanup();
    if (!thumb) continue;
    const blob = await canvasToBlob(thumb, "image/jpeg", 0.8);
    maps.push({ ...candidate, thumb: URL.createObjectURL(blob) });
  }
  return maps;
}

export async function chooseContent(title, found, maps) {
  const kinds = KINDS.map((key) => ({
    key,
    label: game.i18n.localize(`CARLRPG.PdfImport.Kind.${key}`),
    count: found[key].length,
  }));
  return showCarlDialog({
    title: game.i18n.localize("CARLRPG.PdfImport.Title"),
    template: "systems/carl-rpg/templates/dialog/pdf-import-results.hbs",
    context: { title, kinds, maps },
    position: { width: 720 },
    classes: ["carl-pdf-import-dialog"],
    // The map thumbnails are blob: URLs, which Foundry's HTML cleaning strips.
    trusted: true,
    // Select all / no maps at once (e.g. a re-import that shouldn't make the
    // map Scenes again).
    onRender: (event, dialog) => {
      const root = dialog?.element ?? event?.target?.element;
      root?.querySelectorAll("[data-map-select]").forEach((button) => button.addEventListener("click", () => {
        const on = button.dataset.mapSelect === "all";
        for (const box of root.querySelectorAll('.carl-pdf-import-map input[type="checkbox"]')) box.checked = on;
      }));
    },
    buttons: [
      {
        action: "import",
        icon: "fa-solid fa-file-import",
        label: "CARLRPG.PdfImport.Import",
        default: true,
        callback: (event, button) =>
          foundry.utils.expandObject(
            new foundry.applications.ux.FormDataExtended(button.form).object,
          ),
      },
      cancelButton(),
    ],
  });
}

function summarize(results) {
  return Object.entries(results)
    .map(([key, r]) => {
      const line = game.i18n.format("CARLRPG.PdfImport.SummaryLine", {
        kind: game.i18n.localize(`CARLRPG.PdfImport.Kind.${key}`),
        created: r.created,
        updated: r.updated,
      });
      const parts = [line];
      // Written as a compendium's copy (a gear bonus's matched Skill isn't one).
      const { spells = 0, consumables = 0, gear = 0 } = r.matched ?? {};
      const copies = spells + consumables + gear;
      if (copies) parts.push(game.i18n.format("CARLRPG.PdfImport.SummaryCopied", { copied: copies }));
      if (r.skipped?.length) parts.push(game.i18n.format("CARLRPG.PdfImport.SummarySkipped", { skipped: r.skipped.length }));
      return parts.join(" ");
    })
    .join(", ");
}

/** Names of documents a re-import left alone because the GM edited them. */
function skippedNotice(results) {
  const names = Object.values(results).flatMap((r) => r.skipped ?? []);
  if (!names.length) return null;
  const shown = names.slice(0, 12).join(", ");
  return game.i18n.format("CARLRPG.PdfImport.SkippedEdited", {
    names: names.length > 12 ? `${shown}, ...` : shown,
  });
}

/** Entry point: the Items sidebar button and the settings menu both call this. */
export async function openRulebookImporter() {
  if (!game.user.isGM) {
    ui.notifications.warn("CARLRPG.PdfImport.GMOnly", { localize: true });
    return;
  }
  const file = await pickFile();
  if (!file) return;

  const title = bookTitleFromFilename(file.name);
  let progress = ui.notifications.info(game.i18n.format("CARLRPG.PdfImport.Reading", { title }), {
    progress: true,
  });
  let maps = [];
  let pdfDoc = null;
  try {
    const loaded = await loadPdfDocument(file);
    const pdfjs = loaded.pdfjs;
    pdfDoc = loaded.pdfDoc;
    // Only the full-quality edition is supported (quality.mjs).
    progress.update({ message: game.i18n.format("CARLRPG.PdfImport.CheckingQuality", { title }) });
    const quality = await checkImageQuality(pdfDoc, pdfjs.OPS);
    if (quality.lowQuality) throw new LowQualityPdfError(quality.ppi);
    const pages = await readPages(pdfDoc, {
      onProgress: (done, total) =>
        progress.update({
          pct: done / total,
          message: game.i18n.format("CARLRPG.PdfImport.ReadingPage", { title, done, total }),
        }),
    });
    const found = parseBook(pages);
    maps = await resolveMaps(pdfDoc, pdfjs, found.maps, progress);
    progress.update({ pct: 1 });

    const choice = await chooseContent(title, found, maps);
    if (!choice) return;
    const kinds = KINDS.filter((k) => choice.kind?.[k]);
    const chosenMaps = maps.filter((m) => choice.map?.[m.page]);
    if (!kinds.length && !chosenMaps.length) return;

    progress = ui.notifications.info(game.i18n.format("CARLRPG.PdfImport.Importing", { title }), {
      progress: true,
    });
    const results = await importBook({
      title,
      found,
      kinds,
      maps: chosenMaps,
      pdfDoc,
      onProgress: (message, pct) => progress.update({ message, pct }),
    });
    progress.update({ pct: 1 });
    ui.notifications.info(
      game.i18n.format("CARLRPG.PdfImport.Done", { title, summary: summarize(results) }),
    );
    const skipped = skippedNotice(results);
    if (skipped) ui.notifications.warn(skipped, { permanent: true });
  } catch (err) {
    if (err instanceof LowQualityPdfError) {
      ui.notifications.error(
        game.i18n.format("CARLRPG.PdfImport.LowQuality", { title, ppi: Math.round(err.ppi) }),
        { permanent: true },
      );
      return;
    }
    console.error("CarlRPG | Rulebook PDF import failed", err);
    ui.notifications.error(game.i18n.format("CARLRPG.PdfImport.Failed", { error: err.message }));
  } finally {
    progress?.update?.({ pct: 1 });
    for (const map of maps) URL.revokeObjectURL(map.thumb);
    // Each document has its own pdf.js worker holding the whole book: end it.
    pdfDoc?.destroy().catch((err) => console.warn("CarlRPG | closing the rulebook PDF failed", err));
  }
}

/**
 * Settings menu entry (Configure Settings > Game Settings). Foundry opens a
 * settings menu by constructing and rendering its class, so this one just
 * starts the import flow instead of drawing a window of its own.
 */
export class RulebookImportMenu extends foundry.applications.api.ApplicationV2 {
  async render() {
    openRulebookImporter();
    return this;
  }
}
