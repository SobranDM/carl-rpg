/**
 * Cooldowns (docs/rules-fixes.md B, rulings Q3 and Q4): a Skill's, Spell's
 * or Damage Effect's free-text `cooldown`, read by module/helpers/
 * timer-text.mjs, starts when the item is used:
 *  - "N minutes/hours": on the world clock (a combat round moves it 10
 *    seconds, p.62);
 *  - "Once per round": until the next round of the fight it was used in.
 *    Outside a fight there are no rounds, so nothing is counted;
 *  - "Once per scene": until the fight it was used in ends - or, outside a
 *    fight, until the GM's "New scene" (the GM Toolbox), which ends every
 *    scene cooldown at once by moving a world counter on (`sceneEpoch`);
 *  - text with no time in it ("Once per Floor") isn't tracked.
 *
 * The state is stamped on the item (`flags.carl-rpg.cooldown`) by whoever
 * used it - its owner - and read lazily: whether it still runs is worked
 * out from the clock, the fight and the scene counter whenever it's asked,
 * so nothing has to sweep it away. Using an item that is still cooling
 * down warns and asks (Q3); going ahead puts "Used before cooldown." on its
 * card so the GM can see it. Every use path in module/dice/dice.mjs runs
 * through passCooldown before anything is spent, and startCooldown once it
 * was used.
 */
import { parseTimerText, resolveTimerSeconds, ROUND_SECONDS } from "./timer-text.mjs";
import { showCarlDialog, cancelButton } from "../apps/carl-dialog.mjs";
import { noteUndo } from "./actions.mjs";
import { ownedRank } from "./modifiers.mjs";
import { esc } from "./html.mjs";
import { fightOf } from "./fights.mjs";

const SCOPE = "carl-rpg";
const FLAG_PATH = "flags.carl-rpg.cooldown";
/** The world setting "New scene" moves on. */
export const SCENE_EPOCH_SETTING = "sceneEpoch";

/** The item types that carry a `cooldown` text. */
const COOLDOWN_TYPES = new Set(["skill", "spell", "damageEffect"]);

/** Seconds in a round (CONFIG.time.roundTime, p.62). */
export function roundSeconds() {
  return CONFIG.time?.roundTime || ROUND_SECONDS;
}

/**
 * The Intelligence score ("the full name ... refers to the score", p.57).
 * @param {Actor|null|undefined} actor
 * @returns {number}
 */
export function intelligenceScore(actor) {
  const int = actor?.system?.stats?.int;
  return Number(int?.effective ?? int?.value ?? 0) || 0;
}

/** The current "New scene" counter. */
export function sceneEpoch() {
  return Number(game.settings.get(SCOPE, SCENE_EPOCH_SETTING)) || 0;
}

/**
 * Whether this item's cooldown is tracked: a Skill, Spell or Damage Effect
 * the actor really owns - not a Scroll's stand-in Spell or a made-up Skill
 * for an untrained roll, which aren't saved.
 * @param {Item|null|undefined} item
 * @returns {boolean}
 */
export function tracksCooldown(item) {
  if (!item || !COOLDOWN_TYPES.has(item.type)) return false;
  return item.parent?.items?.get?.(item.id) === item;
}

/**
 * The cooldown that starts if the item is used now, or null if it has
 * none that can be counted. Every key is always set, so a new state
 * written over an old one (a flag update merges) leaves nothing behind.
 * @param {Item} item
 * @param {{now?: number, fight?: Combat|null}} [context]
 * @returns {object|null}
 */
export function cooldownToStart(item, { now = game.time.worldTime, fight = fightOf(item?.actor) } = {}) {
  const text = item?.system?.cooldown ?? "";
  const parsed = parseTimerText(text);
  if (!parsed || parsed.manual) return null;
  const base = { kind: null, endsAt: null, combatId: null, round: null, epoch: null, text };
  if (parsed.perRound) return fight ? { ...base, kind: "round", combatId: fight.id, round: fight.round } : null;
  if (parsed.perScene) return { ...base, kind: "scene", combatId: fight?.id ?? null, epoch: sceneEpoch() };
  const actor = item.actor;
  const seconds = resolveTimerSeconds(parsed, {
    rank: actor ? ownedRank(actor, item) : (item.system.rank ?? 0),
    intelligence: intelligenceScore(actor),
    roundSeconds: roundSeconds(),
  });
  if (!seconds) return null;
  return { ...base, kind: "time", endsAt: now + seconds };
}

/**
 * The item's cooldown, if it is still running.
 * @param {Item|null|undefined} item
 * @returns {object|null}  The stored state, plus `left` (seconds) for a timed one.
 */
export function activeCooldown(item) {
  const state = item ? foundry.utils.getProperty(item, FLAG_PATH) : null;
  if (!state?.kind) return null;
  if (state.kind === "time") {
    const left = Number(state.endsAt) - game.time.worldTime;
    return left > 0 ? { ...state, left } : null;
  }
  if (state.kind === "round") {
    const combat = game.combats.get(state.combatId);
    return combat?.started && combat.round === state.round ? state : null;
  }
  if (state.kind === "scene") {
    if (state.epoch !== sceneEpoch()) return null;
    if (state.combatId && !game.combats.has(state.combatId)) return null;
    return state;
  }
  return null;
}

/**
 * What the cooldown chip says: "Cooldown 4 min", "Until next round", "This scene".
 * @param {object} state  activeCooldown's result.
 * @returns {string}
 */
export function cooldownLabel(state) {
  if (!state) return "";
  if (state.kind === "round") return game.i18n.localize("CARLRPG.Cooldown.Chip.Round");
  if (state.kind === "scene") return game.i18n.localize("CARLRPG.Cooldown.Chip.Scene");
  const left = Math.max(0, Number(state.left) || 0);
  let amount;
  let unit;
  if (left < 60) { amount = Math.ceil(left); unit = "Seconds"; }
  else if (left < 3600) { amount = Math.ceil(left / 60); unit = "Minutes"; }
  else { amount = Math.round(left / 360) / 10; unit = "Hours"; }
  return game.i18n.format(`CARLRPG.Cooldown.Chip.${unit}`, { amount });
}

/**
 * The chip for an item's row (the Skill, Spell and Damage Effect lists, the
 * Hotlist), or "" when it isn't cooling down.
 * @param {Item} item
 * @returns {string}  HTML.
 */
export function cooldownChipHtml(item) {
  const state = activeCooldown(item);
  if (!state) return "";
  const tip = `${game.i18n.localize("CARLRPG.Cooldown.Label")}: ${state.text ?? ""}`;
  return `<span class="carl-cooldown-chip" data-tooltip="${esc(tip)}"><i class="fas fa-hourglass-half"></i> ${esc(cooldownLabel(state))}</span>`;
}

/**
 * Before an item is used: if it's still cooling down, ask whether to use
 * it anyway (Q3). Nothing has been spent yet when this is called, so a
 * "no" spends nothing.
 * @param {Item|null|undefined} item
 * @returns {Promise<{ok: boolean, early: boolean}>}  ok false: refused.
 */
export async function passCooldown(item) {
  if (!tracksCooldown(item)) return { ok: true, early: false };
  const state = activeCooldown(item);
  if (!state) return { ok: true, early: false };
  const name = esc(item.name);
  const ok = await showCarlDialog({
    title: game.i18n.format("CARLRPG.Cooldown.AskTitle", { name: item.name }),
    content: `<div class="carl-dialog-body"><p>${game.i18n.format("CARLRPG.Cooldown.AskBody", { name, left: esc(cooldownLabel(state)) })}</p></div>`,
    classes: ["carl-cooldown-confirm"],
    buttons: [
      { action: "useAnyway", icon: "fa-solid fa-hourglass-end", label: "CARLRPG.Cooldown.UseAnyway", callback: () => true },
      { ...cancelButton(), default: true },
    ],
  });
  return ok ? { ok: true, early: true } : { ok: false, early: false };
}

/**
 * Several items used together (an Attack's Skill and its Damage Effect):
 * asked one at a time, stopping at the first "no".
 * @param {Array<Item|null|undefined>} items
 * @returns {Promise<{ok: boolean, early: boolean}>}
 */
export async function passCooldowns(items) {
  let early = false;
  for (const item of items) {
    const result = await passCooldown(item);
    if (!result.ok) return result;
    early ||= result.early;
  }
  return { ok: true, early };
}

/**
 * The item was used: start its cooldown (a fresh one, even if it was used
 * early). An undone Action puts the old state back (helpers/action-undo.mjs).
 * Only the item's owner writes it - the one who used it.
 * @param {Item|null|undefined} item
 * @returns {Promise<object|null>}  The state started.
 */
export async function startCooldown(item) {
  if (!tracksCooldown(item) || !item.isOwner) return null;
  const state = cooldownToStart(item);
  const prior = foundry.utils.getProperty(item, FLAG_PATH) ?? null;
  if (!state && !prior) return null;
  noteUndo(item.actor, { t: "set", uuid: item.uuid, data: { [FLAG_PATH]: prior } });
  await item.update({ [FLAG_PATH]: state });
  return state;
}

/** The chat card's note for a use the cooldown didn't allow. */
export function earlyUseNote() {
  return `<p class="carl-cooldown-early"><i class="fas fa-hourglass-end"></i> ${esc(game.i18n.localize("CARLRPG.Cooldown.UsedEarly"))}</p>`;
}

/**
 * "New scene" (GM Toolbox): every "Once per scene" cooldown ends, for
 * every actor - world actors and tokens alike - by moving the scene
 * counter on. GM only.
 * @returns {Promise<number>}  The new counter.
 */
export async function startNewScene() {
  if (!game.user.isGM) return sceneEpoch();
  const next = sceneEpoch() + 1;
  await game.settings.set(SCOPE, SCENE_EPOCH_SETTING, next);
  return next;
}

/**
 * What the actor's chips say right now, in one string - a sheet is
 * redrawn when it changes (refreshCooldownSheets).
 * @param {Actor} actor
 * @returns {string}
 */
export function cooldownSignature(actor) {
  const parts = [];
  for (const item of actor?.items ?? []) {
    if (!COOLDOWN_TYPES.has(item.type)) continue;
    const state = activeCooldown(item);
    if (state) parts.push(`${item.id}:${cooldownLabel(state)}`);
  }
  return parts.join("|");
}

/** The sheet parts that show cooldown chips (Skills/Spells lists, the Hotlist). */
const CHIP_PARTS = ["abilities", "skills"];

/**
 * Redraw the chip-carrying parts of open actor sheets whose chips changed
 * since they were drawn (every client): the clock moved, a round turned, a
 * fight ended, or a new scene began. Only sheets that recorded what they
 * drew (CarlRPGActorSheet) are touched.
 */
export function refreshCooldownSheets() {
  for (const app of foundry.applications.instances?.values?.() ?? []) {
    const doc = app.document;
    if (!app.rendered || !(doc instanceof Actor) || app._carlCooldownSig === undefined) continue;
    if (cooldownSignature(doc) === app._carlCooldownSig) continue;
    const parts = CHIP_PARTS.filter((p) => app.parts?.[p]);
    if (parts.length) app.render({ parts });
  }
}

/** Register the setting, the chip helper and the redraw hooks (call once, from init). */
export function registerCooldowns() {
  game.settings.register(SCOPE, SCENE_EPOCH_SETTING, {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
    onChange: () => refreshCooldownSheets(),
  });
  Handlebars.registerHelper("cooldownChip", (item) => new Handlebars.SafeString(item ? cooldownChipHtml(item) : ""));
  Hooks.on("updateWorldTime", () => refreshCooldownSheets());
  Hooks.on("updateCombat", (combat, changed) => {
    if (foundry.utils.hasProperty(changed, "round")) refreshCooldownSheets();
  });
  Hooks.on("deleteCombat", () => refreshCooldownSheets());
}
