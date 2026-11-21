/**
 * What a rulebook import wrote, so a re-import can tell a document the GM
 * never touched from one they edited (ruled 2026-11-18, Q5).
 *
 * Each imported document carries, in flags.carl-rpg.pdfImport:
 *   - `fields`: the paths the import wrote (from the data it sent - not
 *     `_id`, `folder`, `sort`, `flags`, `ownership` or `_stats`). An array of
 *     objects (`system.changes`, Upgrade tiers, target effects) is followed
 *     into its elements as stored after the write - `system.changes.0.value`
 *     and so on, plus `system.changes.length` - so a key a later version adds
 *     to those objects (filled in with its default) is never part of it; an
 *     array of plain values is one value;
 *   - `hash`: a fingerprint of those paths' stored values, read back after
 *     the write (so the data model's own cleaning is part of it);
 *   - `v`: FINGERPRINT_VERSION.
 * The re-check reads the same stored paths. A parser that later writes new
 * fields (or drops some) doesn't make an untouched document look edited: the
 * new fields are fingerprinted when it next updates.
 *
 * Version 1 (0.7.0 development builds) hashed arrays whole. A v1 document
 * whose v1 hash still matches is untouched (and re-stamped as v2 when next
 * written); one that doesn't stays edited. A document with no `v`, or an
 * unknown one, was imported by an older version (before 0.7.0 a fingerprint
 * covered whatever the newest parse wrote, so every new parsed field read as
 * an edit): it counts as untouched once and is re-baselined. A migration
 * that rewrites imported fields on a document that was untouched before its
 * write calls restamp after it, so the change isn't read as a GM edit.
 *
 * A field a later version's import adds (a Mob's AI Text, 0.8.2) isn't in
 * an older stamp, so text the GM typed there is found by textSinceImport
 * instead.
 *
 * Pure (no Foundry globals).
 */

export const FINGERPRINT_VERSION = 2;

/** Top-level keys that are never part of what an import wrote. */
const NOT_WRITTEN = new Set(["_id", "folder", "sort", "flags", "ownership", "_stats"]);

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** An array followed into its elements: one holding objects (or arrays). */
const isDeepArray = (value) =>
  Array.isArray(value) && value.some((e) => e && typeof e === "object");

/**
 * Push the paths of one value: an object's leaves, a deep array's elements
 * (and its length), anything else whole.
 * @param {*} value      What the import sent there.
 * @param {string} path
 * @param {*} stored     The stored value there, if known: a deep array is followed as stored.
 * @param {string[]} out
 */
function walk(value, path, stored, out) {
  if (Array.isArray(value)) {
    const list = Array.isArray(stored) ? stored : value;
    if (!isDeepArray(list)) {
      out.push(path);
      return;
    }
    out.push(`${path}.length`);
    list.forEach((element, i) => walk(element, `${path}.${i}`, element, out));
  } else if (isPlainObject(value) && Object.keys(value).length) {
    for (const [key, inner] of Object.entries(value)) {
      walk(inner, `${path}.${key}`, isPlainObject(stored) ? stored[key] : undefined, out);
    }
  } else out.push(path);
}

/**
 * The paths a piece of import data writes: every leaf of its plain
 * objects, an empty object or an array of plain values counting as one, an
 * array of objects followed into its elements (as stored in `source`, when
 * given) with its length.
 * @param {object} data
 * @param {object} [source]  The document's stored data after the write.
 * @returns {string[]}  Sorted.
 */
export function writtenFields(data, source) {
  const out = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!NOT_WRITTEN.has(key)) walk(value, key, source?.[key], out);
  }
  return [...new Set(out)].sort();
}

/**
 * Stored fields with every followed array re-read from the stored data now
 * (its elements and length as they are): for restamp, and to bring a v1
 * flag's whole-array fields to v2's.
 * @param {object} source
 * @param {string[]} fields
 * @returns {string[]}  Sorted.
 */
function currentFields(source, fields) {
  const roots = new Set();
  for (const field of fields) {
    if (field.endsWith(".length")) roots.add(field.slice(0, -".length".length));
    else if (isDeepArray(getPath(source, field))) roots.add(field);
  }
  // Only the outermost: an inner array is re-read with its parent.
  const outer = [...roots].filter((r) => ![...roots].some((o) => o !== r && r.startsWith(`${o}.`)));
  const under = (field) => outer.some((r) => field === r || field.startsWith(`${r}.`));
  const out = fields.filter((field) => !under(field));
  for (const root of outer) {
    const value = getPath(source, root);
    walk(Array.isArray(value) ? value : [], root, value, out);
  }
  return [...new Set(out)].sort();
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
  const fields = writtenFields(data, source);
  return { v: FINGERPRINT_VERSION, fields, hash: fingerprint(source, fields) };
}

/**
 * The flag values to stamp on a document a migration just wrote, if it was
 * untouched before the write (importState, read before it): the same
 * fields, its followed arrays re-read as they are now, and a new hash. A v1
 * flag's whole arrays become v2's element paths.
 * @param {object} source  Its stored data, after the write.
 * @param {object|undefined} flag  Its flags.carl-rpg.pdfImport.
 * @returns {{v: number, fields: string[], hash: string}|null}  null: nothing
 *   to restamp (no fingerprint, so it's re-baselined on the next import anyway).
 */
export function restamp(source, flag) {
  if (!flag?.hash || !Array.isArray(flag.fields)) return null;
  const fields = currentFields(source, flag.fields);
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
  // Imported before fingerprints: untouched once.
  if (!flag.hash || !Array.isArray(flag.fields)) return "untouched";
  // v1 hashed the same paths' values, its arrays whole: still checkable.
  if (flag.v === 1 || flag.v === FINGERPRINT_VERSION) {
    return fingerprint(source, flag.fields) === flag.hash ? "untouched" : "edited";
  }
  // An unknown version: untouched once, and re-baselined.
  return "untouched";
}

/** Text with its tags and spaces taken out: "" for an empty editor. */
const bareText = (value) =>
  String(value)
    .replace(/<[^>]*>|&nbsp;/g, "")
    .replace(/\s+/g, "");

/**
 * Text the GM wrote in a field the last import didn't write - one a later
 * version's import has added, such as a Mob's AI Text (0.8.2) - which this
 * import would replace. The fingerprint can't see such an edit (the field
 * isn't in it), so a re-import counts the document as edited when there is
 * any, and leaves it alone (ruled 2026-11-21).
 * @param {object} data    What the import would write.
 * @param {object} source  The document's stored data.
 * @param {object|undefined} flag  Its flags.carl-rpg.pdfImport.
 * @returns {string[]}  The paths, sorted.
 */
export function textSinceImport(data, source, flag) {
  // Imported before fingerprints: no list of what it wrote, and untouched
  // once by design (importState).
  if (!Array.isArray(flag?.fields)) return [];
  const stamped = new Set(flag.fields);
  return writtenFields(data, source).filter((path) => {
    if (stamped.has(path)) return false;
    const stored = getPath(source, path);
    if (typeof stored !== "string" || !bareText(stored)) return false;
    return bareText(stored) !== bareText(getPath(data, path) ?? "");
  });
}
