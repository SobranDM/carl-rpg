/**
 * Timed toggled Spells (docs/rules-fixes.md B): a toggled Spell (Shield,
 * Oakhide, Bang Bro - module/data/spell.mjs) switches itself off when its
 * `duration` text runs out (module/helpers/timer-text.mjs).
 *  - Worked out when it's switched on: "per Rank" at the Rank it's cast
 *    at, "seconds equal to your Intelligence" from the Intelligence score.
 *  - Seconds, minutes, hours and rounds all count on the world clock - a
 *    combat round moves it 10 seconds (p.62), so "2 rounds" is 20 seconds
 *    in a fight or out of one.
 *  - "Until the end of the combat or N minutes": whichever comes first -
 *    the clock, or the end of the fight it was cast in.
 *  - Text that isn't a time ("Until you enter a saferoom...") sets no
 *    timer; ", or until the caster chooses to end the effect" keeps the
 *    time as the upper bound (switching it off by hand always works).
 *
 * The timer is stamped on the Spell beside `system.active`
 * (`flags.carl-rpg.spellTimer`: {endsAt, combatId, text}) in the same
 * update that switches it on, and cleared when it goes off. The active GM
 * switches it off: in the world-time sweep (module/helpers/expiry.mjs) and
 * when a fight ends (module/helpers/round-end.mjs processCombatEnd).
 */
import { parseTimerText, resolveTimerSeconds } from "./timer-text.mjs";
import { fightOf, intelligenceScore, roundSeconds } from "./cooldowns.mjs";
import { ownedRank } from "./modifiers.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { esc } from "../chat/chat-card.mjs";

export const SPELL_TIMER_PATH = "flags.carl-rpg.spellTimer";

/**
 * The timer a toggled Spell gets when switched on now, or null if its
 * duration isn't a time.
 * @param {Actor} actor  The caster.
 * @param {Item} spell
 * @param {{now?: number, fight?: Combat|null}} [context]
 * @returns {{endsAt: number|null, combatId: string|null, text: string}|null}
 */
export function spellTimerFor(actor, spell, { now = game.time.worldTime, fight = fightOf(actor) } = {}) {
  const text = spell?.system?.duration ?? "";
  const parsed = parseTimerText(text);
  if (!parsed || parsed.manual) return null;
  const seconds = resolveTimerSeconds(parsed, {
    rank: actor ? ownedRank(actor, spell) : (spell.system.rank ?? 0),
    intelligence: intelligenceScore(actor),
    roundSeconds: roundSeconds(),
  });
  const combatId = parsed.untilCombatEnd && fight ? fight.id : null;
  if (seconds === null && !combatId) return null;
  return { endsAt: seconds === null ? null : now + seconds, combatId, text };
}

/** @param {Item} spell @returns {object|null} */
export function spellTimerOf(spell) {
  return foundry.utils.getProperty(spell, SPELL_TIMER_PATH) ?? null;
}

/**
 * An actor's switched-on Spells whose timers have run out by `worldTime`.
 * @param {Actor} actor
 * @param {number} worldTime
 * @returns {Item[]}
 */
export function spellsEndingBy(actor, worldTime) {
  return (actor?.items ?? []).filter((i) => {
    if (i.type !== "spell" || !i.system.active) return false;
    const endsAt = spellTimerOf(i)?.endsAt;
    return typeof endsAt === "number" && endsAt <= worldTime;
  });
}

/**
 * An actor's switched-on Spells that end with this fight.
 * @param {Actor} actor
 * @param {string} combatId
 * @returns {Item[]}
 */
export function spellsEndingWithCombat(actor, combatId) {
  return (actor?.items ?? []).filter((i) => i.type === "spell" && i.system.active && spellTimerOf(i)?.combatId === combatId);
}

/** Whether any of the actor's switched-on Spells has a timer (the sweep skips the rest). */
export function hasSpellTimers(actor) {
  return (actor?.items ?? []).some((i) => i.type === "spell" && i.system.active && spellTimerOf(i));
}

/**
 * Switch Spells off and clear their timers, through the actor's queue.
 * Not a cast: no Mana, no Action, no card of the caster's own.
 * @param {Actor} actor
 * @param {(actor: Actor) => Item[]} pick  Which Spells, worked out inside the queue.
 * @returns {Promise<string[]>}  Their names.
 */
function switchOff(actor, pick) {
  return queueForActor(actor.uuid, async () => {
    const spells = pick(actor);
    if (!spells.length) return [];
    await actor.updateEmbeddedDocuments("Item", spells.map((s) => ({
      _id: s.id, "system.active": false, [SPELL_TIMER_PATH]: null,
    })));
    return spells.map((s) => s.name);
  });
}

/**
 * Switch off the actor's Spells whose time is up (the GM's sweep).
 * @param {Actor} actor
 * @param {number} worldTime
 * @returns {Promise<string[]>}  Their names.
 */
export function expireSpellTimers(actor, worldTime) {
  return switchOff(actor, (a) => spellsEndingBy(a, worldTime));
}

/**
 * Switch off the actor's Spells that last "until the end of the combat".
 * @param {Actor} actor
 * @param {string} combatId
 * @returns {Promise<string[]>}  Their names.
 */
export function endCombatSpellTimers(actor, combatId) {
  return switchOff(actor, (a) => spellsEndingWithCombat(a, combatId));
}

/**
 * The chat lines for Spells that ended.
 * @param {Actor} actor
 * @param {string[]} names
 * @returns {string[]}  Trusted HTML.
 */
export function spellEndedLines(actor, names) {
  return names.map((spell) => game.i18n.format("CARLRPG.Toggle.Ended", { name: esc(actor.name), spell: esc(spell) }));
}
