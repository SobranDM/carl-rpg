/**
 * 0.7.0: the Character's old Pet tab becomes real actors.
 *
 * The printed sheet's Pet page held two inline stat blocks on a Character:
 * `system.pet` and `system.mount` ("Mount / Vehicle"). They're gone from the
 * Character schema; CarlRPGActor.migrateData keeps their raw values in
 * `flags.carl-rpg.legacyCompanions` (Foundry would otherwise drop them when
 * it cleans the source). This turns each filled-in block into its own actor
 * - the Pet block a Pet (owned by the Character), the Mount block a Vehicle
 * - checks every mapped value landed, and only then erases the old data.
 *
 * Nothing is lost: what has no field on the new type goes, verbatim, into
 * that actor's Biography (its Description tab) under "From the old Pet tab".
 *  - Pet: Evade (now worked out from DEX + Floor), the two free-text Attacks
 *    and Special (a Pet's attacks are Skill items now), an HB other than the
 *    untouched 10/10 (kept too, as an HB slot override), a Size that isn't a
 *    number or size name, and any number that had to be clamped.
 *  - Vehicle: Accessories (Vehicles only have their upgrade boxes), an HB
 *    max other than 10 (a Vehicle always has 10 slots), a Size that isn't a
 *    number or size name, and any number that had to be clamped.
 *
 * Safe to run again: each new actor is tagged `flags.carl-rpg.migratedFrom`
 * ({uuid, block, original} - the old block verbatim, too); one already made
 * for a block is reused, never made twice. A converted Character is marked
 * `flags.carl-rpg.companionsMigrated`, so even old keys the database kept
 * aren't brought back.
 */
import CarlRPGPet from "../data/pet.mjs";
import { grantPetSkills } from "./pets.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { parseSize } from "./size.mjs";
import { ownerIds, withOwners } from "./ownership.mjs";

export const COMPANIONS_MIGRATION_ID = "0.7.0-companion-actors";
const SCOPE = "carl-rpg";

/** The old blocks the safety net kept for this actor, or null. */
export function legacyCompanionsOf(actor) {
  return actor?.flags?.[SCOPE]?.legacyCompanions ?? null;
}

const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && !value.trim());

/** A whole number from a stored value, or null if there isn't one. */
function toInt(value) {
  if (isBlank(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** The old blocks' Health Bar default (10/10) - indistinguishable from untouched. */
function isDefaultHb(hb) {
  return !hb || ((toInt(hb.value) ?? 10) === 10 && (toInt(hb.max) ?? 10) === 10);
}

/**
 * Was anything entered in this old block? Any text, any number, any
 * Attack - and its Health Bar only if it isn't the untouched 10/10.
 * @param {object|null} block
 * @returns {boolean}
 */
export function blockEntered(block) {
  if (!block || typeof block !== "object") return false;
  for (const [key, value] of Object.entries(block)) {
    if (key === "hb") {
      if (!isDefaultHb(value)) return true;
    } else if (Array.isArray(value)) {
      if (value.some((v) => !isBlank(v))) return true;
    } else if (!isBlank(value)) {
      return true;
    }
  }
  return false;
}

// The old free-text Size is read by helpers/size.mjs (shared with a Race's Size).
export { parseSize };

const loc = (key, data) => game.i18n.format(`CARLRPG.Migration.Companions.${key}`, data ?? {});

/**
 * The common part of a new actor's data, and a recorder for what is set
 * (to verify after creating) and what has nowhere to go (its Biography).
 */
function builder() {
  const system = {};
  const expected = {};
  const notes = [];
  const set = (path, value) => {
    foundry.utils.setProperty(system, path, value);
    expected[`system.${path}`] = value;
  };
  const note = (label, value) => notes.push({ label, value: String(value) });
  /** Set a whole number within [min, max]; a clamped one is noted with its original. */
  const setInt = (path, raw, { min = -Infinity, max = Infinity, label }) => {
    const n = toInt(raw);
    if (n === null) return null;
    const v = Math.min(Math.max(n, min), max);
    set(path, v);
    if (v !== n) note(label, loc("Clamped", { value: n, now: v }));
    return v;
  };
  return { system, expected, notes, set, note, setInt };
}

/** The tag a new actor carries: where it came from, and the old block verbatim. */
function migratedFlags(character, block, original) {
  return { [SCOPE]: { migratedFrom: { uuid: character.uuid, block, original: foundry.utils.deepClone(original) } } };
}

/** Its Biography: the "From the old Pet tab" list, or "" when nothing was left over. */
function biographyFor(character, notes) {
  if (!notes.length) return "";
  const items = notes.map((n) => `<li><strong>${esc(n.label)}:</strong> ${esc(n.value)}</li>`).join("");
  return `<h3>${esc(loc("Heading"))}</h3><p>${esc(loc("Intro", { name: character.name }))}</p><ul>${items}</ul>`;
}

/**
 * The Pet actor for a Character's old Pet block.
 * @param {Actor} character
 * @param {object} pet  The old system.pet.
 * @param {{inPack?: boolean}} [options]  inPack: the Character is in a
 *   compendium. A Pet's crawler is a world actor, found by id - a compendium
 *   entry's id means nothing there - so it's left unbonded, its crawler
 *   named in its Biography.
 * @returns {{data: object, notes: {label: string, value: string}[], expected: Object<string, *>}}
 */
export function petDataFrom(character, pet, { inPack = false } = {}) {
  const b = builder();
  const L = (key) => game.i18n.localize(key);
  if (inPack) b.note(loc("Crawler"), character.name);
  else b.set("ownerId", character.id);
  const level = b.setInt("attributes.level.value", pet.level, { min: 1, max: 250, label: L("CARLRPG.Actor.Level") });
  for (const key of Object.keys(CONFIG.CARLRPG.stats)) {
    b.setInt(`stats.${key}.value`, pet[key], { min: 1, label: L(CONFIG.CARLRPG.statAbbreviations?.[key] ?? key) });
  }
  b.setInt("dr", pet.dr, { min: 0, label: "DR" });
  b.setInt("move", pet.move, { min: 0, label: L("CARLRPG.Actor.Move") });
  let size = null;
  if (!isBlank(pet.size)) {
    size = parseSize(pet.size);
    if (size !== null) b.set("size", size);
    else b.note(L("CARLRPG.Actor.Size"), pet.size);
  }
  if (!isBlank(pet.evade)) b.note(loc("Evade"), pet.evade);
  (pet.attacks ?? []).forEach((attack, i) => {
    if (!isBlank(attack)) b.note(loc("Attack", { n: i + 1 }), attack);
  });
  if (!isBlank(pet.special)) b.note(loc("Special"), pet.special);

  // An untouched 10/10 can't be told from an entered one: the Pet gets its
  // rule HB. Anything else carries over (as an override where it differs).
  if (!isDefaultHb(pet.hb)) {
    const rule = CarlRPGPet.hbSlotsFor({ size: size ?? 3, level: level ?? 1, isMount: false });
    const max = toInt(pet.hb.max);
    const slots = max !== null && max >= 1 ? max : rule;
    if (slots !== rule) b.set("hbSlotsOverride", slots);
    const value = toInt(pet.hb.value);
    if (value !== null) b.set("hb.value", Math.min(Math.max(value, 0), slots));
    b.note(L("CARLRPG.Actor.HealthBar"), `${pet.hb.value ?? "-"}/${pet.hb.max ?? "-"}`);
  }

  const name = isBlank(pet.name) ? loc("PetName", { name: character.name }) : String(pet.name).trim();
  const biography = biographyFor(character, b.notes);
  // Checked for presence only - its HTML may be tidied when saved.
  if (biography) foundry.utils.setProperty(b.system, "biography", biography);
  const data = { name, type: "pet", folder: character.folder?.id ?? null, system: b.system, flags: migratedFlags(character, "pet", pet) };
  return { data, notes: b.notes, expected: { name, ...b.expected } };
}

/**
 * The Vehicle actor for a Character's old Mount / Vehicle block.
 * @param {Actor} character
 * @param {object} mount  The old system.mount.
 * @returns {{data: object, notes: {label: string, value: string}[], expected: Object<string, *>}}
 */
export function vehicleDataFrom(character, mount) {
  const b = builder();
  const L = (key) => game.i18n.localize(key);
  if (!isBlank(mount.size)) {
    const size = parseSize(mount.size);
    if (size !== null) b.set("size", size);
    else b.note(L("CARLRPG.Actor.Size"), mount.size);
  }
  b.setInt("move", mount.move, { min: 0, label: L("CARLRPG.Actor.Move") });
  b.setInt("occupancy", mount.occupants, { min: 1, label: loc("Occupants") });
  b.setInt("dr", mount.dr, { min: 0, label: "DR" });
  if (!isBlank(mount.accessories)) b.note(loc("Accessories"), mount.accessories);
  if (!isDefaultHb(mount.hb)) {
    const max = toInt(mount.hb.max);
    const raw = toInt(mount.hb.value);
    const value = raw === null ? null : Math.min(Math.max(raw, 0), 10);
    if (value !== null) b.set("hb.value", value);
    // One note: the slots a Vehicle can't have, or else a clamped value.
    if (max !== null && max !== 10) {
      b.note(L("CARLRPG.Actor.HealthBar"), loc("VehicleSlots", { value: mount.hb.value ?? "-", max }));
    } else if (value !== raw && raw !== null) {
      b.note(L("CARLRPG.Actor.HealthBar"), loc("Clamped", { value: raw, now: value }));
    }
  }

  // The Character's players can drive it - set here, not by Vehicle
  // _preCreate (which would add the migrating GM's own crawler's players).
  const ownership = withOwners({ default: character.ownership?.default ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }, ownerIds(character));

  const name = isBlank(mount.name) ? loc("VehicleName", { name: character.name }) : String(mount.name).trim();
  const biography = biographyFor(character, b.notes);
  // Checked for presence only - its HTML may be tidied when saved.
  if (biography) foundry.utils.setProperty(b.system, "biography", biography);
  const data = {
    name, type: "vehicle", folder: character.folder?.id ?? null, ownership, system: b.system,
    flags: migratedFlags(character, "mount", mount),
  };
  return { data, notes: b.notes, expected: { name, ...b.expected } };
}

const BLOCKS = [
  { block: "pet", build: petDataFrom },
  { block: "mount", build: vehicleDataFrom },
];

const madeFrom = (entry, character, block) => {
  const from = entry.flags?.[SCOPE]?.migratedFrom;
  return from?.uuid === character.uuid && from?.block === block;
};

/**
 * One already made from this Character's block (a re-run), if any - in the
 * world, or in the pack (found from its index, without loading every entry).
 * @returns {Promise<Actor|null>}
 */
async function findMigrated(character, block, pack) {
  if (!pack) return game.actors.find((a) => madeFrom(a, character, block)) ?? null;
  const collection = game.packs.get(pack);
  const index = await collection.getIndex({ fields: [`flags.${SCOPE}.migratedFrom`] });
  const entry = index.find((e) => madeFrom(e, character, block));
  return entry ? collection.getDocument(entry._id) : null;
}

/**
 * Turn one Character's old Pet tab into actors: create (or find) one per
 * filled-in block, check each mapped value landed, then erase the old data -
 * only if every block checked out.
 * @param {Actor} character
 * @param {{pack?: string|null}} [options]  pack: the world compendium the
 *   Character is in (its new actors go there too).
 * @returns {Promise<{ok: boolean, created: {actor: Actor, notes: object[]}[], error?: string}>}
 */
export async function migrateCompanionsOf(character, { pack = null } = {}) {
  const legacy = legacyCompanionsOf(character);
  if (!legacy) return { ok: true, created: [] };
  const created = [];
  for (const { block, build } of BLOCKS) {
    if (!blockEntered(legacy[block])) continue;
    const { data, notes, expected } = build(character, legacy[block], { inPack: !!pack });
    let actor = await findMigrated(character, block, pack);
    let madeNow = false;
    if (!actor) {
      actor = await Actor.implementation.create(data, { pack, carlMigration: true, renderSheet: false });
      madeNow = true;
    }
    if (!actor) return { ok: false, created, error: `couldn't create the ${block} actor` };
    // Only one made just now is checked: one from an earlier run may have
    // levelled with its crawler or been edited since, and that's fine.
    if (madeNow) {
      const wrong = Object.entries(expected)
        .filter(([path, value]) => foundry.utils.getProperty(actor._source, path) !== value)
        .map(([path]) => path);
      if (data.system.biography && !actor._source.system?.biography) wrong.push("system.biography");
      if (wrong.length) {
        await actor.delete();
        return { ok: false, created, error: `the new ${block} actor didn't keep ${wrong.join(", ")}` };
      }
      // A new Pet learns its Slice Attack here, awaited - not in the
      // background as usual (CarlRPGActor#_onCreate skips a migration's), so
      // it's done before a compendium is locked again.
      if (actor.type === "pet") {
        try {
          await grantPetSkills(actor);
        } catch (err) {
          console.error(`carl-rpg | 0.7.0 migration: ${actor.name} didn't learn its Skills`, err);
        }
      }
    }
    created.push({ actor, notes, block });
  }

  // Every block checked out: erase the old data. Replacing system with its
  // own (already pruned) source drops pet/mount from the database - a plain
  // update can't, as the client strips keys the schema doesn't know. diff:
  // false, or the client would see no difference and send nothing.
  const { ForcedReplacement, ForcedDeletion } = foundry.data.operators;
  await character.update({
    system: ForcedReplacement.create(character.system.toObject()),
    flags: { [SCOPE]: { legacyCompanions: new ForcedDeletion(), companionsMigrated: true } },
  }, { diff: false, render: false, carlMigration: true });
  return { ok: true, created };
}

/** Post the GM a summary: what was made from whose Pet tab, and what went to a Biography. */
async function postSummary(rows, failed) {
  if (!rows.length && !failed.length) return;
  const link = (actor) => `<a class="content-link" draggable="true" data-link data-uuid="${actor.uuid}" data-type="Actor">`
    + `<i class="fas fa-user"></i>${esc(actor.name)}</a>`;
  const lines = rows.map(({ character, created }) => {
    const made = created.map(({ actor, notes }) => {
      const kept = notes.length ? ` - ${esc(loc("ToBiography", { fields: notes.map((n) => n.label).join(", ") }))}` : "";
      return `<li>${link(actor)}${kept}</li>`;
    }).join("");
    return `<p><strong>${esc(character.name)}</strong></p><ul>${made}</ul>`;
  });
  if (failed.length) lines.push(`<p class="carl-hint">${esc(loc("Failed", { names: failed.join(", ") }))}</p>`);
  await createCardMessage({
    title: loc("CardTitle"),
    body: lines.join(""),
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
  });
}

/** The world's Characters that still have old Pet tab data. */
function flaggedWorldCharacters() {
  return game.actors.filter((a) => a.type === "character" && legacyCompanionsOf(a)).map((character) => ({ character }));
}

/**
 * Convert every given Character still carrying old Pet tab data.
 * @param {{character: Actor, pack?: string|null}[]} entries
 * @returns {Promise<{changed: number, errors: number, incomplete: boolean}>}
 */
async function convertAll(entries) {
  const rows = [];
  const failed = [];
  let changed = 0;
  for (const { character, pack = null } of entries) {
    try {
      const result = await migrateCompanionsOf(character, { pack });
      if (!result.ok) {
        console.error(`carl-rpg | 0.7.0 migration: ${character.name}: ${result.error}`);
        failed.push(character.name);
        continue;
      }
      changed += result.created.length + 1;
      if (result.created.length) rows.push({ character, created: result.created });
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't move ${character.name}'s Pet tab`, err);
      failed.push(character.name);
    }
  }
  try {
    await postSummary(rows, failed);
  } catch (err) {
    console.error("carl-rpg | 0.7.0 migration: couldn't post its summary card", err);
  }
  if (failed.length) ui.notifications.warn(loc("Failed", { names: failed.join(", ") }), { permanent: true });
  return { changed, errors: failed.length, incomplete: failed.length > 0 };
}

/**
 * The 0.7.0 migration: world Characters, and Characters in the world's own
 * compendiums (their new actors go in the same pack, unlocked for the run).
 * Incomplete - so it runs again next load - while any couldn't be converted.
 * @returns {Promise<{changed: number, errors: number, incomplete: boolean}>}
 */
export async function migrateCompanionActors() {
  const entries = flaggedWorldCharacters();
  const packs = game.packs.filter((p) => p.documentName === "Actor" && p.metadata.packageType === "world");
  const relock = [];
  try {
    for (const pack of packs) {
      // The index is the stored data, before the safety net: a Character
      // with old Pet tab data still shows system.pet / system.mount there.
      const index = await pack.getIndex({ fields: ["system.pet", "system.mount", `flags.${SCOPE}.companionsMigrated`] });
      const ids = index
        .filter((e) => e.type === "character" && !e.flags?.[SCOPE]?.companionsMigrated && (e.system?.pet || e.system?.mount))
        .map((e) => e._id);
      if (!ids.length) continue;
      const flagged = (await pack.getDocuments({ _id__in: ids })).filter((a) => legacyCompanionsOf(a));
      if (!flagged.length) continue;
      if (pack.locked) {
        await pack.configure({ locked: false });
        relock.push(pack);
      }
      for (const character of flagged) entries.push({ character, pack: pack.collection });
    }
    return await convertAll(entries);
  } finally {
    for (const pack of relock) await pack.configure({ locked: true });
  }
}

/**
 * Once the migration is recorded (migrateWorld calls this then): a world
 * Character that still has old Pet tab data - one imported later from an
 * older export, whose old values the safety net kept - is converted.
 * @returns {Promise<void>}
 */
export async function sweepLegacyCompanions() {
  const entries = flaggedWorldCharacters();
  if (entries.length) await convertAll(entries);
}
