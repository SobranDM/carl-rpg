/**
 * Battle maps from the user's own rulebook PDF: each map is the picture
 * embedded in its page, taken out of the PDF as it is stored (its own
 * pixels, at its own resolution - pdf.js has already applied any soft mask
 * as alpha), turned upright, saved as a WebP under the Foundry Data folder
 * (carl-rpg/<book>/maps/), and made into a gridless Scene. Nothing is
 * bundled with the system or downloaded.
 *
 * The page itself is never rendered for a map: the text drawn over it -
 * the per-page download stamp, the page number, a title - is not part of
 * the embedded image, so it can't end up in the saved file.
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
 * Every image the page draws, in drawing order, with the transform it is
 * drawn under (an image fills the unit square under it). Images inside a
 * soft-mask group only shape another layer's transparency (they are never
 * seen), so they are left out.
 * @param {{fnArray: number[], argsArray: any[]}} opList  page.getOperatorList()
 * @param {object} OPS  pdf.js OPS table.
 * @returns {{index: number, ctm: number[], objId: string|null, inline: object|null,
 *   pixelWidth: number, pixelHeight: number}[]}
 */
export function imageDraws({ fnArray, argsArray }, OPS) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const draws = [];
  // One entry per open group: whether it is a soft mask's.
  const groups = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.beginGroup) groups.push(!!args?.[0]?.smask);
    else if (fn === OPS.endGroup) groups.pop();
    else if (groups.includes(true)) continue;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0])) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject) {
      draws.push({
        index: i,
        ctm,
        objId: typeof args?.[0] === "string" ? args[0] : null,
        inline: null,
        pixelWidth: args?.[1] ?? 0,
        pixelHeight: args?.[2] ?? 0,
      });
    } else if (fn === OPS.paintInlineImageXObject) {
      const img = args?.[0] ?? {};
      draws.push({
        index: i,
        ctm,
        objId: null,
        inline: img,
        pixelWidth: img.width ?? 0,
        pixelHeight: img.height ?? 0,
      });
    }
  }
  return draws;
}

/** Where an image drawn under `ctm` lands on the page, clipped to `view`. */
export function drawRect(ctm, [vx0, vy0, vx1, vy1]) {
  const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
  const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
  return [
    Math.max(Math.min(...xs), vx0),
    Math.max(Math.min(...ys), vy0),
    Math.min(Math.max(...xs), vx1),
    Math.min(Math.max(...ys), vy1),
  ];
}

/**
 * The page's map: the image drawn over the most of it, or null when no
 * image covers enough of the page to be a map. A full-page background with
 * a large image on top of it (Core Rulebook map pages) gives the image on
 * top.
 * @param {object[]} draws  From imageDraws.
 * @param {number[]} view   The page's view box.
 */
export function pickMapDraw(draws, view) {
  const [vx0, vy0, vx1, vy1] = view;
  const pageArea = (vx1 - vx0) * (vy1 - vy0);
  const big = draws
    .map((draw) => {
      const rect = drawRect(draw.ctm, view);
      const area = Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
      return { ...draw, rect, share: area / pageArea };
    })
    .filter((d) => d.share >= MIN_MAP_AREA)
    .sort((a, b) => b.share - a.share);
  if (!big.length) return null;
  // Full-page layers (background texture and its mask) sit under the map.
  return big.find((d) => d.share <= 0.97) ?? big[0];
}

/**
 * How to draw a stored image upright: its own pixels (row 0 at the top)
 * mapped onto an output of `width` x `height` as the page shows them -
 * flipped or turned by quarter turns, and scaled down to fit `maxPixels`.
 * An image the page draws skewed or at an odd angle is kept as stored.
 * @param {number[]} ctm   The transform the page draws the image under.
 * @param {number} width   Stored pixel width.
 * @param {number} height  Stored pixel height.
 * @param {number} [maxPixels]
 * @returns {{width: number, height: number, matrix: number[]}}  matrix as
 *   canvas setTransform takes it: stored pixels to output pixels.
 */
export function imageTransform(ctm, width, height, maxPixels = Infinity) {
  // In the unit square the image fills, stored x runs along (a, b) and
  // stored y (downward) along -(c, d); the page's y axis points up, the
  // output's down.
  const axis = (x, y) => {
    const len = Math.hypot(x, y);
    if (!len) return null;
    const snap = (v) =>
      Math.abs(v) < 0.01 ? 0 : Math.abs(Math.abs(v) - 1) < 0.01 ? Math.sign(v) : NaN;
    const out = [snap(x / len), snap(y / len)];
    return out.some(Number.isNaN) ? null : out;
  };
  let u = axis(ctm[0], -ctm[1]);
  let v = axis(-ctm[2], ctm[3]);
  if (!u || !v || u[0] * v[0] + u[1] * v[1] !== 0) {
    u = [1, 0];
    v = [0, 1];
  }
  const outW = Math.abs(u[0]) * width + Math.abs(v[0]) * height;
  const outH = Math.abs(u[1]) * width + Math.abs(v[1]) * height;
  const xs = [0, u[0] * width, v[0] * height, u[0] * width + v[0] * height];
  const ys = [0, u[1] * width, v[1] * height, u[1] * width + v[1] * height];
  const s = Math.min(1, maxPixels / Math.max(outW, outH));
  return {
    width: Math.round(outW * s),
    height: Math.round(outH * s),
    // `|| 0`: no -0 entries.
    matrix: [
      u[0] * s,
      u[1] * s,
      v[0] * s,
      v[1] * s,
      -Math.min(...xs) * s,
      -Math.min(...ys) * s,
    ].map((n) => n || 0),
  };
}

/**
 * A pdf.js image object's pixels as RGBA. pdf.js ImageKind: 1 = 1 bit per
 * pixel (rows padded to a byte, 0 black), 2 = RGB, 3 = RGBA - how pdf.js
 * hands over an image with a soft mask or alpha, already applied.
 * @param {{width: number, height: number, kind: number, data: Uint8Array|Uint8ClampedArray}} img
 * @returns {Uint8ClampedArray}
 */
export function imageToRGBA({ width, height, kind, data }) {
  const out = new Uint8ClampedArray(width * height * 4);
  if (kind === 3) {
    out.set(data.subarray(0, out.length));
  } else if (kind === 2) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j];
      out[i * 4 + 1] = data[j + 1];
      out[i * 4 + 2] = data[j + 2];
      out[i * 4 + 3] = 255;
    }
  } else if (kind === 1) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const at = (y * width + x) * 4;
        out[at] = out[at + 1] = out[at + 2] = bit ? 255 : 0;
        out[at + 3] = 255;
      }
    }
  } else {
    throw new Error(`Unsupported image kind: ${kind}`);
  }
  return out;
}

/**
 * Apply an unscaled imageTransform (a turn or flip) to RGBA pixels - for
 * the Node preview tool, which has no canvas.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width   Stored width.
 * @param {number} height  Stored height.
 * @param {{width: number, height: number, matrix: number[]}} transform
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function orientRGBA(rgba, width, height, { width: outW, height: outH, matrix }) {
  const [a, b, c, d, e, f] = matrix;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Pixel centres, so a flip lands on the mirrored pixel.
      const ox = Math.floor(a * (x + 0.5) + c * (y + 0.5) + e);
      const oy = Math.floor(b * (x + 0.5) + d * (y + 0.5) + f);
      out.set(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (oy * outW + ox) * 4);
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * The page's map image as pdf.js decoded it, and how the page draws it.
 * @param {object} page  pdf.js page.
 * @param {object} OPS   pdf.js OPS table.
 * @returns {Promise<{img: object, ctm: number[], rect: number[]}|null>}  img:
 *   {width, height} and either `bitmap` (an ImageBitmap, in browsers) or
 *   `kind` and `data` (see imageToRGBA).
 */
export async function loadMapImage(page, OPS) {
  const pick = pickMapDraw(imageDraws(await page.getOperatorList(), OPS), page.view);
  if (!pick) return null;
  let img = pick.inline;
  if (pick.objId) {
    // An image used on many pages lives in the document's shared objects.
    const pool = pick.objId.startsWith("g_") ? page.commonObjs : page.objs;
    img = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Map image ${pick.objId} did not load`)),
        60000,
      );
      pool.get(pick.objId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }
  if (!img?.width || !img?.height || !(img.bitmap || img.data)) return null;
  return { img, ctm: pick.ctm, rect: pick.rect };
}

/**
 * The page's map, upright, on a canvas (browser only).
 * @param {object} page  pdf.js page.
 * @param {object} OPS   pdf.js OPS table.
 * @param {{maxPixels?: number}} [options]  The longest side (a thumbnail's).
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function mapImageCanvas(page, OPS, { maxPixels = MAX_PIXELS } = {}) {
  const found = await loadMapImage(page, OPS);
  if (!found) return null;
  const { img, ctm } = found;
  let source = img.bitmap;
  if (!source) {
    source = document.createElement("canvas");
    source.width = img.width;
    source.height = img.height;
    source
      .getContext("2d")
      .putImageData(new ImageData(imageToRGBA(img), img.width, img.height), 0, 0);
  }
  const t = imageTransform(ctm, img.width, img.height, Math.min(maxPixels, MAX_PIXELS));
  const canvas = document.createElement("canvas");
  canvas.width = t.width;
  canvas.height = t.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(...t.matrix);
  ctx.drawImage(source, 0, 0);
  return canvas;
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
