import { currentFloor } from "../helpers/floor.mjs";
import {
  checkCollapseWarning,
  clockStage,
  floorClock,
  floorClocks,
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

  /**
   * Each floor's 24-hour notice, as this client last saw it - so going back
   * to a floor that was already warned doesn't warn again.
   * @type {Record<string, boolean>}
   */
  static #warned = {};

  /** Put the bar on the screen and keep it current. Call from `ready`. */
  static init() {
    if (document.getElementById(ID)) return;
    const el = document.createElement("div");
    el.id = ID;
    el.className = "carl-rpg carl-floor-clock";
    el.dataset.tooltipText = game.i18n.localize("CARLRPG.FloorClock.Hint");
    document.body.append(el);
    FloorClockHud.#el = el;
    FloorClockHud.#warned = FloorClockHud.#warnedByFloor();
    FloorClockHud.#wireDrag(el);
    FloorClockHud.refresh();
    FloorClockHud.place();

    // The clock moving (the Floor changing: the currentFloor setting's
    // onChange calls refresh).
    Hooks.on("updateWorldTime", () => {
      FloorClockHud.refresh();
      checkCollapseWarning();
    });
    // The hotbar moving (it re-renders; the sidebar opening or closing) or
    // the window resizing: back above it, unless the user placed it.
    Hooks.on("renderHotbar", () => FloorClockHud.place());
    Hooks.on("collapseSidebar", () => FloorClockHud.place());
    window.addEventListener("resize", () => FloorClockHud.place());
  }

  /**
   * A timer changed (its setting's onChange, every client): redraw, and
   * announce the current floor's 24-hour notice the first time it's set.
   */
  static onClockChange() {
    const clock = floorClock();
    if (clock.warned && !FloorClockHud.#warned[currentFloor()]) {
      const collapsed = clockStage(hoursLeft(clock)) === "collapsed";
      ui.notifications.warn(
        game.i18n.localize(
          collapsed ? "CARLRPG.FloorClock.CollapsedNotice" : "CARLRPG.FloorClock.Warning",
        ),
        { permanent: true },
      );
    }
    FloorClockHud.#warned = FloorClockHud.#warnedByFloor();
    FloorClockHud.refresh();
  }

  /** Which floors' 24-hour notices have gone out. */
  static #warnedByFloor() {
    return Object.fromEntries(
      Object.entries(floorClocks()).map(([floor, clock]) => [floor, !!clock.warned]),
    );
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
    if (Number.isFinite(saved.centre) && Number.isFinite(saved.top)) {
      FloorClockHud.#moveTo(saved.centre, saved.top);
      return;
    }
    const bar = el.getBoundingClientRect();
    const hotbar = document.getElementById("hotbar")?.getBoundingClientRect();
    const top = hotbar?.height ? hotbar.top - bar.height - 6 : window.innerHeight - bar.height - 90;
    const centre = hotbar?.width ? hotbar.left + hotbar.width / 2 : window.innerWidth / 2;
    FloorClockHud.#moveTo(centre, top);
  }

  /**
   * Put the bar's centre here (it's anchored by its centre, so when the
   * countdown appears or changes length it grows both ways), kept on screen.
   */
  static #moveTo(centre, top) {
    const el = FloorClockHud.#el;
    const bar = el.getBoundingClientRect();
    const half = bar.width / 2;
    const x = Math.min(Math.max(half, centre), window.innerWidth - half);
    const y = Math.min(Math.max(0, top), window.innerHeight - bar.height);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  /** Drag to move (this user's own place for it); double-click to put it back. */
  static #wireDrag(el) {
    let start = null;
    const centreOf = () => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top };
    };
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const at = centreOf();
      start = {
        dx: event.clientX - at.x,
        dy: event.clientY - at.y,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      el.setPointerCapture(event.pointerId);
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (event) => {
      if (!start) return;
      // A few pixels' wobble in a click isn't a drag.
      if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
      start.moved = true;
      FloorClockHud.#moveTo(event.clientX - start.dx, event.clientY - start.dy);
    });
    el.addEventListener("pointerup", async (event) => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      el.releasePointerCapture(event.pointerId);
      el.classList.remove("dragging");
      if (!moved) return;
      const at = centreOf();
      await game.settings.set("carl-rpg", "floorClockPosition", {
        centre: Math.round(at.x),
        top: Math.round(at.y),
      });
    });
    el.addEventListener("dblclick", async () => {
      await game.settings.set("carl-rpg", "floorClockPosition", {});
      FloorClockHud.place();
    });
  }
}
