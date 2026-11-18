/**
 * Roll-options dialog: Advantage/Disadvantage, an optional Difficulty
 * (pre-filled from p.59's formulas; a GM's situational call goes into it -
 * there's no separate modifier, ruled 2026-11-18), and one checkbox per applicable
 * ChangeEntry.conditions toggle (see module/helpers/modifiers.mjs -
 * conditions are NEVER auto-evaluated; this dialog is the only place they
 * get applied, based on what the player/GM checks per the fiction).
 */
import { showCarlDialog, rollButton, cancelButton } from "../apps/carl-dialog.mjs";
import { slugifySkillName } from "../helpers/modifiers.mjs";

/**
 * When a Damage Effect with more than one `parentSkills` entry is rolled
 * directly (CarlDice.rollDamageEffect), the player must pick which owned
 * Skill/Spell candidate to attack with - one button per candidate, plus
 * Cancel. Not needed (and never called) when there's only one candidate.
 * @param {Item} damageEffectItem
 * @param {Item[]} candidates  Owned Skill/Spell items matching parentSkills.
 * @returns {Promise<string|null>} The chosen candidate's id, or null if cancelled.
 */
export async function promptParentSkillChoice(damageEffectItem, candidates) {
  const buttons = candidates.map((c) => ({
    action: c.id,
    label: c.name,
    callback: () => c.id,
  }));
  buttons.push(cancelButton());
  return showCarlDialog({
    title: game.i18n.format("CARLRPG.Dialog.ChooseParentSkillTitle", { name: damageEffectItem.name }),
    content: `<p>${game.i18n.format("CARLRPG.Dialog.ChooseParentSkillBody", { name: damageEffectItem.name })}</p>`,
    buttons,
  });
}

/**
 * Conditional modifiers relevant to rolling a specific skill/spell/damage
 * effect: every conditionalModifier targeting that skill by name
 * (skillRank/skillDamage), plus every non-skill-scoped one
 * (stat/resource/rollMode/custom), which are offered on any roll for this
 * actor, plus - for an Attack roll - every skillRank/skillDamage-targeted
 * conditionalModifier sourced from one of `extraSourceItemIds` (a Damage
 * Effect candidate for this Attack). A Damage Effect's own conditions
 * target ITSELF, not the parent Skill (e.g. Choke Out/Smush/Skullcracker's
 * grapple-check bonuses), so without this they'd never surface at all when
 * rolling the Skill they're attached to. Surfacing every CANDIDATE's
 * conditions here (not just the one that ends up chosen) is deliberate -
 * CarlDice.rollAttack narrows to only the actually-chosen Damage Effect's
 * conditions once it's known, after the dialog resolves.
 * @param {foundry.abstract.TypeDataModel} actorSystem
 * @param {string|null} skillName
 * @param {string[]} [extraSourceItemIds]
 * @returns {object[]}
 */
export function collectApplicableConditionalModifiers(actorSystem, skillName = null, extraSourceItemIds = []) {
  const list = actorSystem?.conditionalModifiers ?? [];
  const skillKey = skillName ? slugifySkillName(skillName) : null;
  return list.filter((cm) => {
    if (cm.targetType === "skillRank" || cm.targetType === "skillDamage") {
      if (skillKey && slugifySkillName(cm.target) === skillKey) return true;
      return extraSourceItemIds.includes(cm.sourceItemId);
    }
    return true;
  });
}

/**
 * The Stat dropdown for a Skill Check or Attack (Off-Stat, "Determine the
 * Approach", p.58 - Survival rolled with INT instead of CON, p.77): every
 * Stat, the Skill's governing one picked. A Skill with none also offers
 * "None" (no Stat Mod), picked.
 * @param {string} governing  The Skill's governingStat ("" for none).
 * @returns {{selected: string, governing: string, options: {key: string, label: string, selected: boolean}[]}}
 */
export function buildStatChoice(governing = "") {
  const stats = CONFIG.CARLRPG.stats ?? {};
  const keys = [...(governing && !(governing in stats) ? [governing] : []), ...Object.keys(stats)];
  const options = keys.map((key) => ({
    key, label: game.i18n.localize(stats[key] ?? key), selected: key === governing,
  }));
  if (!governing) options.unshift({ key: "", label: game.i18n.localize("CARLRPG.Dialog.NoStat"), selected: true });
  return { selected: governing, governing, options };
}

/**
 * The Stat a roll uses: the dialog's choice when it offered one, else the
 * Skill's own.
 * @param {{statKey?: string}} options  promptRollOptions' result (or the defaults used without a dialog).
 * @param {string} governing
 * @returns {string}
 */
export function chosenStat(options, governing = "") {
  return typeof options?.statKey === "string" ? options.statKey : (governing ?? "");
}

/**
 * The card's note when a roll used another Stat than its Skill's (Off-Stat,
 * p.58): "Rolled with INT instead of CON (Off-Stat)". "" when it didn't.
 * @param {string} statKey
 * @param {string} governing
 * @returns {string}  Trusted HTML.
 */
export function offStatNote(statKey, governing = "") {
  if ((statKey ?? "") === (governing ?? "")) return "";
  const abbr = (key) => (key ? game.i18n.localize(CONFIG.CARLRPG.statAbbreviations?.[key] ?? key) : game.i18n.localize("CARLRPG.Dialog.NoStat"));
  const text = governing
    ? game.i18n.format("CARLRPG.Dialog.OffStatNote", { stat: abbr(statKey), governing: abbr(governing) })
    : game.i18n.format("CARLRPG.Dialog.OffStatNoteNoGoverning", { stat: abbr(statKey) });
  return `<p class="carl-off-stat-note"><i class="fas fa-shuffle" aria-hidden="true"></i> ${foundry.utils.escapeHTML(text)}</p>`;
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {number|null} [options.difficulty]  Pre-filled Difficulty, editable by the GM.
 * @param {"advantage"|null} [options.defaultAdvantage]  Pre-selects the
 *   Advantage dropdown and surfaces a hint explaining why (currently only the
 *   Nat-20/Amazing-Success Evade entitlement - module/dice/dice.mjs's
 *   rollAttack - sets this). Still fully overridable by the player/GM.
 * @param {boolean} [options.showDifficulty]
 * @param {object[]} [options.conditionalModifiers]  From collectApplicableConditionalModifiers().
 * @param {{id: string, name: string, rank: number}[]} [options.damageEffectChoices]  Rank-0
 *   entries are expected to already be filtered out by the caller (docs/known-gaps.md 1.5).
 * @param {{manaCost: number, description: string, isBase: boolean}[]} [options.manaCostChoices]
 *   Spell Mana-cost variants (docs/known-gaps.md 1.6) - index 0 is always the base cost
 *   (`isBase: true`). Built by the caller (module/dice/dice.mjs's buildManaCostChoices).
 * @param {object[]} [options.debuffRows]  Decorated DebuffRows (module/helpers/
 *   debuff-effects.mjs's decorateRows) - one pre-ticked checkbox each, so the
 *   roller can untick a debuff the fiction says doesn't apply.
 * @param {boolean} [options.showRollMode]  false hides the Advantage/
 *   Disadvantage dropdown - a Mob Attack (CarlDice.rollMobAttack) has no d20.
 * @param {string|null} [options.difficultyLabel]  Overrides the Difficulty
 *   field's label (e.g. "Base Difficulty" when debuff rows adjust it).
 * @param {{key: string, label: string, value: number|null, selected?: boolean}[]} [options.difficultyPresets]
 *   p.59's formulas (module/helpers/rules.mjs's buildDifficultyPresets);
 *   picking one fills the Difficulty field. The selected one should match
 *   `difficulty`.
 * @param {{name: string}[]} [options.areaTargets]  The targeted tokens, in
 *   order - shown as Splash checkboxes for an Area Attack (p.83).
 * @param {boolean} [options.isArea]  Pre-ticks "Area Attack".
 * @param {string} [options.weaponNote]  A note that the weapon is swapped in
 *   from the Hotlist for this Attack (module/helpers/weapons.mjs).
 * @param {boolean|null} [options.usesAction]  In a fight: show a "Uses an
 *   Action" box, ticked or not (helpers/actions.mjs). null: no box.
 * @param {{selected: string, governing: string, options: object[]}|null} [options.statChoice]
 *   A Skill Check's or Attack's Stat dropdown (buildStatChoice) - Off-Stat.
 *   The result's `statKey` is the Stat picked. A row marked `dexOnly` (Woozy's
 *   "no DEX Mod") shows only while DEX is picked.
 * @param {{choices: {id: string, label: string}[], selected: string|null,
 *   load: (id: string) => Promise<object|null>}} [options.skillPicker]
 *   The Attack! button's Attack Skill choice (CarlDice.chooseAttack), first
 *   in the dialog, as radios. `selected` is drawn picked, with its options
 *   (these same arguments); picking another calls load(id) for its options
 *   and redraws the rest of the dialog for it, keeping the Advantage,
 *   Difficulty and situational modifier already entered. With nothing
 *   selected only the choice shows.
 * @returns {Promise<{advantage: "normal"|"advantage"|"disadvantage", difficulty: number|null, modifier: number, checked: Set<string>, checkedDebuffs: Set<string>, damageEffectId: string|null, manaCostChoice: number, isArea: boolean, splash: Set<number>, usesAction: boolean|null, statKey?: string, skillId?: string|null}|null>}
 *   null if the dialog was cancelled/closed. skillId: the picked Attack
 *   Skill, with a skillPicker.
 */
export async function promptRollOptions(options = {}) {
  const { title, skillPicker = null } = options;
  // The options the dialog currently shows - a picked Attack Skill's.
  let current = withDefaults(options);
  let selected = skillPicker?.selected ?? null;
  const contextFor = (args) => ({
    // The help icon's tooltip as plain text, for screen readers.
    difficultyHelpText: game.i18n.localize("CARLRPG.Dialog.DifficultyPresetHelp").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    difficulty: args.difficulty, showDifficulty: args.showDifficulty, defaultAdvantage: args.defaultAdvantage,
    conditions: args.conditionalModifiers, damageEffectChoices: args.damageEffectChoices,
    manaCostChoices: args.manaCostChoices, debuffRows: args.debuffRows, showRollMode: args.showRollMode,
    difficultyLabel: args.difficultyLabel,
    // Where the pre-filled Difficulty came from ("Unopposed: 16"), or nothing.
    difficultyBasis: difficultyBasisOf(args.difficultyPresets),
    areaTargets: args.areaTargets, isArea: args.isArea, weaponNote: args.weaponNote,
    // In a fight: whether this roll spends one of the roller's Actions.
    showUsesAction: args.usesAction !== null, usesAction: !!args.usesAction,
    statChoice: args.statChoice,
    // Woozy's "no DEX Mod" row only matters while DEX is picked.
    statIsDex: (args.statChoice?.selected ?? "dex") === "dex",
    skillPicker: skillPicker ? { choices: skillPicker.choices, selected } : null,
    // With a picker, nothing else shows until an Attack Skill is picked.
    hideOptions: !!skillPicker && !selected,
  });

  const result = await showCarlDialog({
    title,
    template: ROLL_OPTIONS_TEMPLATE,
    context: contextFor(current),
    buttons: [rollButton(), cancelButton()],
    // Wide enough for "Situational Modifier" on one line.
    position: { width: 480 },
    classes: ["carl-roll-dialog"],
    onRender: (event, dialog) => {
      const root = dialog.element ?? dialog;
      wireRollOptions(root);
      if (!skillPicker || !(root instanceof HTMLElement)) return;
      setRollEnabled(root, !!selected);
      // A newer pick supersedes a load still in flight.
      let pending = 0;
      root.addEventListener("change", async (changeEvent) => {
        if (!changeEvent.target.matches?.("[data-carl-attack-skill]")) return;
        const id = changeEvent.target.value || null;
        const ticket = ++pending;
        setRollEnabled(root, false);
        const args = id ? await skillPicker.load(id) : null;
        if (ticket !== pending) return;
        const kept = readKeptFields(root);
        selected = args ? id : null;
        current = withDefaults({ ...(args ?? {}), title });
        const html = await foundry.applications.handlebars.renderTemplate(ROLL_OPTIONS_TEMPLATE, contextFor(current));
        if (ticket !== pending) return;
        root.querySelector(".carl-dialog-body")?.replaceWith(htmlToElement(html));
        restoreKeptFields(root, kept);
        wireRollOptions(root);
        setRollEnabled(root, !!selected);
        dialog.setPosition?.({ height: "auto" });
      });
    },
  });
  if (!result) return null;
  if (skillPicker && !selected) return null;

  const { conditionalModifiers, debuffRows, areaTargets, usesAction, statChoice } = current;
  // Each conditionalModifier may list multiple alternative conditions (e.g.
  // "attacking from behind OR flanking"); checking any one of them applies
  // the change once (OR logic, no double-counting).
  const checked = new Set();
  for (const cm of conditionalModifiers) {
    const changeConditions = result.conditions?.[cm.id] ?? {};
    if (Object.values(changeConditions).some(Boolean)) checked.add(cm.id);
  }

  const checkedDebuffs = new Set(debuffRows.filter((row) => result.debuffs?.[row.id]).map((row) => row.id));

  return {
    checkedDebuffs,
    advantage: result.advantage ?? "normal",
    // An emptied number box comes back null (FormDataExtended): no Difficulty.
    difficulty: Number.isFinite(Number(result.difficulty ?? NaN)) && result.difficulty !== "" ? Number(result.difficulty) : null,
    modifier: Number(result.modifier) || 0,
    checked,
    damageEffectId: result.damageEffectId || null,
    manaCostChoice: result.manaCostChoice !== undefined && result.manaCostChoice !== "" ? Number(result.manaCostChoice) : 0,
    isArea: areaTargets.length ? !!result.isArea : false,
    splash: new Set(areaTargets.map((_, i) => i).filter((i) => result.isArea && result.splash?.[i])),
    // null when the box wasn't offered (not in a fight).
    usesAction: usesAction === null ? null : !!result.usesAction,
    // The Stat picked (Off-Stat), when the dialog offered one.
    ...(statChoice ? { statKey: typeof result.stat === "string" ? result.stat : statChoice.selected } : {}),
    ...(skillPicker ? { skillId: selected } : {}),
  };
}

const ROLL_OPTIONS_TEMPLATE = "systems/carl-rpg/templates/dialog/roll-options.hbs";

/** promptRollOptions' arguments with their defaults filled in. */
function withDefaults({
  title, difficulty = null, showDifficulty = true, defaultAdvantage = null,
  conditionalModifiers = [], damageEffectChoices = [], manaCostChoices = [],
  debuffRows = [], showRollMode = true, difficultyLabel = null,
  difficultyPresets = [], areaTargets = [], isArea = false, weaponNote = "", usesAction = null, statChoice = null,
} = {}) {
  return {
    title, difficulty, showDifficulty, defaultAdvantage, conditionalModifiers, damageEffectChoices,
    manaCostChoices, debuffRows, showRollMode, difficultyLabel, difficultyPresets, areaTargets, isArea, weaponNote,
    usesAction, statChoice,
  };
}

/** The dialog's Roll button on or off (off until an Attack Skill is picked). */
function setRollEnabled(root, enabled) {
  const button = root.querySelector('button[data-action="roll"]');
  if (button) button.disabled = !enabled;
}

/** One element from an HTML string (a rendered template's single root). */
function htmlToElement(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

/**
 * What's been entered that doesn't depend on the Attack Skill - Advantage,
 * Difficulty, the situational modifier - to keep across a redraw.
 * @param {HTMLElement} root
 * @returns {{advantage?: string, difficulty?: string, modifier?: string}}
 */
function readKeptFields(root) {
  const kept = {};
  const advantage = root.querySelector('select[name="advantage"]');
  if (advantage) kept.advantage = advantage.value;
  for (const name of ["difficulty"]) {
    const field = root.querySelector(`input[name="${name}"]`);
    if (field) kept[name] = field.value;
  }
  return kept;
}

/** Put readKeptFields' values back after a redraw. */
function restoreKeptFields(root, kept) {
  if (kept.advantage) {
    const advantage = root.querySelector('select[name="advantage"]');
    if (advantage) advantage.value = kept.advantage;
  }
  for (const name of ["difficulty"]) {
    const field = root.querySelector(`input[name="${name}"]`);
    if (field && kept[name] !== undefined) field.value = kept[name];
  }
}

/**
 * The pre-filled Difficulty's source, for the hint under the field: the
 * selected preset's label ("Unopposed: 16", "Opposed vs. Goblin's CHA: 15",
 * "Set Difficulty: 14"), or "" when there's none (Custom, or no presets).
 * @param {{label: string, value: number|null, selected?: boolean}[]} [presets]
 * @returns {string}
 */
export function difficultyBasisOf(presets = []) {
  const picked = (presets ?? []).find((p) => p.selected);
  return picked && picked.value !== null && picked.value !== undefined ? picked.label : "";
}

/**
 * Dialog wiring: the Area Attack checkbox shows/hides the Splash target list.
 * @param {HTMLElement} root
 */
function wireRollOptions(root) {
  if (!(root instanceof HTMLElement)) return;
  const area = root.querySelector("[data-carl-area-toggle]");
  const splash = root.querySelector(".carl-splash-targets");
  if (area && splash) area.addEventListener("change", () => { splash.style.display = area.checked ? "" : "none"; });
  // Off-Stat: Woozy's "no DEX Mod" row only while DEX is the Stat rolled.
  const stat = root.querySelector('select[name="stat"]');
  if (stat) {
    stat.addEventListener("change", () => {
      const isDex = stat.value === "dex";
      for (const row of root.querySelectorAll("[data-carl-dex-only]")) {
        row.hidden = !isDex;
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = isDex;
      }
    });
  }
}
