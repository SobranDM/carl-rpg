import {
  canAdvance,
  currentCrawler,
  pressSession,
  sessionState,
} from "../helpers/opening-session.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The Opening Session window (helpers/opening-session.mjs), on every
 * client: the current crawler's boxes, Bronze first (each box's title its
 * tooltip); Open! starts them, one at a time - the box shakes and glows,
 * then shows what came out - and Next! moves on. Only that crawler's player
 * or the GM can press them; the GM also has Skip Player and End. An
 * ordinary window, not kept on top: sheets open over it, and each client
 * keeps it where they put it (ruled 2026-11-19).
 */
export default class OpeningSessionApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "carl-opening-session",
    classes: ["carl-rpg", "carl-opening-session"],
    window: { title: "CARLRPG.Opening.Title", icon: "fas fa-box-open", resizable: true },
    position: { width: 520, height: "auto" },
    actions: {
      open: OpeningSessionApp.#press,
      next: OpeningSessionApp.#press,
      skip: OpeningSessionApp.#press,
      end: OpeningSessionApp.#press,
    },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/opening-session.hbs" },
  };

  /**
   * Draw the session here as it changes: open the window when one is on,
   * close it when it ends. The setting's onChange, and `ready`.
   * @param {object} [state]
   */
  static sync(state = sessionState()) {
    const app = foundry.applications.instances.get("carl-opening-session");
    if (!state?.active) {
      app?.close();
      return;
    }
    if (app) app.render({ force: !app.rendered });
    else new OpeningSessionApp().render({ force: true });
  }

  /** Where this client last put the window. @override */
  _initializeApplicationOptions(options) {
    const opts = super._initializeApplicationOptions(options);
    const saved = game.settings.get("carl-rpg", "openingSessionPosition") ?? {};
    for (const key of ["left", "top", "width"]) {
      if (Number.isFinite(saved[key])) opts.position[key] = saved[key];
    }
    return opts;
  }

  /** Keep where it's put (this client only). @override */
  setPosition(position) {
    const result = super.setPosition(position);
    if (this.rendered) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = setTimeout(() => {
        const { left, top, width } = this.position;
        game.settings.set("carl-rpg", "openingSessionPosition", { left, top, width });
      }, 500);
    }
    return result;
  }

  #saveTimer = null;

  /** @override */
  async _prepareContext(options) {
    const state = sessionState();
    const actor = currentCrawler(state);
    const tiers = CONFIG.CARLRPG.lootBoxTiers;
    const box = state.boxes?.[state.box] ?? null;
    const result = state.result;
    return {
      step: state.step,
      isGM: game.user.isGM,
      canAdvance: canAdvance(game.user, state),
      crawler: actor ? { name: actor.name, img: actor.img } : null,
      boxes: (state.boxes ?? []).map((b) => ({
        ...b,
        tierLabel: tiers[b.tierKey]?.label ?? b.tierKey,
      })),
      count: { at: (state.box ?? 0) + 1, of: state.boxes?.length ?? 0 },
      box,
      result:
        result && !result.failed
          ? {
              gold: result.gold,
              items: result.items,
              empty: !result.gold && !result.items?.length,
            }
          : null,
      failed: !!result?.failed,
      lastBox: (state.box ?? 0) + 1 >= (state.boxes?.length ?? 0),
    };
  }

  /** Any of the buttons: sent to the GM's client, which checks it. */
  static async #press(event, target) {
    target.disabled = true;
    const done = await pressSession(target.dataset.action);
    if (!done && this.rendered) target.disabled = false;
  }
}
