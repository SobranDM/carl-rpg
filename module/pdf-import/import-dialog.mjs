/**
 * "Import Rulebook PDF": the GM picks their own copy of a Dungeon Crawler
 * Carl RPG book, the importer reads it in the browser, shows what it found
 * (with thumbnails of the pages that look like maps), and writes the chosen
 * content into the world. See importer.mjs for what lands where.
 */

import { cancelButton, showCarlDialog } from "../apps/carl-dialog.mjs";
import { importBook } from "./importer.mjs";
import { canvasToBlob, findMapImage, renderRegion } from "./maps.mjs";
import { loadPdfDocument } from "./pdf-loader.mjs";
import { bookTitleFromFilename, parseBook, readPages } from "./scan.mjs";

const KINDS = ["gear", "spells", "mobs", "achievements"];
const THUMB_WIDTH = 220;

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

/** Find each candidate page's map image and render a thumbnail of it. */
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
    const image = await findMapImage(page, pdfjs.OPS);
    if (!image) continue;
    const blob = await canvasToBlob(
      await renderRegion(page, image.rect, { width: THUMB_WIDTH }),
      "image/jpeg",
      0.8,
    );
    maps.push({ ...candidate, image, thumb: URL.createObjectURL(blob) });
  }
  return maps;
}

async function chooseContent(title, found, maps) {
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
      return r.skipped?.length
        ? `${line} ${game.i18n.format("CARLRPG.PdfImport.SummarySkipped", { skipped: r.skipped.length })}`
        : line;
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
  try {
    const { pdfjs, pdfDoc } = await loadPdfDocument(file);
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
    console.error("CarlRPG | Rulebook PDF import failed", err);
    ui.notifications.error(game.i18n.format("CARLRPG.PdfImport.Failed", { error: err.message }));
  } finally {
    progress?.update?.({ pct: 1 });
    for (const map of maps) URL.revokeObjectURL(map.thumb);
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
