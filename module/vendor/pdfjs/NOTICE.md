`pdf.mjs` and `pdf.worker.mjs` are vendored from [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) (Mozilla's PDF.js), licensed under the Apache License 2.0. Vendored directly (rather than loaded from `node_modules` at runtime) because Foundry loads system code as native ES modules with no bundling step.

To update: `npm install pdfjs-dist@latest` then re-copy `node_modules/pdfjs-dist/build/pdf.mjs` and `pdf.worker.mjs` here.
