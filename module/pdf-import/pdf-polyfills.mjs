/**
 * Polyfills for the vendored pdf.js (module/vendor/pdfjs/, the "modern"
 * build), which assumes the newest built-ins. Each is installed only where
 * the browser (or Node, for tools/pdf-import) lacks it, and follows the
 * spec's behaviour for the way pdf.js calls it.
 *
 * Loaded on the main thread by pdf-loader.mjs and inside the pdf.js worker
 * by pdf-worker.mjs - the worker is its own realm, so a main-thread
 * polyfill never reaches it. Kept here rather than vendoring pdf.js's
 * "legacy" build: that build carries a large core-js bundle for much older
 * browsers, while Foundry v14's browsers lack only these few.
 */

for (const Ctor of [Map, WeakMap]) {
  // Map.prototype.getOrInsert / getOrInsertComputed (TC39 "upsert").
  if (typeof Ctor.prototype.getOrInsertComputed !== "function") {
    Object.defineProperty(Ctor.prototype, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value(key, callback) {
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      },
    });
  }
  if (typeof Ctor.prototype.getOrInsert !== "function") {
    Object.defineProperty(Ctor.prototype, "getOrInsert", {
      configurable: true,
      writable: true,
      value(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
}

// Math.sumPrecise: a plain sum is close enough for pdf.js's use (bounding boxes).
if (typeof Math.sumPrecise !== "function") {
  Math.sumPrecise = (values) => {
    let sum = 0;
    for (const value of values) sum += value;
    return sum;
  };
}

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function () {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof Promise.try !== "function") {
  Promise.try = function (fn, ...args) {
    return new this((resolve) => resolve(fn(...args)));
  };
}

// Uint8Array base64/hex (the document fingerprint is a toHex()).
if (typeof Uint8Array.prototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    writable: true,
    value() {
      let out = "";
      for (const byte of this) out += byte.toString(16).padStart(2, "0");
      return out;
    },
  });
}
if (typeof Uint8Array.prototype.toBase64 !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    configurable: true,
    writable: true,
    value() {
      let binary = "";
      for (let i = 0; i < this.length; i += 0x8000) {
        binary += String.fromCharCode(...this.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    },
  });
}
if (typeof Uint8Array.fromBase64 !== "function") {
  Object.defineProperty(Uint8Array, "fromBase64", {
    configurable: true,
    writable: true,
    value(text) {
      const binary = atob(String(text).replace(/\s+/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    },
  });
}
