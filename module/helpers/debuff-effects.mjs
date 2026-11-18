/**
 * Roll-time Debuff automation (Table 11, Playing the Game p.60/p.96-97).
 * Reads each condition's structured `mechanics` (CONFIG.CARLRPG.debuffs, see
 * module/helpers/config.mjs) and turns an actor's active Debuffs into
 * "adjustment rows" - one per condition that matters for the roll at hand.
 *
 * The same rows feed both halves of the p.96 rule:
 *  - A creature that ROLLS a d20 (a crawler) - `resolveRollerRows`: a "-X"
 *    penalty is a RollParts term, Disadvantage/Advantage feed
 *    resolveD20Formula's counts, Woozy drops the DEX Mod term.
 *  - A Mob, whose number is a static Difficulty a crawler rolls against -
 *    `resolveDifficultyRows`: "-X" lowers the Difficulty by X, and net
 *    Disadvantage is -5 / net Advantage +5 (p.60 "Mob Advantage &
 *    Disadvantage" - they cancel, and two of the same don't combine).
 *
 * Every row is shown in the roll-options dialog as a pre-ticked checkbox
 * (module/dice/roll-prompt.mjs), so the GM/player can untick one that the
 * fiction says doesn't apply - a "sight-based" Blinded penalty, say, which
 * is offered but only pre-ticked for Attacks and Evades.
 *
 * Collectors take an actor's SYSTEM data (not the Actor) so they also work
 * from inside prepareDerivedData (module/data/mob.mjs's evadeBase/
 * surpriseBase display) and on plain objects in tests.
 */
import { CARLRPG } from "./config.mjs";

/**
 * @typedef {"attack"|"evade"|"check"} RollKind
 *   What the debuffed creature is doing: making (or being the Difficulty
 *   of) an Attack, an Evade, or any other Check (Skill/Stat/Opposed).
 */

/**
 * @typedef {object} DebuffRow
 * @property {string} id           Unique within one dialog; never contains "." (it's a form-field name segment).
 * @property {string} key          CONFIG.CARLRPG.debuffs key.
 * @property {string} conditionId  The system.conditions entry's own id - what consumption removes.
 * @property {"penalty"|"disadvantage"|"advantage"|"noDex"} kind
 * @property {number} value        penalty/noDex: the signed amount added to the roll or Difficulty. 0 for advantage/disadvantage.
 * @property {boolean} defaultOn   Pre-ticked in the dialog (and applied when the dialog is skipped).
 * @property {boolean} consume     Remove the condition once this row is applied (Stunned, Queasy, Staggered).
 * @property {string} label        e.g. "Minor Injury" or "Minor Injury (Goblin)".
 */

const CONSUMED_SCOPES = new Set(["nextAttack", "nextCheck", "nextAction"]);

/**
 * Whether a `disadvantage` scope applies to this kind of roll (Table 11's
 * own wording): "all"/"sight"/"nextCheck" reach every Check; "attack"/
 * "nextAttack" only Attacks; "nextAction" (Queasy - "if your next Action
 * requires a roll") any roll that IS the creature's own Action - not a
 * free Evade, a Taunt resisted, or a Difficulty a crawler rolls against
 * (a Mob's Evade/Surprise).
 * @param {string} scope
 * @param {RollKind} rollKind
 * @param {{ownAction?: boolean}} [options]
 * @returns {boolean}
 */
export function disadvantageScopeApplies(scope, rollKind, { ownAction = true } = {}) {
  switch (scope) {
    case "all":
    case "sight":
    case "nextCheck":
      return true;
    case "attack":
    case "nextAttack":
      return rollKind === "attack";
    case "nextAction":
      return ownAction;
    default:
      return false;
  }
}

/**
 * Debuffs a single roll can remove: Stunned/Queasy/Staggered. Also the
 * only ones the GM-side socket relay will remove on a player's behalf
 * (module/helpers/chat-socket.mjs).
 * @param {string} key  CONFIG.CARLRPG.debuffs key.
 * @returns {boolean}
 */
export function isOneShotDebuff(key) {
  const mech = CARLRPG.debuffs[key]?.mechanics;
  return !!mech && (CONSUMED_SCOPES.has(mech.disadvantage) || !!mech.endsAfterAction);
}

/** Blinded's "Checks that require sight" - pre-ticked only for Attacks/Evades. */
function scopeDefaultOn(scope, rollKind) {
  if (scope === "sight") return rollKind === "attack" || rollKind === "evade";
  return true;
}

function localizedDebuffLabel(condition, preset) {
  if (condition.label) return condition.label;
  return preset ? game.i18n.localize(preset.label) : condition.key;
}

/**
 * Debuffs on `sys` that change a roll of this kind.
 * @param {object} sys       An actor's system data ({conditions, stats}).
 * @param {RollKind} rollKind
 * @param {object} [options]
 * @param {boolean} [options.usesDex]  Whether this roll/Difficulty includes the DEX Mod at all
 *   (Woozy only matters then). Defaults true for Evade, false otherwise.
 * @param {string} [options.ownerName] Appended to each label, e.g. "Minor Injury (Goblin)".
 * @param {string} [options.idPrefix]  Keeps row ids unique when one dialog lists two creatures' rows.
 * @param {boolean} [options.ownAction]  Whether this roll is the creature's own Action (see
 *   disadvantageScopeApplies). False for a Mob's Difficulty a crawler rolls against.
 * @returns {DebuffRow[]}
 */
export function collectDebuffRows(sys, rollKind, { usesDex = rollKind === "evade", ownerName = "", idPrefix = "self", ownAction = true } = {}) {
  const rows = [];
  const dexMod = sys?.stats?.dex?.mod ?? 0;
  for (const condition of sys?.conditions ?? []) {
    const preset = CARLRPG.debuffs[condition.key];
    const mech = preset?.mechanics;
    if (!mech) continue;
    const base = localizedDebuffLabel(condition, preset);
    const label = ownerName ? `${base} (${ownerName})` : base;
    const row = (kind, value, extra = {}) => rows.push({
      id: `${idPrefix}-${condition.id}-${kind}`,
      key: condition.key,
      conditionId: condition.id,
      kind, value, label,
      defaultOn: true,
      consume: false,
      ...extra,
    });

    if (mech.penalty) {
      const stacks = Math.max(1, Number(condition.stacks) || 1);
      row("penalty", -(mech.penalty * stacks));
    }
    if (mech.disadvantage && disadvantageScopeApplies(mech.disadvantage, rollKind, { ownAction })) {
      row("disadvantage", 0, {
        defaultOn: scopeDefaultOn(mech.disadvantage, rollKind),
        consume: CONSUMED_SCOPES.has(mech.disadvantage),
      });
    }
    if (mech.noDexMod && usesDex && (rollKind === "attack" || rollKind === "evade") && dexMod !== 0) {
      row("noDex", -dexMod);
    }
  }
  return rows;
}

/**
 * "Attacks against a Held foe are made with Advantage" (Held, Take Down) -
 * debuffs on the DEFENDER that help whoever attacks it.
 * @param {object} defenderSys
 * @param {{ownerName?: string, idPrefix?: string}} [options]
 * @returns {DebuffRow[]}
 */
export function collectAdvantageAgainstRows(defenderSys, { ownerName = "", idPrefix = "target" } = {}) {
  const rows = [];
  for (const condition of defenderSys?.conditions ?? []) {
    const preset = CARLRPG.debuffs[condition.key];
    if (!preset?.mechanics?.attackersGainAdvantage) continue;
    const base = localizedDebuffLabel(condition, preset);
    rows.push({
      id: `${idPrefix}-${condition.id}-advantage`,
      key: condition.key,
      conditionId: condition.id,
      kind: "advantage",
      value: 0,
      defaultOn: true,
      consume: false,
      label: ownerName ? `${base} (${ownerName})` : base,
    });
  }
  return rows;
}

/** Rows that are on, given the dialog's checked-id set (null = use each row's defaultOn). */
function activeRows(rows, checked) {
  return rows.filter((r) => (checked ? checked.has(r.id) : r.defaultOn));
}

/**
 * Resolve rows for a creature that actually rolls the d20.
 * @param {DebuffRow[]} rows
 * @param {Set<string>|null} checked
 * @returns {{penalties: {label: string, value: number}[], advantageCount: number, disadvantageCount: number, applied: DebuffRow[]}}
 */
export function resolveRollerRows(rows, checked = null) {
  const applied = activeRows(rows, checked);
  return {
    // Woozy's "no DEX Mod" is folded in as its own negative term (rather
    // than silently dropping the DEX row) so the roll breakdown shows why.
    penalties: applied.filter((r) => r.kind === "penalty" || r.kind === "noDex").map((r) => ({ label: r.label, value: r.value })),
    advantageCount: applied.filter((r) => r.kind === "advantage").length,
    disadvantageCount: applied.filter((r) => r.kind === "disadvantage").length,
    applied,
  };
}

/**
 * Resolve rows against a Mob's static Difficulty (p.60/p.96).
 * @param {number|null} base  The Difficulty before any debuff (null = none set; returned unchanged).
 * @param {DebuffRow[]} rows
 * @param {Set<string>|null} checked
 * @returns {{difficulty: number|null, delta: number, netAdvantage: -1|0|1, applied: DebuffRow[]}}
 *   netAdvantage < 0 is a Disadvantaged Mob - a Disadvantaged Mob ATTACK
 *   gives its target a free Evade Check.
 */
export function resolveDifficultyRows(base, rows, checked = null) {
  const applied = activeRows(rows, checked);
  let delta = 0;
  for (const r of applied) {
    if (r.kind === "penalty" || r.kind === "noDex") delta += r.value;
  }
  const adv = applied.filter((r) => r.kind === "advantage").length;
  const dis = applied.filter((r) => r.kind === "disadvantage").length;
  const netAdvantage = Math.sign(adv - dis);
  delta += netAdvantage * 5;
  return {
    difficulty: base === null || base === undefined ? null : base + delta,
    delta,
    netAdvantage,
    applied,
  };
}

/**
 * The dialog's short description of what a row does, e.g. "-2",
 * "Disadvantage", "Difficulty -5".
 * @param {DebuffRow} row
 * @param {"roll"|"difficulty"} mode  Whether the row changes a d20 roll or a Mob's static Difficulty.
 * @returns {string}
 */
export function describeRow(row, mode) {
  const i18n = game.i18n;
  let text;
  // A bonus (an occupant's Evade Buff, module/helpers/vehicle-rows.mjs)
  // reads "+4", not "4".
  const signed = row.value > 0 ? `+${row.value}` : String(row.value);
  if (row.kind === "penalty") {
    text = mode === "difficulty"
      ? i18n.format("CARLRPG.DebuffRow.Difficulty", { value: signed })
      : signed;
  } else if (row.kind === "noDex") {
    text = i18n.format(mode === "difficulty" ? "CARLRPG.DebuffRow.NoDexDifficulty" : "CARLRPG.DebuffRow.NoDex", { value: row.value });
  } else if (row.kind === "disadvantage") {
    text = i18n.localize(mode === "difficulty" ? "CARLRPG.DebuffRow.MobDisadvantage" : "CARLRPG.Dialog.Disadvantage");
  } else {
    text = i18n.localize(mode === "difficulty" ? "CARLRPG.DebuffRow.MobAdvantage" : "CARLRPG.Dialog.Advantage");
  }
  if (row.consume) text += ` · ${i18n.localize("CARLRPG.DebuffRow.Consumed")}`;
  return text;
}

/**
 * Attach dialog display fields to each row.
 * @param {DebuffRow[]} rows
 * @param {"roll"|"difficulty"} mode
 * @returns {Array<DebuffRow & {detail: string}>}
 */
export function decorateRows(rows, mode) {
  return rows.map((r) => ({ ...r, detail: describeRow(r, mode) }));
}

/**
 * A condition entry's display name - its own label, else the preset's.
 * @param {{key: string, label?: string}} condition
 * @returns {string}
 */
export function conditionLabel(condition) {
  return localizedDebuffLabel(condition, CARLRPG.debuffs[condition.key]);
}

/**
 * A one-line chat-card summary of what the debuffs did to this roll, or ""
 * if nothing applied - e.g. "Debuffs: Minor Injury -2; Shit-Faced
 * (Goblin) (Difficulty -5)".
 * @param {Array<DebuffRow & {detail: string}>} appliedRows  Decorated rows that were applied.
 * @returns {string} Trusted HTML.
 */
export function buildDebuffNote(appliedRows) {
  if (!appliedRows?.length) return "";
  const esc = foundry.utils.escapeHTML;
  const line = (rows, icon, titleKey) => {
    if (!rows.length) return "";
    const parts = rows.map((r) => `${esc(r.label)} (${esc(r.detail)})`);
    return `<p class="carl-debuff-note"><i class="fas ${icon}"></i> ${game.i18n.localize(titleKey)}: ${parts.join("; ")}</p>`;
  };
  // Riding in a vehicle (module/helpers/vehicle-rows.mjs) isn't a Debuff -
  // it gets its own line.
  return line(appliedRows.filter((r) => !r.situational), "fa-skull-crossbones", "CARLRPG.DebuffRow.NoteTitle")
    + line(appliedRows.filter((r) => r.situational), "fa-car", "CARLRPG.Vehicle.Rows.NoteTitle");
}

/**
 * Whether any active condition on `sys` carries the given mechanics flag.
 * @param {object} sys
 * @param {string} flag  e.g. "noHealing", "noSpells", "noActions".
 * @returns {object|null} The first matching condition entry, or null.
 */
export function findConditionWithMechanic(sys, flag) {
  return (sys?.conditions ?? []).find((c) => CARLRPG.debuffs[c.key]?.mechanics?.[flag]) ?? null;
}

/**
 * Debuffs that forbid this roll outright: "You can't take any Actions"
 * (Paralyzed, Dying) and "You can't speak or cast Spells" (Muted). Returns
 * the localized reason, or null if the roll may proceed.
 * @param {Actor} actor
 * @param {{isSpell?: boolean}} [options]
 * @returns {string|null}
 */
export function getActionBlockReason(actor, { isSpell = false } = {}) {
  const sys = actor?.system;
  const blocking = findConditionWithMechanic(sys, "noActions")
    ?? (isSpell ? findConditionWithMechanic(sys, "noSpells") : null);
  if (!blocking) return null;
  const preset = CARLRPG.debuffs[blocking.key];
  return game.i18n.format("CARLRPG.Warning.DebuffBlocksAction", {
    name: actor.name,
    debuff: localizedDebuffLabel(blocking, preset),
  });
}

/**
 * Condition ids to remove after a roll: every applied row marked `consume`
 * (Stunned/Queasy/Staggered - "once you make a Check" / "your next Action").
 * @param {DebuffRow[]} appliedRows
 * @returns {string[]}
 */
export function consumedConditionIds(appliedRows) {
  return [...new Set((appliedRows ?? []).filter((r) => r.consume).map((r) => r.conditionId))];
}

/**
 * Condition ids a roll ends: the consumed rows above, plus - when the roll
 * is the creature's own Action - every `endsAfterAction` Debuff (Queasy,
 * Staggered: "At the end of the next Action you take"), whether or not it
 * changed this particular roll.
 * @param {object} sys  The rolling (or acting) creature's system data.
 * @param {DebuffRow[]} appliedRows
 * @param {{isAction?: boolean}} [options]
 * @returns {string[]}
 */
export function endedConditionIds(sys, appliedRows, { isAction = true } = {}) {
  const ids = new Set(consumedConditionIds(appliedRows));
  if (isAction) {
    for (const c of sys?.conditions ?? []) {
      if (CARLRPG.debuffs[c.key]?.mechanics?.endsAfterAction) ids.add(c.id);
    }
  }
  return [...ids];
}
