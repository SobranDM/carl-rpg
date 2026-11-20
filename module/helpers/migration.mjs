/**
 * One-time world migrations: data fixes for a world made by an older version
 * of the system. Run from the `ready` hook (module/carl-rpg.mjs).
 *
 * - Only the active GM runs them (game.user.isActiveGM), so players never
 *   write and normally exactly one client does. (The same GM in two tabs, or
 *   a GM handover mid-run, could overlap - harmless, as below.)
 * - Each migration has an id; the hidden world setting
 *   `carl-rpg.completedMigrations` lists the ids a world has had, so each
 *   runs once per world - whatever version number it carries, and however
 *   the system was numbered when it ran. A world with nothing in it yet (no
 *   Actors, Items, Scenes or world compendium content) has nothing to fix:
 *   it's marked as having had them all (migrationPlan).
 * - Every migration is idempotent (it only changes what still needs it). Its
 *   id is recorded once a pass completes, even if it threw or some documents
 *   failed - they're reported, not retried forever (as dnd5e does). Only a
 *   run cut short (the tab closed mid-way), or one that reports itself
 *   incomplete (the Pet tab's: a Character must never be stranded), runs
 *   again on the next load.
 * - After that, the old Pet tab sweep (companion-migration.mjs) converts any
 *   world Character that still has old Pet tab data.
 * - Updates pass `render: false` and change only the one field involved, so
 *   no sheets redraw mid-run and no other data is rewritten.
 * - World compendiums are migrated too, unlocked for the run and locked
 *   again after. The system's own packs are rebuilt from source instead, and
 *   modules' packs aren't the world's to edit. Unlinked tokens' own item
 *   overrides aren't visited (as in dnd5e and Draw Steel).
 */
import { slugifySkillName } from "./modifiers.mjs";
import { createNoticeMessage } from "../chat/chat-card.mjs";
import { tierRank } from "./worship.mjs";
import {
  COMPANIONS_MIGRATION_ID,
  migrateCompanionActors,
  sweepLegacyCompanions,
} from "./companion-migration.mjs";
import {
  LEGACY_FLAG,
  MOB_ATTACK_TYPE,
  attacksToCheck,
  convertLegacyAttacks,
} from "./mob-attacks.mjs";
import { importState, restamp } from "../pdf-import/fingerprint.mjs";
import { parseSize } from "./size.mjs";
import { LEGACY_DRIVE_SKILLS } from "../data/vehicle.mjs";
import {
  HANDS,
  WEAR_SLOT_OF_GEAR_SLOT,
  accessoryKindOf,
  canWear,
  fitsSlot,
  guessGearSlots,
  heldOrWearable,
  isConsumable,
  isShield,
  isTwoHanded,
  isWeapon,
  slotsFromName,
} from "./gear.mjs";
import { freeSlotFor, isItemWorn, placeInFreeSlot } from "./equip-slots.mjs";
import { PACKS, withUnlockedPack } from "./packs.mjs";
import { gmUserIds } from "./ownership.mjs";
import { esc } from "./html.mjs";
import { unlinkedTokenActors } from "./token-resolution.mjs";

const SCOPE = "carl-rpg";
export const MIGRATION_SETTING = "completedMigrations";

/** The 0.7.0 Deity block migration's id (migrateDeityBlocks). */
export const DEITY_MIGRATION_ID = "0.7.0-deity-block";

/** The 0.7.0 Deity Tier backfill's id (migrateDeityTiers). */
export const DEITY_TIER_MIGRATION_ID = "0.7.0-deity-tier";

/** The 0.7.0 refresh of owned compendium items' id (migrateCompendiumCopies). */
export const COMPENDIUM_REFRESH_ID = "0.7.0-compendium-refresh";

/** The 0.7.0 Character base DR lock's id (migrateCharacterBaseDr). */
export const BASE_DR_MIGRATION_ID = "0.7.0-character-base-dr";

/** The 0.7.0 "character creation is done" mark's id (migrateChargenDone). */
export const CHARGEN_DONE_MIGRATION_ID = "0.7.0-chargen-done";

/** The 0.7.0 Weapon Skill notice's id (announceWeaponSkill). */
export const WEAPON_SKILL_NOTICE_ID = "0.7.0-weapon-skill-notice";

/** 0.7.0: a Mob's Attacks became items (docs/mob-sheet.md). */
export const MOB_ATTACKS_MIGRATION_ID = "0.7.0-mob-attack-items";

/** 0.7.0: a Mob's Size became Table 9's value, saved (migrateMobSizes). */
export const MOB_SIZE_MIGRATION_ID = "0.7.0-mob-size";

/** 0.7.0: gear says where it's worn (docs/gear-slots.md; migrateGearSlots). */
export const GEAR_SLOTS_MIGRATION_ID = "0.7.0-gear-slots";

/** 0.7.0: a blank Weapon Skill guessed from the item's name (migrateWeaponSkillGuesses). */
export const WEAPON_SKILL_GUESS_ID = "0.7.0-weapon-skill-guess";

/** Powerful Strike / Magic Missile multipliers moved to "base" (migrateBaseMultipliers). */
export const BASE_MULTIPLIER_MIGRATION_ID = "0.7.0-base-multipliers";

/** 0.7.0: a vehicle's driving Skill by name, its perks on the Skill's tiers, Lance's Mounted box (migrateVehicleSkillSettings). */
export const VEHICLE_SKILL_MIGRATION_ID = "0.7.0-vehicle-skill-settings";

/** 0.8.0: the Stat a Skill or Spell is Opposed by, on existing copies (migrateOpposedStats). */
export const OPPOSED_STATS_MIGRATION_ID = "0.8.0-opposed-stats";

/** 0.7.0: Skills' Needs no weapon / No Damage Effects / Commands pets boxes, gear's Hand-to-Hand Debuffs (migrateSkillSettingBoxes). */
export const SKILL_SETTING_BOXES_ID = "0.7.0-skill-setting-boxes";

/**
 * A world's completed ids with any renamed ones read as their new ids
 * (RENAMED_MIGRATION_IDS), without duplicates.
 * @param {string[]} done
 * @returns {string[]}
 */
export function currentMigrationIds(done) {
  return [...new Set((done ?? []).map((id) => RENAMED_MIGRATION_IDS[id] ?? id))];
}

/** Register the setting listing the migrations this world has had (init). */
export function registerMigrationSetting() {
  game.settings.register(SCOPE, MIGRATION_SETTING, {
    name: "Completed System Migrations",
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });
}

/**
 * What a world needs: which migrations to run, and the list of completed
 * ids to record after.
 * @param {{done: string[], hasContent: boolean}} world  done: the ids it has
 *   had; hasContent: whether it has any Actors, Items, Scenes or world
 *   compendium entries yet.
 * @returns {{run: typeof MIGRATIONS, record: string[]|null}}  record: null
 *   when nothing needs writing.
 */
export function migrationPlan({ done, hasContent }) {
  const had = new Set(currentMigrationIds(done));
  const missing = MIGRATIONS.filter((m) => !had.has(m.id));
  if (!missing.length) return { run: [], record: null };
  const record = [...had, ...missing.map((m) => m.id)];
  // A new world has nothing to fix: it has, in effect, had them all.
  if (!hasContent) return { run: [], record };
  return { run: missing, record };
}

/** Has this world anything that could need fixing? */
function worldHasContent() {
  if (game.actors.size + game.items.size + game.scenes.size > 0) return true;
  return game.packs.some((p) => p.metadata.packageType === "world" && p.index.size > 0);
}

/**
 * Bring this world's data up to date - once, on the active GM's client.
 * @returns {Promise<void>}
 */
export async function migrateWorld() {
  if (!game.user.isActiveGM) return;
  const stored = game.settings.get(SCOPE, MIGRATION_SETTING) ?? [];
  // A world that recorded these migrations under their old ids keeps them done.
  const done = currentMigrationIds(stored);
  if (done.length !== stored.length || done.some((id, i) => id !== stored[i])) {
    await game.settings.set(SCOPE, MIGRATION_SETTING, done);
  }
  const { run, record } = migrationPlan({ done, hasContent: worldHasContent() });
  if (record && !run.length) await game.settings.set(SCOPE, MIGRATION_SETTING, record);
  if (run.length) await runMigrations(run, done);
  // A pre-0.7.0 Character imported after the Pet tab migration ran still
  // has its old Pet tab turned into actors.
  if ((game.settings.get(SCOPE, MIGRATION_SETTING) ?? []).includes(COMPANIONS_MIGRATION_ID)) {
    await sweepLegacyCompanions();
  }
}

/**
 * Run these migrations in order, with a banner, recording each that finishes.
 * @param {typeof MIGRATIONS} run
 * @param {string[]} done  The ids recorded before.
 */
async function runMigrations(run, done) {
  const version = run.at(-1).version;
  const banner = ui.notifications.info(game.i18n.format("CARLRPG.Migration.Begin", { version }), {
    permanent: true,
  });
  let errors = 0;
  let changed = 0;
  const finished = [];
  // What each step couldn't migrate, for the GM's list at the end.
  const failures = [];
  try {
    for (const migration of run) {
      console.log(`carl-rpg | Running migration ${migration.id}`);
      const fail = (where, err) => failures.push(migrationFailure(migration.id, where, err));
      try {
        const result = await migration.run({ fail });
        errors += result.errors;
        changed += result.changed;
        // A full pass is recorded even if some documents failed - they're
        // reported rather than retried on every load - unless the migration
        // says it must run again (incomplete).
        if (!result.incomplete) finished.push(migration.id);
      } catch (err) {
        // Recorded too: reported once, not retried on every load.
        console.error(`carl-rpg | Migration ${migration.id} failed`, err);
        errors += 1;
        fail("", err);
        finished.push(migration.id);
      }
    }
    await game.settings.set(SCOPE, MIGRATION_SETTING, [...new Set([...done, ...finished])]);
  } finally {
    ui.notifications.remove(banner);
  }
  if (failures.length) {
    try {
      await whisperMigrationFailures(failures);
    } catch (err) {
      console.error("carl-rpg | couldn't whisper the migration failures", err);
    }
  }
  if (errors) {
    ui.notifications.warn(
      game.i18n.format("CARLRPG.Migration.Failed", { version, count: changed, errors }),
      { permanent: true },
    );
  } else {
    ui.notifications.info(game.i18n.format("CARLRPG.Migration.Done", { version, count: changed }), {
      permanent: true,
    });
  }
}

/* -------------------------------------------------- */
/*  Per-document writes and the GM's failure list     */
/* -------------------------------------------------- */

/** A step run on its own (a test, a re-run): failures are only counted and logged. */
const NO_FAIL = () => {};

/**
 * One failure as the GM's list shows it.
 * @param {string} step   The migration's id.
 * @param {string} where  The document (or pack) it couldn't migrate; "" for the whole step.
 * @param {unknown} err
 * @returns {{step: string, where: string, message: string}}
 */
export function migrationFailure(step, where, err) {
  return { step, where: String(where ?? ""), message: String(err?.message ?? err ?? "") };
}

/**
 * Whisper the GM one list of everything the migrations couldn't migrate.
 * @param {{step: string, where: string, message: string}[]} failures
 * @returns {Promise<ChatMessage>}
 */
export function whisperMigrationFailures(failures) {
  const lines = failures.map((f) =>
    game.i18n.format("CARLRPG.Migration.Failures.Line", {
      where: esc(f.where || game.i18n.localize("CARLRPG.Migration.Failures.WholeStep")),
      step: esc(f.step),
      message: esc(f.message),
    }),
  );
  return whisperGmList("Failures", lines);
}

/**
 * Run `fn` on each document, one at a time: one that throws is reported and
 * the rest still run.
 * @param {Iterable<Document>} documents
 * @param {(doc: Document) => Promise<number|boolean>} fn  How many it changed (true: 1).
 * @param {(doc: Document, err: unknown) => void} onFail
 * @returns {Promise<number>}  The total changed.
 */
export async function eachDocument(documents, fn, onFail) {
  let total = 0;
  for (const doc of documents) {
    try {
      total += Number(await fn(doc)) || 0;
    } catch (err) {
      onFail(doc, err);
    }
  }
  return total;
}

/**
 * A migration's count of what it changed and what failed. `failed` logs a
 * failure, counts it and reports it (runMigrations' `fail`, which lists it
 * for the GM by `label`); `attempt` adds what `fn` changed, reporting a
 * throw as a failure of `label`.
 * @param {(where: string, err: unknown) => void} fail  runMigrations'.
 * @returns {{changed: number, errors: number,
 *   failed: (label: string, err: unknown, message?: string) => void,
 *   attempt: (label: string, fn: () => Promise<number|boolean>, message?: string) => Promise<void>,
 *   result: () => {changed: number, errors: number}}}
 */
function migrationTally(fail) {
  const tally = { changed: 0, errors: 0 };
  tally.failed = (label, err, message = `couldn't update ${label}`) => {
    console.error(`carl-rpg | 0.7.0 migration: ${message}`, err);
    tally.errors += 1;
    fail(label, err);
  };
  tally.attempt = async (label, fn, message) => {
    try {
      tally.changed += Number(await fn()) || 0;
    } catch (err) {
      tally.failed(label, err, message);
    }
  };
  tally.result = () => ({ changed: tally.changed, errors: tally.errors });
  return tally;
}

/**
 * Every world Actor, then every Actor in the world's own Actor compendiums
 * (unlocked for the run): `perActor` gives how many it changed (`where`: the
 * compendium's title). One that throws is reported by its name, a
 * compendium that can't be read by its id.
 * @param {ReturnType<typeof migrationTally>} tally
 * @param {(actor: Actor, where?: string) => Promise<number|boolean>} perActor
 * @param {{actorMessage: (actor: Actor) => string, packMessage: (pack: CompendiumCollection) => string}} messages
 *   The console messages for a failure.
 */
async function eachWorldActor(tally, perActor, { actorMessage, packMessage }) {
  for (const actor of game.actors)
    await tally.attempt(actor.name, () => perActor(actor), actorMessage(actor));
  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    try {
      await withUnlockedPack(pack, async () => {
        for (const actor of await pack.getDocuments()) {
          await tally.attempt(actor.name, () => perActor(actor, pack.title), actorMessage(actor));
        }
      });
    } catch (err) {
      tally.failed(pack.collection, err, packMessage(pack));
    }
  }
}

/**
 * One of the world's own compendiums, unlocked for the run: each Actor
 * through `onActor`; for an Item compendium, each Item's update
 * (`itemUpdate`, null for none) written together (updateItemsEach).
 * @param {CompendiumCollection} pack
 * @param {{onActor: (actor: Actor) => Promise<number>, itemUpdate: (item: Item) => object|null, options: object}} how
 *   options: the Item update's ({pack} is added).
 * @param {((label: string, err: unknown) => void)|null} failed  None: the first failure throws.
 * @returns {Promise<number>}  How many were changed.
 */
function migrateWorldPack(pack, { onActor, itemUpdate, options }, failed) {
  return withUnlockedPack(pack, async () => {
    const documents = await pack.getDocuments();
    const onFail = failed && ((doc, err) => failed(`${doc.name} (${pack.title})`, err));
    if (pack.documentName === "Actor")
      return eachDocument(
        documents,
        onActor,
        onFail ??
          ((doc, err) => {
            throw err;
          }),
      );
    const updates = documents.map(itemUpdate).filter(Boolean);
    return updateItemsEach(documents, updates, { pack: pack.collection, ...options }, onFail);
  });
}

/** An imported rulebook document the GM hadn't edited (fingerprint.mjs), so a migration's write can be re-stamped. */
function untouchedImport(doc) {
  const flag = doc?.flags?.[SCOPE]?.pdfImport;
  return (
    !!flag?.hash && Array.isArray(flag.fields) && importState(doc._source, flag) === "untouched"
  );
}

/**
 * Update unowned Items (the Items directory's, or one compendium's): as one
 * batch, or - if the batch fails - one at a time, so one bad document
 * doesn't stop the rest. A rulebook import the GM hadn't edited is
 * re-fingerprinted after (fingerprint.mjs restamp), so this write isn't
 * read as their edit on the next import.
 * @param {Iterable<Item>} documents  The Items the updates are for.
 * @param {object[]} updates  With `_id`.
 * @param {object} options    Update options ({pack} for a compendium's).
 * @param {(doc: Item|{name: string}, err: unknown) => void} [onFail]  None: the first failure throws.
 * @returns {Promise<number>}  How many were written.
 */
export async function updateItemsEach(documents, updates, options, onFail = null) {
  if (!updates.length) return 0;
  const cls = Item.implementation;
  const byId = new Map([...documents].map((d) => [d.id, d]));
  const untouched = new Set(
    updates.filter((u) => untouchedImport(byId.get(u._id))).map((u) => u._id),
  );
  const fresh = new Map();
  const keep = (docs) => {
    for (const d of docs ?? []) fresh.set(d.id, d);
  };
  const thrown = new Set();
  try {
    keep(await cls.updateDocuments(updates, { ...options }));
  } catch (batchErr) {
    if (!onFail) throw batchErr;
    for (const update of updates) {
      try {
        keep(await cls.updateDocuments([update], { ...options }));
      } catch (err) {
        thrown.add(update._id);
        onFail(byId.get(update._id) ?? { name: update._id }, err);
      }
    }
  }
  // Foundry skips (and only logs) a document whose update is invalid or
  // refused in pre-update, and still resolves: every update here changes
  // something, so one not given back wasn't written.
  for (const update of updates) {
    if (fresh.has(update._id) || thrown.has(update._id)) continue;
    onFail?.(
      byId.get(update._id) ?? { name: update._id },
      new Error(game.i18n.localize("CARLRPG.Migration.Failures.NotWritten")),
    );
  }
  const written = updates.filter((u) => fresh.has(u._id)).length;
  const key = `flags.${SCOPE}.pdfImport`;
  const stamps = [...untouched]
    .map((id) => fresh.get(id))
    .filter(Boolean)
    .map((doc) => ({ _id: doc.id, [key]: restamp(doc._source, doc.flags[SCOPE].pdfImport) }))
    .filter((s) => s[key]);
  if (stamps.length) {
    try {
      await cls.updateDocuments(stamps, { ...options });
    } catch (err) {
      if (!onFail) throw err;
      onFail({ name: stamps.map((s) => byId.get(s._id)?.name ?? s._id).join(", ") }, err);
    }
  }
  return written;
}

/* -------------------------------------------------- */
/*  0.7.0: the Hand-to-Hand box                       */
/* -------------------------------------------------- */

// The hand-to-hand Combat Skills (p.179), which 0.7.0's pack ticks.
const HAND_TO_HAND = new Set(
  ["Foot Soldier", "Noggin Nocker", "Pugilism", "Unarmed Combat", "Wrasslin'"].map((name) =>
    slugifySkillName(name),
  ),
);

/** A copy of one of the five whose Hand-to-Hand box isn't ticked yet. */
export function needsHandToHand(item) {
  return (
    item?.type === "skill" &&
    !item.system?.isHandToHand &&
    HAND_TO_HAND.has(slugifySkillName(item.name))
  );
}

/**
 * Tick the box on an Actor's own copies (a world or compendium Actor).
 * @param {Actor} actor
 * @returns {Promise<number>}  How many were ticked.
 */
export async function tickHandToHandOn(actor) {
  const updates = actor.items
    .filter(needsHandToHand)
    .map((item) => ({ _id: item.id, "system.isHandToHand": true }));
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { render: false });
  return updates.length;
}

/**
 * 0.7.0 added the Hand-to-Hand box to Skills. Copies of Foot Soldier,
 * Noggin Nocker, Pugilism, Unarmed Combat and Wrasslin' made before then -
 * on world Actors, in the Items directory and in world compendiums - get it
 * ticked, as the pack's own copies are.
 * Homebrew Skills are left alone.
 * @param {{fail?: (where: string, err: unknown) => void}} [context]  runMigrations'.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateHandToHandSkills({ fail = NO_FAIL } = {}) {
  const { attempt, failed, result } = migrationTally(fail);

  for (const actor of game.actors)
    await attempt(`Actor ${actor.name}`, () => tickHandToHandOn(actor));

  await attempt("the Items directory", () => {
    const updates = game.items
      .filter(needsHandToHand)
      .map((item) => ({ _id: item.id, "system.isHandToHand": true }));
    return updateItemsEach(game.items, updates, { render: false }, (item, err) =>
      failed(item.name, err),
    );
  });

  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () => migratePack(pack, failed));
  }
  return result();
}

/* -------------------------------------------------- */
/*  0.7.0: Skill setting boxes                        */
/* -------------------------------------------------- */

/**
 * The book's Skills whose name used to mean a behaviour, by the box 0.7.0's
 * pack ticks instead (module/data/skill.mjs): Needs no weapon (Improvised
 * Weapons, p.178; the natural attacks), No Damage Effects (Unarmed Combat,
 * p.179), Commands pets (Animal Handling, p.232). Only this migration (and
 * the Weapon Skill guess, which may run before it) reads these names.
 */
const SKILL_SETTING_BOXES = {
  noWeapon: ["Improvised Weapons", "Bite", "Back Claw", "Slice Attack"],
  noDamageEffects: ["Unarmed Combat"],
  commandsPets: ["Animal Handling"],
};
const BOX_BY_SLUG = new Map(
  Object.entries(SKILL_SETTING_BOXES).flatMap(([box, names]) =>
    names.map((name) => [slugifySkillName(name), box]),
  ),
);

/**
 * A copy of one of those Skills whose box isn't ticked yet, as the update
 * ticking it; null otherwise.
 * @param {Item} item
 * @returns {object|null}
 */
export function skillSettingBoxUpdate(item) {
  if (item?.type !== "skill") return null;
  const box = BOX_BY_SLUG.get(slugifySkillName(item.name));
  if (!box || item.system?.[box]) return null;
  return { _id: item.id, [`system.${box}`]: true };
}

/**
 * Is this gear Debuff's "Only with" list exactly the five hand-to-hand
 * Combat Skills (p.179) - what the rulebook importer wrote for "with any
 * Hand-to-Hand Attack" before 0.7.0's box? A partial list isn't.
 * @param {string[]} skills
 * @returns {boolean}
 */
export function isBookHandToHandList(skills) {
  const slugs = new Set(
    (skills ?? [])
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .map((s) => slugifySkillName(s)),
  );
  return slugs.size === HAND_TO_HAND.size && [...slugs].every((s) => HAND_TO_HAND.has(s));
}

/**
 * Gear whose Debuffs list the five hand-to-hand Skills by name, as the
 * update giving them the "With any Hand-to-Hand Attack" box instead (the
 * list cleared; the array written whole). Null when there's nothing to change.
 * @param {Item} item
 * @returns {object|null}
 */
export function handToHandOnlyUpdate(item) {
  if (item?.type !== "item") return null;
  const source = item._source?.system ?? item.system;
  let changed = false;
  const targetEffects = (source?.targetEffects ?? []).map((te) => {
    if (!isBookHandToHandList(te?.skills)) return te;
    changed = true;
    return { ...te, skills: [], handToHandOnly: true };
  });
  return changed ? { _id: item.id, "system.targetEffects": targetEffects } : null;
}

/** This step's update for one item (a Skill's box, or gear's Debuffs), or null. */
export function skillSettingUpdate(item) {
  return skillSettingBoxUpdate(item) ?? handToHandOnlyUpdate(item);
}

/**
 * The step on an Actor's own items (a world, token or compendium Actor).
 * @param {Actor} actor
 * @returns {Promise<number>}  How many were changed.
 */
export async function applySkillSettingBoxesOn(actor) {
  const updates = actor.items.map(skillSettingUpdate).filter(Boolean);
  if (updates.length)
    await actor.updateEmbeddedDocuments("Item", updates, { carlMigration: true, render: false });
  return updates.length;
}

/**
 * 0.7.0 replaced Skill behaviour read from names with boxes on the Skill,
 * so a GM's homebrew Skill can do the same. Copies made before then of
 * Improvised Weapons, Bite, Back Claw and Slice Attack get Needs no weapon,
 * Unarmed Combat No Damage Effects, Animal Handling Commands pets - and gear
 * Debuffs "Only with" exactly the five hand-to-hand Skills get "With any
 * Hand-to-Hand Attack" instead. On world Actors (and unlinked tokens' own
 * items), in the Items directory and in world compendiums. Homebrew Skills
 * and partial lists are left alone.
 * @param {{fail?: (where: string, err: unknown) => void}} [context]  runMigrations'.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function migrateSkillSettingBoxes({ fail = NO_FAIL } = {}) {
  const { attempt, failed, result } = migrationTally(fail);
  for (const actor of actorsWithOwnGear())
    await attempt(`Actor ${actor.name}`, () => applySkillSettingBoxesOn(actor));
  await attempt("the Items directory", () => {
    const updates = game.items.map(skillSettingUpdate).filter(Boolean);
    return updateItemsEach(
      game.items,
      updates,
      { carlMigration: true, render: false },
      (item, err) => failed(item.name, err),
    );
  });
  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () =>
      migrateWorldPack(
        pack,
        {
          onActor: applySkillSettingBoxesOn,
          itemUpdate: skillSettingUpdate,
          options: { carlMigration: true, render: false },
        },
        failed,
      ),
    );
  }
  return result();
}

/* -------------------------------------------------- */
/*  0.7.0: base-dice multipliers                      */
/* -------------------------------------------------- */

/**
 * Items whose multiplier scales only the base damage dice, not the total
 * (Powerful Strike, p.180: "Multiply your base damage dice result by your
 * Rank in this Skill, then add your modifiers and buffs"; Magic Missile
 * Rank 15: "base damage x3"). 0.7.0 split the old "multiplier" dice kind in
 * two - "multiplier" now means x total (Choke Out, Smush) and "base" on a
 * multiply change means x base dice - so these copies' old "multiplier"
 * would multiply more than the book says.
 */
const BASE_MULTIPLIER_ITEMS = new Set(["powerful-strike", "magic-missile"]);

/**
 * A copy of Powerful Strike or Magic Missile with "multiplier" changes, as
 * an update moving them to "base" (its own changes and every Upgrade
 * tier's; arrays written whole). Null when there's nothing to change.
 * @param {Item} item
 * @returns {object|null}
 */
export function baseMultiplierUpdate(item) {
  if (!["skill", "spell", "damageEffect"].includes(item?.type)) return null;
  if (!BASE_MULTIPLIER_ITEMS.has(slugifySkillName(item.name))) return null;
  const source = item._source?.system ?? item.system;
  let changed = false;
  const fix = (changes) =>
    (changes ?? []).map((c) => {
      if (c?.damageDiceKind !== "multiplier") return c;
      changed = true;
      return { ...c, damageDiceKind: "base" };
    });
  const changes = fix(source.changes);
  const upgrades = (source.upgrades ?? []).map((u) => ({ ...u, changes: fix(u.changes) }));
  if (!changed) return null;
  return { _id: item.id, "system.changes": changes, "system.upgrades": upgrades };
}

/** Fix an Actor's own copies (a world or compendium Actor). */
async function fixBaseMultipliersOn(actor) {
  const updates = actor.items.map(baseMultiplierUpdate).filter(Boolean);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { render: false });
  return updates.length;
}

/**
 * Powerful Strike and Magic Missile copies made before 0.7.0 - on world
 * Actors, in the Items directory and in world compendiums - get their
 * multiplier marked "base", as the pack's own copies are.
 * @param {{fail?: (where: string, err: unknown) => void}} [context]  runMigrations'.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateBaseMultipliers({ fail = NO_FAIL } = {}) {
  const { attempt, failed, result } = migrationTally(fail);
  for (const actor of game.actors)
    await attempt(`Actor ${actor.name}`, () => fixBaseMultipliersOn(actor));
  await attempt("the Items directory", () => {
    const updates = game.items.map(baseMultiplierUpdate).filter(Boolean);
    return updateItemsEach(game.items, updates, { render: false }, (item, err) =>
      failed(item.name, err),
    );
  });
  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () =>
      migrateWorldPack(
        pack,
        {
          onActor: fixBaseMultipliersOn,
          itemUpdate: baseMultiplierUpdate,
          options: { render: false },
        },
        failed,
      ),
    );
  }
  return result();
}

/**
 * The world's own Actor and Item packs - never the system's or a module's.
 * @param {CompendiumCollection} pack
 * @returns {boolean}
 */
function shouldMigratePack(pack) {
  return ["Actor", "Item"].includes(pack.documentName) && pack.metadata.packageType === "world";
}

/* -------------------------------------------------- */
/*  0.7.0: the structured Deity block                 */
/* -------------------------------------------------- */

/**
 * 0.7.0 turned a Character's Deity rich text box into a structured block
 * (module/data/character.mjs); CarlRPGCharacter.migrateData keeps the old
 * text as its notes, but only in memory. Until the block is saved whole,
 * the database still holds the old string, and an ordinary Deity edit -
 * sent as a diff such as {deity: {name}} - would be merged over that string
 * by the server, losing the notes. This writes each Character's block
 * whole, once. The client can't tell which Characters still hold a string
 * (it only sees the migrated data), so every Character is written - the same
 * value, so a second run changes nothing.
 * @param {{fail?: (where: string, err: unknown) => void}} [context]  runMigrations'.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateDeityBlocks({ fail = NO_FAIL } = {}) {
  const tally = migrationTally(fail);
  const failed = (label, err) => tally.failed(label, err, `couldn't save the Deity of ${label}`);
  const attempt = (label, fn) => tally.attempt(label, fn, `couldn't save the Deity of ${label}`);
  for (const actor of game.actors)
    await attempt(`Actor ${actor.name}`, () => persistDeityBlock(actor));
  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () =>
      withUnlockedPack(pack, async () =>
        eachDocument(await pack.getDocuments(), persistDeityBlock, (actor, err) =>
          failed(`${actor.name} (${pack.title})`, err),
        ),
      ),
    );
  }
  return tally.result();
}

/**
 * Save one Character's Deity block whole. A ForcedReplacement survives the
 * client's diff (a plain value equal to the migrated source would be
 * dropped as unchanged) and replaces whatever the database holds.
 * @param {Actor} actor
 * @returns {Promise<number>}  1 if it was a Character, else 0.
 */
export async function persistDeityBlock(actor) {
  if (actor.type !== "character") return 0;
  const { ForcedReplacement } = foundry.data.operators;
  const deity = foundry.utils.deepClone(actor.system.toObject().deity);
  await actor.update(
    { system: { deity: ForcedReplacement.create(deity) } },
    { render: false, carlMigration: true },
  );
  return 1;
}

/* -------------------------------------------------- */
/*  0.7.0: the Deity Tier, from the Boons owned       */
/* -------------------------------------------------- */

/**
 * The church Tier a Character's Boons imply: the highest Tier among its
 * tiered Boons (features), for a Character whose Deity block has no Tier
 * yet. "" when there's nothing to fill in.
 * @param {Actor} actor
 * @returns {string}
 */
export function inferDeityTier(actor) {
  if (actor?.type !== "character" || actor.system.deity?.tier) return "";
  let best = "";
  for (const item of actor.items) {
    const tier = item.type === "feature" ? item.system?.tier : "";
    if (tier && tierRank(tier) > tierRank(best)) best = tier;
  }
  return best;
}

/**
 * Fill in one Character's Deity Tier from its Boons (inferDeityTier), saving
 * the block whole as persistDeityBlock does.
 * @param {Actor} actor
 * @returns {Promise<string>}  The Tier set, or "" if none was.
 */
export async function backfillDeityTier(actor) {
  const tier = inferDeityTier(actor);
  if (!tier) return "";
  const { ForcedReplacement } = foundry.data.operators;
  const deity = { ...foundry.utils.deepClone(actor.system.toObject().deity), tier };
  await actor.update(
    { system: { deity: ForcedReplacement.create(deity) } },
    { render: false, carlMigration: true },
  );
  return tier;
}

/**
 * 0.7.0 gave the Deity block a Tier, and a tiered Boon now applies only at or
 * below it (worship.mjs deityBenefitApplies, pp.163-164). Before, a Boon's
 * Tier was only a label and every Boon applied. So a Character keeps its
 * Boons, its Tier is set to the highest Tier among them - only where no Tier
 * is set yet. The GM gets a whispered list of who was given which Tier, to
 * check.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateDeityTiers({ fail = NO_FAIL } = {}) {
  const tally = migrationTally(fail);
  const lines = [];
  await eachWorldActor(
    tally,
    async (actor, where) => {
      const tier = await backfillDeityTier(actor);
      if (!tier) return 0;
      lines.push(
        game.i18n.format("CARLRPG.Migration.DeityTier.Line", {
          name: esc(actor.name) + (where ? ` (${esc(where)})` : ""),
          tier: esc(game.i18n.localize(CONFIG.CARLRPG.featureTiers[tier])),
        }),
      );
      return 1;
    },
    {
      actorMessage: (actor) => `couldn't set the Deity Tier of ${actor.name}`,
      packMessage: (pack) => `couldn't set Deity Tiers in compendium ${pack.collection}`,
    },
  );
  if (lines.length) await whisperGmList("DeityTier", lines);
  return tally.result();
}

/* -------------------------------------------------- */
/*  0.7.0: owned copies of the changed compendium items */
/* -------------------------------------------------- */

/**
 * The compendium items whose DR, Move, Step or Evade 0.7.0 made automatic
 * (Phase 2, docs/known-gaps.md 7.2c), by pack and name.
 */
export const REFRESHED_ITEMS = {
  "classes-and-races": [
    "Tigran",
    "Tigran (Primal)",
    "Amazonian",
    "Amazonian (Primal)",
    "Doppelgänger",
    "Doppelgänger (Primal)",
    "Elf (High)",
    "Elf (High) (Primal)",
    "Obsidian Butterfly",
    "Obsidian Butterfly (Primal)",
    "Straight-to-DVD Action Hero",
    "Zulu Warrior",
  ],
  "skills-and-spells": [
    "Dodge",
    "Running",
    "Catlike Reflexes",
    "Jumping",
    "Longsword",
    "Rapier",
    "Quarterstaff",
    "Oakhide",
  ],
};

/** The change targets the refresh owns: everything else on a copy is kept. */
const MANAGED_TARGETS = {
  resource: new Set(["dr", "move", "step"]),
  rollMode: new Set(["evadeBonus", "evadeDice"]),
};

/** Oakhide's description note before and after it became a toggled Spell. */
const OAKHIDE_OLD_NOTE =
  "<p><em>Note: DR has no temporary/conditional-bonus mechanism in this system - apply this bonus by hand while the buff is active.</em></p>";
const OAKHIDE_NEW_NOTE =
  "<p><em>Casting it switches it on (paying its Mana) and its DR is added automatically; cast it again when the buff ends to switch it off.</em></p>";

/**
 * Whether the refresh owns this change: a DR, Move or Step resource change,
 * or an Evade bonus or Evade dice.
 * @param {object} change
 * @returns {boolean}
 */
export function isManagedChange(change) {
  return !!MANAGED_TARGETS[change?.targetType]?.has(change.target);
}

/** The managed changes in a list, order-free, for comparing two lists. */
function managedSignature(changes) {
  return (changes ?? [])
    .filter(isManagedChange)
    .map((c) =>
      [
        c.targetType,
        c.target,
        c.mode,
        String(c.value),
        Number(c.levelGate) || 0,
        (c.conditions ?? []).length,
      ].join("|"),
    )
    .sort()
    .join(";");
}

/**
 * A change list with its managed changes replaced by the source's (fresh
 * ids), the rest kept as they are. null if they already match.
 * @param {object[]} own
 * @param {object[]} source
 * @returns {object[]|null}
 */
function mergeManagedChanges(own, source) {
  if (managedSignature(own) === managedSignature(source)) return null;
  return [
    ...(own ?? []).filter((c) => !isManagedChange(c)),
    ...(source ?? [])
      .filter(isManagedChange)
      .map((c) => ({ ...foundry.utils.deepClone(c), id: foundry.utils.randomID() })),
  ];
}

/**
 * What an owned copy of a refreshed compendium item needs: its DR, Move,
 * Step and Evade changes - base and per Upgrade tier (matched by Rank) -
 * made the compendium's; a Spell the compendium made toggled, toggled;
 * Oakhide's old "apply by hand" note replaced. Everything else - the Rank,
 * marks, other changes (a Race's baked Stat and Skill grants keep their
 * ids, so nothing bakes twice), descriptions - is kept.
 * @param {Item|object} item  The owned copy.
 * @param {Item|object} source  The compendium item.
 * @returns {object|null}  Update data (system.* paths), or null if current.
 */
export function refreshedItemUpdate(item, source) {
  const plain = (sys) => (typeof sys?.toObject === "function" ? sys.toObject() : (sys ?? {}));
  const own = plain(item.system);
  const src = plain(source.system);
  const update = {};

  const changes = mergeManagedChanges(own.changes, src.changes);
  if (changes) update["system.changes"] = changes;

  if (Array.isArray(own.upgrades) && Array.isArray(src.upgrades)) {
    let touched = false;
    // A tier the compendium doesn't have (a homebrew Rank 7) is left as it is.
    const upgrades = own.upgrades.map((tier) => {
      const sourceTier = src.upgrades.find((t) => t.rankThreshold === tier.rankThreshold);
      if (!sourceTier) return tier;
      const next = mergeManagedChanges(tier.changes, sourceTier.changes ?? []);
      if (!next) return tier;
      touched = true;
      return { ...tier, changes: next };
    });
    // A compendium tier the copy lacks is added, when it carries a managed
    // change - whole, as the compendium has it.
    for (const sourceTier of src.upgrades) {
      if (upgrades.some((t) => t.rankThreshold === sourceTier.rankThreshold)) continue;
      if (!(sourceTier.changes ?? []).some(isManagedChange)) continue;
      upgrades.push({
        ...foundry.utils.deepClone(sourceTier),
        changes: (sourceTier.changes ?? []).map((c) => ({
          ...foundry.utils.deepClone(c),
          id: foundry.utils.randomID(),
        })),
      });
      touched = true;
    }
    upgrades.sort((a, b) => a.rankThreshold - b.rankThreshold);
    if (touched) update["system.upgrades"] = upgrades;
  }

  if (item.type === "spell" && src.isToggled && !own.isToggled) update["system.isToggled"] = true;
  if (typeof own.description === "string" && own.description.includes(OAKHIDE_OLD_NOTE)) {
    update["system.description"] = own.description.replace(OAKHIDE_OLD_NOTE, OAKHIDE_NEW_NOTE);
  }
  return Object.keys(update).length ? update : null;
}

/**
 * The refreshed items, read from the system's (rebuilt) packs.
 * @returns {Promise<{sources: Item[], missing: string[]}>}  missing: system packs not found.
 */
async function loadRefreshSources() {
  const sources = [];
  const missing = [];
  for (const [packName, names] of Object.entries(REFRESHED_ITEMS)) {
    const pack = game.packs.get(`${SCOPE}.${packName}`);
    if (!pack) {
      missing.push(`${SCOPE}.${packName}`);
      continue;
    }
    const index = await pack.getIndex();
    for (const name of names) {
      const entry = index.find((e) => e.name === name);
      if (entry) sources.push(await pack.getDocument(entry._id));
    }
  }
  return { sources, missing };
}

/** The error a step reports for a system compendium it couldn't find. */
function missingPackError(id) {
  return new Error(game.i18n.format("CARLRPG.Migration.Failures.MissingPack", { pack: id }));
}

/**
 * The compendium item an owned item is a copy of. One that says where it
 * came from (its compendium source) is only matched to that item - a copy of
 * a homebrew "Dodge" from a world compendium is not the system's Dodge. One
 * that doesn't say is matched by type and name. Sources are compared by the
 * item id at the end of the uuid, so an older "Compendium.carl-rpg.pack.id"
 * source reads the same as "Compendium.carl-rpg.pack.Item.id".
 * @param {Item|object} item
 * @param {Item[]} sources
 * @returns {Item|null}
 */
export function refreshSourceFor(item, sources) {
  const origin = item._stats?.compendiumSource || item.flags?.core?.sourceId || "";
  const sameType = sources.filter((s) => s.type === item.type);
  if (origin) {
    const fromSystem = origin.startsWith(`Compendium.${SCOPE}.`);
    const id = origin.split(".").pop();
    return fromSystem ? (sameType.find((s) => s.id === id) ?? null) : null;
  }
  return sameType.find((s) => s.name === item.name) ?? null;
}

/**
 * The updates for these items' stale copies.
 * @param {Iterable<Item>} items
 * @param {Item[]} sources
 * @returns {{updates: object[], names: string[], movement: boolean}}  movement:
 *   whether any of them now changes Move or Step.
 */
function refreshUpdatesFor(items, sources) {
  const updates = [];
  const names = [];
  let movement = false;
  for (const item of items) {
    const source = refreshSourceFor(item, sources);
    const update = source ? refreshedItemUpdate(item, source) : null;
    if (!update) continue;
    updates.push({ _id: item.id, ...update });
    names.push(item.name);
    movement ||= changesMovement(source);
  }
  return { updates, names, movement };
}

/** Whether a compendium item changes Move or Step, at any Rank. */
function changesMovement(source) {
  const all = [
    ...(source.system.changes ?? []),
    ...(source.system.upgrades ?? []).flatMap((t) => t.changes ?? []),
  ];
  return all.some(
    (c) => c.targetType === "resource" && (c.target === "move" || c.target === "step"),
  );
}

/**
 * Move and Step were typed by hand before 0.7.0, so a crawler whose base
 * isn't the starting 20/10 may already include what its Race or Skills now
 * add - a note for the GM's list.
 * @param {Actor} actor
 * @returns {string}
 */
function typedMovementNote(actor) {
  const details = actor?.type === "character" ? actor.system.details : null;
  if (!details || (details.move === 20 && details.step === 10)) return "";
  return ` ${game.i18n.format("CARLRPG.Migration.Refresh.CheckMove", { move: details.move, step: details.step })}`;
}

/**
 * 0.7.0 made the DR, Move, Step and Evade of some Races, Classes, Skills
 * and Spells automatic (REFRESHED_ITEMS), but every actor holds its own
 * copy of an item, made before. This brings each copy's DR, Move, Step and
 * Evade changes - and Oakhide's toggle - up to the compendium's, on world
 * Actors, in the Items directory and in world compendiums. The GM gets a
 * whispered list of what was updated.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateCompendiumCopies({ fail = NO_FAIL } = {}) {
  const { sources, missing } = await loadRefreshSources();
  let changed = 0;
  let errors = 0;
  // A system pack that isn't there: reported, not counted as done.
  for (const id of missing) {
    console.error(`carl-rpg | 0.7.0 migration: the system compendium ${id} is missing`);
    errors += 1;
    fail(id, missingPackError(id));
  }
  const lines = [];
  // A fresh object for every write: updateEmbeddedDocuments writes its
  // parent onto the options it's given, and a shared one would send the next
  // write (the Items directory's, a compendium's) to that actor's items.
  const options = () => ({ render: false, carlMigration: true });
  // An unowned Item one at a time if a batch fails (updateItemsEach).
  const failedItem = (where) => (item, err) => {
    console.error(`carl-rpg | 0.7.0 migration: couldn't refresh ${item.name}`, err);
    errors += 1;
    fail(where ? `${item.name} (${where})` : item.name, err);
  };
  const refresh = async (label, items, write, actor = null) => {
    try {
      const { updates, names, movement } = refreshUpdatesFor(items, sources);
      if (!updates.length) return;
      // updateItemsEach says how many it wrote; an Actor's embedded update returns its Items.
      const written = await write(updates);
      changed += typeof written === "number" ? written : updates.length;
      const note = movement ? esc(typedMovementNote(actor)) : "";
      lines.push(
        game.i18n.format("CARLRPG.Migration.Refresh.Line", {
          name: esc(label),
          items: names.map(esc).join(", "),
        }) + note,
      );
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't refresh the items of ${label}`, err);
      errors += 1;
      fail(label, err);
    }
  };
  if (!sources.length) return { changed, errors };

  for (const actor of game.actors) {
    await refresh(
      actor.name,
      actor.items,
      (u) => actor.updateEmbeddedDocuments("Item", u, options()),
      actor,
    );
  }
  await refresh(game.i18n.localize("CARLRPG.Migration.Refresh.ItemsDirectory"), game.items, (u) =>
    updateItemsEach(game.items, u, options(), failedItem("")),
  );
  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    try {
      await withUnlockedPack(pack, async () => {
        const documents = await pack.getDocuments();
        if (pack.documentName === "Actor") {
          for (const actor of documents) {
            await refresh(
              `${actor.name} (${pack.title})`,
              actor.items,
              (u) => actor.updateEmbeddedDocuments("Item", u, options()),
              actor,
            );
          }
        } else {
          await refresh(pack.title, documents, (u) =>
            updateItemsEach(
              documents,
              u,
              { ...options(), pack: pack.collection },
              failedItem(pack.title),
            ),
          );
        }
      });
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't refresh items in compendium ${pack.collection}`,
        err,
      );
      errors += 1;
      fail(pack.collection, err);
    }
  }
  if (lines.length) await whisperGmList("Refresh", lines);
  return { changed, errors };
}

/* -------------------------------------------------- */
/*  0.7.0: a Character's base DR is 0                 */
/* -------------------------------------------------- */

/**
 * Zero one Character's saved base DR (character.mjs already treats it as
 * 0). Reads the saved value, which the prepared data hides.
 * @param {Actor} actor
 * @returns {Promise<number>}  The old base DR, or 0 if there was nothing to zero.
 */
export async function zeroCharacterBaseDr(actor) {
  if (actor?.type !== "character") return 0;
  const dr = Number(actor._source.system?.dr) || 0;
  if (!dr) return 0;
  await actor.update({ "system.dr": 0 }, { render: false, carlMigration: true });
  return dr;
}

/**
 * 0.7.0 locks a Character's base DR at 0: its DR is only what its Race,
 * Class, gear, Skills, Spells and Buffs give. A base typed in before is
 * zeroed, on world Characters and in world compendiums, and the GM gets a
 * whispered list of who had what - DR from something not automated yet
 * (or a home rule) can be put back as an item bonus.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateCharacterBaseDr({ fail = NO_FAIL } = {}) {
  const tally = migrationTally(fail);
  const lines = [];
  await eachWorldActor(
    tally,
    async (actor, where) => {
      const dr = await zeroCharacterBaseDr(actor);
      if (!dr) return 0;
      lines.push(
        game.i18n.format("CARLRPG.Migration.BaseDr.Line", {
          name: esc(actor.name) + (where ? ` (${esc(where)})` : ""),
          dr,
        }),
      );
      return 1;
    },
    {
      actorMessage: (actor) => `couldn't zero the base DR of ${actor.name}`,
      packMessage: (pack) => `couldn't zero base DR in compendium ${pack.collection}`,
    },
  );
  if (lines.length) await whisperGmList("BaseDr", lines);
  return tally.result();
}

/* -------------------------------------------------- */
/*  0.7.0: Characters made before the wizard          */
/* -------------------------------------------------- */

/** The item types that are a crawler's Skills. A new Character has none. */
const SKILL_TYPES = ["skill", "spell", "damageEffect"];

/**
 * Whether a Character was made before the Create Crawler wizard (0.7.0):
 * not marked as through it, but already holding Skills, Spells or Damage
 * Effects. A new Character starts with none, so any means it was built.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function madeBeforeChargen(actor) {
  return (
    actor?.type === "character" &&
    !actor.getFlag(SCOPE, "chargen")?.done &&
    actor.items.some((i) => SKILL_TYPES.includes(i.type))
  );
}

/**
 * Mark one Character made before the wizard as through character creation,
 * so its sheet stops offering Create Crawler.
 * @param {Actor} actor
 * @returns {Promise<boolean>}  Whether it was marked.
 */
export async function markChargenDone(actor) {
  if (!madeBeforeChargen(actor)) return false;
  await actor.update(
    { [`flags.${SCOPE}.chargen`]: { done: true, migrated: true } },
    { render: false, carlMigration: true },
  );
  return true;
}

/**
 * 0.7.0 added the Create Crawler wizard, offered on a Character's sheet
 * until it has been through it. Characters already built (with any Skill,
 * Spell or Damage Effect) are marked as through it - on world Actors and
 * in world compendiums - or the button would stay on them for good. A
 * Character with no Skills yet keeps the button.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateChargenDone({ fail = NO_FAIL } = {}) {
  const tally = migrationTally(fail);
  await eachWorldActor(tally, async (actor) => ((await markChargenDone(actor)) ? 1 : 0), {
    actorMessage: (actor) => `couldn't mark ${actor.name} as created`,
    packMessage: (pack) => `couldn't mark Characters in compendium ${pack.collection}`,
  });
  return tally.result();
}

/**
 * A GM-whispered notice: CARLRPG.Migration.<key>.Title, its Body, then a
 * list of lines (already escaped).
 * @param {string} key
 * @param {string[]} lines
 */
function whisperGmList(key, lines) {
  return createNoticeMessage({
    title: game.i18n.localize(`CARLRPG.Migration.${key}.Title`),
    bodyHtml:
      `<p>${esc(game.i18n.localize(`CARLRPG.Migration.${key}.Body`))}</p>` +
      `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
    whisper: gmUserIds(),
  });
}

/* -------------------------------------------------- */
/*  0.7.0: a Mob's Attacks as items                   */
/* -------------------------------------------------- */

/**
 * 0.7.0 made a Mob's Attacks `mobAttack` items (module/data/mob-attack.mjs;
 * docs/mob-sheet.md) in place of the printed-text list `system.attacks`.
 * Each Mob's list is converted (module/helpers/mob-attacks.mjs
 * convertLegacyAttacks - safe to run again) in world Actors, in unlinked
 * tokens whose own data overrides the list, and in the world's Actor
 * compendiums. A Mob whose Attacks were guessed to be Area Attacks, or whose
 * effect text names a Debuff, is listed for the GM: when a Debuff lands
 * can't be read reliably from prose, so it's set on the Attack by hand.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function migrateMobAttacks({ fail = NO_FAIL } = {}) {
  let changed = 0;
  let errors = 0;
  const lines = [];
  const convert = async (actor, where, attacks = actor.system?.attacks ?? []) => {
    if (actor?.type !== "mob" || !attacks.length) return;
    const list = foundry.utils.deepClone(attacks);
    try {
      await convertLegacyAttacks(actor, { attacks: list });
      changed += 1;
      const check = attacksToCheck(list);
      if (check.length) {
        lines.push(
          game.i18n.format("CARLRPG.Migration.MobAttacks.Line", {
            name: esc(actor.name) + (where ? ` (${esc(where)})` : ""),
            attacks: esc(check.join(", ")),
          }),
        );
      }
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't convert the Attacks of ${actor.name}`,
        err,
      );
      errors += 1;
      fail(actor.name, err);
    }
  };

  for (const actor of game.actors) await convert(actor);

  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const own = tokenOwnAttacks(token);
      if (!own) continue;
      try {
        await clearInheritedAttacks(token);
      } catch (err) {
        console.error(
          `carl-rpg | 0.7.0 migration: couldn't clear the inherited Attacks of token ${token.name}`,
          err,
        );
        errors += 1;
        fail(token.name, err);
        continue;
      }
      await convert(token.actor, `${scene.name}: ${token.name}`, own);
    }
  }

  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    try {
      await withUnlockedPack(pack, async () => {
        for (const actor of await pack.getDocuments()) await convert(actor, pack.title);
      });
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't convert Mob Attacks in compendium ${pack.collection}`,
        err,
      );
      errors += 1;
      fail(pack.collection, err);
    }
  }
  if (lines.length) await whisperGmList("MobAttacks", lines);
  return { changed, errors };
}

/**
 * An unlinked Mob token's own Attacks list (the GM edited that token's
 * Attacks before 0.7.0), or null: one without one inherits its Mob's.
 * @param {TokenDocument} token
 * @returns {object[]|null}
 */
function tokenOwnAttacks(token) {
  const own = token.actorLink ? null : token.delta?._source?.system?.attacks;
  return Array.isArray(own) && own.length && token.actor?.type === "mob" ? own : null;
}

/** A token's Attacks inherited from its Mob's conversion - its own replace them. */
async function clearInheritedAttacks(token) {
  const inherited = token.actor.items
    .filter((i) => i.type === MOB_ATTACK_TYPE && Number.isInteger(i.getFlag(SCOPE, LEGACY_FLAG)))
    .map((i) => i.id);
  if (inherited.length)
    await token.actor.deleteEmbeddedDocuments("Item", inherited, { carlMigration: true });
}

/**
 * Convert one unlinked token's own Attacks list (the migration's step for
 * tokens; tests). Its inherited Attacks go, its own are made in their place.
 * @param {TokenDocument} token
 * @returns {Promise<number>}  How many Attacks were made (0: no list of its own).
 */
export async function convertTokenAttacks(token) {
  const own = tokenOwnAttacks(token);
  if (!own) return 0;
  const list = foundry.utils.deepClone(own);
  await clearInheritedAttacks(token);
  return convertLegacyAttacks(token.actor, { attacks: list });
}

/* -------------------------------------------------- */
/*  0.7.0: a Mob's Size as Table 9's value            */
/* -------------------------------------------------- */

/**
 * 0.7.0 made a Mob's Size Table 9's value (p.92; module/data/mob.mjs) in
 * place of free text ("Large (5)"). The data model reads old text as the
 * value in memory on every load (migrateData); this saves it, so the stored
 * data holds the number too:
 *  - every world Mob, written with no diff (in memory it's already the
 *    number, so a normal update would see no change);
 *  - an unlinked token whose own data still holds text;
 *  - Mobs in the world's Actor compendiums whose stored Size is text (read
 *    from the index, which isn't migrated).
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function migrateMobSizes({ fail = NO_FAIL } = {}) {
  let changed = 0;
  let errors = 0;
  const mobs = game.actors.filter((a) => a.type === "mob");
  if (mobs.length) {
    try {
      changed += await saveMobSizes(mobs);
    } catch (err) {
      console.error("carl-rpg | 0.7.0 migration: couldn't save Mob Sizes", err);
      errors += 1;
      fail(game.i18n.localize("TYPES.Actor.mob"), err);
    }
  }

  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const raw = token.actorLink ? undefined : token.delta?._source?.system?.size;
      if (typeof raw !== "string" || token.actor?.type !== "mob") continue;
      try {
        await token.actor.update(
          { "system.size": parseSize(raw) },
          { diff: false, render: false, carlMigration: true },
        );
        changed += 1;
      } catch (err) {
        console.error(
          `carl-rpg | 0.7.0 migration: couldn't save the Size of token ${token.name}`,
          err,
        );
        errors += 1;
        fail(token.name, err);
      }
    }
  }

  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    try {
      const index = await pack.getIndex({ fields: ["type", "system.size"] });
      const updates = index
        .filter((entry) => entry.type === "mob" && typeof entry.system?.size === "string")
        .map((entry) => ({ _id: entry._id, "system.size": parseSize(entry.system.size) }));
      if (!updates.length) continue;
      await withUnlockedPack(pack, () =>
        Actor.implementation.updateDocuments(updates, {
          pack: pack.collection,
          diff: false,
          render: false,
          carlMigration: true,
        }),
      );
      changed += updates.length;
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't save Mob Sizes in compendium ${pack.collection}`,
        err,
      );
      errors += 1;
      fail(pack.collection, err);
    }
  }
  return { changed, errors };
}

/**
 * Save world Mobs' Sizes as read (the migration's step for world actors;
 * tests). Written with no diff: in memory it's already the number.
 * @param {Actor[]} mobs
 * @returns {Promise<number>}  How many were written.
 */
export async function saveMobSizes(mobs) {
  const list = mobs.filter((a) => a?.type === "mob");
  if (!list.length) return 0;
  await Actor.implementation.updateDocuments(
    list.map((a) => ({ _id: a.id, "system.size": a.system.size ?? null })),
    { diff: false, render: false, carlMigration: true },
  );
  return list.length;
}

/* -------------------------------------------------- */
/*  0.7.0: where gear is worn                         */
/* -------------------------------------------------- */

/**
 * 0.7.0 gave gear the slots it's worn in (docs/gear-slots.md; module/
 * helpers/gear.mjs). In two passes, the first finished before the second
 * (ruled 2026-11-17: "complete the [inference] FIRST, so that something
 * without a slot type that gains it doesn't get unequipped prematurely"):
 *  1. Every gear item with no slot gets one guessed (gear.mjs
 *     guessGearSlots: its "Gear Slot:" line, its name, a Weapon Skill, the
 *     slot it's worn in) - in the sidebar, on every actor, and in world
 *     compendiums.
 *  2. On every actor, gear worn where it doesn't fit comes off: a doll
 *     slot it isn't worn in, a second Belt or Cape, a two-handed item with
 *     the other hand full, or equipped gear with no slot at all.
 * A card lists every creature that had gear taken off, by actor type; the
 * gear left with no slot is whispered to the GM.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function migrateGearSlots({ fail = NO_FAIL } = {}) {
  let changed = 0;
  let errors = 0;
  // Gear left with no slot, by who has it (an actor, the Items directory,
  // a compendium): each named, and marked if it was worn and comes off.
  const unplaced = new Map();
  const noteUnplaced = (where, item, owned = true) => {
    if (!unplaced.has(where)) unplaced.set(where, []);
    // Only an actor's gear is taken off (unequipMisfits).
    unplaced.get(where).push({
      name: item.name,
      takenOff: owned && !!item.system?.equipped && !heldOrWearable(item),
    });
  };
  const removed = [];

  const failed = (where, err) => {
    console.error(`carl-rpg | 0.7.0 migration: couldn't set gear slots for ${where}`, err);
    errors += 1;
    fail(where, err);
  };

  // 1. Slots for gear that has none. One at a time if a batch fails.
  const inferItems = async (items, where, options = {}) => {
    const updates = [];
    for (const item of items) {
      const update = gearSlotUpdate(item);
      if (update) updates.push(update);
      else if (needsSlot(item)) noteUnplaced(where, item, false);
    }
    changed += await updateItemsEach(
      items,
      updates,
      { ...options, carlMigration: true, render: false },
      (item, err) => failed(`${item.name} (${where})`, err),
    );
  };
  const actorsToCheck = [];
  const sidebar = game.i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.Sidebar");
  try {
    await inferItems(game.items.contents, sidebar);
  } catch (err) {
    console.error("carl-rpg | 0.7.0 migration: couldn't set gear slots on sidebar items", err);
    errors += 1;
    fail(sidebar, err);
  }
  for (const actor of actorsWithOwnGear()) {
    try {
      const result = await inferActorGear(actor);
      changed += result.changed;
      for (const item of result.unplaced) noteUnplaced(actor.name, item);
      actorsToCheck.push(actor);
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't set gear slots for ${actor.name}`, err);
      errors += 1;
      fail(actor.name, err);
    }
  }
  for (const pack of game.packs.filter(shouldMigratePack)) {
    try {
      await withUnlockedPack(pack, async () => {
        const documents = await pack.getDocuments();
        if (pack.documentName === "Item")
          return inferItems(documents, pack.title, { pack: pack.collection });
        await eachDocument(
          documents,
          async (actor) => {
            const result = await inferActorGear(actor);
            changed += result.changed;
            for (const item of result.unplaced) noteUnplaced(`${pack.title}: ${actor.name}`, item);
            const off = await unequipMisfits(actor);
            if (off.length) {
              removed.push({ type: actor.type, name: `${actor.name} (${pack.title})`, items: off });
              changed += 1;
            }
          },
          (actor, err) => failed(`${actor.name} (${pack.title})`, err),
        );
      });
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't set gear slots in compendium ${pack.collection}`,
        err,
      );
      errors += 1;
      fail(pack.collection, err);
    }
  }

  // 2. Off what doesn't fit - only once every slot above is set.
  for (const actor of actorsToCheck) {
    try {
      const off = await unequipMisfits(actor);
      if (off.length) {
        removed.push({ type: actor.type, name: actor.name, items: off });
        changed += 1;
      }
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't take misfit gear off ${actor.name}`, err);
      errors += 1;
      fail(actor.name, err);
    }
  }

  if (removed.length) await announceRemovedGear(removed);
  if (unplaced.size) await whisperUnplacedGear(unplaced);
  return { changed, errors };
}

/** Gear with no slot, which can't be worn until one is set. */
function needsSlot(item) {
  return item?.type === "item" && !item.system?.consumable?.kind && !canWear(item);
}

/**
 * The update setting a gear item's slots, guessed (gear.mjs
 * guessGearSlots), or null when it has some or nothing tells.
 * @param {Item} item
 * @param {string|null} [wornIn]  Where it's worn now (a where-worn key).
 * @returns {object|null}
 */
export function gearSlotUpdate(item, wornIn = null) {
  if (item?.type !== "item" || (item.system?.slots ?? []).length || item.system?.consumable?.kind)
    return null;
  const guess = guessGearSlots(item, { wornIn });
  if (!guess) return null;
  const update = { _id: item.id, "system.slots": guess.slots };
  if (guess.twoHanded) update["system.twoHanded"] = true;
  if (guess.accessoryKind && guess.slots.includes("accessory"))
    update["system.accessoryKind"] = guess.accessoryKind;
  return update;
}

/**
 * The migration's first pass on one actor: slots for its gear that has
 * none (the slot it's worn in is the last guess).
 * @param {Actor} actor
 * @returns {Promise<{changed: number, unplaced: Item[]}>}  unplaced: its gear left with no slot.
 */
export async function inferActorGear(actor) {
  const sys = actor.system ?? {};
  const wornIn = (item) => {
    const key = Object.keys(sys.gearSlots ?? {}).find((k) => sys.gearSlots[k] === item.id);
    if (key) return WEAR_SLOT_OF_GEAR_SLOT[key] ?? null;
    return (sys.accessories ?? []).includes(item.id) ? "accessory" : null;
  };
  const updates = [];
  const unplaced = [];
  for (const item of actor.items) {
    const update = gearSlotUpdate(item, wornIn(item));
    if (update) updates.push(update);
    else if (needsSlot(item)) unplaced.push(item);
  }
  if (updates.length)
    await actor.updateEmbeddedDocuments("Item", updates, { carlMigration: true, render: false });
  return { changed: updates.length, unplaced };
}

/**
 * The migration's second pass on one actor: gear worn where it doesn't fit
 * comes off (docs/gear-slots.md Q6) - out of a doll slot it isn't worn in,
 * a second Belt or Cape, a two-handed item whose other hand holds something
 * else (one alone in a hand takes both), and equipped gear with no slot.
 * @param {Actor} actor
 * @returns {Promise<string[]>}  The names of the gear taken off.
 */
export async function unequipMisfits(actor) {
  const sys = actor.system ?? {};
  const off = new Set();
  // In a doll slot when this started: a misfit comes off (ruled
  // 2026-11-17), it isn't moved to a slot it fits.
  const wornBefore = new Set(
    [...Object.values(sys.gearSlots ?? {}), ...(sys.accessories ?? [])].filter(Boolean),
  );
  const update = {};
  // A consumable is never worn or held (gear.mjs fitsSlot): it leaves its
  // slot quietly, unequipped below and not listed.
  let quietlyCleared = false;
  if (sys.gearSlots) {
    const gearSlots = { ...sys.gearSlots };
    for (const [key, id] of Object.entries(gearSlots)) {
      const item = id ? actor.items.get(id) : null;
      if (item && !fitsSlot(item, { slotType: "gear", slotKey: key })) {
        if (isConsumable(item)) quietlyCleared = true;
        else off.add(item.id);
        gearSlots[key] = "";
      }
    }
    // A two-handed item: both hands, or off if the other holds something else.
    for (const hand of HANDS) {
      const item = gearSlots[hand] ? actor.items.get(gearSlots[hand]) : null;
      if (!item || !isTwoHanded(item)) continue;
      const other = HANDS.find((h) => h !== hand);
      // Empty, or a deleted item's id: free.
      if (!gearSlots[other] || !actor.items.get(gearSlots[other])) gearSlots[other] = item.id;
      else if (gearSlots[other] !== item.id) {
        off.add(item.id);
        for (const h of HANDS) if (gearSlots[h] === item.id) gearSlots[h] = "";
      }
    }
    const kinds = new Set();
    const accessories = (sys.accessories ?? []).filter((id) => {
      const item = actor.items.get(id);
      if (!item) return true;
      if (!fitsSlot(item, { slotType: "accessory", slotKey: "0" })) {
        if (isConsumable(item)) quietlyCleared = true;
        else off.add(item.id);
        return false;
      }
      const kind = accessoryKindOf(item);
      if (kind && kinds.has(kind)) {
        off.add(item.id);
        return false;
      }
      if (kind) kinds.add(kind);
      return true;
    });
    if (off.size || quietlyCleared)
      Object.assign(update, { "system.gearSlots": gearSlots, "system.accessories": accessories });
    else if (JSON.stringify(gearSlots) !== JSON.stringify(sys.gearSlots))
      update["system.gearSlots"] = gearSlots;
  }
  if (Object.keys(update).length)
    await actor.update(update, { carlMigration: true, render: false });
  // A Character's gear equipped through the old Equipped box (in no doll
  // slot): into a free slot it fits, or off - one item per slot (p.98).
  if (actor.system.gearSlots) {
    for (const item of actor.items) {
      if (
        item.type !== "item" ||
        !item.system.equipped ||
        isConsumable(item) ||
        wornBefore.has(item.id) ||
        isItemWorn(actor, item.id) ||
        !canWear(item)
      )
        continue;
      const slot = freeSlotFor(actor, item);
      if (slot) await placeInFreeSlot(actor, slot, item);
      else off.add(item.id);
    }
  }
  // An equipped consumable (held, worn, or only ticked): never worn -
  // unequipped, not listed.
  const quiet = actor.items
    .filter((i) => i.type === "item" && i.system.equipped && isConsumable(i))
    .map((i) => i.id);
  if (quiet.length) {
    await actor.updateEmbeddedDocuments(
      "Item",
      quiet.map((id) => ({ _id: id, "system.equipped": false })),
      { carlMigration: true, carlInAction: true, render: false },
    );
  }
  // Equipped with no slot, and not held in a hand.
  for (const item of actor.items) {
    if (
      item.type === "item" &&
      item.system.equipped &&
      !isConsumable(item) &&
      !heldOrWearable(item)
    )
      off.add(item.id);
  }
  // Worn elsewhere still? Then it stays equipped (only its misfit slot went).
  const unequip = [...off].filter(
    (id) =>
      actor.items.get(id)?.system.equipped &&
      (!isItemWorn(actor, id) || !heldOrWearable(actor.items.get(id))),
  );
  if (unequip.length) {
    await actor.updateEmbeddedDocuments(
      "Item",
      unequip.map((id) => ({ _id: id, "system.equipped": false })),
      { carlMigration: true, carlInAction: true, render: false },
    );
  }
  return [...off].map((id) => actor.items.get(id)?.name).filter(Boolean);
}

/**
 * The GM's list of gear the 0.7.0 gear slots migration couldn't place, by
 * who has it, each named - and marked where it was worn and so taken off.
 * @param {Map<string, {name: string, takenOff: boolean}[]>} unplaced
 */
export function whisperUnplacedGear(unplaced) {
  const i18n = game.i18n;
  const sections = [...unplaced.entries()]
    .map(([where, items]) => {
      const lines = items
        .map(
          (i) =>
            `<li>${esc(i.name)}${i.takenOff ? ` <em>(${esc(i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.TakenOff"))})</em>` : ""}</li>`,
        )
        .join("");
      return `<h4>${esc(where)}</h4><ul>${lines}</ul>`;
    })
    .join("");
  return createNoticeMessage({
    title: i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.Title"),
    bodyHtml: `<p>${esc(i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.Body"))}</p>${sections}`,
    whisper: gmUserIds(),
  });
}

/**
 * The card naming every creature that had gear taken off by the 0.7.0 gear
 * slots migration, grouped by actor type (ruled 2026-11-17), whispered to
 * the GM.
 * @param {{type: string, name: string, items: string[]}[]} removed
 */
export function announceRemovedGear(removed) {
  const groups = new Map();
  for (const entry of removed) {
    if (!groups.has(entry.type)) groups.set(entry.type, []);
    groups.get(entry.type).push(entry);
  }
  const sections = [...groups.entries()]
    .map(([type, entries]) => {
      const heading = game.i18n.localize(`TYPES.Actor.${type}`);
      const lines = entries
        .map((e) => `<li><strong>${esc(e.name)}:</strong> ${esc(e.items.join(", "))}</li>`)
        .join("");
      return `<h4>${esc(heading)}</h4><ul>${lines}</ul>`;
    })
    .join("");
  return createNoticeMessage({
    title: game.i18n.localize("CARLRPG.Migration.GearSlots.Title"),
    bodyHtml: `<p>${esc(game.i18n.localize("CARLRPG.Migration.GearSlots.Body"))}</p>${sections}`,
    whisper: gmUserIds(),
  });
}

/* -------------------------------------------------- */
/*  0.7.0: Weapon Skills guessed from names           */
/* -------------------------------------------------- */

// The guesses are read from the system's Gear and Skills packs (only read, never written).

/** How many this load's guess run filled in, for the notice (null: it didn't run this load). */
let weaponSkillsFilled = null;

/**
 * A name's Skill slug, or null for one with no letters or digits
 * (slugifySkillName makes those all "unknown", which would match each other).
 * @param {string} name
 * @returns {string|null}
 */
function nameSlug(name) {
  const slug = slugifySkillName(name);
  return slug === "unknown" ? null : slug;
}

/**
 * An Attack Skill that needs a weapon (weapons.mjs needsWeapon): not
 * hand-to-hand, no Needs no weapon box. Works on a Skill item or a
 * compendium index entry. This step may run before the Skill setting boxes
 * step ticks the box on old copies, so a copy of one of the book's
 * weaponless Skills (SKILL_SETTING_BOXES) counts as ticked.
 * @param {object} skill
 * @returns {boolean}
 */
function isWieldedAttackSkill(skill) {
  if (skill?.type !== "skill" || skill.system?.category !== "attack" || skill.system?.isHandToHand)
    return false;
  if (skill.system?.noWeapon) return false;
  const slug = nameSlug(skill.name);
  return !!slug && BOX_BY_SLUG.get(slug) !== "noWeapon";
}

/**
 * What the guesses are read from, by name slug - loaded once per run from
 * the system packs' indexes (a pack that isn't there gives nothing):
 *  - gear: the Gear compendium's weapons -> their Weapon Skill (null where
 *    two of the same name disagree);
 *  - notWeapons: the Gear compendium's other gear (a Torch, a Lantern);
 *  - skills: the Skills and Spells compendium's Attack Skills that need a
 *    weapon -> their name;
 *  - missing: the ids of those packs that weren't there (to report).
 * @returns {Promise<{gear: Map<string, string|null>, notWeapons: Set<string>, skills: Map<string, string>, missing: string[]}>}
 */
export async function loadWeaponSkillSources() {
  const gear = new Map();
  const notWeapons = new Set();
  const skills = new Map();
  const missing = [PACKS.gear, PACKS.skillsAndSpells].filter((id) => !game.packs.get(id));
  const gearPack = game.packs.get(PACKS.gear);
  for (const entry of (await gearPack?.getIndex({
    fields: ["type", "system.weaponSkill", "system.consumable.kind"],
  })) ?? []) {
    const slug = nameSlug(entry.name);
    if (entry.type !== "item" || !slug) continue;
    const weaponSkill = String(entry.system?.weaponSkill ?? "").trim();
    if (!weaponSkill || entry.system?.consumable?.kind) {
      notWeapons.add(slug);
      continue;
    }
    gear.set(slug, gear.has(slug) && gear.get(slug) !== weaponSkill ? null : weaponSkill);
  }
  const skillsPack = game.packs.get(PACKS.skillsAndSpells);
  for (const entry of (await skillsPack?.getIndex({
    fields: ["type", "system.category", "system.isHandToHand", "system.noWeapon"],
  })) ?? []) {
    if (isWieldedAttackSkill(entry)) skills.set(nameSlug(entry.name), entry.name);
  }
  return { gear, notWeapons, skills, missing };
}

/**
 * The Weapon Skill a gear item's name says it has, or null. Only gear with
 * a blank Weapon Skill that isn't a consumable; by exact name (compared as
 * Skill names are: case and punctuation aside), in order:
 *  1. one of its owner's Attack Skills that needs a weapon;
 *  2. a weapon of that name in the Gear compendium ("Greatsword":
 *     Longsword);
 *  3. an Attack Skill of that name in the Skills and Spells compendium -
 *     unless its owner has a Skill of that name of its own that 1 passed
 *     over (hand-to-hand, weaponless, or not an Attack): that's the one
 *     the name means.
 * @param {Item} item
 * @param {Awaited<ReturnType<typeof loadWeaponSkillSources>>} sources
 * @param {Actor|null} [owner]  Who has it (default: its actor).
 * @returns {{weaponSkill: string, from: "owner"|"gear"|"skills"}|null}
 */
export function guessWeaponSkill(item, sources, owner = item?.actor ?? null) {
  if (
    item?.type !== "item" ||
    String(item.system?.weaponSkill ?? "").trim() ||
    item.system?.consumable?.kind
  )
    return null;
  const slug = nameSlug(item.name);
  if (!slug) return null;
  const own = owner
    ? owner.items.filter((i) => i.type === "skill" && nameSlug(i.name) === slug)
    : [];
  const skill = own.find(isWieldedAttackSkill);
  if (skill) return { weaponSkill: skill.name, from: "owner" };
  const weaponSkill = sources.gear.get(slug);
  if (weaponSkill) return { weaponSkill, from: "gear" };
  if (!own.length && sources.skills.has(slug))
    return { weaponSkill: sources.skills.get(slug), from: "skills" };
  return null;
}

/**
 * The updates filling in these items' guessed Weapon Skills.
 * @param {Iterable<Item>} items
 * @param {object} sources  loadWeaponSkillSources.
 * @param {Actor|null} [owner]
 * @returns {object[]}
 */
function weaponSkillUpdates(items, sources, owner = null) {
  const updates = [];
  for (const item of items) {
    const guess = guessWeaponSkill(item, sources, owner);
    if (guess) updates.push({ _id: item.id, "system.weaponSkill": guess.weaponSkill });
  }
  return updates;
}

/**
 * The guess on one actor's gear (the migration's step for actors; tests).
 * @param {Actor} actor
 * @param {object} sources  loadWeaponSkillSources.
 * @returns {Promise<number>}  How many were filled in.
 */
export async function guessActorWeaponSkills(actor, sources) {
  const updates = weaponSkillUpdates(actor.items, sources, actor);
  if (updates.length)
    await actor.updateEmbeddedDocuments("Item", updates, { carlMigration: true, render: false });
  return updates.length;
}

/**
 * The guess on unowned gear - the Items directory's, or a compendium's
 * (the migration's step for those; tests).
 * @param {Item[]} items
 * @param {object} sources  loadWeaponSkillSources.
 * @param {object} [options]  Update options ({pack} for a compendium's).
 * @param {(item: Item|{name: string}, err: unknown) => void} [onFail]  One at a
 *   time if the batch fails, each failure reported (updateItemsEach); none: it throws.
 * @returns {Promise<number>}  How many were filled in.
 */
export async function guessItemWeaponSkills(items, sources, options = {}, onFail = null) {
  const updates = weaponSkillUpdates(items, sources);
  return updateItemsEach(
    items,
    updates,
    { ...options, carlMigration: true, render: false },
    onFail,
  );
}

/**
 * 0.7.0 added gear's Weapon Skill (module/helpers/weapons.mjs), blank on
 * everything made before. Where the name tells (guessWeaponSkill), it's
 * filled in: on gear in the Items directory, on every actor (and unlinked
 * tokens' own gear), and in world compendiums. Runs before the gear slots
 * migration, so a weapon guessed here is made Held there, and before the
 * notice, which says how many were filled in and lists what's left.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function migrateWeaponSkillGuesses({ fail = NO_FAIL } = {}) {
  let changed = 0;
  let errors = 0;
  const failed = (where, err) => {
    console.error(`carl-rpg | 0.7.0 migration: couldn't fill in Weapon Skills for ${where}`, err);
    errors += 1;
    fail(where, err);
  };
  let sources;
  try {
    sources = await loadWeaponSkillSources();
  } catch (err) {
    console.error(
      "carl-rpg | 0.7.0 migration: couldn't read the Gear and Skills compendiums for Weapon Skills",
      err,
    );
    sources = { gear: new Map(), notWeapons: new Set(), skills: new Map(), missing: [] };
    errors += 1;
    fail("", err);
  }
  // A system pack that isn't there: reported, not counted as done.
  for (const id of sources.missing ?? []) failed(id, missingPackError(id));
  const sidebar = game.i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.Sidebar");
  try {
    changed += await guessItemWeaponSkills(game.items.contents, sources, {}, (item, err) =>
      failed(`${item.name} (${sidebar})`, err),
    );
  } catch (err) {
    console.error(
      "carl-rpg | 0.7.0 migration: couldn't fill in Weapon Skills on sidebar items",
      err,
    );
    errors += 1;
    fail(sidebar, err);
  }
  for (const actor of actorsWithOwnGear()) {
    try {
      changed += await guessActorWeaponSkills(actor, sources);
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't fill in Weapon Skills for ${actor.name}`,
        err,
      );
      errors += 1;
      fail(actor.name, err);
    }
  }
  for (const pack of game.packs.filter(shouldMigratePack)) {
    try {
      await withUnlockedPack(pack, async () => {
        const documents = await pack.getDocuments();
        const onFail = (doc, err) => failed(`${doc.name} (${pack.title})`, err);
        if (pack.documentName === "Item") {
          changed += await guessItemWeaponSkills(
            documents,
            sources,
            { pack: pack.collection },
            onFail,
          );
          return;
        }
        changed += await eachDocument(
          documents,
          (actor) => guessActorWeaponSkills(actor, sources),
          onFail,
        );
      });
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't fill in Weapon Skills in compendium ${pack.collection}`,
        err,
      );
      errors += 1;
      fail(pack.collection, err);
    }
  }
  weaponSkillsFilled = changed;
  return { changed, errors };
}

/** World actors, and unlinked tokens with gear of their own (as migrateGearSlots walks them). */
function actorsWithOwnGear() {
  return [
    ...game.actors,
    ...unlinkedTokenActors(game.scenes, (token) => !!token.delta?._source?.items?.length),
  ];
}

/* -------------------------------------------------- */
/*  0.7.0: the Weapon Skill notice                    */
/* -------------------------------------------------- */

/**
 * Gear with a blank Weapon Skill that looks like a weapon: held in its
 * Character's Main or Off Hand, or worn only in a hand (Held) - but not a
 * consumable, a Shield (ticked, or named a shield or buckler), or gear the
 * Gear compendium has by that name without a Weapon Skill (a Torch, a
 * Lantern).
 * @param {Item} item
 * @param {{notWeapons?: Set<string>}} [sources]  loadWeaponSkillSources.
 * @returns {boolean}
 */
export function looksLikeWeapon(item, sources = {}) {
  if (item?.type !== "item" || isWeapon(item) || isConsumable(item) || isShield(item)) return false;
  if (slotsFromName(item.name)?.slots.includes("held")) return false;
  if (sources.notWeapons?.has(nameSlug(item.name))) return false;
  const hands = item.actor?.system?.gearSlots;
  if (hands && HANDS.some((hand) => hands[hand] === item.id)) return true;
  const slots = item.system?.slots ?? [];
  return slots.length === 1 && slots[0] === "held";
}

/**
 * 0.7.0 added a Weapon Skill field to gear, and an Attack with a Weapon
 * Skill now needs a weapon whose Weapon Skill names it (module/helpers/
 * weapons.mjs). The guess migration filled in what names told; this tells
 * everyone, and whispers the GM the weapons still blank (looksLikeWeapon),
 * by who has them. Runs after the gear slots migration, so it sees where
 * gear is worn now. A new world (nothing in it) never gets it:
 * migrationPlan marks every migration had.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function announceWeaponSkill({ fail = NO_FAIL } = {}) {
  let errors = 0;
  let sources = {};
  try {
    sources = await loadWeaponSkillSources();
  } catch (err) {
    console.error(
      "carl-rpg | 0.7.0 migration: couldn't read the Gear compendium for the Weapon Skill notice",
      err,
    );
    errors += 1;
    fail("", err);
  }
  const remaining = new Map();
  const note = (where, items) => {
    const names = [...items]
      .filter((item) => looksLikeWeapon(item, sources))
      .map((item) => item.name);
    if (names.length) remaining.set(where, [...(remaining.get(where) ?? []), ...names]);
  };
  note(game.i18n.localize("CARLRPG.Migration.GearSlotsUnplaced.Sidebar"), game.items);
  for (const actor of actorsWithOwnGear()) note(actor.name, actor.items);
  for (const pack of game.packs.filter(shouldMigratePack)) {
    try {
      const documents = await pack.getDocuments();
      if (pack.documentName === "Item") note(pack.title, documents);
      else for (const actor of documents) note(`${pack.title}: ${actor.name}`, actor.items);
    } catch (err) {
      console.error(
        `carl-rpg | 0.7.0 migration: couldn't read compendium ${pack.collection} for the Weapon Skill notice`,
        err,
      );
      errors += 1;
      fail(pack.collection, err);
    }
  }
  await postWeaponSkillNotice({ filled: weaponSkillsFilled, remaining });
  return { changed: 0, errors };
}

/**
 * The Weapon Skill notice, to everyone: what the field is, how many were
 * filled in from names, and whether any are left. The weapons left, by who
 * has them, go to the GM only (they can name Mobs and compendium entries).
 * @param {{filled: number|null, remaining: Map<string, string[]>}} result
 *   filled: how many the guess filled in (0 or null: not said).
 * @returns {Promise<{notice: ChatMessage, list: ChatMessage|null}>}
 */
export async function postWeaponSkillNotice({ filled, remaining }) {
  const i18n = game.i18n;
  const paragraphs = [i18n.localize("CARLRPG.Migration.WeaponSkill.Body")];
  if (filled)
    paragraphs.push(i18n.format("CARLRPG.Migration.WeaponSkill.Filled", { count: filled }));
  paragraphs.push(
    i18n.localize(
      remaining.size
        ? "CARLRPG.Migration.WeaponSkill.Left"
        : "CARLRPG.Migration.WeaponSkill.NoneLeft",
    ),
  );
  const notice = await createNoticeMessage({
    title: i18n.localize("CARLRPG.Migration.WeaponSkill.Title"),
    bodyHtml: paragraphs.map((p) => `<p>${esc(p)}</p>`).join(""),
  });
  if (!remaining.size) return { notice, list: null };
  const sections = [...remaining.entries()]
    .map(
      ([where, names]) =>
        `<h4>${esc(where)}</h4><ul>${names.map((name) => `<li>${esc(name)}</li>`).join("")}</ul>`,
    )
    .join("");
  const list = await createNoticeMessage({
    title: i18n.localize("CARLRPG.Migration.WeaponSkillLeft.Title"),
    bodyHtml: `<p>${esc(i18n.localize("CARLRPG.Migration.WeaponSkillLeft.Body"))}</p>${sections}`,
    whisper: gmUserIds(),
  });
  return { notice, list };
}

/** One compendium: unlocked for the run, locked again after. */
/**
 * The Hand-to-Hand box in one compendium, unlocked for the run and locked
 * again after; document by document, so one that fails doesn't stop the rest.
 * @param {CompendiumCollection} pack
 * @param {(where: string, err: unknown) => void} [failed]  Each document that
 *   couldn't be updated; none: the first failure throws.
 * @returns {Promise<number>}  How many were ticked.
 */
export function migratePack(pack, failed = null) {
  return migrateWorldPack(
    pack,
    {
      onActor: tickHandToHandOn,
      itemUpdate: (item) =>
        needsHandToHand(item) ? { _id: item.id, "system.isHandToHand": true } : null,
      options: { render: false },
    },
    failed,
  );
}

/* -------------------------------------------------- */
/*  0.7.0: vehicle Skills set on the items            */
/* -------------------------------------------------- */

/**
 * What 0.7.0 moved from CONFIG onto Driving's and Chopper Pilot's own
 * Upgrade tiers (p.187, p.190; module/data/shared/upgrade-tier.mjs), by
 * slug and Rank - as the pack's copies now have them.
 */
const DRIVE_SKILL_TIERS = {
  driving: {
    5: { vehicleAttackOk: true },
    10: { vehicleMove: 5, vehicleEvadeAdvantage: true },
    15: { vehicleMove: 5, vehicleStuntAdvantage: true },
  },
  "chopper-pilot": {
    5: { vehicleMove: 5 },
    10: { vehicleAttackOk: true },
    15: { vehicleMove: 5, vehicleStuntAdvantage: true },
  },
};

/** Skills 0.7.0 marks mounted-only (system.mounted), by slug. */
const MOUNTED_SKILLS = new Set(["lance"]);

/**
 * A vehicle's old driving-Skill key as the Skill's name; anything else as is.
 * @param {*} raw
 * @returns {*}
 */
export function driveSkillName(raw) {
  return typeof raw === "string" && Object.hasOwn(LEGACY_DRIVE_SKILLS, raw)
    ? LEGACY_DRIVE_SKILLS[raw]
    : raw;
}

/**
 * A copy of Driving, Chopper Pilot or Lance made before 0.7.0, as an update
 * giving it what the pack's copy now has: the vehicle fields merged into
 * its tiers by Rank (the first tier of that Rank; a field already set is
 * left alone; a Rank with no tier gets a bare one, so the copy keeps what
 * CONFIG gave it), or Lance's Mounted box. The tiers are written whole,
 * everything else in them kept. Null when there's nothing to change.
 * @param {Item} item
 * @returns {object|null}
 */
export function vehicleSkillUpdate(item) {
  if (item?.type !== "skill") return null;
  const slug = slugifySkillName(item.name);
  const source = item._source?.system ?? item.system;
  const update = {};
  if (MOUNTED_SKILLS.has(slug) && source.mounted !== true) update["system.mounted"] = true;
  const ranks = DRIVE_SKILL_TIERS[slug];
  if (ranks) {
    const upgrades = (source.upgrades ?? []).map((u) => ({ ...u }));
    let changed = false;
    for (const [rank, fields] of Object.entries(ranks)) {
      let tier = upgrades.find((u) => u.rankThreshold === Number(rank));
      if (!tier) {
        tier = {
          id: foundry.utils.randomID(),
          rankThreshold: Number(rank),
          description: "",
          changes: [],
          targetEffects: [],
        };
        upgrades.push(tier);
        changed = true;
      }
      for (const [key, value] of Object.entries(fields)) {
        if (tier[key]) continue;
        tier[key] = value;
        changed = true;
      }
    }
    if (changed) update["system.upgrades"] = upgrades;
  }
  return Object.keys(update).length ? { _id: item.id, ...update } : null;
}

/** An Actor's own copies (a world or compendium Actor). */
export async function fixVehicleSkillsOn(actor) {
  const updates = actor.items.map(vehicleSkillUpdate).filter(Boolean);
  if (updates.length)
    await actor.updateEmbeddedDocuments("Item", updates, { render: false, carlMigration: true });
  return updates.length;
}

/**
 * Save world vehicles' driving Skill as read, one at a time. Written with
 * no diff: migrateData already reads an old key as the Skill's name in
 * memory, so a normal update would see no change.
 * @param {Actor[]} vehicles
 * @param {(doc: Actor, err: unknown) => void} [onFail]  None: the first failure throws.
 * @returns {Promise<number>}  How many were written.
 */
export function saveDriveSkills(
  vehicles,
  onFail = (doc, err) => {
    throw err;
  },
) {
  const list = vehicles.filter((a) => a?.type === "vehicle");
  return eachDocument(
    list,
    async (vehicle) => {
      await vehicle.update(
        { "system.driveSkill": vehicle.system.driveSkill },
        { diff: false, render: false, carlMigration: true },
      );
      return 1;
    },
    onFail,
  );
}

/**
 * 0.7.0 stopped matching Skills by name for vehicles:
 *  - a vehicle's driving Skill became the Skill's name ("driving" ->
 *    "Driving", "chopperPilot" -> "Chopper Pilot"), saved on world
 *    vehicles, unlinked tokens and vehicles in world Actor compendiums (the
 *    data model reads an old key on load meanwhile - data/vehicle.mjs);
 *  - Driving's and Chopper Pilot's Rank perks moved from CONFIG onto their
 *    Upgrade tiers, and Lance got its Mounted box: copies on world Actors,
 *    in the Items directory and in world compendiums get them, as the
 *    pack's copies have them. Homebrew Skills are left alone.
 * @param {{fail?: (where: string, err: unknown) => void}} [context]  runMigrations'.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function migrateVehicleSkillSettings({ fail = NO_FAIL } = {}) {
  const { attempt, failed, result } = migrationTally(fail);

  await attempt(game.i18n.localize("TYPES.Actor.vehicle"), () =>
    saveDriveSkills(
      game.actors.filter((a) => a.type === "vehicle"),
      (actor, err) => failed(actor.name, err),
    ),
  );
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const raw = token.actorLink ? undefined : token.delta?._source?.system?.driveSkill;
      if (driveSkillName(raw) === raw || token.actor?.type !== "vehicle") continue;
      await attempt(token.name, async () => {
        await token.actor.update(
          { "system.driveSkill": driveSkillName(raw) },
          { diff: false, render: false, carlMigration: true },
        );
        return 1;
      });
    }
  }

  for (const actor of game.actors)
    await attempt(`Actor ${actor.name}`, () => fixVehicleSkillsOn(actor));
  await attempt("the Items directory", () => {
    const updates = game.items.map(vehicleSkillUpdate).filter(Boolean);
    return updateItemsEach(
      game.items,
      updates,
      { render: false, carlMigration: true },
      (item, err) => failed(item.name, err),
    );
  });

  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () =>
      withUnlockedPack(pack, async () => {
        const onFail = (doc, err) => failed(`${doc.name} (${pack.title})`, err);
        const options = { pack: pack.collection, render: false, carlMigration: true };
        if (pack.documentName === "Item") {
          const documents = await pack.getDocuments();
          return updateItemsEach(
            documents,
            documents.map(vehicleSkillUpdate).filter(Boolean),
            options,
            onFail,
          );
        }
        // Vehicles with an old key, found from the index (which isn't migrated).
        const index = await pack.getIndex({ fields: ["type", "system.driveSkill"] });
        const oldKeys = new Set(
          index
            .filter(
              (e) =>
                e.type === "vehicle" &&
                driveSkillName(e.system?.driveSkill) !== e.system?.driveSkill,
            )
            .map((e) => e._id),
        );
        const documents = await pack.getDocuments();
        const keys = await eachDocument(
          documents.filter((a) => oldKeys.has(a.id)),
          async (vehicle) => {
            await vehicle.update(
              { "system.driveSkill": vehicle.system.driveSkill },
              { diff: false, render: false, carlMigration: true },
            );
            return 1;
          },
          onFail,
        );
        return keys + (await eachDocument(documents, fixVehicleSkillsOn, onFail));
      }),
    );
  }
  return result();
}

/* -------------------------------------------------- */
/*  The list                                          */
/* -------------------------------------------------- */

// Last in the file, so every id and step it names is declared before it's read.
/**
 * The migrations, oldest first. `id` never changes once released; `version`
 * is the release whose data it brings a world up to (for messages). A run
 * that returns `incomplete: true` isn't recorded, so it runs again on the
 * next load (one whose leftovers must not be stranded - the Pet tab's).
 * `run` is given {fail(where, error)}, to report a document it couldn't
 * migrate (runMigrations whispers the GM one list of them).
 * @type {{id: string, version: string, run: (context: {fail: (where: string, error: unknown) => void}) => Promise<{changed: number, errors: number, incomplete?: boolean}>}[]}
 */
/* -------------------------------------------------- */
/*  0.8.0: the Stat a Skill or Spell is Opposed by    */
/* -------------------------------------------------- */

/**
 * The update an owned copy of a system Skill or Spell needs for 0.8.0's
 * Opposed Checks (p.59): the Stat its compendium original is Opposed by -
 * only that field, and only where the copy has none (a Stat the GM set is
 * kept). Its Rank, marks and everything else are left alone.
 * @param {Item|object} item
 * @param {Item[]} sources  The system's Skills and Spells with an opposed Stat.
 * @returns {object|null}  {_id, "system.opposedStat"}, or null.
 */
export function opposedStatUpdate(item, sources) {
  if (!["skill", "spell"].includes(item?.type)) return null;
  if (item.system?.opposedStat) return null;
  const stat = refreshSourceFor(item, sources)?.system?.opposedStat;
  return stat ? { _id: item.id, "system.opposedStat": stat } : null;
}

/**
 * 0.8.0 gave the system Skills and Spells the book calls Opposed ("Make an
 * Int-Opposed Skill Check") the Stat they're Opposed by, so a Check with one
 * opens Opposed at a target. Every actor holds its own copy, made before:
 * this sets the Stat on each copy that has none - on world Actors, in the
 * Items directory and in world compendiums - and whispers the GM a list.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateOpposedStats({ fail = NO_FAIL } = {}) {
  const packId = `${SCOPE}.skills-and-spells`;
  const pack = game.packs.get(packId);
  if (!pack) {
    console.error(`carl-rpg | 0.8.0 migration: the system compendium ${packId} is missing`);
    fail(packId, missingPackError(packId));
    return { changed: 0, errors: 1 };
  }
  const sources = (await pack.getDocuments()).filter((d) => d.system?.opposedStat);
  let changed = 0;
  let errors = 0;
  const lines = [];
  // A fresh object for every write: updateEmbeddedDocuments writes its
  // parent onto the options it's given, and a shared one would send the next
  // write (the Items directory's, a compendium's) to that actor's items.
  const options = () => ({ render: false, carlMigration: true });
  const failedItem = (where) => (item, err) => {
    console.error(`carl-rpg | 0.8.0 migration: couldn't update ${item.name}`, err);
    errors += 1;
    fail(where ? `${item.name} (${where})` : item.name, err);
  };
  const patch = async (label, items, write) => {
    try {
      const updates = [...items].map((i) => opposedStatUpdate(i, sources)).filter(Boolean);
      if (!updates.length) return;
      const written = await write(updates);
      changed += typeof written === "number" ? written : updates.length;
      const names = updates.map(
        (u) => items.get?.(u._id)?.name ?? [...items].find((i) => i.id === u._id)?.name,
      );
      lines.push(
        game.i18n.format("CARLRPG.Migration.Refresh.Line", {
          name: esc(label),
          items: names.filter(Boolean).map(esc).join(", "),
        }),
      );
    } catch (err) {
      console.error(`carl-rpg | 0.8.0 migration: couldn't update the items of ${label}`, err);
      errors += 1;
      fail(label, err);
    }
  };
  if (!sources.length) return { changed, errors };

  for (const actor of game.actors) {
    await patch(actor.name, actor.items, (u) =>
      actor.updateEmbeddedDocuments("Item", u, options()),
    );
  }
  await patch(game.i18n.localize("CARLRPG.Migration.Refresh.ItemsDirectory"), game.items, (u) =>
    updateItemsEach(game.items, u, options(), failedItem("")),
  );
  for (const worldPack of game.packs.filter((p) => shouldMigratePack(p))) {
    try {
      await withUnlockedPack(worldPack, async () => {
        const documents = await worldPack.getDocuments();
        if (worldPack.documentName === "Actor") {
          for (const actor of documents) {
            await patch(`${actor.name} (${worldPack.title})`, actor.items, (u) =>
              actor.updateEmbeddedDocuments("Item", u, options()),
            );
          }
        } else {
          await patch(worldPack.title, documents, (u) =>
            updateItemsEach(
              documents,
              u,
              { ...options(), pack: worldPack.collection },
              failedItem(worldPack.title),
            ),
          );
        }
      });
    } catch (err) {
      console.error(
        `carl-rpg | 0.8.0 migration: couldn't update items in compendium ${worldPack.collection}`,
        err,
      );
      errors += 1;
      fail(worldPack.collection, err);
    }
  }
  if (lines.length) await whisperGmList("OpposedStats", lines);
  return { changed, errors };
}

export const MIGRATIONS = [
  { id: "0.7.0-hand-to-hand-box", version: "0.7.0", run: migrateHandToHandSkills },
  { id: COMPANIONS_MIGRATION_ID, version: "0.7.0", run: migrateCompanionActors },
  { id: DEITY_MIGRATION_ID, version: "0.7.0", run: migrateDeityBlocks },
  // These have their own ids, so a world that already had the three above
  // still gets them.
  { id: DEITY_TIER_MIGRATION_ID, version: "0.7.0", run: migrateDeityTiers },
  { id: COMPENDIUM_REFRESH_ID, version: "0.7.0", run: migrateCompendiumCopies },
  { id: BASE_MULTIPLIER_MIGRATION_ID, version: "0.7.0", run: migrateBaseMultipliers },
  { id: BASE_DR_MIGRATION_ID, version: "0.7.0", run: migrateCharacterBaseDr },
  { id: CHARGEN_DONE_MIGRATION_ID, version: "0.7.0", run: migrateChargenDone },
  // Before the gear slots (a guessed weapon is then Held) and the notice
  // (which says what it filled in).
  { id: WEAPON_SKILL_GUESS_ID, version: "0.7.0", run: migrateWeaponSkillGuesses },
  { id: MOB_ATTACKS_MIGRATION_ID, version: "0.7.0", run: migrateMobAttacks },
  { id: MOB_SIZE_MIGRATION_ID, version: "0.7.0", run: migrateMobSizes },
  { id: GEAR_SLOTS_MIGRATION_ID, version: "0.7.0", run: migrateGearSlots },
  // Last: it lists the weapons still blank, by where they're now worn.
  { id: WEAPON_SKILL_NOTICE_ID, version: "0.7.0", run: announceWeaponSkill },
  { id: VEHICLE_SKILL_MIGRATION_ID, version: "0.7.0", run: migrateVehicleSkillSettings },
  { id: SKILL_SETTING_BOXES_ID, version: "0.7.0", run: migrateSkillSettingBoxes },
  { id: OPPOSED_STATS_MIGRATION_ID, version: "0.8.0", run: migrateOpposedStats },
];

/**
 * Ids these migrations had before they were renamed. They were first
 * numbered for 0.6.0, but 0.6.0 had already been released without them: they
 * ship in 0.7.0. Only development worlds ever recorded the old ids; a world
 * that did has them read as the new ones, so nothing runs twice (a second
 * compendium refresh would undo hand edits made since).
 * @type {Record<string, string>}
 */
export const RENAMED_MIGRATION_IDS = Object.freeze({
  "0.6.0-hand-to-hand-box": "0.7.0-hand-to-hand-box",
  "0.6.0-companion-actors": COMPANIONS_MIGRATION_ID,
  "0.6.0-deity-block": DEITY_MIGRATION_ID,
  "0.6.0-deity-tier": DEITY_TIER_MIGRATION_ID,
  "0.6.0-compendium-refresh": COMPENDIUM_REFRESH_ID,
  "0.6.0-character-base-dr": BASE_DR_MIGRATION_ID,
  "0.6.0-chargen-done": CHARGEN_DONE_MIGRATION_ID,
  "0.6.0-weapon-skill-notice": WEAPON_SKILL_NOTICE_ID,
});
