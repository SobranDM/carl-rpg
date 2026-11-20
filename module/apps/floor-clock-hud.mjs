import { currentFloor } from "../helpers/floor.mjs";
import {
  checkCollapseWarning,
  clockStage,
  floorClock,
  formatTimeLeft,
  hoursLeft,
} from "../helpers/floor-clock.mjs";

/**
 * The floor-collapse bar (helpers/floor-clock.mjs; ruled 2026-11-19): on
 * every user's screen, always - the crawlers' HUD "always provides you
 * with a countdown timer". "Floor 3 · 4d 12h 30m to collapse" (30-hour
 * days); the Floor alone with no timer running. Amber in its last 30 hours,
 * red in its last 24, "Floor collapsed" at zero.
 *
 * It sits just above the hotbar; each user can drag it elsewhere (kept in
 * their own client setting) and double-click it to put it back.
 */
const ID = "carl-floor-clock";

export default class FloorClockHud {
  /** The bar's element. @type {HTMLElement|null} */
  static #el = null;

  /** Whether the 24-hour notice has been announced, as this client last saw. */
  static #warned = false;

  /** Put the bar on the screen and keep it current. Call from `ready`. */
  static init() {
    if (document.getElementById(ID)) return;
    const el = document.createElement("div");
    el.id = ID;
    el.className = "carl-rpg carl-floor-clock";
    el.dataset.tooltipText = game.i18n.localize("CARLRPG.FloorClock.Hint");
    document.body.append(el);
    FloorClockHud.#el = el;
    FloorClockHud.#warned = floorClock().warned;
    FloorClockHud.#wireDrag(el);
    FloorClockHud.refresh();
    FloorClockHud.place();

    // The clock moving, the Floor changing.
    Hooks.on("updateWorldTime", () => {
      FloorClockHud.refresh();
      checkCollapseWarning();
    });
    Hooks.on("updateSetting", (setting) => {
      if (setting.key === "carl-rpg.currentFloor") FloorClockHud.refresh();
    });
    window.addEventListener("resize", () => FloorClockHud.place());
  }

  /**
   * The timer changed (its setting's onChange, every client): redraw, and
   * announce the 24-hour notice the first time it's set.
   * @param {object} clock
   */
  static onClockChange(clock) {
    if (clock?.warned && !FloorClockHud.#warned) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.FloorClock.Warning"), {
        permanent: true,
      });
    }
    FloorClockHud.#warned = !!clock?.warned;
    FloorClockHud.refresh();
  }

  /** Redraw the bar's text and colour. */
  static refresh() {
    const el = FloorClockHud.#el;
    if (!el) return;
    const hours = hoursLeft();
    const stage = clockStage(hours);
    const floor = game.i18n.format("CARLRPG.FloorClock.Floor", { floor: currentFloor() });
    let time = "";
    if (stage === "collapsed") time = game.i18n.localize("CARLRPG.FloorClock.Collapsed");
    else if (stage !== "none") {
      time = game.i18n.format("CARLRPG.FloorClock.Left", { time: formatTimeLeft(hours) });
    }
    el.dataset.stage = stage;
    el.innerHTML = `<i class="fas fa-hourglass-half"></i> <span class="carl-floor-clock-floor"></span>${
      time
        ? ` <span class="carl-floor-clock-sep">·</span> <span class="carl-floor-clock-time"></span>`
        : ""
    }`;
    el.querySelector(".carl-floor-clock-floor").textContent = floor;
    if (time) el.querySelector(".carl-floor-clock-time").textContent = time;
  }

  /**
   * Where the bar goes: where this user dragged it, else centred just above
   * the hotbar (or near the bottom, with no hotbar).
   */
  static place() {
    const el = FloorClockHud.#el;
    if (!el) return;
    const saved = game.settings.get("carl-rpg", "floorClockPosition") ?? {};
    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      FloorClockHud.#moveTo(saved.left, saved.top);
      return;
    }
    const bar = el.getBoundingClientRect();
    const hotbar = document.getElementById("hotbar")?.getBoundingClientRect();
    const top = hotbar?.height ? hotbar.top - bar.height - 6 : window.innerHeight - bar.height - 90;
    const centre = hotbar?.width ? hotbar.left + hotbar.width / 2 : window.innerWidth / 2;
    FloorClockHud.#moveTo(centre - bar.width / 2, top);
  }

  /** Put the bar here, kept on screen. */
  static #moveTo(left, top) {
    const el = FloorClockHud.#el;
    const bar = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, left), window.innerWidth - bar.width);
    const y = Math.min(Math.max(0, top), window.innerHeight - bar.height);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  /** Drag to move (this user's own place for it); double-click to put it back. */
  static #wireDrag(el) {
    let start = null;
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = el.getBoundingClientRect();
      start = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      el.setPointerCapture(event.pointerId);
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (event) => {
      if (start) FloorClockHud.#moveTo(event.clientX - start.dx, event.clientY - start.dy);
    });
    el.addEventListener("pointerup", async (event) => {
      if (!start) return;
      start = null;
      el.releasePointerCapture(event.pointerId);
      el.classList.remove("dragging");
      const rect = el.getBoundingClientRect();
      await game.settings.set("carl-rpg", "floorClockPosition", {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      });
    });
    el.addEventListener("dblclick", async () => {
      await game.settings.set("carl-rpg", "floorClockPosition", {});
      FloorClockHud.place();
    });
  }
}
