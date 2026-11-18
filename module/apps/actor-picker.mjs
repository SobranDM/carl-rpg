/**
 * The GM Toolbox's shared "who does this apply to" picker (End Floor, Rest,
 * Mend, the 2-Hour Tick, Party Level Up - module/apps/gm-toolbox.mjs;
 * docs/release-0.7.0.md §5). Not every Character is in "the party, right
 * now" (an absent player's crawler, a retired one, a GM-run henchman), so
 * nothing applies to everyone silently:
 *  - **Logged in**: Characters a connected player owns - ticked.
 *  - **Not logged in**: Characters whose player isn't connected, or that
 *    only the GM owns - unticked, collapsed, with a hint saying so.
 *  - **Pets** (where the action takes them) - ticked when their crawler is.
 * Each row names who plays it. Select All (with the running count) sits on
 * its own row above the groups; the name filter opens a collapsed group
 * holding a match. Only `character` actors (and Pets) are listed - Mobs
 * aren't party members.
 */
import { isPet } from "../helpers/actor-kinds.mjs";
import { petOwner } from "../helpers/pets.mjs";

const esc = (value) => foundry.utils.escapeHTML(String(value ?? ""));

/** Does a connected, non-GM user own this actor? */
export function ownedByActivePlayer(actor) {
  return game.users.some((u) => u.active && !u.isGM && actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

/**
 * Who plays an actor, for its row: its non-GM owners' names, or "GM".
 * @param {Actor} actor
 * @returns {string}
 */
export function playedBy(actor) {
  const players = game.users.filter((u) => !u.isGM && actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
  return players.length ? players.map((u) => u.name).join(", ") : game.i18n.localize("CARLRPG.Toolbox.ActorPicker.GmOnly");
}

/**
 * The actors a picker lists, sorted and grouped.
 * @param {{includePets?: boolean}} [options]
 * @returns {{active: Actor[], other: Actor[], pets: Actor[]}}
 */
export function pickerGroups({ includePets = false } = {}) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const characters = game.actors.filter((a) => a.type === "character").sort(byName);
  // Pets rest and mend with their crawlers; they level only through their
  // crawler (module/helpers/pets.mjs), so the Level/Grind pickers leave them out.
  const pets = includePets ? game.actors.filter((a) => isPet(a)).sort(byName) : [];
  return {
    active: characters.filter(ownedByActivePlayer),
    other: characters.filter((a) => !ownedByActivePlayer(a)),
    pets,
  };
}

/**
 * The picker's content.
 * @param {{active: Actor[], other: Actor[], pets: Actor[]}} groups
 * @param {string} prompt  The intro line (already localized).
 * @param {{before?: string, after?: string}} [extra]  Trusted HTML around
 *   the picker in the same dialog (the Rest dialog's length and Advance
 *   time - gm-toolbox.mjs).
 * @returns {string}
 */
export function actorPickerContent({ active, other, pets }, prompt, { before = "", after = "" } = {}) {
  const i18n = game.i18n;
  // data-actor-id is read straight off the DOM by the confirm button (see
  // gm-toolbox.mjs), not through FormDataExtended's name expansion.
  const row = (actor, checked, who) => `<label class="carl-actor-picker-option" data-actor-name="${esc(actor.name.toLowerCase())}">
      <input type="checkbox" data-actor-id="${actor.id}" ${checked ? "checked" : ""} />
      <span class="carl-actor-picker-name">${esc(actor.name)}</span>
      <span class="carl-actor-picker-who">${esc(who)}</span>
    </label>`;

  const activeSection = active.length
    ? `<section class="carl-actor-picker-group" data-group="active">
        <h4 class="carl-actor-picker-heading">${esc(i18n.format("CARLRPG.Toolbox.ActorPicker.LoggedIn", { count: active.length }))}</h4>
        ${active.map((a) => row(a, true, playedBy(a))).join("")}
      </section>`
    : "";
  const otherSection = other.length
    ? `<details class="carl-actor-picker-group carl-actor-picker-other" data-group="other">
        <summary class="carl-actor-picker-heading">${esc(i18n.format("CARLRPG.Toolbox.ActorPicker.NotLoggedIn", { count: other.length }))}</summary>
        <p class="carl-actor-picker-hint">${esc(i18n.localize("CARLRPG.Toolbox.ActorPicker.NotLoggedInHint"))}</p>
        ${other.map((a) => row(a, false, playedBy(a))).join("")}
      </details>`
    : "";
  // A Pet starts ticked when its crawler's player is logged in.
  const petSection = pets.length
    ? `<details class="carl-actor-picker-group carl-actor-picker-pets" data-group="pets" open>
        <summary class="carl-actor-picker-heading">${esc(i18n.format("CARLRPG.Toolbox.ActorPicker.Pets", { count: pets.length }))}</summary>
        ${pets.map((p) => {
          const owner = petOwner(p);
          const who = owner ? i18n.format("CARLRPG.Toolbox.ActorPicker.PetOf", { crawler: owner.name }) : "";
          return row(p, !!owner && ownedByActivePlayer(owner), who);
        }).join("")}
      </details>`
    : "";

  return `<div class="carl-dialog-body carl-actor-picker">
    ${before}
    <p>${esc(prompt)}</p>
    <input type="search" class="carl-actor-picker-filter" placeholder="${esc(i18n.localize("CARLRPG.Toolbox.ActorPicker.FilterPlaceholder"))}" />
    <label class="carl-actor-picker-select-all">
      <input type="checkbox" data-picker-select-all />
      <strong>${esc(i18n.localize("CARLRPG.Toolbox.ActorPicker.SelectAll"))}</strong>
      <span class="carl-actor-picker-count" data-picker-count></span>
    </label>
    <div class="carl-actor-picker-list">${activeSection}${otherSection}${petSection}</div>
    ${after}
  </div>`;
}

/**
 * The "Advance time" box (Rest, Mend, Grind - docs/release-0.7.0.md §6):
 * ticked, the world clock moves forward by the time spent; unticked when
 * that time is already being counted (two crawlers rest 8 hours while two
 * others grind the same 8: tick it on one dialog only).
 * @param {string} hours  For the hint: "8 hours", "the hours above".
 * @returns {string}
 */
export function advanceTimeField(hours) {
  const i18n = game.i18n;
  return `<label class="carl-advance-time">
      <input type="checkbox" name="advanceTime" data-advance-time checked />
      <strong>${esc(i18n.localize("CARLRPG.Toolbox.AdvanceTime"))}</strong>
      <span class="carl-advance-time-hint" data-advance-time-hint>${esc(i18n.format("CARLRPG.Toolbox.AdvanceTimeHint", { hours }))}</span>
    </label>`;
}

/**
 * Wire a rendered picker: Select All (de)selects every row and follows
 * individual ticks; the count stays current; the filter hides other names
 * and opens a collapsed group holding a match.
 * @param {HTMLElement} root  The dialog's element.
 */
export function wireActorPicker(root) {
  const selectAll = root.querySelector("[data-picker-select-all]");
  const countEl = root.querySelector("[data-picker-count]");
  const filterInput = root.querySelector(".carl-actor-picker-filter");
  const rows = () => [...root.querySelectorAll(".carl-actor-picker-option")];
  const boxes = () => rows().map((r) => r.querySelector('input[type="checkbox"]'));

  const update = () => {
    const all = boxes();
    if (selectAll) selectAll.checked = all.length > 0 && all.every((b) => b.checked);
    if (countEl) {
      countEl.textContent = game.i18n.format("CARLRPG.Toolbox.ActorPicker.SelectedCount", {
        count: all.filter((b) => b.checked).length, total: all.length,
      });
    }
  };
  update();
  selectAll?.addEventListener("change", () => {
    for (const box of boxes()) box.checked = selectAll.checked;
    update();
  });
  for (const box of boxes()) box.addEventListener("change", update);
  filterInput?.addEventListener("input", () => {
    const needle = filterInput.value.trim().toLowerCase();
    for (const row of rows()) row.hidden = !!needle && !row.dataset.actorName.includes(needle);
    if (!needle) return;
    for (const group of root.querySelectorAll("details.carl-actor-picker-group")) {
      if (group.querySelector(".carl-actor-picker-option:not([hidden])")) group.open = true;
    }
  });
}
