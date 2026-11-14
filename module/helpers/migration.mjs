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
 *   id is recorded once a full pass completes - a document that fails is
 *   reported, not retried forever (as dnd5e does); only a run cut short (the
 *   tab closed mid-way) runs again on the next load.
 * - Updates pass `render: false` and change only the one field involved, so
 *   no sheets redraw mid-run and no other data is rewritten.
 * - World compendiums are migrated too, unlocked for the run and locked
 *   again after. The system's own packs are rebuilt from source instead, and
 *   modules' packs aren't the world's to edit. Unlinked tokens' own item
 *   overrides aren't visited (as in dnd5e and Draw Steel).
 */
import { slugifySkillName } from "./modifiers.mjs";

const SCOPE = "carl-rpg";
export const MIGRATION_SETTING = "completedMigrations";

/**
 * The migrations, oldest first. `id` never changes once released; `version`
 * is the release whose data it brings a world up to (for messages).
 * @type {{id: string, version: string, run: () => Promise<{changed: number, errors: number}>}[]}
 */
export const MIGRATIONS = [
  { id: "0.6.0-hand-to-hand-box", version: "0.6.0", run: migrateHandToHandSkills },
];

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
  const had = new Set(done ?? []);
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
  const { run, record } = migrationPlan({
    done: game.settings.get(SCOPE, MIGRATION_SETTING),
    hasContent: worldHasContent(),
  });
  if (!record) return;
  if (!run.length) {
    await game.settings.set(SCOPE, MIGRATION_SETTING, record);
    return;
  }

  const version = run.at(-1).version;
  const banner = ui.notifications.info(game.i18n.format("CARLRPG.Migration.Begin", { version }), { permanent: true });
  let errors = 0;
  let changed = 0;
  try {
    for (const migration of run) {
      console.log(`carl-rpg | Running migration ${migration.id}`);
      try {
        const result = await migration.run();
        errors += result.errors;
        changed += result.changed;
      } catch (err) {
        console.error(`carl-rpg | Migration ${migration.id} failed`, err);
        errors += 1;
      }
    }
    // A full pass happened: record it, even if some documents failed - they
    // are reported rather than retried on every load.
    await game.settings.set(SCOPE, MIGRATION_SETTING, record);
  } finally {
    ui.notifications.remove(banner);
  }
  if (errors) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Migration.Failed", { version, count: changed, errors }), { permanent: true });
  } else {
    ui.notifications.info(game.i18n.format("CARLRPG.Migration.Done", { version, count: changed }), { permanent: true });
  }
}

/* -------------------------------------------------- */
/*  0.6.0: the Hand-to-Hand box                       */
/* -------------------------------------------------- */

// The hand-to-hand Combat Skills (p.179), which 0.6.0's pack ticks.
const HAND_TO_HAND = new Set(["Foot Soldier", "Noggin Nocker", "Pugilism", "Unarmed Combat", "Wrasslin'"]
  .map((name) => slugifySkillName(name)));

/** A copy of one of the five whose Hand-to-Hand box isn't ticked yet. */
export function needsHandToHand(item) {
  return item?.type === "skill" && !item.system?.isHandToHand && HAND_TO_HAND.has(slugifySkillName(item.name));
}

/**
 * Tick the box on an Actor's own copies (a world or compendium Actor).
 * @param {Actor} actor
 * @returns {Promise<number>}  How many were ticked.
 */
export async function tickHandToHandOn(actor) {
  const updates = actor.items.filter(needsHandToHand).map((item) => ({ _id: item.id, "system.isHandToHand": true }));
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { render: false });
  return updates.length;
}

/**
 * 0.6.0 added the Hand-to-Hand box to Skills. Copies of Foot Soldier,
 * Noggin Nocker, Pugilism, Unarmed Combat and Wrasslin' made before then -
 * on world Actors, in the Items directory and in world compendiums - get it
 * ticked, as the pack's own copies are.
 * Homebrew Skills are left alone.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateHandToHandSkills() {
  let changed = 0;
  let errors = 0;
  const attempt = async (label, fn) => {
    try {
      changed += await fn();
    } catch (err) {
      console.error(`carl-rpg | 0.6.0 migration: couldn't update ${label}`, err);
      errors += 1;
    }
  };

  for (const actor of game.actors) await attempt(`Actor ${actor.name}`, () => tickHandToHandOn(actor));

  await attempt("the Items directory", async () => {
    const updates = game.items.filter(needsHandToHand).map((item) => ({ _id: item.id, "system.isHandToHand": true }));
    if (updates.length) await Item.implementation.updateDocuments(updates, { render: false });
    return updates.length;
  });

  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () => migratePack(pack));
  }
  return { changed, errors };
}

/**
 * The world's own Actor and Item packs - never the system's or a module's.
 * @param {CompendiumCollection} pack
 * @returns {boolean}
 */
function shouldMigratePack(pack) {
  return ["Actor", "Item"].includes(pack.documentName) && pack.metadata.packageType === "world";
}

/** One compendium: unlocked for the run, locked again after. */
async function migratePack(pack) {
  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  try {
    let changed = 0;
    const documents = await pack.getDocuments();
    if (pack.documentName === "Actor") {
      for (const actor of documents) changed += await tickHandToHandOn(actor);
    } else {
      const updates = documents.filter(needsHandToHand).map((item) => ({ _id: item.id, "system.isHandToHand": true }));
      if (updates.length) await Item.implementation.updateDocuments(updates, { pack: pack.collection, render: false });
      changed += updates.length;
    }
    return changed;
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
}
