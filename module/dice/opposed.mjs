import { currentFloor } from "../helpers/floor.mjs";
import { opposedDifficulty } from "../helpers/rules.mjs";
import { esc } from "../helpers/html.mjs";

/**
 * Opposed Checks (p.59; ruled 2026-11-20): "10 + antagonist's relevant Stat
 * Mod + Floor Number" - the GM never rolls, the opponent's number sets the
 * Difficulty. Any Skill or Stat Check can be made Opposed (p.106: "Checks
 * labeled as Unopposed can, at the GM's discretion, become Opposed"):
 *
 *  - the opponent: a targeted token (several: the hardest of them, Stat by
 *    Stat - its name is the creature with that Mod), another creature on the
 *    scene the user can see, or "a number" - "The Stat Mod value could be
 *    replaced by a Spell Rank, a size class, or whatever force the crawler
 *    is up against". With nothing targeted it starts on the number;
 *  - the Stat they oppose with: the Skill's own opposed Stat if it has one,
 *    else the Stat the crawler rolls with (a chase's "Running Skill Check is
 *    Opposed by the quarry's Dex Mod", p.75), following it while the crawler
 *    changes theirs (Off-Stat) until the opposing one is picked.
 *
 * The controls (opposedFieldsHtml) sit under a Difficulty field and set it
 * live (wireOpposed); unticking goes back to the roll's own Difficulty. One
 * function (resolveOpposed) works out the Mod, the Difficulty and the words
 * for the first draw, every change and the card. Used by the roll dialog
 * (dice/roll-prompt.mjs) and the GM Toolbox's Party Skill Check.
 */

const STATS = () => Object.keys(CONFIG.CARLRPG.stats);

/** Does this actor have Stats to oppose with (not a Loot Box or a vehicle)? */
function hasStats(actor) {
  return STATS().some((k) => Number.isFinite(actor?.system?.stats?.[k]?.mod));
}

/** An actor's Stat Mods, by Stat. */
function modsOf(actor) {
  return Object.fromEntries(STATS().map((k) => [k, actor?.system?.stats?.[k]?.mod ?? 0]));
}

/**
 * The hardest of several tokens to beat with one Stat: the one with the
 * highest Mod (ruled 2026-11-20, #44). The dice's own Opposed presets use it
 * too.
 * @param {Token[]} tokens
 * @param {string} statKey
 * @returns {Token|null}
 */
export function hardestTarget(tokens, statKey) {
  const modOf = (t) => t.actor?.system?.stats?.[statKey]?.mod ?? 0;
  return tokens.reduce((best, t) => (!best || modOf(t) > modOf(best) ? t : best), null);
}

/**
 * Who a Check can be Opposed by: the targeted tokens - with two or more, the
 * hardest of them first - then the other creatures on the scene this user
 * can see (not the roller's own), then "a number".
 * @param {Actor|null} [self]  The roller, left out of the list.
 * @returns {{id: string, name: string, mods: Record<string, number>|null,
 *   names?: Record<string, string>, targeted: boolean}[]}
 */
export function opposedOpponents(self = null) {
  const targets = [...(game.user.targets ?? [])].filter((t) => hasStats(t.actor));
  const targetIds = new Set(targets.map((t) => t.id));
  const others =
    (canvas?.ready ? canvas.tokens?.placeables : [])
      ?.filter(
        (t) =>
          hasStats(t.actor) &&
          !targetIds.has(t.id) &&
          t.actor !== self &&
          (game.user.isGM || !t.document.hidden),
      )
      .sort((a, b) => a.name.localeCompare(b.name)) ?? [];
  const list = [];
  if (targets.length > 1) {
    // Stat by Stat, the hardest - and who that is, for the card.
    const hardest = Object.fromEntries(STATS().map((k) => [k, hardestTarget(targets, k)]));
    list.push({
      id: "targets",
      name: game.i18n.format("CARLRPG.Opposed.Hardest", { count: targets.length }),
      mods: Object.fromEntries(STATS().map((k) => [k, modsOf(hardest[k].actor)[k]])),
      names: Object.fromEntries(STATS().map((k) => [k, hardest[k].name])),
      targeted: true,
    });
  }
  for (const t of targets) {
    list.push({ id: t.id, name: t.name, mods: modsOf(t.actor), targeted: true });
  }
  for (const t of others) {
    list.push({ id: t.id, name: t.name, mods: modsOf(t.actor), targeted: false });
  }
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
 * @param {Actor|null} [options.self]  The roller (not an opponent of their own).
 * @returns {object}  For opposedFieldsHtml / wireOpposed / readOpposed.
 */
export function buildOpposedChoice({
  statKey = "",
  follow = false,
  opposed = false,
  base,
  self = null,
}) {
  const opponents = opposedOpponents(self);
  const firstTarget = opponents.find((o) => o.targeted);
  const choice = {
    opponents,
    // Nothing targeted: a number, not whoever sorts first on the scene.
    selected: firstTarget?.id ?? "other",
    statKey: statKey && STATS().includes(statKey) ? statKey : "int",
    follow,
    floor: currentFloor(),
    opposed: opposed && !!firstTarget,
    base: { value: base?.value ?? null, label: base?.label ?? "" },
  };
  const now = resolveOpposed(choice);
  choice.difficulty = choice.opposed ? now.value : choice.base.value;
  choice.label = choice.opposed ? now.label : choice.base.label;
  return choice;
}

/**
 * Who opposes it, with what Mod, the Difficulty that makes, and the words
 * for it: "Opposed vs. Goblin's INT: 15", "Opposed by 3: 16".
 * @param {object} choice  buildOpposedChoice's.
 * @param {{opponentId?: string, statKey?: string, number?: number|string}} [picked]
 * @returns {{name: string|null, statKey: string|null, mod: number, value: number, label: string}|null}
 */
export function resolveOpposed(choice, picked = {}) {
  const opponentId = picked.opponentId ?? choice.selected;
  const statKey = STATS().includes(picked.statKey) ? picked.statKey : choice.statKey;
  const opponent = choice.opponents.find((o) => o.id === opponentId);
  if (!opponent) return null;
  if (!opponent.mods) {
    const mod = Number(picked.number) || 0;
    const value = opposedDifficulty(mod, choice.floor);
    return {
      name: null,
      statKey: null,
      mod,
      value,
      label: game.i18n.format("CARLRPG.Opposed.LabelNumber", { number: mod, value }),
    };
  }
  const mod = opponent.mods[statKey] ?? 0;
  const value = opposedDifficulty(mod, choice.floor);
  // The hardest of several: named as the creature with that Mod.
  const name = opponent.names?.[statKey] ?? opponent.name;
  return {
    name,
    statKey,
    mod,
    value,
    label: game.i18n.format("CARLRPG.Dialog.Preset.Opposed", {
      name,
      stat: game.i18n.localize(CONFIG.CARLRPG.statAbbreviations[statKey] ?? statKey),
      value,
    }),
  };
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
    `<option value="${esc(o.id)}"${o.id === choice.selected ? " selected" : ""}>${esc(o.name)}</option>`;
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
  const isNumber = choice.selected === "other";
  return `<div class="form-group carl-dialog-opposed" data-carl-opposed${choice.follow ? " data-follow" : ""}>
    <label class="checkbox" data-tooltip-text="${esc(i18n.localize("CARLRPG.Opposed.Hint"))}">
      <input type="checkbox" name="opposed"${choice.opposed ? " checked" : ""} />
      ${esc(i18n.localize("CARLRPG.Opposed.Label"))}
    </label>
    <div class="form-fields">
      <select name="opposedBy" aria-label="${esc(i18n.localize("CARLRPG.Opposed.By"))}"${off}>
        ${group("CARLRPG.Opposed.Targeted", targeted)}${group("CARLRPG.Opposed.Scene", others)}${other ? opt(other) : ""}
      </select>
      <select name="opposedStat" aria-label="${esc(i18n.localize("CARLRPG.Opposed.Stat"))}"${off}${
        isNumber ? " hidden" : ""
      }>${stats}</select>
      <input type="number" name="opposedNumber" value="0" class="carl-w-tiny"
        aria-label="${esc(i18n.localize("CARLRPG.Opposed.Number"))}"
        data-tooltip-text="${esc(i18n.localize("CARLRPG.Opposed.NumberHint"))}"${off}${
          isNumber ? "" : " hidden"
        } />
    </div>
  </div>`;
}

/**
 * Wire the controls: ticking, or changing who or which Stat, sets the
 * Difficulty field and its "where it came from" line; unticking puts the
 * roll's own Difficulty back. A Difficulty typed by hand stays until one of
 * those changes.
 * @param {HTMLElement} root
 * @param {{difficulty: HTMLInputElement|null, basis: HTMLElement|null, choice: object|null}} fields
 * @returns {{setStat: (statKey: string, tick?: boolean) => void}|null}  To pick
 *   the Stat from outside (the Party Check, once its Skill is known).
 */
export function wireOpposed(root, { difficulty, basis, choice }) {
  const box = root?.querySelector?.("[data-carl-opposed]");
  if (!box || !choice) return null;
  const on = box.querySelector('[name="opposed"]');
  const by = box.querySelector('[name="opposedBy"]');
  const stat = box.querySelector('[name="opposedStat"]');
  const number = box.querySelector('[name="opposedNumber"]');
  const update = () => {
    const isNumber = by.value === "other";
    stat.hidden = isNumber;
    number.hidden = !isNumber;
    for (const field of [by, stat, number]) field.disabled = !on.checked;
    if (!on.checked) {
      if (difficulty) difficulty.value = choice.base.value ?? "";
      if (basis) basis.textContent = choice.base.label;
      return;
    }
    const now = resolveOpposed(choice, {
      opponentId: by.value,
      statKey: stat.value,
      number: number.value,
    });
    if (!now) return;
    if (difficulty) difficulty.value = now.value;
    if (basis) basis.textContent = now.label;
  };
  for (const field of [on, by, stat]) field.addEventListener("change", update);
  number.addEventListener("input", update);
  // No opposed Stat of its own: it follows the Stat rolled (Off-Stat) until
  // the opposing one is picked - and only changes the Difficulty while
  // ticked, so a Difficulty typed by hand isn't lost.
  let picked = false;
  stat.addEventListener("change", () => (picked = true));
  const rolled = root.querySelector('select[name="stat"]');
  if (rolled && box.hasAttribute("data-follow")) {
    rolled.addEventListener("change", () => {
      if (picked || !rolled.value) return;
      stat.value = rolled.value;
      if (on.checked) update();
    });
  }
  return {
    setStat(statKey, tick = false) {
      if (!STATS().includes(statKey) || picked) return;
      stat.value = statKey;
      if (tick && choice.opponents.some((o) => o.targeted)) on.checked = true;
      if (on.checked) update();
    },
  };
}

/**
 * What the roller picked: who opposed it and with what - for the card's
 * note. Null when it wasn't Opposed.
 * @param {{opposed?: boolean, opposedBy?: string, opposedStat?: string, opposedNumber?: number|string}} values
 * @param {object|null} choice  buildOpposedChoice's.
 * @returns {{name: string|null, statKey: string|null, mod: number}|null}
 */
export function readOpposed(values, choice) {
  if (!choice || !values?.opposed) return null;
  const now = resolveOpposed(choice, {
    opponentId: values.opposedBy,
    statKey: values.opposedStat,
    number: values.opposedNumber,
  });
  return now ? { name: now.name, statKey: now.statKey, mod: now.mod } : null;
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
