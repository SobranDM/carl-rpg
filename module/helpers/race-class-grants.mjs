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
 */

import { applyScalarChange, slugifySkillName } from "./modifiers.mjs";
import { CARLRPG } from "./config.mjs";

const BAKEABLE_TARGET_TYPES = new Set(["stat", "skillRank"]);
// Derived from the same table modifiers.mjs's isBakedGrant validates a
// "stat" change's target against (module/helpers/config.mjs) - a single
// source of truth, not a second hardcoded copy that could silently drift
// out of sync and leave some future stat's grants unbaked-but-also-
// unapplied (neither side would touch it).
const STAT_KEYS = new Set(Object.keys(CARLRPG.statAbbreviations));
const SKILL_LIKE_TYPES = ["skill", "spell", "damageEffect"];

// Serializes bakeItemGrants per actor: two near-simultaneous grants (e.g. a
// Race and Class added in the same drag-drop or import-script batch) must
// not both read the same pre-update stat value before either write
// commits, or one grant's bump silently overwrites the other's. A plain
// Promise chain is enough here - everything that touches actor.update for
// this feature runs through this same queue, on this same client.
const actorBakeQueues = new Map();

function queueForActor(actorId, task) {
  const previous = actorBakeQueues.get(actorId) ?? Promise.resolve();
  const next = previous.then(task, task);
  actorBakeQueues.set(actorId, next.catch(() => {}));
  return next;
}

// "If you have that Skill, add the bonus, up to 10" (Race & Class
// Selection, p.127) - a Rank-10 ceiling specifically during grant
// application to an EXISTING Skill, separate from the normal Rank-15/20
// advancement ceiling. Only applies when the actor already has some Ranks
// in the Skill; a from-scratch grant ("you gain it at that Rank listed")
// has no such cap.
const SKILL_RANK_GRANT_CAP = 10;

function bakedGrantIds(item) {
  return item.getFlag("carl-rpg", "bakedGrantIds") ?? [];
}

function isEligibleNow(change, actorLevel) {
  if (!BAKEABLE_TARGET_TYPES.has(change.targetType)) return false;
  // Roll-time conditional changes are never a permanent grant - leave them
  // to the normal live-bonus/conditional-modifier path untouched.
  if (Array.isArray(change.conditions) && change.conditions.length) return false;
  if (change.levelGate && Number(change.levelGate) > actorLevel) return false;
  return true;
}

/**
 * Search world compendiums, then the world Items directory, for a
 * Skill/Spell/Damage-Effect by name - the "you gain it at that Rank
 * listed" case, where the actor doesn't already own a matching item.
 * Matched by slugified name (module/helpers/modifiers.mjs's
 * slugifySkillName), the same convention the live aggregation engine uses
 * everywhere else - a raw case/whitespace difference between a grant's
 * authored target and the real item name must not miss the match here.
 * @param {string} name
 * @returns {Promise<Item|null>}
 */
async function findSkillLikeItem(name) {
  const slug = slugifySkillName(name);
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    let index;
    try {
      index = await pack.getIndex({ fields: ["type"] });
    } catch (e) {
      continue;
    }
    const hit = index.find((e) => slugifySkillName(e.name) === slug && SKILL_LIKE_TYPES.includes(e.type));
    if (hit) {
      const doc = await pack.getDocument(hit._id);
      if (doc) return doc;
    }
  }
  const worldHit = game.items?.find((i) => slugifySkillName(i.name) === slug && SKILL_LIKE_TYPES.includes(i.type));
  return worldHit ?? null;
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
  const targetSlug = slugifySkillName(name);
  const existing = actor.items.find((i) => SKILL_LIKE_TYPES.includes(i.type) && slugifySkillName(i.name) === targetSlug);
  if (existing) {
    const current = existing.system.rank ?? 0;
    let next = applyScalarChange(current, change.mode, delta);
    // The Rank-10 grant ceiling ("If you have that Skill, add the bonus, up
    // to 10", p.127) only applies when the actor already has some Ranks in
    // it - a Skill owned at Rank 0 (added but never invested in) is treated
    // as the from-scratch case below, no cap.
    if (current > 0) next = Math.min(next, SKILL_RANK_GRANT_CAP);
    await existing.update({ "system.rank": next });
    return;
  }

  const rank = Math.max(0, delta);
  const found = await findSkillLikeItem(name);
  if (found) {
    const itemData = found.toObject();
    delete itemData._id;
    itemData.system.rank = rank;
    itemData.system.marked = false;
    // isToggled state is spell-only (module/data/spell.mjs) - don't write
    // it onto a copied skill/damageEffect item, which has no such field.
    if (found.type === "spell") itemData.system.active = false;
    await Item.create(itemData, { parent: actor });
  } else {
    await Item.create({
      name,
      type: "skill",
      system: { rank, category: "utility" },
    }, { parent: actor });
  }
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

  // Serialized per-actor (see actorBakeQueues above) so a second grant
  // landing while this one is still mid-bake can't read a stale pre-update
  // stat value.
  return queueForActor(actor.id, () => bakeEligibleGrants(item, actor));
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

  const newlyBaked = [];

  const statUpdates = {};
  for (const change of pending) {
    if (change.targetType !== "stat" || !STAT_KEYS.has(change.target)) continue;
    const path = `system.stats.${change.target}.value`;
    const base = actor.system.stats?.[change.target]?.value ?? 0;
    const current = path in statUpdates ? statUpdates[path] : base;
    statUpdates[path] = applyScalarChange(current, change.mode, Number(change.value) || 0);
    newlyBaked.push(change.id);
  }
  if (Object.keys(statUpdates).length) await actor.update(statUpdates);

  // Skill-rank grants run sequentially (each may create/copy its own item,
  // and a later grant targeting the same Skill needs to see the prior one's
  // update already applied).
  for (const change of pending) {
    if (change.targetType !== "skillRank") continue;
    await bakeSkillRankGrant(actor, change);
    newlyBaked.push(change.id);
  }

  if (newlyBaked.length) {
    await item.setFlag("carl-rpg", "bakedGrantIds", [...baked, ...newlyBaked]);
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
