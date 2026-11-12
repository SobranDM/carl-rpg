/**
 * Battle maps from the user's own rulebook PDF, done the blades68 way: each
 * map is rendered in the browser, saved as a WebP under the Foundry Data
 * folder (carl-rpg/<book>/maps/), and turned into a gridless Scene. Nothing
 * is bundled with the system or downloaded.
 *
 * A map page often carries more than the map (the page frame, a full-page
 * background texture), so the render is cropped to the map image itself,
 * found by walking the page's drawing operators.
 */

const UPLOAD_ROOT = "carl-rpg";
// The browser refuses very large canvases, and Foundry has to load whatever
// is produced as a texture.
const MAX_PIXELS = 6000;
// An image smaller than this share of the page is art or decoration.
const MIN_MAP_AREA = 0.3;

/** Same as pdf.js Util.transform: m1 then m2. */
function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Where the page's map image sits, in PDF points, and its native size.
 * Returns null when no image covers enough of the page to be a map. A
 * full-page background with a large image on top of it (Core Rulebook map
 * pages) gives the image on top.
 * @param {object} page  pdf.js page.
 * @param {object} OPS   pdf.js OPS table.
 * @returns {Promise<{rect: number[], pixelWidth: number, pixelHeight: number}|null>}
 */
export async function findMapImage(page, OPS) {
  const [vx0, vy0, vx1, vy1] = page.view;
  const pageArea = (vx1 - vx0) * (vy1 - vy0);
  const { fnArray, argsArray } = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const images = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0])) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      // An image fills the unit square under the current transform.
      const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
      const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
      const rect = [
        Math.max(Math.min(...xs), vx0),
        Math.max(Math.min(...ys), vy0),
        Math.min(Math.max(...xs), vx1),
        Math.min(Math.max(...ys), vy1),
      ];
      const area = Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
      images.push({
        rect,
        share: area / pageArea,
        pixelWidth: args?.[1] ?? 0,
        pixelHeight: args?.[2] ?? 0,
      });
    }
  }
  const big = images.filter((i) => i.share >= MIN_MAP_AREA).sort((a, b) => b.share - a.share);
  if (!big.length) return null;
  // Full-page layers (background texture and its mask) sit under the map.
  const pick = big.find((i) => i.share <= 0.97) ?? big[0];
  return { rect: pick.rect, pixelWidth: pick.pixelWidth, pixelHeight: pick.pixelHeight };
}

/**
 * Render just `rect` (PDF points) of a page to a canvas.
 * @param {object} page
 * @param {number[]} rect
 * @param {{scale?: number, width?: number}} options  A fixed scale, or a target pixel width.
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderRegion(page, rect, { scale, width } = {}) {
  const base = page.getViewport({ scale: 1 });
  const [x0, y0] = base.convertToViewportPoint(rect[0], rect[1]);
  const [x1, y1] = base.convertToViewportPoint(rect[2], rect[3]);
  const w1 = Math.abs(x1 - x0);
  const h1 = Math.abs(y1 - y0);
  let s = scale ?? (width ? width / w1 : 2);
  if (Math.max(w1, h1) * s > MAX_PIXELS) s = MAX_PIXELS / Math.max(w1, h1);
  const viewport = page.getViewport({
    scale: s,
    offsetX: -Math.min(x0, x1) * s,
    offsetY: -Math.min(y0, y1) * s,
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w1 * s);
  canvas.height = Math.round(h1 * s);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

/** Render a map at the map image's own resolution. */
export async function renderMap(page, found) {
  const pointsWide = Math.abs(found.rect[2] - found.rect[0]);
  const pointsHigh = Math.abs(found.rect[3] - found.rect[1]);
  // Pixels per point, by area so a rotated image gives the same answer.
  const native = Math.sqrt((found.pixelWidth * found.pixelHeight) / (pointsWide * pointsHigh));
  return renderRegion(page, found.rect, {
    scale: Number.isFinite(native) && native > 1 ? native : 3,
  });
}

export function canvasToBlob(canvas, type = "image/webp", quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function getFilePickerClass() {
  return (
    foundry.applications.apps?.FilePicker?.implementation ?? foundry.applications.apps.FilePicker
  );
}

async function ensureDirectory(target) {
  const FilePicker = getFilePickerClass();
  let built = "";
  for (const segment of target.split("/")) {
    built = built ? `${built}/${segment}` : segment;
    try {
      await FilePicker.createDirectory("data", built);
    } catch (err) {
      if (!String(err.message ?? err).includes("EEXIST")) throw err;
    }
  }
  return target;
}

/**
 * Save a rendered map under carl-rpg/<bookSlug>/maps/ in the Data folder.
 * @returns {Promise<string|null>} The saved file's path.
 */
export async function uploadMap(blob, bookSlug, filename) {
  const dir = await ensureDirectory(`${UPLOAD_ROOT}/${bookSlug}/maps`);
  const file = new File([blob], filename, { type: blob.type || "image/webp" });
  const response = await getFilePickerClass().upload("data", dir, file, {}, { notify: false });
  return response?.path ?? null;
}

/**
 * Gridless scene data for a saved map, as blades68 makes its city map. In
 * Foundry v14 a scene's background lives on its first Level.
 */
export function mapSceneData({ name, path, width, height, folder }) {
  return {
    name,
    folder,
    width,
    height,
    padding: 0,
    grid: { type: CONST.GRID_TYPES.GRIDLESS, size: 100 },
    tokenVision: false,
    fog: { mode: CONST.FOG_EXPLORATION_MODES.DISABLED },
    levels: [{ name, background: { src: path, color: "#000000" } }],
  };
}
