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
import { createNoticeMessage, esc } from "../chat/chat-card.mjs";
import { tierRank } from "./worship.mjs";
import { COMPANIONS_MIGRATION_ID, migrateCompanionActors, sweepLegacyCompanions } from "./companion-migration.mjs";

const SCOPE = "carl-rpg";
export const MIGRATION_SETTING = "completedMigrations";

/** The 0.6.0 Deity block migration's id (migrateDeityBlocks). */
export const DEITY_MIGRATION_ID = "0.6.0-deity-block";

/** The 0.6.0 Deity Tier backfill's id (migrateDeityTiers). */
export const DEITY_TIER_MIGRATION_ID = "0.6.0-deity-tier";

/** The 0.6.0 Weapon Skill notice's id (announceWeaponSkill). */
export const WEAPON_SKILL_NOTICE_ID = "0.6.0-weapon-skill-notice";

/**
 * The migrations, oldest first. `id` never changes once released; `version`
 * is the release whose data it brings a world up to (for messages). A run
 * that returns `incomplete: true` isn't recorded, so it runs again on the
 * next load (one whose leftovers must not be stranded - the Pet tab's).
 * @type {{id: string, version: string, run: () => Promise<{changed: number, errors: number, incomplete?: boolean}>}[]}
 */
export const MIGRATIONS = [
  { id: "0.6.0-hand-to-hand-box", version: "0.6.0", run: migrateHandToHandSkills },
  { id: COMPANIONS_MIGRATION_ID, version: "0.6.0", run: migrateCompanionActors },
  { id: DEITY_MIGRATION_ID, version: "0.6.0", run: migrateDeityBlocks },
  // These two have their own ids, so a world that already had the three
  // above still gets them.
  { id: DEITY_TIER_MIGRATION_ID, version: "0.6.0", run: migrateDeityTiers },
  { id: WEAPON_SKILL_NOTICE_ID, version: "0.6.0", run: announceWeaponSkill },
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
  const done = game.settings.get(SCOPE, MIGRATION_SETTING) ?? [];
  const { run, record } = migrationPlan({ done, hasContent: worldHasContent() });
  if (record && !run.length) await game.settings.set(SCOPE, MIGRATION_SETTING, record);
  if (run.length) await runMigrations(run, done);
  // A pre-0.6.0 Character imported after the Pet tab migration ran still
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
  const banner = ui.notifications.info(game.i18n.format("CARLRPG.Migration.Begin", { version }), { permanent: true });
  let errors = 0;
  let changed = 0;
  const finished = [];
  try {
    for (const migration of run) {
      console.log(`carl-rpg | Running migration ${migration.id}`);
      try {
        const result = await migration.run();
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
        finished.push(migration.id);
      }
    }
    await game.settings.set(SCOPE, MIGRATION_SETTING, [...new Set([...done, ...finished])]);
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

/* -------------------------------------------------- */
/*  0.6.0: the structured Deity block                 */
/* -------------------------------------------------- */

/**
 * 0.6.0 turned a Character's Deity rich text box into a structured block
 * (module/data/character.mjs); CarlRPGCharacter.migrateData keeps the old
 * text as its notes, but only in memory. Until the block is saved whole,
 * the database still holds the old string, and an ordinary Deity edit -
 * sent as a diff such as {deity: {name}} - would be merged over that string
 * by the server, losing the notes. This writes each Character's block
 * whole, once. The client can't tell which Characters still hold a string
 * (it only sees the migrated data), so every Character is written - the same
 * value, so a second run changes nothing.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateDeityBlocks() {
  let changed = 0;
  let errors = 0;
  const attempt = async (label, fn) => {
    try {
      changed += await fn();
    } catch (err) {
      console.error(`carl-rpg | 0.6.0 migration: couldn't save the Deity of ${label}`, err);
      errors += 1;
    }
  };
  for (const actor of game.actors) await attempt(`Actor ${actor.name}`, () => persistDeityBlock(actor));
  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    await attempt(`compendium ${pack.collection}`, () => withUnlockedPack(pack, async () => {
      let count = 0;
      for (const actor of await pack.getDocuments()) count += await persistDeityBlock(actor);
      return count;
    }));
  }
  return { changed, errors };
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
  await actor.update({ system: { deity: ForcedReplacement.create(deity) } }, { render: false, carlMigration: true });
  return 1;
}

/* -------------------------------------------------- */
/*  0.6.0: the Deity Tier, from the Boons owned       */
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
  await actor.update({ system: { deity: ForcedReplacement.create(deity) } }, { render: false, carlMigration: true });
  return tier;
}

/**
 * 0.6.0 gave the Deity block a Tier, and a tiered Boon now applies only at or
 * below it (worship.mjs deityBenefitApplies, pp.163-164). Before, a Boon's
 * Tier was only a label and every Boon applied. So a Character keeps its
 * Boons, its Tier is set to the highest Tier among them - only where no Tier
 * is set yet. The GM gets a whispered list of who was given which Tier, to
 * check.
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateDeityTiers() {
  let changed = 0;
  let errors = 0;
  const lines = [];
  const attempt = async (actor, where) => {
    try {
      const tier = await backfillDeityTier(actor);
      if (!tier) return;
      changed += 1;
      lines.push(game.i18n.format("CARLRPG.Migration.DeityTier.Line", {
        name: esc(actor.name) + (where ? ` (${esc(where)})` : ""),
        tier: esc(game.i18n.localize(CONFIG.CARLRPG.featureTiers[tier])),
      }));
    } catch (err) {
      console.error(`carl-rpg | 0.6.0 migration: couldn't set the Deity Tier of ${actor.name}`, err);
      errors += 1;
    }
  };
  for (const actor of game.actors) await attempt(actor);
  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    try {
      await withUnlockedPack(pack, async () => {
        for (const actor of await pack.getDocuments()) await attempt(actor, pack.title);
      });
    } catch (err) {
      console.error(`carl-rpg | 0.6.0 migration: couldn't set Deity Tiers in compendium ${pack.collection}`, err);
      errors += 1;
    }
  }
  if (lines.length) {
    await createNoticeMessage({
      title: game.i18n.localize("CARLRPG.Migration.DeityTier.Title"),
      bodyHtml: `<p>${esc(game.i18n.localize("CARLRPG.Migration.DeityTier.Body"))}</p>`
        + `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
      whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    });
  }
  return { changed, errors };
}

/* -------------------------------------------------- */
/*  0.6.0: the Weapon Skill notice                    */
/* -------------------------------------------------- */

/**
 * 0.6.0 added a Weapon Skill field to gear, and an Attack with a Weapon
 * Skill now needs a weapon whose Weapon Skill names it (module/helpers/
 * weapons.mjs). Gear isn't its own "weapon" type, so there's no telling
 * which existing items are weapons, or for which Skill - the players set it.
 * This posts a chat notice, to everyone, saying so. A new world (nothing
 * in it) never gets it: migrationPlan marks every migration had.
 * @returns {Promise<{changed: number, errors: number}>}
 */
export async function announceWeaponSkill() {
  await createNoticeMessage({
    title: game.i18n.localize("CARLRPG.Migration.WeaponSkill.Title"),
    body: game.i18n.localize("CARLRPG.Migration.WeaponSkill.Body"),
  });
  return { changed: 0, errors: 0 };
}

/** Run fn with a compendium unlocked, locked again after. */
async function withUnlockedPack(pack, fn) {
  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  try {
    return await fn();
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
}

/** One compendium: unlocked for the run, locked again after. */
function migratePack(pack) {
  return withUnlockedPack(pack, async () => {
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
  });
}
