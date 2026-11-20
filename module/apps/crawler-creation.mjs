/**
 * The Create Crawler wizard: the First Floor character creation steps
 * ("Crawlers & Customization", Starter Set pp.4-19) one page at a time, for
 * one Character. The rules and the final write live in
 * module/helpers/chargen.mjs; this keeps the in-progress choices (`draft` - ApplicationV2 already has a `state`)
 * and draws them.
 *
 * Opened from the Character sheet's "Create Crawler" button, and on its
 * own when someone makes a new Character from the Actors sidebar.
 */
import {
  ANIMAL_SIZES,
  BASE_COMBAT_SKILL,
  COMBAT_OPTIONS,
  CRAWLER_NUMBER_RANGE,
  PAST_TABLES,
  SKILLS_PER_BACKGROUND,
  SPELL_MIN_INT,
  STANDARD_ARRAY,
  STARTING_SETS,
  STAT_ORDER,
  allChargenProblems,
  applyChargen,
  backgroundOptions,
  canRollBackground,
  chargenMethods,
  chargenProblems,
  chargenSkills,
  chargenTable,
  chosenStats,
  combatChoice,
  drawText,
  newChargenState,
  parseBackgroundResult,
  rollStats,
  skillsTakenElsewhere,
  stagesFor,
  tableTexts,
} from "../helpers/chargen.mjs";
import { slugifySkillName } from "../helpers/modifiers.mjs";
import { getStatMod } from "../helpers/rules.mjs";
import { STORY_SECTIONS } from "../helpers/rich-text.mjs";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * The draft's plain text fields. Typing in one changes nothing else on the
 * page, so it doesn't redraw the wizard - a redraw on leaving the box would
 * swallow the click that left it (Next, Create) and lose Tab's focus. Only
 * the problems list and Next/Create are brought up to date.
 */
const TEXT_FIELDS = [
  "name",
  "pronouns",
  "crawlerNumber",
  "combat.weaponName",
  ...Object.keys(PAST_TABLES).map((key) => `past.${key}`),
  "stuff.clothing",
  "stuff.weapon",
  "stuff.item",
  "stuff.weird",
];

/** The draft without its text fields: what a redraw depends on. */
function layoutOf(draft) {
  const copy = foundry.utils.deepClone(draft);
  for (const path of TEXT_FIELDS) foundry.utils.setProperty(copy, path, null);
  return JSON.stringify(copy);
}

/** The wizard's pages, in order. */
const STEPS = ["crawler", "backgrounds", "combat", "stats", "past", "stuff", "review"];

export default class CrawlerCreation extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @param {Actor} actor  The Character being created. */
  constructor(actor, options = {}) {
    super({ id: `carl-chargen-${actor.id}`, ...options });
    this.actor = actor;
    this.draft = newChargenState(actor);
    this.step = 0;
    /** Table choices, loaded once: {stageKey: options[], pastTrauma: string[], ...}. */
    this.tables = null;
    this.busy = false;
  }

  /**
   * Open the wizard for a Character (one window per Character).
   * @param {Actor} actor
   * @returns {CrawlerCreation}
   */
  static open(actor) {
    const existing = foundry.applications.instances.get(`carl-chargen-${actor.id}`);
    if (existing) {
      existing.bringToFront();
      return existing;
    }
    const app = new CrawlerCreation(actor);
    app.render({ force: true });
    return app;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["carl-rpg", "carl-chargen"],
    window: { title: "CARLRPG.Chargen.Title", icon: "fas fa-user-plus", resizable: true },
    position: { width: 640, height: "auto" },
    form: { handler: CrawlerCreation.#onFormChange, submitOnChange: true, closeOnSubmit: false },
    actions: {
      next: CrawlerCreation.#onNext,
      back: CrawlerCreation.#onBack,
      randomNumber: CrawlerCreation.#onRandomNumber,
      rollBackground: CrawlerCreation.#onRollBackground,
      rollStats: CrawlerCreation.#onRollStats,
      rollPast: CrawlerCreation.#onRollPast,
      startingSet: CrawlerCreation.#onStartingSet,
      create: CrawlerCreation.#onCreate,
    },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/apps/crawler-creation.hbs" },
  };

  /** @override */
  get title() {
    return game.i18n.format("CARLRPG.Chargen.TitleFor", { name: this.actor.name });
  }

  /** The current page's key. */
  get stepKey() {
    return STEPS[this.step];
  }

  /** Load every table the wizard offers (once). */
  async #loadTables() {
    if (this.tables) return this.tables;
    const stages = ["human", "animal"].flatMap((kind) => stagesFor({ kind }));
    const pasts = Object.entries(PAST_TABLES);
    // All at once: they don't depend on each other.
    const [stageTables, pastTables] = await Promise.all([
      Promise.all(stages.map((stage) => chargenTable(stage.table))),
      Promise.all(pasts.map(([, name]) => chargenTable(name))),
    ]);
    const tables = {};
    stages.forEach((stage, i) => {
      tables[stage.key] = backgroundOptions(stageTables[i]);
    });
    pasts.forEach(([key], i) => {
      tables[key] = tableTexts(pastTables[i]);
    });
    this.tables = tables;
    return tables;
  }

  /** @override */
  async _prepareContext(options) {
    const tables = await this.#loadTables();
    const state = this.draft;
    const methods = chargenMethods();
    const loc = (key) => game.i18n.localize(key);
    const problems =
      this.stepKey === "review" ? allChargenProblems(state) : chargenProblems(state, this.stepKey);

    const stages = stagesFor(state).map((stage) => {
      const picked = state.stages[stage.key] ?? {};
      const option = tables[stage.key].find((o) => o.name === picked.background) ?? null;
      const taken = skillsTakenElsewhere(state, stage.key);
      const chosen = new Set((picked.skills ?? []).map(slugifySkillName));
      const skillCount = option?.skills.length ?? 0;
      return {
        // Empty rows standing in for the Skills until a background is picked.
        placeholders: Array.from({ length: Math.max(0, 3 - skillCount) }),
        key: stage.key,
        label: loc(`CARLRPG.Chargen.Stage.${stage.key}`),
        rank: stage.rank,
        background: picked.background ?? "",
        rolled: !!picked.rolled,
        canChoose: methods.chooseBackground,
        canRoll: canRollBackground(state, stage.key, option),
        choices: { "": "", ...Object.fromEntries(tables[stage.key].map((o) => [o.name, o.name])) },
        skills: (option?.skills ?? []).map((s, i) => {
          const slug = slugifySkillName(s.name);
          const isChosen = chosen.has(slug);
          return {
            index: i,
            name: s.name,
            stat: s.stat ? s.stat.toUpperCase() : "",
            chosen: isChosen,
            taken: taken.has(slug),
            disabled: !isChosen && (taken.has(slug) || chosen.size >= SKILLS_PER_BACKGROUND),
          };
        }),
      };
    });

    const stats = chosenStats(state);
    const choice = combatChoice(state);
    const weaponChoices = {};
    for (const [group, names] of Object.entries(COMBAT_OPTIONS.weapons)) {
      for (const name of names)
        weaponChoices[name] = `${name} (${loc(`CARLRPG.Chargen.WeaponGroup.${group}`)})`;
    }

    return {
      state,
      step: this.stepKey,
      stepNumber: this.step + 1,
      stepCount: STEPS.length,
      stepLabel: loc(`CARLRPG.Chargen.Step.${this.stepKey}`),
      isFirst: this.step === 0,
      isLast: this.stepKey === "review",
      problems,
      busy: this.busy,
      methods,
      isAnimal: state.kind === "animal",
      kindChoices: { human: "CARLRPG.Chargen.Human", animal: "CARLRPG.Chargen.Animal" },
      sizeChoices: Object.fromEntries(
        ANIMAL_SIZES.map((n) => [n, `${loc(CONFIG.CARLRPG.sizes[n])} (${n})`]),
      ),
      stages,
      baseCombat: BASE_COMBAT_SKILL[state.kind === "animal" ? "animal" : "human"],
      combatTypes: {
        weapon: "CARLRPG.Chargen.Combat.Weapon",
        spell: "CARLRPG.Chargen.Combat.Spell",
        handToHand: "CARLRPG.Chargen.Combat.HandToHand",
        ...(state.kind === "animal" ? { strike: "CARLRPG.Chargen.Combat.Strike" } : {}),
      },
      strikeChoices: Object.fromEntries(COMBAT_OPTIONS.animalStrikes.map((n) => [n, n])),
      weaponChoices,
      spellChoices: Object.fromEntries(COMBAT_OPTIONS.spells.map((n) => [n, n])),
      handToHandChoices: Object.fromEntries(
        Object.entries(COMBAT_OPTIONS.handToHand).map(([s, d]) => [s, `${s} + ${d}`]),
      ),
      spellMinInt: SPELL_MIN_INT,
      statRows: STAT_ORDER.map((key) => {
        const value =
          stats?.[key] ??
          (state.statMethod === "roll"
            ? state.rolledStats?.[key]
            : Number(state.arrayStats[key]) || null);
        return {
          key,
          label: loc(CONFIG.CARLRPG.stats[key]),
          arrayValue: state.arrayStats[key] ?? "",
          rolled: state.rolledStats?.[key] ?? null,
          mod: value ? getStatMod(value) : null,
        };
      }),
      arrayChoices: { "": "", ...Object.fromEntries(STANDARD_ARRAY.map((n) => [n, String(n)])) },
      statMethodChoices: Object.fromEntries([
        ...(methods.statArray ? [["array", "CARLRPG.Chargen.StatArray"]] : []),
        ...(methods.statRoll ? [["roll", "CARLRPG.Chargen.StatRoll"]] : []),
      ]),
      derived: stats
        ? {
            hbSlot: getStatMod(stats.con),
            mana: stats.int,
            evade: getStatMod(stats.dex),
          }
        : null,
      past: Object.keys(PAST_TABLES).map((key) => ({
        key,
        label: loc(STORY_SECTIONS.find((s) => s.field === key)?.key ?? key),
        value: state.past[key] ?? "",
        choices: { "": "", ...Object.fromEntries(tables[key].map((text) => [text, text])) },
      })),
      startingSets: Object.keys(STARTING_SETS).map((key) => ({
        key,
        label: loc(`CARLRPG.Chargen.Set.${key}`),
      })),
      showWeaponStuff: state.combat.type === "weapon",
      review:
        this.stepKey === "review"
          ? {
              skills: chargenSkills(state),
              stats: STAT_ORDER.map((k) => ({
                label: loc(CONFIG.CARLRPG.stats[k]),
                value: stats?.[k] ?? "-",
              })),
              combat: choice,
            }
          : null,
    };
  }

  /* -------------------------------------------- */
  /*  Form                                        */
  /* -------------------------------------------- */

  /**
   * A field changed: merge the page's fields into the state, then redraw.
   * @this {CrawlerCreation}
   */
  static async #onFormChange(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const state = this.draft;
    const before = layoutOf(state);
    // Picking a Past from its list fills that text box: a redraw shows it.
    const picked = Object.values(data.pastPick ?? {}).some(Boolean);
    for (const key of ["name", "pronouns", "crawlerNumber"])
      if (key in data) state[key] = String(data[key] ?? "");
    if ("kind" in data && data.kind !== state.kind) {
      state.kind = data.kind;
      state.stages = {};
      // A human has no strike Skills to pick from.
      if (state.kind !== "animal" && state.combat.type === "strike") state.combat.type = "weapon";
    }
    if ("size" in data) state.size = Number(data.size);
    if (data.stage) {
      for (const [key, value] of Object.entries(data.stage)) this.#mergeStage(key, value);
    }
    if (data.combat) Object.assign(state.combat, data.combat);
    if ("statMethod" in data) state.statMethod = data.statMethod;
    if (data.array) Object.assign(state.arrayStats, data.array);
    if (data.pastPick) {
      for (const [key, value] of Object.entries(data.pastPick)) if (value) state.past[key] = value;
    }
    if (data.past) {
      for (const [key, value] of Object.entries(data.past)) {
        // A pick from the list wins over the (unchanged) text box it fills.
        if (!data.pastPick?.[key]) state.past[key] = String(value ?? "");
      }
    }
    if (data.stuff) Object.assign(state.stuff, data.stuff);
    if (!picked && layoutOf(state) === before) this.#refreshNav();
    else this.render();
  }

  /**
   * Bring the problems list and Next/Create up to date without a redraw
   * (after a text field changed - see TEXT_FIELDS).
   */
  #refreshNav() {
    const el = this.element;
    if (!el) return;
    const problems =
      this.stepKey === "review"
        ? allChargenProblems(this.draft)
        : chargenProblems(this.draft, this.stepKey);
    const list = el.querySelector(".carl-chargen-problems");
    if (list) {
      list.replaceChildren(
        ...problems.map((problem) => {
          const li = document.createElement("li");
          const icon = document.createElement("i");
          icon.className = "fas fa-exclamation-triangle";
          li.append(icon, " ", problem);
          return li;
        }),
      );
      list.hidden = !problems.length;
    }
    for (const button of el.querySelectorAll('[data-action="next"], [data-action="create"]')) {
      button.disabled = problems.length > 0 || this.busy;
    }
    this.setPosition({ height: "auto" });
  }

  /**
   * One background card's fields: a new background (its Skills reset), or
   * its Skill boxes - two at most, never a Skill taken elsewhere.
   * @param {string} key  The stage key.
   * @param {{background?: string, skill?: Record<string, boolean>}} value
   */
  #mergeStage(key, value) {
    const state = this.draft;
    const current = state.stages[key] ?? { background: "", rolled: false, skills: [] };
    if (value.background !== undefined && value.background !== current.background) {
      state.stages[key] = { background: value.background, rolled: false, skills: [] };
      return;
    }
    if (!value.skill) return;
    const option = this.tables[key]?.find((o) => o.name === current.background);
    if (!option) return;
    const taken = skillsTakenElsewhere(state, key);
    const wanted = option.skills
      .filter((s, i) => value.skill[i] && !taken.has(slugifySkillName(s.name)))
      .map((s) => s.name);
    // Keep the earlier picks first, so a third tick is the one dropped.
    const ordered = [
      ...current.skills.filter((n) => wanted.includes(n)),
      ...wanted.filter((n) => !current.skills.includes(n)),
    ];
    state.stages[key] = { ...current, skills: ordered.slice(0, SKILLS_PER_BACKGROUND) };
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** @this {CrawlerCreation} */
  static #onNext() {
    if (chargenProblems(this.draft, this.stepKey).length) return;
    this.step = Math.min(STEPS.length - 1, this.step + 1);
    this.render();
  }

  /** @this {CrawlerCreation} */
  static #onBack() {
    this.step = Math.max(0, this.step - 1);
    this.render();
  }

  /** "Choose a number between 500,000 and 12,900,000" - or let the dice. @this {CrawlerCreation} */
  static #onRandomNumber() {
    const [min, max] = CRAWLER_NUMBER_RANGE;
    this.draft.crawlerNumber = String(min + Math.floor(Math.random() * (max - min + 1)));
    this.render();
  }

  /** Roll one background on its table (shown in chat). @this {CrawlerCreation} */
  static async #onRollBackground(event, target) {
    const key = target.dataset.stage;
    const stage = stagesFor(this.draft).find((s) => s.key === key);
    const current =
      this.tables?.[key]?.find((o) => o.name === this.draft.stages[key]?.background) ?? null;
    if (!stage || !canRollBackground(this.draft, key, current)) return;
    const table = await chargenTable(stage.table);
    if (!table) return;
    const parsed = parseBackgroundResult(await drawText(table));
    if (!parsed) return;
    this.draft.stages[key] = { background: parsed.name, rolled: true, skills: [] };
    this.render();
  }

  /** Roll the Stats, once ("No takesie-backsies"). @this {CrawlerCreation} */
  static async #onRollStats() {
    if (this.draft.rolledStats) return;
    this.draft.statMethod = "roll";
    this.draft.rolledStats = await rollStats(this.actor);
    this.render();
  }

  /** Roll a Past Trauma, Loose End or Regret (shown in chat). @this {CrawlerCreation} */
  static async #onRollPast(event, target) {
    const key = target.dataset.past;
    const table = PAST_TABLES[key] ? await chargenTable(PAST_TABLES[key]) : null;
    if (!table) return;
    this.draft.past[key] = await drawText(table);
    this.render();
  }

  /** Fill Starting Stuff from an example set. @this {CrawlerCreation} */
  static #onStartingSet(event, target) {
    const set = STARTING_SETS[target.dataset.set];
    if (!set) return;
    const { weaponSkill, ...stuff } = set;
    Object.assign(this.draft.stuff, stuff);
    // The set's weapon is only kept when it's the crawler's weapon Skill.
    if (this.draft.combat.type !== "weapon" || this.draft.combat.weapon !== weaponSkill)
      this.draft.stuff.weapon = "";
    this.render();
  }

  /** Build the crawler. @this {CrawlerCreation} */
  static async #onCreate() {
    if (this.busy || allChargenProblems(this.draft).length) return;
    this.busy = true;
    this.render();
    try {
      await applyChargen(this.actor, this.draft);
      ui.notifications.info(game.i18n.format("CARLRPG.Chargen.Created", { name: this.actor.name }));
      await this.close();
      this.actor.sheet?.render({ force: true });
    } catch (err) {
      console.error("CarlRPG | character creation failed", err);
      ui.notifications.error(game.i18n.format("CARLRPG.Chargen.Failed", { error: err.message }));
      this.busy = false;
      this.render();
    }
  }
}
