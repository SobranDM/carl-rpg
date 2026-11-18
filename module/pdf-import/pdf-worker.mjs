/**
 * The pdf.js worker entry (GlobalWorkerOptions.workerSrc, pdf-loader.mjs):
 * the polyfills first, then the vendored worker. Imports run in order, so
 * the polyfills are in place before any pdf.js code. Re-exports the worker
 * because pdf.js's fallback "fake worker" imports this same URL on the main
 * thread and reads WorkerMessageHandler from it.
 */
import "./pdf-polyfills.mjs";

export * from "../vendor/pdfjs/pdf.worker.mjs";
