/**
 * Race/Class stat and Skill-Rank grants work differently from every other
 * item type's bonuses. Gear/Feature/Skill/Spell/Damage-Effect bonuses apply
 * to the EFFECTIVE value every render pass (module/helpers/modifiers.mjs's
 * live bonus-aggregation engine) - remove the item, the bonus goes away.
 * Race/Class stat/Skill grants are a one-time, permanent bump to the BASE
 * value instead (the book's own framing: choosing a Race "boosts" your
 * sheet, it doesn't grant a conditional buff) - once baked in, they stay
 * even if the granting Race/Class item is later removed (confirmed user
 * decision), and must NOT also be counted as a live bonus on top of that
 * same base value, or the actor double-dips.
 *
 * This module is the WRITE side of that: baking a class/race item's
 * eligible stat/skillRank ChangeEntries into the actor's real, persisted
 * `system.stats.*.value` / an owned Skill-like item's `system.rank`.
 * modifiers.mjs's `applyOneChange` is the READ side - it skips the live
 * delta for these same targetType/sourceItemType combinations, since this
 * module is what already put that delta into the base value.
 *
 * Idempotency: each ChangeEntry's own `id` is recorded (as a flag on the
 * granting item) once baked, so re-running this - e.g. from an Actor-level
 * hook re-checking every owned Race/Class item whenever Level changes, for
 * a level-gated grant that wasn't eligible yet - never re-applies the same
 * grant twice.
 *
 * That record describes the actor the item was baked on, not the item: a
 * Race/Class created on an actor as its own document (dragged from another
 * actor, the Items sidebar or a compendium) starts with it emptied
 * (documents/item.mjs _preCreate), so it bakes on its new owner. Items
 * that arrive inside a whole actor (a duplicate, an actor import) skip
 * Item _preCreate and keep it - that actor's Stats came along too.
 */

import { applyScalarChange, slugifySkillName } from "./modifiers.mjs";
import { CARLRPG } from "./config.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { buildMatcher } from "../pdf-import/compendium-match.mjs";
import { matchCandidates } from "../pdf-import/importer.mjs";

const BAKEABLE_TARGET_TYPES = new Set(["stat", "skillRank"]);
// Derived from the same table modifiers.mjs's isBakedGrant validates a
// "stat" change's target against (module/helpers/config.mjs) - a single
// source of truth, not a second hardcoded copy that could silently drift
// out of sync and leave some future stat's grants unbaked-but-also-
// unapplied (neither side would touch it).
const STAT_KEYS = new Set(Object.keys(CARLRPG.statAbbreviations));
export const SKILL_LIKE_TYPES = ["skill", "spell", "damageEffect"];

// bakeItemGrants runs per actor through helpers/actor-queue.mjs: two
// near-simultaneous grants (e.g. a Race and Class added in the same
// drag-drop or import-script batch) must not both read the same pre-update
// stat value before either write commits, or one grant's bump silently
// overwrites the other's.

// "If you have that Skill, add the bonus, up to 10" (Race & Class
// Selection, p.127) - a Rank-10 ceiling specifically during grant
// application to an EXISTING Skill, separate from the normal Rank-15/20
// advancement ceiling. Only applies when the actor already has some Ranks
// in the Skill; a from-scratch grant ("you gain it at that Rank listed")
// has no such cap.
export const SKILL_RANK_GRANT_CAP = 10;

/**
 * A Skill's Rank after a grant, with the p.127 ceiling: a gain to a Skill
 * already held stops at 10 ("you stop at 10, and the remaining bonus is
 * wasted") but never lowers a Rank already above 10. A from-scratch grant
 * (Rank 0) and a reduction aren't capped. Shared with the CrawlerForge
 * importer's granted-Skill planning, so the two can't drift.
 * @param {number} current  The Rank before the grant.
 * @param {number} next     The Rank the grant alone would give.
 * @returns {number}
 */
export function cappedGrantRank(current, next) {
  if (current <= 0 || next <= current) return next;
  return Math.max(current, Math.min(next, SKILL_RANK_GRANT_CAP));
}

function bakedGrantIds(item) {
  return item.getFlag("carl-rpg", "bakedGrantIds") ?? [];
}

export function isEligibleNow(change, actorLevel) {
  if (!BAKEABLE_TARGET_TYPES.has(change.targetType)) return false;
  // Roll-time conditional changes are never a permanent grant - leave them
  // to the normal live-bonus/conditional-modifier path untouched.
  if (Array.isArray(change.conditions) && change.conditions.length) return false;
  if (change.levelGate && Number(change.levelGate) > actorLevel) return false;
  return true;
}

/**
 * Find a Skill, Spell or Damage Effect (or another Item type) by name, in
 * the PDF importer's priority (ruled 2026-11-19): the system's own
 * compendiums, then the rulebook imports' compendiums, then the Items
 * directory, then any other compendium (importer.mjs matchCandidates,
 * compendium-match.mjs buildMatcher). Matched by name (case, apostrophes,
 * dashes and parentheticals aside), else by Skill slug (modifiers.mjs
 * slugifySkillName). Only `types` count: a Spellbook asking for a Spell
 * isn't handed a same-named Skill.
 * @param {string} name
 * @param {string[]} [types]
 * @returns {Promise<Item|null>}
 */
export async function findSkillLikeItem(name, types = SKILL_LIKE_TYPES) {
  const match = buildMatcher(await matchCandidates(null), { slug: slugifySkillName })(name, types);
  return match ? ((await fromUuid(match.ref)) ?? null) : null;
}

/**
 * The actor's owned Skill, Spell or Damage Effect with this name - matched
 * by slug (modifiers.mjs's slugifySkillName), the convention the skills bag
 * uses, so a case/spacing difference doesn't look like a different Skill.
 * @param {Actor} actor
 * @param {string} name
 * @param {string[]} [types]
 * @returns {Item|undefined}
 */
export function findOwnedSkillLike(actor, name, types = SKILL_LIKE_TYPES) {
  const slug = slugifySkillName(name);
  return actor.items.find((i) => types.includes(i.type) && slugifySkillName(i.name) === slug);
}

/**
 * Creation data for a clean owned copy of a Skill-like item at a Rank: no
 * id, folder, stats or ownership from the source, no carried-over use-mark,
 * and a Spell starts switched off. Shared by grants, the CrawlerForge
 * importer, Skill potions, Spellbooks and Scrolls.
 * @param {Item|object} source  An Item, or its toObject() data.
 * @param {number} rank
 * @returns {object}
 */
export function cleanSkillLikeCopy(source, rank) {
  const data = foundry.utils.deepClone(typeof source.toObject === "function" ? source.toObject() : source);
  delete data._id;
  delete data.folder;
  delete data._stats;
  delete data.ownership;
  data.system = { ...(data.system ?? {}), rank, marked: false };
  if (data.type === "spell") data.system.active = false;
  return data;
}

/**
 * Creation data for a Skill-like item found in no compendium: a bare item
 * of that type at a Rank - a Skill is a Utility Skill.
 * @param {string} name
 * @param {number} rank
 * @param {{type?: "skill"|"spell"|"damageEffect", img?: string, system?: object, flags?: object}} [options]
 *   system: more system fields (over the defaults); flags: the item's flags.
 * @returns {object}
 */
export function bareSkillLikeData(name, rank, { type = "skill", img, system = {}, flags } = {}) {
  const data = { name, type, system: { rank, ...(type === "skill" ? { category: "utility" } : {}), ...system } };
  if (img) data.img = img;
  if (flags) data.flags = flags;
  return data;
}

/**
 * The actor's own Skill by name, or - untrained - an unsaved Rank 0 copy
 * from the compendium (a bare Utility Skill if there's none), which rolls
 * with Disadvantage and must not be marked for Advancement (it isn't on the
 * actor). Command Pet's Animal Handling, a Driving Check's Driving.
 * @param {Actor} actor
 * @param {string} name
 * @param {{img?: string, system?: object}} [fallback]  For a Skill missing from every compendium.
 * @returns {Promise<{skill: Item, trained: boolean}>}  trained: owned by the actor.
 */
export async function skillOrUntrainedCopy(actor, name, fallback = {}) {
  const owned = findOwnedSkillLike(actor, name, ["skill"]);
  if (owned) return { skill: owned, trained: true };
  const source = await findSkillLikeItem(name);
  const data = cleanSkillLikeCopy(source ?? bareSkillLikeData(name, 0, {
    img: fallback.img ?? "icons/svg/d20.svg", system: fallback.system,
  }), 0);
  data._id = foundry.utils.randomID();
  return { skill: new CONFIG.Item.documentClass(data, { parent: actor }), trained: false };
}

/**
 * Give the actor a Skill-like item it doesn't own yet, at a Rank: a clean
 * copy of the compendium/world one with that name, or a bare Utility Skill.
 * @param {Actor} actor
 * @param {string} name
 * @param {number} rank
 * @returns {Promise<Item|null>}
 */
export async function learnSkillLike(actor, name, rank) {
  const found = await findSkillLikeItem(name);
  const data = found
    ? cleanSkillLikeCopy(found, rank)
    : bareSkillLikeData(name, rank);
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return created ?? null;
}

/**
 * Bake one skillRank grant into the actor's persisted state: bump an
 * already-owned matching item's Rank, or - if none is owned - copy a
 * matching compendium/world item onto the actor at the granted Rank, or
 * (nothing found anywhere) create a bare new Skill item at that Rank.
 * @param {Actor} actor
 * @param {object} change  A ChangeEntry with targetType "skillRank".
 */
async function bakeSkillRankGrant(actor, change) {
  const name = change.target;
  if (!name) return;
  const delta = Number(change.value) || 0;

  // Slugified match (module/helpers/modifiers.mjs's slugifySkillName), same
  // convention the live aggregation engine uses to key its skills bag - a
  // raw i.name === name comparison would miss a case/whitespace mismatch
  // and create a duplicate item instead of bumping the real one's rank.
  const existing = findOwnedSkillLike(actor, name);
  if (existing) {
    const current = existing.system.rank ?? 0;
    // The Rank-10 grant ceiling ("If you have that Skill, add the bonus, up
    // to 10", p.127) only applies when the actor already has some Ranks in
    // it - a Skill owned at Rank 0 (added but never invested in) is treated
    // as the from-scratch case below, no cap - and caps the gain, never
    // lowering a Rank already above 10 (cappedGrantRank).
    const next = cappedGrantRank(current, applyScalarChange(current, change.mode, delta));
    await existing.update({ "system.rank": next });
    return;
  }

  await learnSkillLike(actor, name, Math.max(0, delta));
}

/**
 * Bake every not-yet-baked, currently-eligible stat/skillRank grant on one
 * owned class/race item into the actor's persisted base values. Safe to
 * call repeatedly (on item creation, on the item's own changes being
 * edited, or on the owning actor's Level changing for a level-gated
 * grant) - already-baked entries are skipped via the item's own
 * "bakedGrantIds" flag.
 * @param {Item} item  An owned class/race Item (no-ops for any other type
 *   or an unowned/non-Character-owned item).
 */
export async function bakeItemGrants(item) {
  const actor = item.parent;
  if (!actor || actor.type !== "character") return;
  if (item.type !== "class" && item.type !== "race") return;

  // Serialized per-actor (helpers/actor-queue.mjs's queueForActor) so a second grant
  // landing while this one is still mid-bake can't read a stale pre-update
  // stat value.
  return queueForActor(actor.uuid, () => bakeEligibleGrants(item, actor));
}

async function bakeEligibleGrants(item, actor) {
  const actorLevel = actor.system.attributes?.level?.value ?? 1;

  // ChangeEntry.id is schema-required and non-blank for anything created
  // fresh via the sheet (auto-random - module/data/shared/change-entry.mjs),
  // but this project's compendium-authored content predates that and ships
  // with literal blank ids - with nothing to key bakedGrantIds' per-change
  // dedup off of, every one of those grants would otherwise be silently
  // unbakeable forever. Self-heal once, in place: any owned class/race
  // item's blank ids get replaced with real ones the first time its grants
  // are checked, and stay fixed from then on.
  let changes = item.system.changes ?? [];
  if (changes.some((c) => !c.id)) {
    changes = changes.map((c) => (c.id ? c : { ...c, id: foundry.utils.randomID() }));
    await item.update({ "system.changes": changes });
  }

  const baked = new Set(bakedGrantIds(item));
  const pending = changes.filter((c) => !baked.has(c.id) && isEligibleNow(c, actorLevel));
  if (!pending.length) return;

  // Recorded as each write lands, so a grant that fails part-way doesn't
  // leave the ones already written unrecorded (and re-applied next time).
  const recorded = [...baked];
  const record = (ids) => {
    if (!ids.length) return undefined;
    recorded.push(...ids);
    return item.setFlag("carl-rpg", "bakedGrantIds", [...recorded]);
  };

  const statIds = [];
  const statUpdates = {};
  for (const change of pending) {
    if (change.targetType !== "stat" || !STAT_KEYS.has(change.target)) continue;
    const path = `system.stats.${change.target}.value`;
    const base = actor.system.stats?.[change.target]?.value ?? 0;
    const current = path in statUpdates ? statUpdates[path] : base;
    statUpdates[path] = applyScalarChange(current, change.mode, Number(change.value) || 0);
    statIds.push(change.id);
  }
  if (Object.keys(statUpdates).length) await actor.update(statUpdates);
  await record(statIds);

  // Skill-rank grants run sequentially (each may create/copy its own item,
  // and a later grant targeting the same Skill needs to see the prior one's
  // update already applied).
  for (const change of pending) {
    if (change.targetType !== "skillRank") continue;
    await bakeSkillRankGrant(actor, change);
    await record([change.id]);
  }
}

/**
 * Re-check every owned class/race item on a Character for newly-eligible
 * level-gated grants (e.g. Bune's "At Level 50, +2 Dexterity") - call this
 * whenever the actor's Level changes, since a grant that wasn't eligible at
 * add-time needs a second chance to bake once the gate is crossed.
 * @param {Actor} actor
 */
export async function recheckLevelGatedGrants(actor) {
  if (actor.type !== "character") return;
  const raceClassItems = actor.items.filter((i) => i.type === "class" || i.type === "race");
  for (const item of raceClassItems) {
    await bakeItemGrants(item);
  }
}
