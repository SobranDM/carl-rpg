/**
 * Lazy loader for the vendored pdf.js (module/vendor/pdfjs/). Foundry loads
 * system code as native ES modules with no bundler, so pdf.js is vendored
 * rather than resolved from node_modules. Same approach as blades68.
 */

// The modern pdf.js build needs built-ins some browsers lack: in place on
// this thread before pdf.js loads, and in its worker via pdf-worker.mjs.
import "./pdf-polyfills.mjs";

let pdfjsLibPromise = null;

export async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("../vendor/pdfjs/pdf.mjs").then((lib) => {
      // Relative to this file, so a server with a route prefix
      // (host/foundry/systems/...) still finds the worker.
      lib.GlobalWorkerOptions.workerSrc = new URL("./pdf-worker.mjs", import.meta.url).href;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

/**
 * A file pdf.js can't open (corrupt, encrypted) still started a worker
 * holding its bytes: that's ended before the error is passed on.
 * @param {File} file  The user's own PDF, picked in the browser.
 * @returns {Promise<{pdfjs: object, pdfDoc: object}>}  Close pdfDoc with closePdfDocument.
 */
export async function loadPdfDocument(file) {
  const pdfjs = await getPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  try {
    return { pdfjs, pdfDoc: await task.promise };
  } catch (err) {
    await task.destroy().catch(() => {});
    throw err;
  }
}

/**
 * End an open document's pdf.js worker, which holds the whole book. In
 * pdf.js 6 the document itself has no destroy(); its loading task does.
 * Never rejects: a failure to close is only logged.
 * @param {object|null|undefined} pdfDoc  A PDFDocumentProxy, or nothing.
 * @returns {Promise<void>}
 */
export async function closePdfDocument(pdfDoc) {
  try {
    await pdfDoc?.loadingTask?.destroy();
  } catch (err) {
    console.warn("CarlRPG | closing the rulebook PDF failed", err);
  }
}
