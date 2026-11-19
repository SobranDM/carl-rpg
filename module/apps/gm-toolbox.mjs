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
 *    advance), which is unrelated to wall-clock time and only moves
 *    when a GM clicks a button.
 */
import { createCardMessage } from "../chat/chat-card.mjs";
import { showCarlDialog, rollButton, cancelButton } from "./carl-dialog.mjs";
import { shortRestUpdates, fullRestoreUpdates, conditionsAfterRest, mendingUpdates } from "../helpers/rest.mjs";
import { BOSS_TIERS, collapseDays, currentFloor, endOfFloorPopularityDelta } from "../helpers/floor.mjs";
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import { rollMagicItem } from "../helpers/loot.mjs";
import { isGrindTarget, grindTargetOptions, addGrindLevelHours } from "../helpers/grinding.mjs";
import { grindAndOfferSurplus } from "../chat/grind-surplus-card.mjs";
import { queueForActor } from "../helpers/actor-queue.mjs";
import { dropExpiredConditions } from "../helpers/expiry.mjs";
import { actorPickerContent, advanceTimeField, pickerGroups, wireActorPicker } from "./actor-picker.mjs";
import { postPartyCheck } from "../chat/party-check-card.mjs";
import { startNewScene } from "../helpers/cooldowns.mjs";
import { unopposedDifficulty } from "../helpers/rules.mjs";
import { esc } from "../helpers/html.mjs";
import { changeConditions, conditionOps } from "../helpers/conditions.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ApplicationV2 } = foundry.applications.api;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Move Foundry's in-world clock forward (v14: game.time.advance; older
 * cores called it advanceTime). Timed effects expire on it (module/helpers/
 * expiry.mjs).
 * @param {number} seconds
 */
async function advanceWorldTime(seconds) {
  if (!seconds) return;
  if (game.time?.advance) await game.time.advance(seconds);
  else if (game.time?.advanceTime) await game.time.advanceTime(seconds);
}


/**
 * A card's line saying whether the world clock moved (Rest, Mend).
 * @param {boolean} advanced
 * @param {number} hours
 * @returns {string}
 */
function clockLine(advanced, hours) {
  const text = advanced
    ? game.i18n.format("CARLRPG.Toolbox.ClockAdvanced", { hours })
    : game.i18n.localize("CARLRPG.Toolbox.ClockNotAdvanced");
  return `<p class="carl-clock-line"><i class="fas fa-clock"></i> ${esc(text)}</p>`;
}

/**
 * The rest lengths (Resting, p.94): their hours, the card's title, and the
 * book's own words for each (shown in the Rest dialog as it's picked).
 */
const REST_CONFIG = {
  short: { hours: 2, titleKey: "CARLRPG.Toolbox.Rest.ShortTitle" },
  long: { hours: 8, titleKey: "CARLRPG.Toolbox.Rest.LongTitle" },
  fullDay: { hours: 30, titleKey: "CARLRPG.Toolbox.Rest.FullDayTitle" },
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
      rest: CarlToolbox.#onRest,
      grind: CarlToolbox.#onGrind,
      rollLoot: CarlToolbox.#onRollLoot,
      partyCheck: CarlToolbox.#onPartyCheck,
      newScene: CarlToolbox.#onNewScene,
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
      floor: currentFloor(),
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
    const floor = currentFloor();
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
    const floor = currentFloor();
    await game.settings.set("carl-rpg", "currentFloor", floor + 1);
    this.render();
  }

  static async #onFloorDecrement(event, target) {
    if (!game.user.isGM) return;
    const floor = currentFloor();
    await game.settings.set("carl-rpg", "currentFloor", Math.max(0, floor - 1));
    this.render();
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
      </div><p class="hint">${game.i18n.localize("CARLRPG.Toolbox.MendHint")}</p>
      ${advanceTimeField(game.i18n.localize("CARLRPG.Toolbox.TheHours"))}</div>`,
      buttons: [rollButton({ label: "CARLRPG.Toolbox.GrindNext" }), cancelButton()],
    });
    const hours = Math.floor(Number(input?.hours) || 0);
    if (hours < 1) return;
    const advance = input?.advanceTime !== false;

    const actors = await CarlToolbox.#promptActorPicker({
      titleKey: "CARLRPG.Toolbox.MendTitle",
      promptKey: "CARLRPG.Toolbox.MendPickerPrompt",
      includePets: true,
    });
    if (!actors) return;

    // Per crawler, in its queue (shared with the expiry sweep, so neither
    // write overwrites the other): first end every timed effect that runs
    // out before the mending does - so a temporary +HB Buff can't leave
    // them healed past their real maximum - then recover. The clock moves
    // last.
    // Unticked, the time is counted elsewhere: nothing runs out here.
    const endsAt = game.time.worldTime + (advance ? hours * 3600 : 0);
    for (const actor of actors) {
      await queueForActor(actor.uuid, async () => {
        await dropExpiredConditions(actor, endsAt);
        await actor.update(mendingUpdates(actor, hours));
      });
    }
    if (advance) await advanceWorldTime(hours * 3600);

    await createCardMessage({
      title: game.i18n.localize("CARLRPG.Toolbox.MendTitle"),
      subtitle: game.i18n.format("CARLRPG.Toolbox.MendSubtitle", { hours, hb: hours, mana: 5 * hours }),
      body: (actors.length
        ? `<ul>${actors.map((a) => `<li>${esc(a.name)}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.NoCharactersPicked")}</p>`) + clockLine(advance, hours),
    });
  }

  /**
   * One Rest dialog (docs/release-0.7.0.md §6): the length (Short, Long,
   * Full Day) with the book's own words for the one picked (Resting, p.94),
   * who rests (the picker, Pets included - not every party member rests at
   * once), and Advance time, ticked. Applies the recovery (helpers/rest.mjs)
   * to the picked actors, then moves Foundry's world clock if ticked.
   */
  static async #onRest(event, target) {
    if (!game.user.isGM) return;
    const i18n = game.i18n;
    const options = Object.entries(REST_CONFIG).map(([kind, rest], i) => `<label class="carl-rest-option">
        <input type="radio" name="carl-rest-kind" value="${kind}" data-hours="${rest.hours}" ${i === 0 ? "checked" : ""} />
        ${esc(i18n.localize(`CARLRPG.Toolbox.Rest.Kind.${kind}`))}
      </label>`).join("");
    const rules = Object.keys(REST_CONFIG).map((kind, i) => `<blockquote class="carl-rest-rule" data-rest-rule="${kind}" ${i === 0 ? "" : "hidden"}>
        <p>${esc(i18n.localize(`CARLRPG.Toolbox.Rest.Rule.${kind}`))}</p>
        <cite>${esc(i18n.localize("CARLRPG.Toolbox.Rest.Source"))}</cite>
      </blockquote>`).join("");
    const before = `<fieldset class="carl-rest-length">
        <legend>${esc(i18n.localize("CARLRPG.Toolbox.Rest.Length"))}</legend>
        <div class="carl-rest-options">${options}</div>
        ${rules}
      </fieldset>`;

    const picked = await CarlToolbox.#pickActors({
      titleKey: "CARLRPG.Toolbox.Rest.Title",
      promptKey: "CARLRPG.Toolbox.Rest.PickerPrompt",
      confirmLabelKey: "CARLRPG.Toolbox.Rest.Confirm",
      includePets: true,
      before,
      after: advanceTimeField(i18n.format("CARLRPG.Toolbox.HoursCount", { n: REST_CONFIG.short.hours })),
      read: (form) => ({
        kind: form.querySelector('input[name="carl-rest-kind"]:checked')?.value ?? "short",
        advance: !!form.querySelector("[data-advance-time]")?.checked,
      }),
      // The picked length's words, and the hours in the Advance time hint.
      onRender: (root) => {
        const hint = root.querySelector("[data-advance-time-hint]");
        for (const radio of root.querySelectorAll('input[name="carl-rest-kind"]')) {
          radio.addEventListener("change", () => {
            for (const rule of root.querySelectorAll("[data-rest-rule]")) rule.hidden = rule.dataset.restRule !== radio.value;
            if (hint) {
              hint.textContent = i18n.format("CARLRPG.Toolbox.AdvanceTimeHint", {
                hours: i18n.format("CARLRPG.Toolbox.HoursCount", { n: radio.dataset.hours }),
              });
            }
          });
        }
      },
    });
    if (!picked) return; // Cancelled: no time advance, no updates.
    const { actors: selectedActors, data } = picked;
    const kind = REST_CONFIG[data.kind] ? data.kind : "short";
    const config = REST_CONFIG[kind];
    const seconds = config.hours * 3600;

    // Expired effects, then recovery, then the clock - see #onMend.
    const endsAt = game.time.worldTime + (data.advance ? seconds : 0);
    for (const actor of selectedActors) {
      await queueForActor(actor.uuid, async () => {
        await dropExpiredConditions(actor, endsAt);
        const sys = actor.system;

        const updates = kind === "short"
          ? shortRestUpdates(actor)
          : fullRestoreUpdates(actor);

        // Injuries and Fatigued end by rest length (rest.mjs's conditionsAfterRest).
        const before = sys.toObject().conditions ?? [];
        await changeConditions(actor, conditionOps(before, conditionsAfterRest(before, kind)), { updates, inQueue: true });
      });
    }
    if (data.advance) await advanceWorldTime(seconds);

    await createCardMessage({
      title: game.i18n.localize(config.titleKey),
      body: (selectedActors.length
        ? `<p>${game.i18n.format("CARLRPG.Toolbox.RestApplied", { count: selectedActors.length })}</p>
           <ul>${selectedActors.map((a) => `<li>${esc(a.name)}</li>`).join("")}</ul>`
        : `<p>${game.i18n.localize("CARLRPG.Toolbox.RestAppliedNone")}</p>`) + clockLine(data.advance, config.hours),
    });
  }

  /**
   * The shared "who does this apply to" picker (module/apps/actor-picker.mjs:
   * Logged in, ticked; Not logged in, collapsed; Pets where the action takes
   * them; Select All on its own row).
   * @param {object} options
   * @param {string} options.titleKey  i18n key for the dialog title.
   * @param {string} options.promptKey  i18n key for the intro line.
   * @param {string} [options.confirmLabelKey]  i18n key for the confirm button.
   * @param {boolean} [options.includePets]  List Pets too (Rest, Mend).
   * @returns {Promise<Actor[]|null>} Selected actors, or null if cancelled/none exist.
   */
  static async #promptActorPicker(options) {
    return (await CarlToolbox.#pickActors(options))?.actors ?? null;
  }

  /**
   * The picker with extra controls in the same dialog (the Rest dialog):
   * `before` / `after` HTML around it, `read(form)` for their values,
   * `onRender(root)` to wire them.
   * @param {object} options  As #promptActorPicker, plus before, after, read, onRender.
   * @returns {Promise<{actors: Actor[], data: object}|null>}
   */
  static async #pickActors({
    titleKey, promptKey, confirmLabelKey = "CARLRPG.Toolbox.ActorPicker.Confirm", includePets = false,
    before = "", after = "", read = () => ({}), onRender = null,
  }) {
    const groups = pickerGroups({ includePets });
    const actors = [...groups.active, ...groups.other, ...groups.pets];
    if (!actors.length) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Toolbox.NoCharacters"));
      return null;
    }
    const result = await showCarlDialog({
      title: game.i18n.localize(titleKey),
      classes: ["carl-pick-actors"],
      content: actorPickerContent(groups, game.i18n.localize(promptKey), { before, after }),
      // A dedicated button rather than the shared rollButton(): reads each
      // checkbox's .checked straight off the live DOM - FormDataExtended's
      // dotted-name expansion was found to lose every checked actor.
      buttons: [
        {
          action: "roll",
          icon: "fa-solid fa-dice-d20",
          label: confirmLabelKey,
          default: true,
          callback: (event, button) => {
            const form = button.form ?? button.closest("form");
            return {
              selectedIds: [...form.querySelectorAll("input[data-actor-id]")]
                .filter((el) => el.checked)
                .map((el) => el.dataset.actorId),
              data: read(form),
            };
          },
        },
        cancelButton(),
      ],
      onRender: (event, dialog) => {
        wireActorPicker(dialog.element);
        onRender?.(dialog.element);
      },
    });
    if (!result) return null;

    const selectedIds = new Set(result.selectedIds ?? []);
    return { actors: actors.filter((a) => selectedIds.has(a.id)), data: result.data ?? {} };
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
        ${advanceTimeField(game.i18n.localize("CARLRPG.Toolbox.TheHours"))}
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
    // Grinding takes that long (docs/release-0.7.0.md §6).
    if (actorResult.advanceTime !== false) await advanceWorldTime(hours * 3600);
  }

  /**
   * Party Skill Check (p.59): the Skill's name, the Difficulty (Unopposed,
   * 10 + Floor x 2, to start) and who rolls (the picker), then the card each
   * crawler's player rolls from (module/chat/party-check-card.mjs).
   */
  static async #onPartyCheck(event, target) {
    if (!game.user.isGM) return;
    const i18n = game.i18n;
    const floor = currentFloor();
    const names = await CarlToolbox.#skillNames();
    const before = `<div class="carl-party-check-setup">
        <div class="form-group">
          <label>${esc(i18n.localize("CARLRPG.PartyCheck.Skill"))}</label>
          <input type="text" name="carl-party-skill" list="carl-party-skill-names" />
          <datalist id="carl-party-skill-names">${names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        </div>
        <div class="form-group">
          <label>${esc(i18n.localize("CARLRPG.Dialog.Difficulty"))}</label>
          <input type="number" name="carl-party-difficulty" value="${unopposedDifficulty(floor)}" />
        </div>
        <p class="carl-dialog-hint">${esc(i18n.localize("CARLRPG.PartyCheck.Rule"))}</p>
      </div>`;
    const picked = await CarlToolbox.#pickActors({
      titleKey: "CARLRPG.PartyCheck.DialogTitle",
      promptKey: "CARLRPG.PartyCheck.PickerPrompt",
      confirmLabelKey: "CARLRPG.PartyCheck.Confirm",
      before,
      read: (form) => ({
        skill: form.querySelector('input[name="carl-party-skill"]')?.value ?? "",
        difficulty: form.querySelector('input[name="carl-party-difficulty"]')?.value ?? "",
      }),
    });
    if (!picked) return;
    const skill = String(picked.data.skill ?? "").trim();
    const difficulty = Number(picked.data.difficulty);
    if (!skill || !Number.isFinite(difficulty) || picked.data.difficulty === "") {
      ui.notifications.warn(i18n.localize("CARLRPG.PartyCheck.NeedSkill"));
      return;
    }
    if (!picked.actors.length) {
      ui.notifications.warn(i18n.localize("CARLRPG.Toolbox.NoCharactersPicked"));
      return;
    }
    await postPartyCheck({ skill, difficulty, actors: picked.actors });
  }

  /**
   * New scene (ruling Q4): every "Once per scene" cooldown ends, for every
   * actor (module/helpers/cooldowns.mjs startNewScene).
   */
  static async #onNewScene(event, target) {
    if (!game.user.isGM) return;
    await startNewScene();
    ui.notifications.info(game.i18n.localize("CARLRPG.Toolbox.NewSceneDone"));
  }

  /** Skill names for the Party Skill Check's suggestions: the compendiums' and the crawlers' own. */
  static async #skillNames() {
    const names = new Set();
    for (const pack of game.packs) {
      if (pack.documentName !== "Item") continue;
      try {
        const index = await pack.getIndex({ fields: ["type"] });
        for (const entry of index) if (entry.type === "skill") names.add(entry.name);
      } catch (e) {
        // An unreadable pack just adds no names.
      }
    }
    for (const actor of game.actors.filter((a) => a.type === "character")) {
      for (const item of actor.items) if (item.type === "skill") names.add(item.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
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
