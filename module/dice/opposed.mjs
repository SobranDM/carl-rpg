import { currentFloor } from "../helpers/floor.mjs";
import { opposedDifficulty } from "../helpers/rules.mjs";
import { esc } from "../helpers/html.mjs";

/**
 * Opposed Checks (p.59; ruled 2026-11-20): "10 + antagonist's relevant Stat
 * Mod + Floor Number" - the GM never rolls, the opponent's number sets the
 * Difficulty. Any Skill or Stat Check can be made Opposed (p.106: "Checks
 * labeled as Unopposed can, at the GM's discretion, become Opposed"):
 *
 *  - the opponent: a targeted token (several: the hardest of them), any
 *    token on the scene, or "a number" - "The Stat Mod value could be
 *    replaced by a Spell Rank, a size class, or whatever force the crawler
 *    is up against";
 *  - the Stat they oppose with: the Skill's own opposed Stat if it has one,
 *    else the Stat the crawler rolls with (a chase's "Running Skill Check is
 *    Opposed by the quarry's Dex Mod", p.75), following it while the crawler
 *    changes theirs (Off-Stat) until the opposing one is picked.
 *
 * The controls (opposedFieldsHtml) sit under a Difficulty field and set it
 * live (wireOpposed); unticked, it goes back to the roll's own Difficulty.
 * Used by the roll dialog (dice/roll-prompt.mjs) and the GM Toolbox's Party
 * Skill Check.
 */

const STATS = () => Object.keys(CONFIG.CARLRPG.stats);

/** An actor's Stat Mods, by Stat. */
function modsOf(actor) {
  return Object.fromEntries(STATS().map((k) => [k, actor?.system?.stats?.[k]?.mod ?? 0]));
}

/** The highest of several actors' Mods, Stat by Stat (the hardest to beat). */
function hardestMods(actors) {
  return Object.fromEntries(
    STATS().map((k) => [k, Math.max(...actors.map((a) => a.system?.stats?.[k]?.mod ?? 0))]),
  );
}

/**
 * Who a Check can be Opposed by: the targeted tokens - with two or more, the
 * hardest of them first (#44) - then the scene's other tokens, then "a
 * number".
 * @returns {{id: string, name: string, mods: Record<string, number>|null, targeted: boolean}[]}
 */
export function opposedOpponents() {
  const targets = [...(game.user.targets ?? [])].filter((t) => t.actor);
  const targetIds = new Set(targets.map((t) => t.id));
  const others =
    (canvas?.ready ? canvas.tokens?.placeables : [])
      ?.filter((t) => t.actor && !targetIds.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name)) ?? [];
  const list = [];
  if (targets.length > 1) {
    list.push({
      id: "targets",
      name: game.i18n.format("CARLRPG.Opposed.Hardest", { count: targets.length }),
      mods: hardestMods(targets.map((t) => t.actor)),
      targeted: true,
    });
  }
  for (const t of targets)
    list.push({ id: t.id, name: t.name, mods: modsOf(t.actor), targeted: true });
  for (const t of others)
    list.push({ id: t.id, name: t.name, mods: modsOf(t.actor), targeted: false });
  list.push({
    id: "other",
    name: game.i18n.localize("CARLRPG.Opposed.Other"),
    mods: null,
    targeted: false,
  });
  return list;
}

/**
 * The Opposed controls for a roll.
 * @param {object} options
 * @param {string} [options.statKey]  The Stat it's opposed with to start: the Skill's opposed Stat, else the one rolled.
 * @param {boolean} [options.follow]  Follow the rolled Stat (no opposed Stat of its own).
 * @param {boolean} [options.opposed]  Start ticked (a Skill that's Opposed, at a target).
 * @param {{value: number|null, label: string}} options.base  The roll's own Difficulty, unticked.
 * @returns {object}  For opposedFieldsHtml / readOpposed.
 */
export function buildOpposedChoice({ statKey = "", follow = false, opposed = false, base }) {
  const opponents = opposedOpponents();
  const firstTarget = opponents.find((o) => o.targeted);
  const selected = firstTarget?.id ?? opponents[0].id;
  const stat = statKey && STATS().includes(statKey) ? statKey : "int";
  const choice = {
    opponents,
    selected,
    statKey: stat,
    follow,
    floor: currentFloor(),
    opposed: opposed && !!firstTarget,
    base: { value: base?.value ?? null, label: base?.label ?? "" },
  };
  choice.difficulty = choice.opposed ? opposedValue(choice) : choice.base.value;
  choice.label = choice.opposed ? opposedLabel(choice) : choice.base.label;
  return choice;
}

/** The Mod the picked opponent opposes with. */
function pickedMod(choice, opponentId = choice.selected, statKey = choice.statKey, number = 0) {
  const opponent = choice.opponents.find((o) => o.id === opponentId);
  if (!opponent?.mods) return Number(number) || 0;
  return opponent.mods[statKey] ?? 0;
}

/** The Opposed Difficulty for the choice as it stands. */
function opposedValue(choice) {
  return opposedDifficulty(pickedMod(choice), choice.floor);
}

/** "Opposed vs. Goblin's INT: 15" (or "vs. 3: 16" for a number). */
function opposedLabel(
  choice,
  { opponentId = choice.selected, statKey = choice.statKey, number = 0 } = {},
) {
  const opponent = choice.opponents.find((o) => o.id === opponentId);
  const value = opposedDifficulty(pickedMod(choice, opponentId, statKey, number), choice.floor);
  if (!opponent?.mods) {
    return game.i18n.format("CARLRPG.Opposed.LabelNumber", { number: Number(number) || 0, value });
  }
  return game.i18n.format("CARLRPG.Dialog.Preset.Opposed", {
    name: opponent.name,
    stat: game.i18n.localize(CONFIG.CARLRPG.statAbbreviations[statKey] ?? statKey),
    value,
  });
}

/**
 * The controls' HTML: "Opposed" ticked or not, by whom, with which Stat (or
 * a number). Trusted - every value escaped.
 * @param {object} choice  buildOpposedChoice's.
 * @returns {string}
 */
export function opposedFieldsHtml(choice) {
  if (!choice) return "";
  const i18n = game.i18n;
  const opt = (o) =>
    `<option value="${esc(o.id)}"${o.id === choice.selected ? " selected" : ""}${
      o.mods ? ` data-mods="${esc(JSON.stringify(o.mods))}"` : ""
    }>${esc(o.name)}</option>`;
  const targeted = choice.opponents.filter((o) => o.targeted);
  const others = choice.opponents.filter((o) => !o.targeted && o.mods);
  const other = choice.opponents.find((o) => o.id === "other");
  const group = (key, list) =>
    list.length
      ? `<optgroup label="${esc(i18n.localize(key))}">${list.map(opt).join("")}</optgroup>`
      : "";
  const stats = STATS()
    .map(
      (k) =>
        `<option value="${k}"${k === choice.statKey ? " selected" : ""}>${esc(
          i18n.localize(CONFIG.CARLRPG.statAbbreviations[k] ?? k),
        )}</option>`,
    )
    .join("");
  const off = choice.opposed ? "" : " disabled";
  return `<div class="form-group carl-dialog-opposed" data-carl-opposed data-floor="${choice.floor}"
      data-base-value="${esc(choice.base.value ?? "")}" data-base-label="${esc(choice.base.label)}"${
        choice.follow ? " data-follow" : ""
      }>
    <label class="checkbox" data-tooltip-text="${esc(i18n.localize("CARLRPG.Opposed.Hint"))}">
      <input type="checkbox" name="opposed"${choice.opposed ? " checked" : ""} />
      ${esc(i18n.localize("CARLRPG.Opposed.Label"))}
    </label>
    <div class="form-fields">
      <select name="opposedBy" aria-label="${esc(i18n.localize("CARLRPG.Opposed.By"))}"${off}>
        ${group("CARLRPG.Opposed.Targeted", targeted)}${group("CARLRPG.Opposed.Scene", others)}${other ? opt(other) : ""}
      </select>
      <select name="opposedStat" aria-label="${esc(i18n.localize("CARLRPG.Opposed.Stat"))}"${off}${
        choice.selected === "other" ? " hidden" : ""
      }>${stats}</select>
      <input type="number" name="opposedNumber" value="0" class="carl-w-tiny"
        aria-label="${esc(i18n.localize("CARLRPG.Opposed.Number"))}"
        data-tooltip-text="${esc(i18n.localize("CARLRPG.Opposed.NumberHint"))}"${off}${
          choice.selected === "other" ? "" : " hidden"
        } />
    </div>
  </div>`;
}

/**
 * Wire the controls: every change sets the Difficulty field and its "where
 * it came from" line; unticked, they go back to the roll's own.
 * @param {HTMLElement} root
 * @param {{difficulty: HTMLInputElement|null, basis: HTMLElement|null}} fields
 */
export function wireOpposed(root, { difficulty, basis }) {
  const box = root?.querySelector?.("[data-carl-opposed]");
  if (!box) return;
  const on = box.querySelector('[name="opposed"]');
  const by = box.querySelector('[name="opposedBy"]');
  const stat = box.querySelector('[name="opposedStat"]');
  const number = box.querySelector('[name="opposedNumber"]');
  const floor = Number(box.dataset.floor) || 0;
  const update = () => {
    const isNumber = by.value === "other";
    stat.hidden = isNumber;
    number.hidden = !isNumber;
    for (const field of [by, stat, number]) field.disabled = !on.checked;
    if (!on.checked) {
      if (difficulty) difficulty.value = box.dataset.baseValue;
      if (basis) basis.textContent = box.dataset.baseLabel;
      return;
    }
    const mods = isNumber ? null : JSON.parse(by.selectedOptions[0]?.dataset.mods ?? "{}");
    const mod = isNumber ? Number(number.value) || 0 : (mods[stat.value] ?? 0);
    const value = opposedDifficulty(mod, floor);
    if (difficulty) difficulty.value = value;
    if (basis) {
      basis.textContent = isNumber
        ? game.i18n.format("CARLRPG.Opposed.LabelNumber", { number: mod, value })
        : game.i18n.format("CARLRPG.Dialog.Preset.Opposed", {
            name: by.selectedOptions[0]?.textContent ?? "",
            stat: stat.selectedOptions[0]?.textContent ?? "",
            value,
          });
    }
  };
  for (const field of [on, by, stat]) field.addEventListener("change", update);
  number.addEventListener("input", update);
  // No opposed Stat of its own: it follows the Stat rolled (Off-Stat) until
  // the opposing one is picked.
  const rolled = root.querySelector('select[name="stat"]');
  if (rolled && box.hasAttribute("data-follow")) {
    let picked = false;
    stat.addEventListener("change", () => (picked = true));
    rolled.addEventListener("change", () => {
      if (picked || !rolled.value) return;
      stat.value = rolled.value;
      update();
    });
  }
}

/**
 * What the roller picked: who opposed it and with what - for the card's
 * note. Null when it wasn't Opposed.
 * @param {{opposed?: boolean, opposedBy?: string, opposedStat?: string, opposedNumber?: number|string}} values
 * @param {object|null} choice  buildOpposedChoice's.
 * @returns {{name: string, statKey: string|null, mod: number}|null}
 */
export function readOpposed(values, choice) {
  if (!choice || !values?.opposed) return null;
  const opponent = choice.opponents.find((o) => o.id === values.opposedBy);
  if (!opponent) return null;
  if (!opponent.mods) {
    return { name: null, statKey: null, mod: Number(values.opposedNumber) || 0 };
  }
  const statKey = STATS().includes(values.opposedStat) ? values.opposedStat : choice.statKey;
  return { name: opponent.name, statKey, mod: opponent.mods[statKey] ?? 0 };
}

/**
 * The card's note: "Opposed by Goblin's INT (+3)", or "Opposed by 3 (a
 * Spell Rank, a size class...)". "" when it wasn't Opposed.
 * @param {{name: string|null, statKey: string|null, mod: number}|null} opposed
 * @returns {string}  Trusted HTML.
 */
export function opposedNote(opposed) {
  if (!opposed) return "";
  const signed = `${opposed.mod >= 0 ? "+" : ""}${opposed.mod}`;
  const text = opposed.name
    ? game.i18n.format("CARLRPG.Opposed.Note", {
        name: opposed.name,
        stat: game.i18n.localize(
          CONFIG.CARLRPG.statAbbreviations[opposed.statKey] ?? opposed.statKey,
        ),
        mod: signed,
      })
    : game.i18n.format("CARLRPG.Opposed.NoteNumber", { mod: signed });
  return `<p class="carl-opposed-note"><i class="fas fa-people-arrows" aria-hidden="true"></i> ${esc(text)}</p>`;
}
