/**
 * The status rows the combat cards share (docs/reaction-card-redesign.md):
 * the Reaction card, the Damage card, and an Attack card's target rows -
 * and a Party Skill Check's card (module/chat/party-check-card.mjs).
 * Each row leads with a status chip - icon, colour and word, never colour
 * alone - then what it is, a right-aligned number column, its action icons,
 * and an expander for the roll behind it. A section groups the rows for one
 * creature under a heading that carries its summary.
 *
 * Markup only: the cards build their rows from their own state and draw
 * them per viewer. Styles: src/scss/components/_status-rows.scss.
 */
import { CARLRPG } from "../helpers/config.mjs";
import { degreeLabel, getDegreeOfSuccess } from "../helpers/rules.mjs";
import { esc } from "../helpers/html.mjs";

/** Each status's icon (Font Awesome). */
const ICONS = {
  incoming: "fa-hourglass-half",
  hit: "fa-xmark",
  evaded: "fa-check",
  half: "fa-circle-half-stroke",
  quarter: "fa-circle-half-stroke",
  caught: "fa-hand",
  // Shield Blocked: half damage, still a hit (helpers/shield-block.mjs).
  blocked: "fa-shield",
  missed: "fa-shield-halved",
  taunt: "fa-bullhorn",
  tauntFailed: "fa-bullhorn",
  moved: "fa-arrow-right",
  // A Party Skill Check's rows (module/chat/party-check-card.mjs).
  waiting: "fa-hourglass-half",
  success: "fa-check",
  fail: "fa-xmark",
};

/**
 * Each status's colour, by tone. A tone is its own key so a card can colour
 * by outcome for the party: a crawler's Hit on a Mob is "good".
 */
const TONES = {
  incoming: "incoming",
  hit: "bad",
  evaded: "good",
  half: "half",
  quarter: "half",
  caught: "caught",
  blocked: "half",
  missed: "neutral",
  taunt: "taunt",
  tauntFailed: "muted",
  moved: "muted",
  waiting: "incoming",
  success: "good",
  fail: "bad",
};

/** Each Degree's icon on its tag (Font Awesome). */
const DEGREE_ICONS = {
  criticalHit: "fa-dice-d20",
  amazingSuccess: "fa-star",
  standardSuccess: "fa-check",
  nearMissFail: "fa-bullseye",
  standardFail: "fa-minus",
  majorFail: "fa-angles-down",
  criticalFail: "fa-skull",
};

/** Each Degree's tag colour: the header badge's palette (degreeBadge). */
const DEGREE_TONES = {
  criticalHit: "great",
  amazingSuccess: "great",
  standardSuccess: "plain",
  nearMissFail: "near",
  standardFail: "plain",
  majorFail: "major",
  criticalFail: "critical",
};

/** The Evade Degrees that change the damage taken (rowOutcome): never hidden behind a Shield Block. */
const DAMAGING_EVADES = ["majorFail", "criticalFail"];

/**
 * A row's Degree tag, stacked under its status chip: icon and short word,
 * with the full Degree and what it does in its tooltip. Nothing for an
 * unknown or missing Degree (older cards).
 * @param {string|null} degree  A CARLRPG.degreesOfSuccess key.
 * @param {{kind?: "attack"|"evade"|"block"}} [options]  What was rolled -
 *   picks the tooltip's effect line.
 * @returns {string}
 */
export function degreeTag(degree, { kind = "evade" } = {}) {
  if (!degree || !DEGREE_TONES[degree]) return "";
  const i18n = game.i18n;
  const name = degreeLabel(degree);
  const effectKey = `CARLRPG.DegreeTag.Effect.${kind}.${degree}`;
  const tip = i18n.has(effectKey)
    ? i18n.format("CARLRPG.DegreeTag.Tip", { degree: name, effect: i18n.localize(effectKey) })
    : name;
  return (
    `<span class="carl-degree-tag" data-degree="${esc(degree)}" data-tone="${DEGREE_TONES[degree]}" data-tooltip-text="${esc(tip)}">` +
    `<i class="fas ${DEGREE_ICONS[degree]}" aria-hidden="true"></i>${esc(i18n.localize(`CARLRPG.DegreeTag.Short.${degree}`))}</span>`
  );
}

/**
 * Which graded Check a row's Degree tag shows: the one that decides the
 * damage. A failed Evade bad enough to add damage (Major or Critical Fail)
 * shows even under a Shield Block; otherwise the block, else the deciding
 * Evade, else the Check the row shows (a failed free Evade). A Check with
 * no Difficulty has no real Degree, so none.
 * @param {{evade?: object|null, block?: object|null, shown?: object|null}} checks
 *   Each a Check (or a summary) with `degree` and, where known, `difficulty`.
 * @returns {{degree: string, kind: "evade"|"block"}|null}
 */
export function decidingDegree({ evade = null, block = null, shown = null }) {
  const pick =
    evade && DAMAGING_EVADES.includes(evade.degree)
      ? { check: evade, kind: "evade" }
      : block
        ? { check: block, kind: "block" }
        : evade
          ? { check: evade, kind: "evade" }
          : shown
            ? { check: shown, kind: "evade" }
            : null;
  if (!pick?.check?.degree || pick.check.difficulty === null) return null;
  return { degree: pick.check.degree, kind: pick.kind };
}

/**
 * A status chip.
 * @param {string} status  A key of CARLRPG.StatusChip.
 * @param {{tone?: string, label?: string}} [options]  tone: override the
 *   colour ("good", "bad", ...); label: override the word.
 * @returns {string}
 */
export function statusChip(status, { tone = null, label = null } = {}) {
  const text = label ?? game.i18n.localize(`CARLRPG.StatusChip.${status}`);
  return (
    `<span class="carl-status-chip" data-tone="${esc(tone ?? TONES[status] ?? "neutral")}">` +
    `<i class="fas ${ICONS[status] ?? "fa-circle"}" aria-hidden="true"></i>${esc(text)}</span>`
  );
}

/**
 * One row.
 * @param {object} row
 * @param {string} row.chip     statusChip(...)
 * @param {string} [row.degree] degreeTag(...): stacked under the chip.
 * @param {string} row.what     Trusted HTML: "<strong>Ghoul</strong> · Bite".
 * @param {string[]} [row.sub]  Plain-text notes under it, joined with " · ".
 * @param {string} [row.flag]   Trusted HTML right after `what` (an icon).
 * @param {string} [row.num]    Trusted HTML for the number column.
 * @param {string} [row.acts]   Trusted HTML: icon buttons.
 * @param {string} [row.detail] Trusted HTML for the expander; none, no expander.
 * @param {string} [row.key]    Stable per row on its card: an opened
 *   expander stays open across redraws.
 * @param {boolean} [row.open]
 * @param {boolean} [row.ghost] Struck through: an Attack that moved away.
 * @param {string} [row.after]  Trusted HTML below the row (a button).
 * @param {string} [row.id]     Its card's id for it (`data-row-id`).
 * @param {string} [row.numTip] A tooltip on the number column.
 * @returns {string}
 */
export function statusRow({
  chip,
  degree = "",
  what,
  sub = [],
  flag = "",
  num = "",
  acts = "",
  detail = "",
  key = "",
  open = false,
  ghost = false,
  after = "",
  id = "",
  numTip = "",
}) {
  const notes = sub.filter(Boolean);
  const subHtml = notes.length
    ? `<span class="carl-status-sub">${notes.map(esc).join(" · ")}</span>`
    : "";
  const lead = degree ? `<span class="carl-status-chips">${chip}${degree}</span>` : chip;
  const line =
    `${lead}<span class="carl-status-what">${what}${flag}${subHtml}</span>` +
    `<span class="carl-status-num"${numTip ? ` data-tooltip="${esc(numTip)}"` : ""}>${num}</span><span class="carl-status-acts">${acts}</span>`;
  const cls = `carl-status-row${ghost ? " is-ghost" : ""}`;
  const rowId = id ? ` data-row-id="${esc(id)}"` : "";
  const body = detail
    ? `<details class="${cls}"${rowId} data-row-key="${esc(key)}"${open ? " open" : ""}><summary class="carl-status-line">${line}</summary>` +
      `<div class="carl-status-detail">${detail}</div></details>`
    : `<div class="${cls}"${rowId}><div class="carl-status-line">${line}</div></div>`;
  return body + after;
}

/**
 * A section: one creature's rows under its name and summary.
 * @param {{name: string, summary?: string, rows: string[], actions?: string, notes?: string[]}} section
 *   notes: trusted HTML lines under the rows (injury reminders).
 * @returns {string}
 */
export function statusSection({ name, summary = "", rows, actions = "", notes = [] }) {
  return `<section class="carl-status-section">
    <header><span class="carl-status-who">${esc(name)}</span><span class="carl-status-sum">${esc(summary)}</span></header>
    ${rows.join("")}
    ${notes.length ? `<ul class="carl-status-notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}
    ${actions ? `<div class="carl-status-section-acts">${actions}</div>` : ""}
  </section>`;
}

/**
 * The header's progress badge ("3 of 5 settled", Locked): replaces the
 * card's own badge, drawn per viewer.
 * @param {HTMLElement} html  The rendered message.
 * @param {string} text
 * @param {{locked?: boolean, subtitle?: string}} [options]  subtitle: a new
 *   subtitle text.
 */
export function headerProgress(html, text, { locked = false, subtitle = null } = {}) {
  const header = html.querySelector(".carl-chat-header");
  if (!header) return;
  header.querySelector(".carl-badge, .carl-status-progress")?.remove();
  header.insertAdjacentHTML(
    "beforeend",
    `<span class="carl-status-progress${locked ? " is-locked" : ""}">` +
      `${locked ? '<i class="fas fa-lock" aria-hidden="true"></i> ' : ""}${esc(text)}</span>`,
  );
  if (subtitle !== null) {
    const el = header.querySelector(".carl-chat-subtitle");
    if (el) el.textContent = subtitle;
  }
}

/**
 * An icon-only button for a row, named in its tooltip.
 * @param {string} icon  Font Awesome class, e.g. "fa-dice-d20".
 * @param {string} title
 * @param {Record<string, string>} data  Its data- attributes (action, op, ...).
 * @returns {string}
 */
export function iconButton(icon, title, data) {
  const attrs = Object.entries(data)
    .map(([k, v]) => `data-${k}="${esc(v)}"`)
    .join(" ");
  return (
    `<button type="button" class="carl-status-icon" ${attrs} data-tooltip="${esc(title)}" aria-label="${esc(title)}">` +
    `<i class="fas ${icon}" aria-hidden="true"></i></button>`
  );
}

/**
 * The "12 vs 15" number column for a Check.
 * @param {number|string} total
 * @param {number|null} difficulty
 * @returns {string}
 */
export function versusNum(total, difficulty) {
  const vs =
    difficulty === null || difficulty === undefined
      ? ""
      : ` <span class="carl-status-vs">${esc(game.i18n.format("CARLRPG.Reaction.Vs", { difficulty }))}</span>`;
  return `<b>${esc(total)}</b>${vs}`;
}

/** "7, 15" - the d20s a stored Roll rolled. */
function rolledD20s(rollData) {
  const term = rollData?.terms?.find((t) => t.faces === 20);
  const results = term?.results?.map((r) => r.result);
  return results?.length ? results.join(", ") : "";
}

/**
 * The roll behind a Check (module/helpers/reaction-state.mjs's shape), for
 * its row's expander: breakdown and Degree, the d20s, each Intervene d6,
 * and what an AI Reroll replaced.
 * @param {object|null} check
 * @returns {string}
 */
export function checkDetail(check) {
  if (!check) return "";
  const i18n = game.i18n;
  const degree = degreeLabel(check.degree);
  const lines = [`${check.breakdown ? `${esc(check.breakdown)} · ` : ""}${esc(degree)}`];
  const dice = rolledD20s(check.roll);
  if (dice) lines.push(esc(i18n.format("CARLRPG.Reaction.Dice", { dice })));
  for (const i of check.interventions ?? [])
    lines.push(
      esc(i18n.format("CARLRPG.Reaction.InterveneLine", { name: i.byName, value: i.value })),
    );
  if (check.aiRerolled) {
    lines.push(
      esc(
        i18n.format("CARLRPG.Reaction.RerolledFrom", {
          total: check.aiRerolled.base,
          natural: check.aiRerolled.natural ?? "-",
        }),
      ),
    );
  }
  return lines.map((line) => `<div>${line}</div>`).join("");
}

/**
 * Whether a d6 could still change a Check's result - where the Intervene
 * icon is drawn: not a Natural 1 or 20 (fixed), and +6 would change its
 * Degree (a Near Miss to a Success, a Success to an Amazing Success). A
 * Taunt only matters while it has failed.
 * @param {object|null} check
 * @param {{taunt?: boolean}} [options]
 * @returns {boolean}
 */
export function d6CouldChange(check, { taunt = false } = {}) {
  if (!check || check.natural === 1 || check.natural === 20) return false;
  if (taunt) return !check.success;
  return getDegreeOfSuccess(check.natural, check.total + 6, check.difficulty) !== check.degree;
}

/** The "Helped by Wren +2" and "AI Reroll" notes a Check adds to its row. */
export function checkNotes(check) {
  const i18n = game.i18n;
  const notes = [];
  const helped = (check?.interventions ?? []).map((i) => `${i.byName} +${i.value}`);
  if (helped.length)
    notes.push(i18n.format("CARLRPG.Reaction.Sub.helped", { names: helped.join(", ") }));
  if (check?.aiRerolled) notes.push(i18n.localize("CARLRPG.Reaction.Op.reroll"));
  return notes;
}

/**
 * Keep opened expanders open across redraws: remember them per card on this
 * client, and open them again on the next draw.
 * @param {HTMLElement} container
 * @param {string} cardId
 * @param {Set<string>} opened  The card module's own set.
 */
export function rememberOpenRows(container, cardId, opened) {
  trackPerCard(opened);
  // "toggle" doesn't bubble - listen in the capture phase.
  container.addEventListener(
    "toggle",
    (event) => {
      const key = event.target?.dataset?.rowKey;
      if (!key) return;
      const id = `${cardId}:${key}`;
      if (event.target.open) opened.add(id);
      else opened.delete(id);
    },
    true,
  );
}

/* -------------------------------------------- */
/*  Per-card client state                       */
/* -------------------------------------------- */

/**
 * The card modules' client-side Sets and Maps keyed by a card's id
 * (`cardId`, or `cardId:rest`): open expanders, results not yet arrived.
 * @type {Set<Set<string>|Map<string, *>>}
 */
const perCardStores = new Set();

/**
 * Forget a card's entries in `store` when the card is deleted (forgetCard).
 * @template {Set<string>|Map<string, *>} T
 * @param {T} store
 * @returns {T}
 */
export function trackPerCard(store) {
  perCardStores.add(store);
  return store;
}

/** Stop tracking a store (trackPerCard). */
export function untrackPerCard(store) {
  perCardStores.delete(store);
}

/**
 * Drop every entry for one card from the tracked stores. Called on
 * `deleteChatMessage` (module/chat/chat-listener.mjs).
 * @param {string} cardId
 */
export function forgetCard(cardId) {
  if (!cardId) return;
  const prefix = `${cardId}:`;
  for (const store of perCardStores) {
    for (const key of [...store.keys()]) {
      if (key === cardId || String(key).startsWith(prefix)) store.delete(key);
    }
  }
}
