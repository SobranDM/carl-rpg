import {
  adjustCollapseTimer,
  clearCollapseTimer,
  clockStage,
  defaultCollapseHours,
  floorClock,
  formatTimeLeft,
  hoursLeft,
  setCollapseTimer,
} from "../../helpers/floor-clock.mjs";
import { collapseDays, currentFloor } from "../../helpers/floor.mjs";
import { useQuenchTimeout, waitFor } from "../helpers.mjs";

/**
 * The floor-collapse timer (0.8.0, ruled 2026-11-19; Time, pp.62-63): the
 * time left follows Foundry's clock, in 30-hour days; the GM sets, adjusts
 * and stops it; everyone's bar shows it. Leaves the world's own timer as
 * it found it.
 */
export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.floor-clock",
    (context) => {
      const { describe, it, assert, before, after } = context;

      describe("Reading the clock", function () {
        it("30-hour days, then hours and minutes", function () {
          assert.equal(formatTimeLeft(4 * 30 + 15.5), "4d 15h 30m");
          assert.equal(formatTimeLeft(12 + 5 / 60), "12h 05m");
          assert.equal(formatTimeLeft(30), "1d 0h 00m", "a whole dungeon day");
          assert.equal(formatTimeLeft(-3), "0h 00m");
        });

        it("its stages: running, the last 30 hours, the last 24, collapsed", function () {
          assert.equal(clockStage(null), "none");
          assert.equal(clockStage(31), "running");
          assert.equal(clockStage(30), "lastDay");
          assert.equal(clockStage(24), "final");
          assert.equal(clockStage(0), "collapsed");
        });

        it("each floor's default length (p.63 and the Atlas)", function () {
          assert.deepEqual(
            [1, 2, 3, 4, 5, 6].map((f) => collapseDays(f)),
            [5, 6, 8, 10, 15, null],
          );
          assert.equal(defaultCollapseHours(3), 240, "the Third Floor: 8 days of 30 hours");
          assert.isNull(defaultCollapseHours(6), "the GM sets it from the Sixth Floor on");
        });
      });

      describe("The GM's timer", function () {
        useQuenchTimeout(this);
        let saved;
        let warn;
        before(function () {
          saved = game.settings.get("carl-rpg", "floorClock");
          // The 24-hour notice is permanent: not one per test run.
          warn = ui.notifications.warn;
          ui.notifications.warn = () => null;
        });
        after(async function () {
          await game.settings.set("carl-rpg", "floorClock", saved);
          ui.notifications.warn = warn;
        });

        it("set, adjusted, warned at 24 hours, and stopped", async function () {
          await setCollapseTimer(50);
          assert.closeTo(hoursLeft(), 50, 0.01);
          assert.isFalse(floorClock().warned);

          await adjustCollapseTimer(-30);
          assert.closeTo(hoursLeft(), 20, 0.01);
          assert.isTrue(floorClock().warned, "24 hours or less: announced once");

          await adjustCollapseTimer(10);
          assert.closeTo(hoursLeft(), 30, 0.01);
          assert.isFalse(floorClock().warned, "moved back past 24 hours: it can warn again");

          await clearCollapseTimer();
          assert.isNull(hoursLeft());
        });

        it("everyone's bar: the Floor, and the time left once a timer runs", async function () {
          const bar = document.getElementById("carl-floor-clock");
          assert.exists(bar, "on the screen");
          await clearCollapseTimer();
          await waitFor(() => bar.dataset.stage === "none");
          assert.include(bar.textContent, String(currentFloor()));
          assert.notInclude(
            bar.textContent,
            game.i18n.format("CARLRPG.FloorClock.Left", { time: "" }).trim(),
            "no countdown without a timer",
          );

          await setCollapseTimer(4 * 30 + 6);
          await waitFor(() => bar.dataset.stage === "running");
          assert.include(bar.textContent, "4d 6h 00m");

          await setCollapseTimer(20);
          await waitFor(() => bar.dataset.stage === "final");
          assert.isNull(bar.getAttribute("title"));
          assert.exists(bar.dataset.tooltipText, "a Foundry tooltip");
        });
      });
    },
    { displayName: "CarlRPG: the floor-collapse timer" },
  );
}
