/**
 * The floating GM Toolbox: a persistent, draggable ApplicationV2 window
 * with buttons for the things the design plan calls out as GM judgment
 * calls that should never auto-resolve - Skill Advancement rolls, Level-ups,
 * Floor progress, Rests, Grinding, and Loot.
 *
 * Real-world vs. in-world time, explicitly split per the project's
 * instruction not to automate the "every 2 hours of play" rule:
 *  - The Play Timer tracks actual wall-clock time (Date.now()) via a
 *    world-scope setting and a client-side interval on the GM's machine.
 *    It only notifies/shines once 2 hours have passed - it never rolls
 *    Advancement Checks or grants Levels on its own.
 *  - Rest buttons advance Foundry's own in-world clock (game.time.
 *    advanceTime), which is unrelated to wall-clock time and only moves
 *    when a GM clicks a button.
 */
import CarlDice from "../dice/dice.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";
import { showCarlDialog, rollButton, cancelButton } from "./carl-dialog.mjs";
import { shortRestUpdates } from "../helpers/rest.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ApplicationV2 } = foundry.applications.api;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const REST_CONFIG = {
  short: { seconds: 2 * 3600, titleKey: "CARLRPG.Toolbox.Rest.ShortTitle" },
  long: { seconds: 8 * 3600, titleKey: "CARLRPG.Toolbox.Rest.LongTitle" },
  fullDay: { seconds: 30 * 3600, titleKey: "CARLRPG.Toolbox.Rest.FullDayTitle" },
};

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default class CarlToolbox extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "carl-toolbox",
    classes: ["carl-rpg", "carl-toolbox"],
    tag: "aside",
    window: {
      title: "CARLRPG.Toolbox.Title",
      icon: "fas fa-dice-d20",
      minimizable: true,
      resizable: false,
    },
    // Pinned near the left edge below the scene navigation bar, out of the
    // way of the canvas - not centered (Foundry centers any window lacking
    // explicit left/top).
    position: { width: 280, height: "auto", left: 20, top: 100 },
    actions: {
      toggleTimer: CarlToolbox.#onToggleTimer,
      resolveTwoHourTick: CarlToolbox.#onResolveTwoHourTick,
      partyLevelUp: CarlToolbox.#onPartyLevelUp,
      floorIncrement: CarlToolbox.#onFloorIncrement,
      floorDecrement: CarlToolbox.#onFloorDecrement,
      newFloor: CarlToolbox.#onNewFloor,
      shortRest: CarlToolbox.#onShortRest,
      longRest: CarlToolbox.#onLongRest,
      fullDayRest: CarlToolbox.#onFullDayRest,
      grind: CarlToolbox.#onGrind,
      rollLoot: CarlToolbox.#onRollLoot,
    },
  };

  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/gm-toolbox.hbs" },
  };

  #interval = null;

  /** @override */
  async _prepareContext(options) {
    const timer = game.settings.get("carl-rpg", "gameTimer");
    const elapsedMs = timer.running ? Math.max(0, Date.now() - timer.startedAt) : 0;
    return {
      timerRunning: timer.running,
      elapsedLabel: formatElapsed(elapsedMs),
      thresholdReached: timer.running && elapsedMs >= TWO_HOURS_MS,
      floor: game.settings.get("carl-rpg", "currentFloor"),
    };
  }

  /**
   * Defense-in-depth GM gate. `game.carlrpg.CarlToolbox` (the raw class) is
   * exposed to every connected client so `game.carlrpg.toolbox` can be typed
   * from macros/console, but that also means a non-GM could otherwise do
   * `new game.carlrpg.CarlToolbox().render({force:true})` and open it
   * directly, bypassing both the `ready`-hook's `if (game.user.isGM)` guard
   * around auto-instantiation and the scene-control button's own
   * `if (!game.user.isGM) return;` (module/carl-rpg.mjs) - neither of which
   * touches this class itself. `_canRender` runs on every render attempt
   * (not just the first), so this refuses the window outright for anyone
   * but the GM, regardless of how/why render() was called.
   * @override
   */
  _canRender(options) {
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.GMOnly"));
      return false;
    }
    return super._canRender(options);
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#startTicking();
  }

  /** @override */
  async _onClose(options) {
    await super._onClose(options);
    this.#stopTicking();
  }

  #startTicking() {
    this.#stopTicking();
    this.#interval = setInterval(() => this.#tick(), 1000);
    this.#tick();
  }

  #stopTicking() {
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = null;
  }

  /**
   * Client-side wall-clock poll (see class docstring). Updates the live
   * display directly via the DOM rather than a full re-render, and once the
   * 2-hour threshold is crossed, pulses the relevant buttons and posts a
   * one-time GM-whispered notice - never rolls or grants anything itself.
   */
  async #tick() {
    if (!this.element) return;
    const timer = game.settings.get("carl-rpg", "gameTimer");
    const elapsedMs = timer.running ? Math.max(0, Date.now() - timer.startedAt) : 0;
    const elapsedEl = this.element.querySelector('[data-el="elapsed"]');
    if (elapsedEl) elapsedEl.textContent = formatElapsed(elapsedMs);

    const reached = timer.running && elapsedMs >= TWO_HOURS_MS;
    for (const el of this.element.querySelectorAll('[data-pulse-target]')) {
      el.classList.toggle("pulse", reached);
    }

    if (reached && !timer.notified) {
      await game.settings.set("carl-rpg", "gameTimer", { ...timer, notified: true });
      await createCardMessage({
        title: game.i18n.localize("CARLRPG.Toolbox.TwoHourReachedTitle"),
        body: `<p>${game.i18n.localize("CARLRPG.Toolbox.TwoHourReachedBody")}</p>`,
        whisper: ChatMessage.getWhisperRecipients("GM"),
      });
    }
  }

  static async #onToggleTimer(event, target) {
    if (!game.user.isGM) return;
    const timer = game.settings.get("carl-rpg", "gameTimer");
    if (timer.running) {
      await game.settings.set("carl-rpg", "gameTimer", { running: false, startedAt: null, notified: false });
    } else {
      await game.settings.set("carl-rpg", "gameTimer", { running: true, startedAt: Date.now(), notified: false });
    }
    this.render();
  }

  /**
   * Bulk-resolve Skill Advancement Checks for every marked Skill/Spell/
   * Damage Effect on every party character, then reset the wall-clock
   * timer. The GM chooses the rank scope explicitly - this never happens
   * without a click.
   */
  static async #onResolveTwoHourTick(event, target) {
    if (!game.user.isGM) return;
    const rankFilter = await CarlToolbox.#promptRankFilter();
    if (!rankFilter) return;

    const actors = game.actors.filter((a) => a.type === "character");
    const digest = [];
    for (const actor of actors) {
      const results = await actor.rollMarkedAdvancementChecks({ rankFilter });
      for (const r of results) {
        digest.push(`${actor.name} - ${r.item.name}: ${r.success ? `Rank ${r.newRank}` : game.i18n.localize("CARLRPG.Toolbox.NoChange")}`);
      }
    }

    await createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.TwoHourResultsTitle"),
      body: digest.length
        ? `<ul>${digest.map((d) => `<li>${d}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.NoMarkedSkills")}</p>`,
    });

    await game.settings.set("carl-rpg", "gameTimer", { running: false, startedAt: null, notified: false });
    this.render();
  }

  static async #promptRankFilter() {
    return showCarlDialog({
      title: game.i18n.localize("CARLRPG.Toolbox.ResolveTwoHourTitle"),
      content: `<p>${game.i18n.localize("CARLRPG.Toolbox.ResolveTwoHourPrompt")}</p>`,
      buttons: [
        { action: "lte4", icon: "fas fa-check", label: "CARLRPG.Toolbox.RankLte4Only", default: true, callback: () => "lte4" },
        { action: "all", icon: "fas fa-list", label: "CARLRPG.Toolbox.AllMarkedSkills", callback: () => "all" },
        cancelButton(),
      ],
    });
  }

  /** Flat, no-roll +1 Level to every party character (the other half of the 2-hour rule). */
  static async #onPartyLevelUp(event, target) {
    if (!game.user.isGM) return;
    const actors = game.actors.filter((a) => a.type === "character");
    for (const actor of actors) {
      const lvl = actor.system.attributes.level.value;
      await actor.update({ "system.attributes.level.value": Math.min(lvl + 1, 250) });
    }
    await createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.PartyLevelUpTitle"),
      body: `<p>${game.i18n.format("CARLRPG.Toolbox.PartyLevelUpBody", { count: actors.length })}</p>`,
    });
  }

  static async #onFloorIncrement(event, target) {
    if (!game.user.isGM) return;
    const floor = game.settings.get("carl-rpg", "currentFloor");
    await game.settings.set("carl-rpg", "currentFloor", floor + 1);
    this.render();
  }

  static async #onFloorDecrement(event, target) {
    if (!game.user.isGM) return;
    const floor = game.settings.get("carl-rpg", "currentFloor");
    await game.settings.set("carl-rpg", "currentFloor", Math.max(0, floor - 1));
    this.render();
  }

  /** Per-floor Advancement cadence: Rank >=5 marked Skills only, then advance the floor counter. */
  static async #onNewFloor(event, target) {
    if (!game.user.isGM) return;
    const actors = game.actors.filter((a) => a.type === "character");
    const digest = [];
    for (const actor of actors) {
      const results = await actor.rollMarkedAdvancementChecks({ rankFilter: "gte5" });
      for (const r of results) {
        digest.push(`${actor.name} - ${r.item.name}: ${r.success ? `Rank ${r.newRank}` : game.i18n.localize("CARLRPG.Toolbox.NoChange")}`);
      }
    }
    const floor = game.settings.get("carl-rpg", "currentFloor");
    await game.settings.set("carl-rpg", "currentFloor", floor + 1);
    await createCardMessage({
      title: game.i18n.format("CARLRPG.Toolbox.NewFloorTitle", { floor: floor + 1 }),
      body: digest.length
        ? `<ul>${digest.map((d) => `<li>${d}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.NoMarkedSkills")}</p>`,
    });
    this.render();
  }

  static async #onShortRest(event, target) {
    if (!game.user.isGM) return;
    return CarlToolbox.#onRest("short");
  }

  static async #onLongRest(event, target) {
    if (!game.user.isGM) return;
    return CarlToolbox.#onRest("long");
  }

  static async #onFullDayRest(event, target) {
    if (!game.user.isGM) return;
    return CarlToolbox.#onRest("fullDay");
  }

  /**
   * In-world Rest: shows a picker of Character actors (see
   * #promptRestActors for the Character-only scoping rationale), then
   * advances Foundry's own game.time (unrelated to the wall-clock Play
   * Timer above) and applies the documented recovery formulas (Playing the
   * Game, p. 94) to only the actors the GM selected - not every party
   * member necessarily rests at the same time (one might be on watch, etc).
   */
  static async #onRest(kind) {
    if (!game.user.isGM) return;
    const config = REST_CONFIG[kind];

    const selectedActors = await CarlToolbox.#promptRestActors(config.titleKey);
    if (!selectedActors) return; // Cancelled: no time advance, no updates.

    if (game.time?.advanceTime) await game.time.advanceTime(config.seconds);

    for (const actor of selectedActors) {
      const sys = actor.system;
      const effectiveMax = sys.hb?.effectiveMax ?? sys.hb?.max ?? 0;

      const updates = kind === "short"
        ? shortRestUpdates(actor)
        : { "system.hb.value": effectiveMax, "system.mana.value": sys.mana?.max ?? 0 };

      if (kind === "long" || kind === "fullDay") {
        let conditions = (sys.conditions ?? []).filter((c) => c.key !== "fatigued");
        if (kind === "fullDay") {
          conditions = conditions.filter((c) => c.key !== "longTermMajorInjury" && c.key !== "longTermMinorInjury");
        }
        updates["system.conditions"] = conditions;
      }

      await actor.update(updates);
    }

    await createCardMessage({
      title: game.i18n.localize(config.titleKey),
      body: selectedActors.length
        ? `<p>${game.i18n.format("CARLRPG.Toolbox.RestApplied", { count: selectedActors.length })}</p>
           <ul>${selectedActors.map((a) => `<li>${a.name}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.RestAppliedNone")}</p>`,
    });
  }

  /**
   * Rest actor picker.
   *
   * SCOPING DECISION: only `type: "character"` actors are listed/rest-able,
   * never NPCs. Rest (Playing the Game, p. 94) is a party/crawler concept;
   * NPCs in this ruleset are Mobs, not participants who "rest". The
   * previous unconditional `game.actors.filter(a =>
   * ["character","npc"].includes(a.type))` applied rest recovery (HB/mana
   * refill, condition clearing) to literally every NPC in the world too -
   * almost certainly an oversight in the original no-picker implementation
   * rather than an intended feature, since hostile/neutral Mobs "resting"
   * mid-crawl has no in-fiction meaning. Flagged here and in the task
   * report for the maintainer to override if NPCs were actually wanted.
   *
   * Default-checked: any Character actor owned (OWNER level) by a
   * currently-active, non-GM user - i.e. someone actually logged in to play
   * them right now. Every other Character (nobody active owns it, or only
   * the GM controls it - e.g. an absent player's PC, or a GM-run henchman)
   * starts unchecked, since the GM must deliberately opt those in.
   * @param {string} titleKey  i18n key for the specific rest kind's dialog title.
   * @returns {Promise<Actor[]|null>} Selected actors, or null if cancelled.
   */
  static async #promptRestActors(titleKey) {
    const actors = game.actors.filter((a) => a.type === "character");
    if (!actors.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.NoCharacters"));
      return null;
    }

    const isOwnedByActivePlayer = (actor) => game.users.some(
      (u) => u.active && !u.isGM && actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER),
    );

    const rows = actors.map((a) => {
      const checked = isOwnedByActivePlayer(a) ? "checked" : "";
      return `<label class="carl-dialog-condition carl-rest-picker-option">
        <input type="checkbox" name="actors.${a.id}" ${checked} />
        ${a.name}
      </label>`;
    }).join("");

    const content = `<div class="carl-dialog-body carl-rest-picker">
      <p>${game.i18n.localize("CARLRPG.Toolbox.Rest.PickerPrompt")}</p>
      <div class="form-group carl-dialog-conditions">
        <label class="carl-dialog-condition">
          <input type="checkbox" data-rest-select-all />
          <strong>${game.i18n.localize("CARLRPG.Toolbox.Rest.SelectAll")}</strong>
        </label>
        <div class="form-fields carl-dialog-conditions-list carl-rest-picker-list">${rows}</div>
      </div>
    </div>`;

    const result = await showCarlDialog({
      title: game.i18n.localize(titleKey),
      content,
      buttons: [rollButton({ label: "CARLRPG.Toolbox.Rest.Confirm" }), cancelButton()],
      // Wires the "Select All" checkbox up after the dialog's DOM exists:
      // toggling it (de)selects every actor row, and toggling any single
      // row keeps "Select All" in sync (checked only when all are checked).
      onRender: (event, dialog) => {
        const selectAll = dialog.element.querySelector('[data-rest-select-all]');
        const boxes = [...dialog.element.querySelectorAll(".carl-rest-picker-option input[type=\"checkbox\"]")];
        if (!selectAll || !boxes.length) return;
        const syncSelectAll = () => { selectAll.checked = boxes.every((b) => b.checked); };
        syncSelectAll();
        selectAll.addEventListener("change", () => {
          for (const box of boxes) box.checked = selectAll.checked;
        });
        for (const box of boxes) box.addEventListener("change", syncSelectAll);
      },
    });
    if (!result) return null;

    const selectedIds = new Set(
      Object.entries(result.actors ?? {}).filter(([, checked]) => checked).map(([id]) => id),
    );
    return actors.filter((a) => selectedIds.has(a.id));
  }

  /**
   * Grinding: GM picks an actor, a Skill, and accrued hours. Once the total
   * meets the Skill's current Rank, immediately rolls the Advancement Check
   * (the GM already opted into this by using the tool) and resets the
   * counter; otherwise just banks the hours as an item flag.
   */
  static async #onGrind(event, target) {
    if (!game.user.isGM) return;
    const actors = game.actors.filter((a) => a.type === "character");
    if (!actors.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.NoCharacters"));
      return;
    }
    const actorOptions = actors.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
    const actorResult = await showCarlDialog({
      title: game.i18n.localize("CARLRPG.Toolbox.GrindTitle"),
      content: `<div class="carl-dialog-body">
        <div class="form-group"><label>${game.i18n.localize("CARLRPG.Toolbox.GrindActor")}</label>
          <select name="actorId">${actorOptions}</select></div>
        <div class="form-group"><label>${game.i18n.localize("CARLRPG.Toolbox.GrindHours")}</label>
          <input type="number" name="hours" value="1" min="1" /></div>
      </div>`,
      buttons: [rollButton({ label: "CARLRPG.Toolbox.GrindNext" }), cancelButton()],
    });
    if (!actorResult) return;
    const actor = game.actors.get(actorResult.actorId);
    const hours = Number(actorResult.hours) || 0;
    if (!actor || hours <= 0) return;

    const skillItems = actor.items.filter((i) => ["skill", "spell", "damageEffect"].includes(i.type));
    if (!skillItems.length) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Toolbox.NoSkills", { name: actor.name }));
      return;
    }
    const skillOptions = skillItems.map((i) => `<option value="${i.id}">${i.name} (Rank ${i.system.rank})</option>`).join("");
    const skillResult = await showCarlDialog({
      title: game.i18n.format("CARLRPG.Toolbox.GrindSkillTitle", { name: actor.name }),
      content: `<div class="carl-dialog-body"><div class="form-group"><select name="itemId">${skillOptions}</select></div></div>`,
      buttons: [rollButton(), cancelButton()],
    });
    if (!skillResult) return;
    const item = actor.items.get(skillResult.itemId);
    if (!item) return;

    const rank = item.system.rank ?? 0;
    const accrued = (item.getFlag("carl-rpg", "grindHours") ?? 0) + hours;

    if (accrued >= rank) {
      await item.setFlag("carl-rpg", "grindHours", Math.max(0, accrued - rank));
      ui.notifications.info(game.i18n.format("CARLRPG.Toolbox.GrindThresholdReached", { name: item.name }));
      await CarlDice.rollAdvancementCheck(actor, item);
    } else {
      await item.setFlag("carl-rpg", "grindHours", accrued);
      ui.notifications.info(game.i18n.format("CARLRPG.Toolbox.GrindProgress", { name: item.name, accrued, rank }));
    }
  }

  /**
   * Roll Loot: hooks into Foundry's native RollTable document. Loot table
   * content itself (Chapters 7-9) is out of scope for this pass - the GM
   * populates their own tables.
   */
  static async #onRollLoot(event, target) {
    if (!game.user.isGM) return;
    const tables = game.tables?.contents ?? [];
    if (!tables.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.NoRollTables"));
      return;
    }
    const options = tables.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
    const result = await showCarlDialog({
      title: game.i18n.localize("CARLRPG.Toolbox.RollLootTitle"),
      content: `<div class="carl-dialog-body"><div class="form-group"><select name="tableId">${options}</select></div></div>`,
      buttons: [rollButton(), cancelButton()],
    });
    if (!result) return;
    const table = game.tables.get(result.tableId);
    if (!table) return;
    await table.draw();
  }
}
