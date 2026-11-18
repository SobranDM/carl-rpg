/**
 * What a rulebook import wrote, so a re-import can tell a document the GM
 * never touched from one they edited (ruled 2026-11-18, Q5).
 *
 * Each imported document carries, in flags.carl-rpg.pdfImport:
 *   - `fields`: the paths the import wrote (from the data it sent - not
 *     `_id`, `folder`, `sort`, `flags`, `ownership` or `_stats`; an array is
 *     one value);
 *   - `hash`: a fingerprint of those paths' stored values, read back after
 *     the write (so the data model's own cleaning is part of it);
 *   - `v`: FINGERPRINT_VERSION.
 * The re-check reads the same stored paths. A parser that later writes new
 * fields (or drops some) doesn't make an untouched document look edited: the
 * new fields are fingerprinted when it next updates.
 *
 * A document with no `v`, or another one, was imported by an older version
 * (before 0.7.0 a fingerprint covered whatever the newest parse wrote, so
 * every new parsed field read as an edit): it counts as untouched once and
 * is re-baselined. Bump the version when a migration rewrites imported
 * fields, so they aren't read as GM edits.
 *
 * Pure (no Foundry globals).
 */

export const FINGERPRINT_VERSION = 1;

/** Top-level keys that are never part of what an import wrote. */
const NOT_WRITTEN = new Set(["_id", "folder", "sort", "flags", "ownership", "_stats"]);

/**
 * The paths a piece of import data writes: every leaf of its plain
 * objects, an array (or an empty object) counting as one.
 * @param {object} data
 * @returns {string[]}  Sorted.
 */
export function writtenFields(data) {
  const out = [];
  const walk = (value, path) => {
    const isObject = value && typeof value === "object" && !Array.isArray(value);
    if (isObject && Object.keys(value).length) {
      for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key);
    } else out.push(path);
  };
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!NOT_WRITTEN.has(key)) walk(value, key);
  }
  return out.sort();
}

function getPath(source, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), source);
}

/** JSON with object keys sorted, so stored key order doesn't matter. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A short fingerprint of a document's stored values at `fields`.
 * @param {object} source  The document's stored data (`doc._source`).
 * @param {string[]} fields
 * @returns {string}
 */
export function fingerprint(source, fields) {
  const text = stableJson(fields.map((f) => [f, getPath(source, f)]));
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * The flag values to stamp on a document just written from `data`.
 * @param {object} source  Its stored data, after the write.
 * @param {object} data    What the import wrote.
 * @returns {{v: number, fields: string[], hash: string}}
 */
export function importStamp(source, data) {
  const fields = writtenFields(data);
  return { v: FINGERPRINT_VERSION, fields, hash: fingerprint(source, fields) };
}

/**
 * Whether a re-import may overwrite this document.
 * @param {object} source  The document's stored data.
 * @param {object|undefined} flag  Its flags.carl-rpg.pdfImport.
 * @returns {"untouched"|"edited"|"notImported"}
 *   notImported: the import didn't make it (no flag) - a GM's own document
 *   of the same name, left alone.
 */
export function importState(source, flag) {
  if (!flag || typeof flag !== "object") return "notImported";
  // Imported before fingerprints, or by an older fingerprint: untouched once.
  if (!flag.hash || flag.v !== FINGERPRINT_VERSION || !Array.isArray(flag.fields))
    return "untouched";
  return fingerprint(source, flag.fields) === flag.hash ? "untouched" : "edited";
}
