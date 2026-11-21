import { esc } from "./html.mjs";
/**
 * One-line summaries for the item sheets' compact rows (docs/skill-item-
 * sheets.md): a Bonus (a ChangeEntry - module/data/shared/change-entry.mjs)
 * and an on-hit Debuff (a target effect - module/data/shared/
 * upgrade-tier.mjs). Each row shows a chip, what it touches, the value on
 * the right, and notes under it; it opens to its fields
 * (templates/item/parts/changes-editor.hbs, target-effects-editor.hbs).
 * Registered as Handlebars helpers in module/carl-rpg.mjs.
 */

const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/**
 * A Bonus's summary.
 * @param {object} change  A ChangeEntry.
 * @returns {{kind: string, what: string, value: string, notes: string[]}}
 */
export function changeSummary(change) {
  const cfg = CONFIG.CARLRPG;
  const type = change?.targetType || "custom";
  const target = String(change?.target ?? "").trim();
  let what;
  switch (type) {
    case "stat":
      what = target ? t(cfg.statAbbreviations[target] ?? target) : "";
      break;
    case "resource":
      what = target ? t(cfg.resourceTargets[target] ?? target) : "";
      break;
    case "rollMode":
      what = target ? t(cfg.rollModeTargets[target] ?? target) : "";
      break;
    case "resistance":
      what = target ? t(cfg.damageTypes[target] ?? target) : "";
      break;
    default:
      what = target;
  }
  if (!what) what = t("CARLRPG.Bonus.NotSet");

  const raw = String(change?.value ?? "").trim();
  let value = raw;
  if (type === "resistance") value = t(`CARLRPG.Bonus.Resist.${raw || "none"}`);
  else if (raw) {
    switch (change?.mode) {
      case "subtract":
        value = `−${raw.replace(/^-/, "")}`;
        break;
      case "multiply":
        value = `×${raw}`;
        break;
      case "override":
        value = `= ${raw}`;
        break;
      case "upgrade":
        value = t("CARLRPG.Bonus.AtLeast", { value: raw });
        break;
      case "downgrade":
        value = t("CARLRPG.Bonus.AtMost", { value: raw });
        break;
      default:
        value = /^[-+]/.test(raw) ? raw : `+${raw}`;
    }
  }

  const notes = [];
  if (type === "skillDamage") {
    if (change?.damageDiceKind)
      notes.push(t(cfg.damageDiceKinds?.[change.damageDiceKind] ?? change.damageDiceKind));
    if (change?.damageType) notes.push(t(cfg.damageTypes[change.damageType] ?? change.damageType));
  }
  if (change?.capMax !== null && change?.capMax !== undefined && String(change.capMax) !== "") {
    notes.push(t("CARLRPG.Bonus.Cap", { cap: change.capMax }));
  }
  const conditions = (change?.conditions ?? []).map((c) => c.label).filter(Boolean);
  if (conditions.length)
    notes.push(t("CARLRPG.Bonus.OnlyWhen", { conditions: conditions.join(", ") }));
  if (Number(change?.levelGate) > 0)
    notes.push(t("CARLRPG.Bonus.FromLevel", { level: change.levelGate }));
  if (change?.label) notes.push(change.label);

  return { kind: t(`CARLRPG.Bonus.Kind.${type}`), what, value, notes };
}

/**
 * When an on-hit Debuff lands, in full - never "AS" (docs/skill-item-
 * sheets.md ruling): on a hit, on a Critical Hit, on an Amazing Success.
 * @param {object} te  A target effect.
 * @returns {{key: "hit"|"crit"|"amazing"|"both", label: string, hint: string}}
 */
export function debuffTrigger(te) {
  const key =
    te?.critOnly && te?.amazingSuccessOnly
      ? "both"
      : te?.critOnly
        ? "crit"
        : te?.amazingSuccessOnly
          ? "amazing"
          : "hit";
  return {
    key,
    label: t(`CARLRPG.OnHitDebuff.Trigger.${key}`),
    hint: t(`CARLRPG.OnHitDebuff.TriggerHint.${key}`),
  };
}

/**
 * A Debuff's summary.
 * @param {object} te  A target effect (optionally with `skills` and `handToHandOnly`, gear's "Only with").
 * @returns {{trigger: {key: string, label: string}, what: string, notes: string[]}}
 */
export function debuffSummary(te) {
  const def = CONFIG.CARLRPG.debuffs?.[te?.debuffKey];
  const name = def ? t(def.label) : t("CARLRPG.Bonus.NotSet");
  const notes = [];
  if (te?.label) notes.push(te.label);
  const skills = (te?.skills ?? []).filter(Boolean);
  if (te?.handToHandOnly) {
    notes.push(
      skills.length
        ? t("CARLRPG.OnHitDebuff.OnlyWithOrHandToHand", { skills: skills.join(", ") })
        : t("CARLRPG.OnHitDebuff.OnlyHandToHand"),
    );
  } else if (skills.length)
    notes.push(t("CARLRPG.OnHitDebuff.OnlyWith", { skills: skills.join(", ") }));
  return { trigger: debuffTrigger(te), what: `${name} ×${te?.stacks || 1}`, notes };
}

/** The tone of a Debuff trigger's chip. */
const TRIGGER_TONES = { hit: "neutral", crit: "accent", amazing: "good", both: "accent" };

/**
 * The summary line of a Bonus row, as HTML (the row's <summary>).
 * @param {object} change
 * @returns {string}
 */
export function changeLineHtml(change) {
  const s = changeSummary(change);
  const notes = s.notes.length
    ? `<span class="carl-edit-row-sub">${s.notes.map(esc).join(" · ")}</span>`
    : "";
  return (
    `<span class="carl-row-chip" data-tone="neutral">${esc(s.kind)}</span>` +
    `<span class="carl-edit-row-what"><b>${esc(s.what)}</b>${notes}</span>` +
    `<span class="carl-edit-row-value">${esc(s.value)}</span>`
  );
}

/**
 * The summary line of a Debuff row, as HTML.
 * @param {object} te
 * @returns {string}
 */
export function debuffLineHtml(te) {
  const s = debuffSummary(te);
  const notes = s.notes.length
    ? `<span class="carl-edit-row-sub">${s.notes.map(esc).join(" · ")}</span>`
    : "";
  return (
    `<span class="carl-row-chip" data-tone="${TRIGGER_TONES[s.trigger.key]}" data-tooltip="${esc(s.trigger.hint)}">${esc(s.trigger.label)}</span>` +
    `<span class="carl-edit-row-what"><b>${esc(s.what)}</b>${notes}</span>` +
    `<span class="carl-edit-row-value"></span>`
  );
}

/**
 * The item row an element in a sheet belongs to: the nearest
 * `[data-item-id]` (a row, a Hotlist slot, a drawer's own button).
 * @param {Element|null} element
 * @returns {HTMLElement|null}
 */
export function itemRow(element) {
  return element?.closest?.("[data-item-id]") ?? null;
}

/**
 * The owned item a sheet action's element belongs to, or null.
 * @param {Actor} actor
 * @param {Element|null} element
 * @returns {Item|null}
 */
export function itemFor(actor, element) {
  const id = itemRow(element)?.dataset.itemId;
  return id ? (actor.items.get(id) ?? null) : null;
}
