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
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { showCarlDialog, rollButton, cancelButton } from "./carl-dialog.mjs";
import { shortRestUpdates, conditionsAfterRest, mendingUpdates } from "../helpers/rest.mjs";
import { BOSS_TIERS, collapseDays, endOfFloorPopularityDelta } from "../helpers/floor.mjs";
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import { rollMagicItem } from "../helpers/loot.mjs";
import { isGrindTarget, grindTargetOptions, addGrindLevelHours } from "../helpers/grinding.mjs";
import { grindAndOfferSurplus } from "../chat/grind-surplus-card.mjs";

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
    // Pinned near the left edge, out of the way of the canvas - not centered
    // (Foundry centers any window lacking explicit left/top). This static
    // top is only a fallback for the rare case #positionAbovePlayersList
    // can't find ui.players' element; in the normal case, _onFirstRender
    // repositions the window just above the connected-players list instead
    // of at this fixed guess, since the players list's own height (and thus
    // where "above it" actually is) depends on how many users are connected.
    position: { width: 280, height: "auto", left: 20, top: 320 },
    actions: {
      toggleTimer: CarlToolbox.#onToggleTimer,
      resolveTwoHourTick: CarlToolbox.#onResolveTwoHourTick,
      endFloor: CarlToolbox.#onEndFloor,
      bossKilled: CarlToolbox.#onBossKilled,
      mend: CarlToolbox.#onMend,
      floorIncrement: CarlToolbox.#onFloorIncrement,
      floorDecrement: CarlToolbox.#onFloorDecrement,
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
    this.#positionAbovePlayersList();
    injectBloodSplatter(this);
    this.#startTicking();
  }

  /**
   * Sit the window's bottom edge just above the connected-players list
   * (ui.players) instead of the fixed guess in DEFAULT_OPTIONS.position -
   * that list's own height (and so where "just above it" actually is)
   * depends on how many users are connected, so a single static top can't
   * get this right for every world. Only runs once, on first render - if
   * the GM drags the window elsewhere afterward, a later content-only
   * re-render (e.g. from #render() calls throughout this class) won't fight
   * that back.
   */
  #positionAbovePlayersList() {
    const playersEl = ui.players?.element;
    if (!playersEl || !this.element) return;
    const playersRect = playersEl.getBoundingClientRect();
    const ownHeight = this.element.getBoundingClientRect().height;
    const top = Math.max(8, playersRect.top - ownHeight - 8);
    this.setPosition({ top });
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
   * The 2-hour rule (Crawler Advancement, p.169): "At the end of every 2
   * hours of play, each party member gains 1 Level", and every marked Skill
   * at Rank 4 or lower rolls its Advancement Check. One click does both for
   * the picked characters (Rank 5+ waits for End Floor), then resets the
   * wall-clock timer.
   */
  static async #onResolveTwoHourTick(event, target) {
    if (!game.user.isGM) return;
    const actors = await CarlToolbox.#promptActorPicker({
      titleKey: "CARLRPG.Toolbox.ResolveTwoHourTitle",
      promptKey: "CARLRPG.Toolbox.ResolveTwoHourPickerPrompt",
    });
    if (!actors) return;

    const digest = [];
    for (const actor of actors) {
      const results = await actor.rollMarkedAdvancementChecks({ rankFilter: "lte4", floorBonus: false });
      digest.push(...CarlToolbox.#advancementLines(actor, results));
      const level = await CarlToolbox.#gainLevels(actor, 1);
      digest.push(game.i18n.format("CARLRPG.Toolbox.LevelGained", { name: esc(actor.name), level }));
    }

    await createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.TwoHourResultsTitle"),
      body: digest.length
        ? `<ul>${digest.map((d) => `<li>${d}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.NoCharactersPicked")}</p>`,
    });

    await game.settings.set("carl-rpg", "gameTimer", { running: false, startedAt: null, notified: false });
    this.render();
  }

  /**
   * End Floor (p.169, p.63, p.280): for the picked characters,
   *  1. every marked Skill at Rank 5+ rolls its Advancement Check ("roll a
   *     Skill Advancement Check at the end of each floor"), with any
   *     Race/Class "at the end of each floor, add 1" bonus;
   *  2. all remaining marks are erased ("After resolving these rolls, erase
   *     all marks and start fresh");
   *  3. the automatic Popularity change from Charisma vs. the Floor;
   * then the Floor advances, and one card lists the results plus the
   * end-of-floor items that stay the GM's call. No Level is gained for
   * finishing a floor - Levels come from play time, Bosses and kills.
   */
  static async #onEndFloor(event, target) {
    if (!game.user.isGM) return;
    const floor = game.settings.get("carl-rpg", "currentFloor");
    const actors = await CarlToolbox.#promptActorPicker({
      titleKey: "CARLRPG.Toolbox.EndFloorTitle",
      promptKey: "CARLRPG.Toolbox.EndFloorPickerPrompt",
      confirmLabelKey: "CARLRPG.Toolbox.EndFloorConfirm",
    });
    if (!actors) return;

    const digest = [];
    for (const actor of actors) {
      const results = await actor.rollMarkedAdvancementChecks({ rankFilter: "gte5" });
      digest.push(...CarlToolbox.#advancementLines(actor, results));

      const stillMarked = actor.items.filter((i) => i.system?.marked);
      if (stillMarked.length) {
        await actor.updateEmbeddedDocuments("Item", stillMarked.map((i) => ({ _id: i.id, "system.marked": false })));
      }

      // Popularity can't drop below 0 (system.details.popularity has min 0),
      // so a crawler already at 0 has nothing to lose - and no line.
      const delta = endOfFloorPopularityDelta(actor.system.stats?.cha?.effective, floor);
      const popularity = actor.system.details?.popularity ?? 0;
      if (delta && popularity + delta >= 0) {
        await actor.update({ "system.details.popularity": popularity + delta });
        digest.push(game.i18n.format(delta > 0 ? "CARLRPG.Toolbox.EndFloorPopularityUp" : "CARLRPG.Toolbox.EndFloorPopularityDown", {
          name: esc(actor.name), limit: delta > 0 ? 5 * floor : 2 * floor,
        }));
      }
    }

    const next = floor + 1;
    await game.settings.set("carl-rpg", "currentFloor", next);
    this.render();

    const days = collapseDays(next);
    const reminders = [
      game.i18n.localize("CARLRPG.Toolbox.EndFloorReminder.Cooldowns"),
      game.i18n.localize("CARLRPG.Toolbox.EndFloorReminder.Popularity"),
      game.i18n.localize("CARLRPG.Toolbox.EndFloorReminder.Boxes"),
      game.i18n.localize("CARLRPG.Toolbox.EndFloorReminder.RaceClass"),
      days
        ? game.i18n.format("CARLRPG.Toolbox.EndFloorReminder.Collapse", { floor: next, days })
        : game.i18n.format("CARLRPG.Toolbox.EndFloorReminder.CollapseCustom", { floor: next }),
    ];
    await createCardMessage({
      title: game.i18n.format("CARLRPG.Toolbox.EndFloorCardTitle", { floor }),
      subtitle: game.i18n.format("CARLRPG.Toolbox.EndFloorCardSubtitle", { floor: next }),
      body: `${digest.length ? `<ul>${digest.map((d) => `<li>${d}</li>`).join("")}</ul>` : `<p>${game.i18n.localize("CARLRPG.Toolbox.NoMarkedSkills")}</p>`}
        <div class="carl-gm-digest carl-gm-only">
          <div class="carl-gm-digest-title">${game.i18n.localize("CARLRPG.Toolbox.EndFloorReminderTitle")}</div>
          <ul>${reminders.map((r) => `<li>${r}</li>`).join("")}</ul>
        </div>`,
    });
  }

  /**
   * Boss Killed (p.170): "When a party kills a Boss, each member gains Levels
   * based on the tier of the Boss" - Neighborhood 1 up to Floor Boss 6.
   */
  static async #onBossKilled(event, target) {
    if (!game.user.isGM) return;
    const options = Object.entries(BOSS_TIERS)
      .map(([key, tier]) => `<option value="${key}">${game.i18n.format("CARLRPG.Toolbox.BossTierOption", {
        tier: game.i18n.localize(tier.label), levels: tier.levels,
      })}</option>`).join("");
    const choice = await showCarlDialog({
      title: game.i18n.localize("CARLRPG.Toolbox.BossKilledTitle"),
      content: `<div class="carl-dialog-body"><div class="form-group">
        <label>${game.i18n.localize("CARLRPG.Toolbox.BossTierLabel")}</label>
        <select name="tier">${options}</select>
      </div></div>`,
      buttons: [rollButton({ label: "CARLRPG.Toolbox.GrindNext" }), cancelButton()],
    });
    const tier = BOSS_TIERS[choice?.tier];
    if (!tier) return;

    const actors = await CarlToolbox.#promptActorPicker({
      titleKey: "CARLRPG.Toolbox.BossKilledTitle",
      promptKey: "CARLRPG.Toolbox.BossKilledPickerPrompt",
    });
    if (!actors?.length) return;

    const lines = [];
    for (const actor of actors) {
      const level = await CarlToolbox.#gainLevels(actor, tier.levels);
      lines.push(game.i18n.format("CARLRPG.Toolbox.LevelsGained", { name: esc(actor.name), levels: tier.levels, level }));
    }
    await createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.BossKilledTitle"),
      subtitle: game.i18n.localize(tier.label),
      body: `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
    });
  }

  /** "{name} - {skill}: Rank N / no change" lines for a card. */
  static #advancementLines(actor, results) {
    return results.map((r) => `${esc(actor.name)} - ${esc(r.item.name)}: ${r.success
      ? `Rank ${r.newRank}` : game.i18n.localize("CARLRPG.Toolbox.NoChange")}`);
  }

  /**
   * Raise a character's Level (capped at 250). Stat points bank, and the
   * grinding-toward-Level total resets, in CarlRPGActor#_preUpdate.
   * @returns {Promise<number>} The new Level.
   */
  static async #gainLevels(actor, levels) {
    const level = Math.min((actor.system.attributes?.level?.value ?? 1) + levels, 250);
    await actor.update({ "system.attributes.level.value": level });
    return level;
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
   * Hourly mending (p.95): "For every full hour spent outside of combat or
   * other stressful situations, they ... recover 1 HB slot and 5 Mana."
   * Asks for the hours, then who mended; advances the world clock.
   */
  static async #onMend(event, target) {
    if (!game.user.isGM) return;
    const input = await showCarlDialog({
      title: game.i18n.localize("CARLRPG.Toolbox.MendTitle"),
      content: `<div class="carl-dialog-body"><div class="form-group">
        <label>${game.i18n.localize("CARLRPG.Toolbox.MendHours")}</label>
        <input type="number" name="hours" value="1" min="1" />
      </div><p class="hint">${game.i18n.localize("CARLRPG.Toolbox.MendHint")}</p></div>`,
      buttons: [rollButton({ label: "CARLRPG.Toolbox.GrindNext" }), cancelButton()],
    });
    const hours = Math.floor(Number(input?.hours) || 0);
    if (hours < 1) return;

    const actors = await CarlToolbox.#promptActorPicker({
      titleKey: "CARLRPG.Toolbox.MendTitle",
      promptKey: "CARLRPG.Toolbox.MendPickerPrompt",
    });
    if (!actors) return;

    if (game.time?.advanceTime) await game.time.advanceTime(hours * 3600);
    for (const actor of actors) await actor.update(mendingUpdates(actor, hours));

    await createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.MendTitle"),
      subtitle: game.i18n.format("CARLRPG.Toolbox.MendSubtitle", { hours, hb: hours, mana: 5 * hours }),
      body: actors.length
        ? `<ul>${actors.map((a) => `<li>${esc(a.name)}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.NoCharactersPicked")}</p>`,
    });
  }

  /**
   * In-world Rest: shows a picker of Character actors (see
   * #promptActorPicker for the Character-only scoping rationale), then
   * advances Foundry's own game.time (unrelated to the wall-clock Play
   * Timer above) and applies the documented recovery formulas (Playing the
   * Game, p. 94) to only the actors the GM selected - not every party
   * member necessarily rests at the same time (one might be on watch, etc).
   */
  static async #onRest(kind) {
    if (!game.user.isGM) return;
    const config = REST_CONFIG[kind];

    const selectedActors = await CarlToolbox.#promptActorPicker({
      titleKey: config.titleKey,
      promptKey: "CARLRPG.Toolbox.Rest.PickerPrompt",
      confirmLabelKey: "CARLRPG.Toolbox.Rest.Confirm",
    });
    if (!selectedActors) return; // Cancelled: no time advance, no updates.

    if (game.time?.advanceTime) await game.time.advanceTime(config.seconds);

    for (const actor of selectedActors) {
      const sys = actor.system;
      const effectiveMax = sys.hb?.effectiveMax ?? sys.hb?.max ?? 0;

      const updates = kind === "short"
        ? shortRestUpdates(actor)
        : { "system.hb.value": effectiveMax, "system.mana.value": sys.mana?.max ?? 0 };

      // Injuries and Fatigued end by rest length (rest.mjs's conditionsAfterRest).
      const conditions = conditionsAfterRest(sys.conditions, kind);
      if (conditions.length !== (sys.conditions ?? []).length) updates["system.conditions"] = conditions;

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
   * Generic Character-actor picker shared by every toolbox action that
   * shouldn't silently apply to every Character in the world (Rest, the
   * 2-Hour Tick, Party Level Up) - not every Character actor is
   * necessarily part of "the party, right now" (an absent player's PC, a
   * retired character, a GM-run henchman, etc).
   *
   * SCOPING DECISION: only `type: "character"` actors are ever listed,
   * never Mobs - Mobs in this ruleset are monsters/NPCs, not party members
   * these bulk actions apply to.
   *
   * Default-checked: any Character actor owned (OWNER level) by a
   * currently-active, non-GM user - i.e. someone actually logged in to
   * play them right now. Everyone else starts unchecked, in a collapsed
   * "Other Characters" section, since the GM must deliberately opt those
   * in. Also provides a live name filter (auto-expanding "Other
   * Characters" on a match) and a running "N/Total selected" counter, so a
   * large roster stays manageable.
   * @param {object} options
   * @param {string} options.titleKey  i18n key for the dialog title.
   * @param {string} options.promptKey  i18n key for the intro line.
   * @param {string} [options.confirmLabelKey]  i18n key for the confirm button.
   * @returns {Promise<Actor[]|null>} Selected actors, or null if cancelled/none exist.
   */
  static async #promptActorPicker({ titleKey, promptKey, confirmLabelKey = "CARLRPG.Toolbox.ActorPicker.Confirm" }) {
    const actors = game.actors
      .filter((a) => a.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!actors.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.NoCharacters"));
      return null;
    }

    const isOwnedByActivePlayer = (actor) => game.users.some(
      (u) => u.active && !u.isGM && actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER),
    );
    const active = actors.filter(isOwnedByActivePlayer);
    const other = actors.filter((a) => !isOwnedByActivePlayer(a));

    // data-actor-id (read directly off the DOM by the confirm button below),
    // not just a `name="actors.<id>"` for FormDataExtended to expand - see
    // the confirm button's own callback for why.
    const row = (a, checked) => `<label class="carl-dialog-condition carl-actor-picker-option" data-actor-name="${foundry.utils.escapeHTML(a.name.toLowerCase())}">
        <input type="checkbox" data-actor-id="${a.id}" ${checked ? "checked" : ""} />
        ${foundry.utils.escapeHTML(a.name)}
      </label>`;

    const activeRows = active.map((a) => row(a, true)).join("");
    const otherRows = other.map((a) => row(a, false)).join("");
    const otherSection = other.length
      ? `<details class="carl-actor-picker-other">
          <summary>${game.i18n.format("CARLRPG.Toolbox.ActorPicker.OtherCharacters", { count: other.length })}</summary>
          ${otherRows}
        </details>`
      : "";

    const content = `<div class="carl-dialog-body carl-actor-picker">
      <p>${game.i18n.localize(promptKey)}</p>
      <input type="search" class="carl-actor-picker-filter" placeholder="${game.i18n.localize("CARLRPG.Toolbox.ActorPicker.FilterPlaceholder")}" />
      <div class="form-group carl-dialog-conditions">
        <label class="carl-dialog-condition carl-actor-picker-select-all">
          <input type="checkbox" data-picker-select-all />
          <strong>${game.i18n.localize("CARLRPG.Toolbox.ActorPicker.SelectAll")}</strong>
          <span class="carl-actor-picker-count" data-picker-count></span>
        </label>
        <div class="form-fields carl-dialog-conditions-list carl-actor-picker-list">${activeRows}${otherSection}</div>
      </div>
    </div>`;

    const result = await showCarlDialog({
      title: game.i18n.localize(titleKey),
      content,
      // A dedicated button rather than the shared rollButton(): reads each
      // checkbox's .checked directly off the live DOM instead of going
      // through FormDataExtended's dotted-name-to-nested-object expansion
      // (button.form's own FormData) - confirmed via manual testing that
      // path was silently losing every checked actor (both a single manual
      // check and Select All), even with no players logged in at all.
      // Reading .checked straight off each <input> sidesteps whatever in
      // that expansion was going wrong, with no dotted-path magic involved.
      buttons: [
        {
          action: "roll",
          icon: "fa-solid fa-dice-d20",
          label: confirmLabelKey,
          default: true,
          callback: (event, button) => ({
            selectedIds: [...(button.form ?? button.closest("form")).querySelectorAll("input[data-actor-id]")]
              .filter((el) => el.checked)
              .map((el) => el.dataset.actorId),
          }),
        },
        cancelButton(),
      ],
      // Wires the picker's interactive bits up after the dialog's DOM
      // exists: Select All (de)selects every row and stays in sync with
      // individual toggles; the running counter updates on any change; the
      // name filter hides non-matching rows and auto-expands "Other
      // Characters" so a match hidden inside the collapsed <details> isn't
      // invisible.
      onRender: (event, dialog) => {
        const root = dialog.element;
        const selectAll = root.querySelector("[data-picker-select-all]");
        const countEl = root.querySelector("[data-picker-count]");
        const filterInput = root.querySelector(".carl-actor-picker-filter");
        const getRows = () => [...root.querySelectorAll(".carl-actor-picker-option")];
        const getBoxes = () => getRows().map((r) => r.querySelector('input[type="checkbox"]'));

        const updateCount = () => {
          if (!countEl) return;
          const boxes = getBoxes();
          countEl.textContent = game.i18n.format("CARLRPG.Toolbox.ActorPicker.SelectedCount", {
            count: boxes.filter((b) => b.checked).length,
            total: boxes.length,
          });
        };
        const syncSelectAll = () => {
          const boxes = getBoxes();
          if (selectAll) selectAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
          updateCount();
        };

        syncSelectAll();
        selectAll?.addEventListener("change", () => {
          for (const box of getBoxes()) box.checked = selectAll.checked;
          updateCount();
        });
        for (const box of getBoxes()) box.addEventListener("change", syncSelectAll);

        filterInput?.addEventListener("input", () => {
          const needle = filterInput.value.trim().toLowerCase();
          for (const rowEl of getRows()) rowEl.hidden = !(!needle || rowEl.dataset.actorName.includes(needle));
          const details = root.querySelector(".carl-actor-picker-other");
          if (details && needle) details.open = true;
        });
      },
    });
    if (!result) return null;

    const selectedIds = new Set(result.selectedIds ?? []);
    return actors.filter((a) => selectedIds.has(a.id));
  }

  /**
   * Grinding (p.170): GM picks an actor, hours, and a Skill that can take
   * them (module/helpers/grinding.mjs's isGrindTarget). Once the
   * Skill's accrued hours meet its Rank, the Advancement Check is rolled
   * immediately, with Debuff penalties; hours beyond that go to a chat card
   * offering them to another Skill (module/chat/grind-surplus-card.mjs).
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

    const skillItems = actor.items.filter((i) => isGrindTarget(actor, i));
    if (!skillItems.length) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Grind.NoTargets", { name: actor.name }));
      return;
    }
    const skillOptions = grindTargetOptions(skillItems);
    const skillResult = await showCarlDialog({
      title: game.i18n.format("CARLRPG.Toolbox.GrindSkillTitle", { name: actor.name }),
      content: `<div class="carl-dialog-body"><div class="form-group"><select name="itemId">${skillOptions}</select></div></div>`,
      buttons: [rollButton(), cancelButton()],
    });
    if (!skillResult) return;
    const item = actor.items.get(skillResult.itemId);
    if (!item || !isGrindTarget(actor, item)) return;
    await grindAndOfferSurplus(actor, item, hours);
    // The same hours also count toward the next Level (p.171).
    await addGrindLevelHours(actor, hours);
  }

  /**
   * Roll Loot: prompts for a loot box tier, then runs the full Randomized
   * Magic Item pipeline (Item Type -> matching sub-table x N rolls, with
   * the Something Unique early-stop/power-multiplier rule) via
   * module/helpers/loot.mjs's rollMagicItem, which posts the one
   * consolidated result card itself.
   */
  static async #onRollLoot(event, target) {
    if (!game.user.isGM) return;

    const options = Object.entries(CONFIG.CARLRPG.lootBoxTiers)
      .map(([key, tier]) => `<option value="${key}">${game.i18n.localize(tier.label)}</option>`)
      .join("");
    const result = await showCarlDialog({
      title: game.i18n.localize("CARLRPG.Toolbox.RollLootTitle"),
      content: `<div class="carl-dialog-body"><div class="form-group"><label>${game.i18n.localize("CARLRPG.Toolbox.LootTierLabel")}</label><select name="tier">${options}</select></div></div>`,
      buttons: [rollButton(), cancelButton()],
    });
    if (!result) return;
    await rollMagicItem(result.tier);
  }
}
