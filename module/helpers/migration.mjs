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
import { MOB_ATTACK_TYPE, attacksToCheck, convertLegacyAttacks } from "./mob-attacks.mjs";

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

/**
 * The migrations, oldest first. `id` never changes once released; `version`
 * is the release whose data it brings a world up to (for messages). A run
 * that returns `incomplete: true` isn't recorded, so it runs again on the
 * next load (one whose leftovers must not be stranded - the Pet tab's).
 * @type {{id: string, version: string, run: () => Promise<{changed: number, errors: number, incomplete?: boolean}>}[]}
 */
export const MIGRATIONS = [
  { id: "0.7.0-hand-to-hand-box", version: "0.7.0", run: migrateHandToHandSkills },
  { id: COMPANIONS_MIGRATION_ID, version: "0.7.0", run: migrateCompanionActors },
  { id: DEITY_MIGRATION_ID, version: "0.7.0", run: migrateDeityBlocks },
  // These have their own ids, so a world that already had the three above
  // still gets them.
  { id: DEITY_TIER_MIGRATION_ID, version: "0.7.0", run: migrateDeityTiers },
  { id: COMPENDIUM_REFRESH_ID, version: "0.7.0", run: migrateCompendiumCopies },
  { id: BASE_DR_MIGRATION_ID, version: "0.7.0", run: migrateCharacterBaseDr },
  { id: CHARGEN_DONE_MIGRATION_ID, version: "0.7.0", run: migrateChargenDone },
  { id: WEAPON_SKILL_NOTICE_ID, version: "0.7.0", run: announceWeaponSkill },
  { id: MOB_ATTACKS_MIGRATION_ID, version: "0.7.0", run: migrateMobAttacks },
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
/*  0.7.0: the Hand-to-Hand box                       */
/* -------------------------------------------------- */

// The hand-to-hand Combat Skills (p.179), which 0.7.0's pack ticks.
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
 * 0.7.0 added the Hand-to-Hand box to Skills. Copies of Foot Soldier,
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
      console.error(`carl-rpg | 0.7.0 migration: couldn't update ${label}`, err);
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
 * @returns {Promise<{changed: number, errors: number}>}
 */
async function migrateDeityBlocks() {
  let changed = 0;
  let errors = 0;
  const attempt = async (label, fn) => {
    try {
      changed += await fn();
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't save the Deity of ${label}`, err);
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
  await actor.update({ system: { deity: ForcedReplacement.create(deity) } }, { render: false, carlMigration: true });
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
      console.error(`carl-rpg | 0.7.0 migration: couldn't set the Deity Tier of ${actor.name}`, err);
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
      console.error(`carl-rpg | 0.7.0 migration: couldn't set Deity Tiers in compendium ${pack.collection}`, err);
      errors += 1;
    }
  }
  if (lines.length) await whisperGmList("DeityTier", lines);
  return { changed, errors };
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
    "Tigran", "Tigran (Primal)", "Amazonian", "Amazonian (Primal)", "Doppelgänger", "Doppelgänger (Primal)",
    "Elf (High)", "Elf (High) (Primal)", "Obsidian Butterfly", "Obsidian Butterfly (Primal)",
    "Straight-to-DVD Action Hero", "Zulu Warrior",
  ],
  "skills-and-spells": ["Dodge", "Running", "Catlike Reflexes", "Jumping", "Longsword", "Rapier", "Quarterstaff", "Oakhide"],
};

/** The change targets the refresh owns: everything else on a copy is kept. */
const MANAGED_TARGETS = {
  resource: new Set(["dr", "move", "step"]),
  rollMode: new Set(["evadeBonus", "evadeDice"]),
};

/** Oakhide's description note before and after it became a toggled Spell. */
const OAKHIDE_OLD_NOTE = "<p><em>Note: DR has no temporary/conditional-bonus mechanism in this system - apply this bonus by hand while the buff is active.</em></p>";
const OAKHIDE_NEW_NOTE = "<p><em>Casting it switches it on (paying its Mana) and its DR is added automatically; cast it again when the buff ends to switch it off.</em></p>";

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
  return (changes ?? []).filter(isManagedChange)
    .map((c) => [c.targetType, c.target, c.mode, String(c.value), Number(c.levelGate) || 0, (c.conditions ?? []).length].join("|"))
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
    ...(source ?? []).filter(isManagedChange).map((c) => ({ ...foundry.utils.deepClone(c), id: foundry.utils.randomID() })),
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
  const plain = (sys) => (typeof sys?.toObject === "function" ? sys.toObject() : sys ?? {});
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
        changes: (sourceTier.changes ?? []).map((c) => ({ ...foundry.utils.deepClone(c), id: foundry.utils.randomID() })),
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

/** The refreshed items, read from the system's (rebuilt) packs. */
async function loadRefreshSources() {
  const sources = [];
  for (const [packName, names] of Object.entries(REFRESHED_ITEMS)) {
    const pack = game.packs.get(`${SCOPE}.${packName}`);
    if (!pack) continue;
    const index = await pack.getIndex();
    for (const name of names) {
      const entry = index.find((e) => e.name === name);
      if (entry) sources.push(await pack.getDocument(entry._id));
    }
  }
  return sources;
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
  const all = [...(source.system.changes ?? []), ...(source.system.upgrades ?? []).flatMap((t) => t.changes ?? [])];
  return all.some((c) => c.targetType === "resource" && (c.target === "move" || c.target === "step"));
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
async function migrateCompendiumCopies() {
  const sources = await loadRefreshSources();
  let changed = 0;
  let errors = 0;
  const lines = [];
  const options = { render: false, carlMigration: true };
  const refresh = async (label, items, write, actor = null) => {
    try {
      const { updates, names, movement } = refreshUpdatesFor(items, sources);
      if (!updates.length) return;
      await write(updates);
      changed += updates.length;
      const note = movement ? esc(typedMovementNote(actor)) : "";
      lines.push(game.i18n.format("CARLRPG.Migration.Refresh.Line", { name: esc(label), items: names.map(esc).join(", ") }) + note);
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't refresh the items of ${label}`, err);
      errors += 1;
    }
  };
  if (!sources.length) return { changed, errors };

  for (const actor of game.actors) {
    await refresh(actor.name, actor.items, (u) => actor.updateEmbeddedDocuments("Item", u, options), actor);
  }
  await refresh(game.i18n.localize("CARLRPG.Migration.Refresh.ItemsDirectory"), game.items,
    (u) => Item.implementation.updateDocuments(u, options));
  for (const pack of game.packs.filter((p) => shouldMigratePack(p))) {
    try {
      await withUnlockedPack(pack, async () => {
        const documents = await pack.getDocuments();
        if (pack.documentName === "Actor") {
          for (const actor of documents) {
            await refresh(`${actor.name} (${pack.title})`, actor.items, (u) => actor.updateEmbeddedDocuments("Item", u, options), actor);
          }
        } else {
          await refresh(pack.title, documents, (u) => Item.implementation.updateDocuments(u, { ...options, pack: pack.collection }));
        }
      });
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't refresh items in compendium ${pack.collection}`, err);
      errors += 1;
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
async function migrateCharacterBaseDr() {
  let changed = 0;
  let errors = 0;
  const lines = [];
  const attempt = async (actor, where) => {
    try {
      const dr = await zeroCharacterBaseDr(actor);
      if (!dr) return;
      changed += 1;
      lines.push(game.i18n.format("CARLRPG.Migration.BaseDr.Line", {
        name: esc(actor.name) + (where ? ` (${esc(where)})` : ""), dr,
      }));
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't zero the base DR of ${actor.name}`, err);
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
      console.error(`carl-rpg | 0.7.0 migration: couldn't zero base DR in compendium ${pack.collection}`, err);
      errors += 1;
    }
  }
  if (lines.length) await whisperGmList("BaseDr", lines);
  return { changed, errors };
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
  return actor?.type === "character"
    && !actor.getFlag(SCOPE, "chargen")?.done
    && actor.items.some((i) => SKILL_TYPES.includes(i.type));
}

/**
 * Mark one Character made before the wizard as through character creation,
 * so its sheet stops offering Create Crawler.
 * @param {Actor} actor
 * @returns {Promise<boolean>}  Whether it was marked.
 */
export async function markChargenDone(actor) {
  if (!madeBeforeChargen(actor)) return false;
  await actor.update({ [`flags.${SCOPE}.chargen`]: { done: true, migrated: true } }, { render: false, carlMigration: true });
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
async function migrateChargenDone() {
  let changed = 0;
  let errors = 0;
  const attempt = async (actor) => {
    try {
      if (await markChargenDone(actor)) changed += 1;
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't mark ${actor.name} as created`, err);
      errors += 1;
    }
  };
  for (const actor of game.actors) await attempt(actor);
  for (const pack of game.packs.filter((p) => p.documentName === "Actor" && shouldMigratePack(p))) {
    try {
      await withUnlockedPack(pack, async () => {
        for (const actor of await pack.getDocuments()) await attempt(actor);
      });
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't mark Characters in compendium ${pack.collection}`, err);
      errors += 1;
    }
  }
  return { changed, errors };
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
    bodyHtml: `<p>${esc(game.i18n.localize(`CARLRPG.Migration.${key}.Body`))}</p>`
      + `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
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
export async function migrateMobAttacks() {
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
        lines.push(game.i18n.format("CARLRPG.Migration.MobAttacks.Line", {
          name: esc(actor.name) + (where ? ` (${esc(where)})` : ""), attacks: esc(check.join(", ")),
        }));
      }
    } catch (err) {
      console.error(`carl-rpg | 0.7.0 migration: couldn't convert the Attacks of ${actor.name}`, err);
      errors += 1;
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
        console.error(`carl-rpg | 0.7.0 migration: couldn't clear the inherited Attacks of token ${token.name}`, err);
        errors += 1;
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
      console.error(`carl-rpg | 0.7.0 migration: couldn't convert Mob Attacks in compendium ${pack.collection}`, err);
      errors += 1;
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
    .filter((i) => i.type === MOB_ATTACK_TYPE && Number.isInteger(i.getFlag("carl-rpg", "legacyAttack")))
    .map((i) => i.id);
  if (inherited.length) await token.actor.deleteEmbeddedDocuments("Item", inherited, { carlMigration: true });
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
/*  0.7.0: the Weapon Skill notice                    */
/* -------------------------------------------------- */

/**
 * 0.7.0 added a Weapon Skill field to gear, and an Attack with a Weapon
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
