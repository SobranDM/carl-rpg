/**
 * Timed effects that end on the clock: a condition entry with `expiresAt`
 * (world time, in seconds - module/data/shared/condition-entry.mjs), such
 * as an Iron Skin Potion's 30 minutes. Combat rounds advance world time by
 * CONFIG.time.roundTime (10 seconds, "Each round lasts for 10 seconds",
 * p.62); outside combat it moves when the GM advances it (the GM Toolbox's
 * rests and Mend, or core's own time controls).
 *
 * The active GM sweeps every actor - world actors and the actors of tokens
 * on any scene - whenever world time changes. Each actor's sweep runs
 * through the per-actor queue (module/helpers/actor-queue.mjs) so it never
 * overwrites round-end processing's own write to the same conditions.
 */
import { queueForActor } from "./actor-queue.mjs";
import { removeConditionsById } from "./conditions.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";

/**
 * Ids of the condition entries that have run out by `worldTime`.
 * @param {object[]} conditions
 * @param {number} worldTime
 * @returns {string[]}
 */
export function expiredConditionIds(conditions, worldTime) {
  return (conditions ?? [])
    .filter((c) => c.expiresAt !== null && c.expiresAt !== undefined && c.expiresAt <= worldTime)
    .map((c) => c.id);
}

/**
 * Seconds from now until an effect lasting `duration` `unit`s ends.
 * @param {number} duration
 * @param {"rounds"|"minutes"|"hours"} unit
 * @returns {number}
 */
export function durationSeconds(duration, unit) {
  const n = Math.max(0, Number(duration) || 0);
  if (unit === "rounds") return n * (CONFIG.time.roundTime || 10);
  if (unit === "hours") return n * 3600;
  return n * 60;
}

/**
 * Actors whose timed effects are checked: world actors, plus the unlinked
 * token actors of the viewed scene and of any scene with a running combat.
 * A token elsewhere isn't built just to be checked - its effect ends the
 * next time the clock moves while its scene is in play (expiry compares
 * against the time then, so nothing is lost).
 */
function sweepableActors() {
  const actors = new Map();
  for (const actor of game.actors) actors.set(actor.uuid, actor);
  const scenes = new Set([canvas?.scene, ...game.combats.filter((c) => c.started).map((c) => c.scene)].filter(Boolean));
  for (const scene of scenes) {
    for (const token of scene.tokens) {
      if (!token.actorLink && token.actor) actors.set(token.actor.uuid, token.actor);
    }
  }
  return [...actors.values()];
}

/**
 * Remove every entry that has run out by `worldTime`, without queueing -
 * for a caller already inside the actor's queue (a rest, module/apps/
 * gm-toolbox.mjs).
 * @param {Actor} actor
 * @param {number} worldTime
 * @returns {Promise<string[]>} Labels of what ended.
 */
export async function dropExpiredConditions(actor, worldTime) {
  const current = actor.system?.conditions ?? [];
  const ids = expiredConditionIds(current, worldTime);
  if (!ids.length) return [];
  const ended = current.filter((c) => ids.includes(c.id)).map((c) => c.label || c.source || c.key);
  await removeConditionsById(actor, ids);
  return ended;
}

/**
 * Remove every expired entry from one actor, through its queue.
 * @param {Actor} actor
 * @param {number} worldTime
 * @returns {Promise<string[]>} Labels of what ended.
 */
export function expireConditions(actor, worldTime) {
  return queueForActor(actor.uuid, () => dropExpiredConditions(actor, worldTime));
}

/**
 * Redraw open actor sheets showing a timed entry, so the Conditions tab's
 * "ends in ..." keeps up with the clock (every client).
 */
function refreshTimedSheets() {
  for (const app of foundry.applications.instances?.values?.() ?? []) {
    const doc = app.document;
    if (!app.rendered || !(doc instanceof Actor)) continue;
    if (doc.system?.conditions?.some?.((c) => c.expiresAt !== null && c.expiresAt !== undefined)) app.render();
  }
}

/** Register the active GM's sweep, and every client's sheet refresh (call once, from init). */
export function registerExpirySweep() {
  Hooks.on("updateWorldTime", refreshTimedSheets);
  Hooks.on("updateWorldTime", async (worldTime) => {
    if (!game.users.activeGM?.isSelf) return;
    const lines = [];
    for (const actor of sweepableActors()) {
      if (!actor.system?.conditions?.some?.((c) => c.expiresAt !== null && c.expiresAt !== undefined)) continue;
      try {
        const ended = await expireConditions(actor, worldTime);
        if (ended.length) {
          lines.push(game.i18n.format("CARLRPG.Consumable.Expired", {
            name: esc(actor.name), effects: ended.map(esc).join(", "),
          }));
        }
      } catch (err) {
        console.error(`CarlRPG | Expiring timed effects failed for ${actor.name}`, err);
      }
    }
    if (lines.length) {
      await createCardMessage({
        title: game.i18n.localize("CARLRPG.Consumable.ExpiredTitle"),
        body: `<ul class="carl-round-end-list">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
        whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
      });
    }
  });
}
