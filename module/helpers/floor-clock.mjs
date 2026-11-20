import { collapseDays, currentFloor } from "./floor.mjs";

/**
 * The floor-collapse timer (Time, pp.62-63; ruled 2026-11-19): "At the start
 * of every floor, the System AI sets the amount of time before the floor
 * collapses... and every crawler has access to the timer." A dungeon day is
 * 30 hours.
 *
 * It's one world setting - the in-world moment the floor collapses (`endsAt`,
 * Foundry's game time in seconds) - so the time left follows Foundry's clock
 * for free: a rest, Grind, the 2-hour tick and combat rounds all move it. The
 * GM starts it (End Floor, or the GM Toolbox's Collapse Timer) and can add
 * or take away time ("have time either fly or stagnate", p.63). Shown to
 * everyone by apps/floor-clock-hud.mjs.
 *
 * Its last day is marked from 30 hours left; at 24 hours everyone gets a
 * notice once (the System's warning before a collapse): the GM's client sets `warned`,
 * and each client announces the change.
 */

const SCOPE = "carl-rpg";
const SETTING = "floorClock";
/** Hours in a dungeon day (p.63). */
export const DAY_HOURS = 30;
const NONE = { endsAt: null, warned: false };

/**
 * Register the timer's settings (init).
 * @param {(clock: object) => void} onChange  Every client, when it changes.
 */
export function registerFloorClockSettings(onChange) {
  game.settings.register(SCOPE, SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: NONE,
    onChange,
  });
  // Where this player put the bar (dragged); empty: above the hotbar.
  game.settings.register(SCOPE, "floorClockPosition", {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
}

/** The timer now: {endsAt, warned}. */
export function floorClock() {
  return { ...NONE, ...(game.settings.get(SCOPE, SETTING) ?? {}) };
}

/**
 * Hours until the floor collapses (negative once it has), or null with no
 * timer running.
 * @param {object} [clock]
 * @param {number} [now]  Game time, in seconds.
 * @returns {number|null}
 */
export function hoursLeft(clock = floorClock(), now = game.time.worldTime) {
  if (clock.endsAt === null || clock.endsAt === undefined) return null;
  return (Number(clock.endsAt) - now) / 3600;
}

/**
 * Time left as the bar shows it, in 30-hour days: "4d 12h 30m", "12h 05m".
 * @param {number} hours
 * @returns {string}
 */
export function formatTimeLeft(hours) {
  // From whole seconds: 7380s / 3600 * 60 comes out at 122.999...
  const minutes = Math.max(0, Math.floor(Math.round(hours * 3600) / 60));
  const days = Math.floor(minutes / (DAY_HOURS * 60));
  const h = Math.floor((minutes % (DAY_HOURS * 60)) / 60);
  const m = String(minutes % 60).padStart(2, "0");
  return days ? `${days}d ${h}h ${m}m` : `${h}h ${m}m`;
}

/**
 * Where the countdown stands: running; its last day (30 hours or less: the
 * book's "30 hours or less to Floor Collapse"); its last 24 hours; collapsed.
 * @param {number|null} hours
 * @returns {"none"|"running"|"lastDay"|"final"|"collapsed"}
 */
export function clockStage(hours) {
  if (hours === null) return "none";
  if (hours <= 0) return "collapsed";
  if (hours <= 24) return "final";
  if (hours <= DAY_HOURS) return "lastDay";
  return "running";
}

/**
 * Set the time left (GM): a running timer is moved by the difference - so
 * its minutes and its 24-hour notice survive a Set that changes nothing -
 * and with none running, one starts.
 * @param {number} hours
 * @returns {Promise<void>}
 */
export async function setTimeLeft(hours) {
  const left = hoursLeft();
  if (left === null) return setCollapseTimer(hours);
  // The dialog shows whole hours: an unchanged Set keeps the minutes.
  const shown = Math.floor(Math.max(0, left));
  const target = Math.max(0, Number(hours) || 0);
  if (target === shown) return;
  return adjustCollapseTimer(target - left);
}

/**
 * Start (or reset) the timer: this many hours from now (GM).
 * @param {number} hours
 * @returns {Promise<void>}
 */
export async function setCollapseTimer(hours) {
  if (!game.user.isGM) return;
  const endsAt = game.time.worldTime + Math.max(0, Number(hours) || 0) * 3600;
  await game.settings.set(SCOPE, SETTING, { endsAt, warned: false });
  await checkCollapseWarning();
}

/**
 * Add (or, negative, take away) time from the running timer (GM).
 * @param {number} hours
 * @returns {Promise<void>}
 */
export async function adjustCollapseTimer(hours) {
  const clock = floorClock();
  if (!game.user.isGM || clock.endsAt === null) return;
  const endsAt = Number(clock.endsAt) + (Number(hours) || 0) * 3600;
  // Moved back past 24 hours: it can warn again.
  const warned = clock.warned && hoursLeft({ endsAt }) <= 24;
  await game.settings.set(SCOPE, SETTING, { endsAt, warned });
  await checkCollapseWarning();
}

/**
 * No timer (GM): the bar shows only the Floor.
 * @returns {Promise<void>}
 */
export async function clearCollapseTimer() {
  if (game.user.isGM) await game.settings.set(SCOPE, SETTING, NONE);
}

/**
 * Twenty-four hours or less left, not yet announced: mark it (the active
 * GM's client), and every client announces it.
 * @returns {Promise<boolean>}  Whether it was marked now.
 */
export async function checkCollapseWarning() {
  if (!game.users.activeGM?.isSelf) return false;
  const clock = floorClock();
  const hours = hoursLeft(clock);
  // Also when the clock jumps straight past zero (a long rest): everyone
  // still hears it - the notice then says the floor has collapsed.
  if (hours === null || clock.warned || hours > 24) return false;
  await game.settings.set(SCOPE, SETTING, { ...clock, warned: true });
  return true;
}

/**
 * A floor's default length in hours (floor.mjs collapseDays), or null.
 * @param {number} [floor]
 * @returns {number|null}
 */
export function defaultCollapseHours(floor = currentFloor()) {
  const days = collapseDays(floor);
  return days ? days * DAY_HOURS : null;
}
