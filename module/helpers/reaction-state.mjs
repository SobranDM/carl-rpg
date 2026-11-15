/**
 * The Crawler Reaction Phase's state (Step 2, p.81-82; docs/combat-phases.md),
 * kept on the Reaction card's `flags.carl-rpg.reaction`. Pure data helpers:
 * no rolls, no writes - module/chat/reaction-card.mjs rolls and the GM's
 * client writes (one change at a time, against the current state).
 *
 * State
 *  - `attacks.<id>`  A declared Mob Attack (module/helpers/declarations.mjs):
 *    the Mob, the Attack, its damage formula, what a Taunt re-resolves against.
 *  - `hits.<id>`     One Attack on one defender (a declaration's target row):
 *    who it's aimed at now and first, whether it was Caught or Taunted, and
 *    its free and paid Evade Checks.
 *  - `crawlers.<key>` Who has used their Evade.
 *  - `taunts.<id>`   Each Taunt Check and the Attacks it pulled.
 *  - `stage`         "taunt" first (Taunts and Catches - "Taunt... after
 *    seeing where the Mob Attacks are headed", p.200), then "evade" once the
 *    GM opens Evades; `locked` once Lock Results runs.
 *
 * A Check: `{kind, formula, natural, base, difficulty, breakdown, roll,
 * advantage, interventions: [{byUuid, byName, value}], aiRerolled}` plus the
 * derived `total`, `degree` and `success` (gradeCheck). `base` is the rolled
 * total; Intervene d6s add to it (p.82).
 */
import { getDegreeOfSuccess, isHitDegree } from "./rules.mjs";

/** The Advantage a Check was rolled with, from its d20 expression. */
export function advantageOf(formula) {
  if (formula === "2d20kh") return "advantage";
  if (formula === "2d20kl") return "disadvantage";
  return "normal";
}

/**
 * A Check record from a roll result (CarlDice's post:false data).
 * @param {"free"|"evade"|"taunt"} kind
 * @param {{roll: Roll|object, total: number, naturalRoll: number|null, formula: string|null,
 *   difficulty: number|null, breakdown?: string, debuffNote?: string}} result
 * @returns {object}
 */
export function makeCheck(kind, result) {
  const roll = typeof result.roll?.toJSON === "function" ? result.roll.toJSON() : (result.roll ?? null);
  return gradeCheck({
    kind,
    formula: result.formula ?? "1d20",
    natural: result.naturalRoll ?? null,
    base: Number(result.total) || 0,
    difficulty: result.difficulty ?? null,
    breakdown: result.breakdown ?? "",
    note: result.debuffNote ?? "",
    roll,
    interventions: [],
    aiRerolled: null,
  });
}

/**
 * Recompute a Check's total (rolled total + Intervene d6s) and its degree.
 * @param {object} check
 * @returns {object} The same check, updated.
 */
export function gradeCheck(check) {
  const bonus = (check.interventions ?? []).reduce((sum, i) => sum + (Number(i.value) || 0), 0);
  check.total = (Number(check.base) || 0) + bonus;
  check.degree = getDegreeOfSuccess(check.natural, check.total, check.difficulty);
  check.success = isHitDegree(check.degree);
  return check;
}

/** A crawler's key in `crawlers` (a uuid's dots would read as a flag path). */
export function crawlerKey(uuid) {
  return String(uuid).replaceAll(".", "_");
}

/** Every hit, in declaration then row order. */
export function hitList(state) {
  return Object.values(state?.hits ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Every Taunt, in the order made. */
export function tauntList(state) {
  return Object.values(state?.taunts ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * The Evade that decides a hit at Resolution: the paid Evade if one was
 * rolled, else a free Evade that succeeded. A failed free Evade decides
 * nothing - "If they fail that free Check, they may still spend an Action to
 * Evade as usual" (p.96) - so it carries no Major Fail, Natural 1 or Near
 * Miss consequences of its own. A Caught hit can't be Evaded at all.
 * @param {object} hit
 * @returns {object|null}
 */
export function decidingEvade(hit) {
  if (hit.caughtBy) return null;
  return hit.evade ?? (hit.free?.success ? hit.free : null);
}

/** Whether a hit's free Evade succeeded and nothing has replaced it. */
export function freeEvaded(hit) {
  return !hit.caughtBy && !hit.evade && !!hit.free?.success;
}

/**
 * Whether a hit is already a miss before Resolution: the to-hit didn't
 * reach a vehicle, or a free Evade succeeded against a single-target Attack
 * (against an Area Attack it only halves the damage, p.83).
 * @param {object} hit
 * @returns {boolean}
 */
export function hitMissed(hit) {
  if (!hit.row?.hit) return true;
  return freeEvaded(hit) && !hit.isArea;
}

/**
 * Whether this hit can still be Evaded by its current target: aimed at a
 * creature that rolls its own Evade, not Caught, no successful Evade yet
 * (free or paid).
 * @param {object} hit
 * @returns {boolean}
 */
export function hitEvadable(hit) {
  return !!hit.row?.hit && !!hit.row?.isCharacter && !hit.caughtBy && !hit.evade && !hit.free?.success;
}

/**
 * The hits a crawler's Evade button rolls against.
 * @param {object} state
 * @param {string} uuid
 * @returns {object[]}
 */
export function evadableHitsFor(state, uuid) {
  return hitList(state).filter((hit) => hit.targetUuid === uuid && hitEvadable(hit));
}

/**
 * The hits a Taunt against this Mob would pull onto the taunter: its
 * single-target Attacks aimed at someone else that haven't missed and
 * weren't Caught.
 * @param {object} state
 * @param {string} mobUuid
 * @param {string} taunterUuid
 * @returns {object[]}
 */
export function pullableHits(state, mobUuid, taunterUuid) {
  return hitList(state).filter((hit) => {
    const attack = state.attacks?.[hit.attackId];
    return attack?.mobUuid === mobUuid && !attack.isArea && hit.targetUuid !== taunterUuid
      && !hit.caughtBy && !hitMissed(hit) && !!hit.row?.isCharacter;
  });
}

/**
 * The Mobs a crawler could Taunt: those with Attacks a Taunt would pull.
 * @param {object} state
 * @param {string} taunterUuid
 * @returns {{mobUuid: string, mobName: string}[]}
 */
export function tauntableMobs(state, taunterUuid) {
  const seen = new Map();
  for (const attack of Object.values(state?.attacks ?? {})) {
    if (seen.has(attack.mobUuid)) continue;
    if (pullableHits(state, attack.mobUuid, taunterUuid).length) seen.set(attack.mobUuid, attack.mobName);
  }
  return [...seen].map(([mobUuid, mobName]) => ({ mobUuid, mobName }));
}

/**
 * The hits a Catcher could take for an ally: single-target, aimed at
 * someone else who rolls their own Evade, not already Caught or a miss.
 * @param {object} state
 * @param {string} catcherUuid
 * @returns {object[]}
 */
export function catchableHits(state, catcherUuid) {
  return hitList(state).filter((hit) => {
    const attack = state.attacks?.[hit.attackId];
    return attack && !attack.isArea && hit.targetUuid !== catcherUuid && !!hit.row?.isCharacter
      && !hit.caughtBy && !hitMissed(hit) && !hit.evade;
  });
}

/**
 * The crawlers whose Checks this intervener could help, for the first step
 * of the Intervene picker.
 * @param {object} state
 * @param {string} intervenerUuid
 * @returns {{uuid: string, name: string}[]}
 */
export function intervenableAllies(state, intervenerUuid) {
  const allies = new Map();
  for (const c of intervenableChecks(state, intervenerUuid)) allies.set(c.ownerUuid, c.ownerName);
  return [...allies].map(([uuid, name]) => ({ uuid, name }));
}

/**
 * Every Check on the card as a reference plus who rolled it:
 * `{ref: {type: "hit", hitId, which: "free"|"evade"} | {type: "taunt", tauntId}, check, ownerUuid, label}`.
 * @param {object} state
 * @returns {object[]}
 */
export function checkList(state) {
  const out = [];
  for (const taunt of tauntList(state)) {
    out.push({ ref: { type: "taunt", tauntId: taunt.id }, check: taunt.check, ownerUuid: taunt.byUuid, ownerName: taunt.byName, taunt });
  }
  for (const hit of hitList(state)) {
    for (const which of ["free", "evade"]) {
      if (hit[which]) out.push({ ref: { type: "hit", hitId: hit.id, which }, check: hit[which], ownerUuid: hit.targetUuid, ownerName: hit.targetName, hit });
    }
  }
  return out;
}

/**
 * The Check a reference points at, or null.
 * @param {object} state
 * @param {object} ref
 * @returns {object|null}
 */
export function checkAt(state, ref) {
  if (ref?.type === "taunt") return state.taunts?.[ref.tauntId]?.check ?? null;
  if (ref?.type === "hit" && ["free", "evade"].includes(ref.which)) return state.hits?.[ref.hitId]?.[ref.which] ?? null;
  return null;
}

/**
 * Whether a Check can still change in this stage. A Taunt's result decides
 * where Attacks go, so it can only change before Evades open; a free Evade
 * only while no paid Evade has replaced it; a paid Evade once Evades are open.
 * @param {object} state
 * @param {object} ref
 * @returns {boolean}
 */
export function checkOpen(state, ref) {
  if (!state || state.locked) return false;
  if (ref.type === "taunt") return state.stage === "taunt";
  const hit = state.hits?.[ref.hitId];
  if (!hit || hit.caughtBy) return false;
  // A free Evade can still be helped or rerolled until a paid Evade takes
  // its place - but not once Evades are open and the crawler has used theirs.
  if (ref.which === "free") return !hit.evade && !state.crawlers?.[crawlerKey(hit.targetUuid)]?.evaded;
  return state.stage === "evade";
}

/**
 * The Checks an Intervene could help: anyone's but the intervener's own,
 * still open to change (p.82: "add the result of that die roll to another
 * crawler's Action after the result is announced").
 * @param {object} state
 * @param {string} intervenerUuid
 * @returns {object[]}
 */
export function intervenableChecks(state, intervenerUuid) {
  return checkList(state).filter((c) => c.ownerUuid !== intervenerUuid && checkOpen(state, c.ref));
}

/**
 * The Checks an AI Favor reroll could replace for one crawler: their own
 * failed Checks, not a Natural 1 (p.61), not already rerolled, still open.
 * @param {object} state
 * @param {string} ownerUuid
 * @returns {object[]}
 */
export function rerollableChecks(state, ownerUuid) {
  return checkList(state).filter((c) => c.ownerUuid === ownerUuid && !c.check.success
    && c.check.natural !== 1 && !c.check.aiRerolled && checkOpen(state, c.ref));
}

/**
 * Who still has an Attack landing that they could Evade but haven't - for
 * Lock Results' warning.
 * @param {object} state
 * @returns {string[]} Their names.
 */
export function unevadedNames(state) {
  const names = new Map();
  for (const hit of hitList(state)) {
    if (hitEvadable(hit)) names.set(hit.targetUuid, hit.targetName);
  }
  return [...names.values()];
}

/**
 * "Goblin: Bite → Wren" for a picker.
 * @param {object} state
 * @param {object} hit
 * @returns {string}
 */
export function hitLabel(state, hit) {
  const attack = state.attacks?.[hit.attackId];
  return `${attack?.mobName ?? "?"}: ${attack?.attackName ?? "?"} → ${hit.targetName}`;
}

/**
 * The sections of the card: one per creature with an Attack on it or a
 * Taunt of its own, in the order first seen.
 * @param {object} state
 * @returns {{uuid: string, name: string, hits: object[], taunts: object[]}[]}
 */
export function sectionsOf(state) {
  const sections = new Map();
  const section = (uuid, name) => {
    if (!sections.has(uuid)) sections.set(uuid, { uuid, name, hits: [], taunts: [] });
    return sections.get(uuid);
  };
  for (const hit of hitList(state)) section(hit.targetUuid, hit.targetName).hits.push(hit);
  for (const taunt of tauntList(state)) section(taunt.byUuid, taunt.byName).taunts.push(taunt);
  return [...sections.values()];
}

/**
 * The initial state from this round's declarations.
 * @param {Combat} combat
 * @param {object[]} declarations  module/helpers/declarations.mjs
 * @returns {object}
 */
export function buildReactionState(combat, declarations) {
  const state = {
    combatId: combat.id, round: combat.round, stage: "taunt", locked: false,
    attacks: {}, hits: {}, crawlers: {}, taunts: {}, nextOrder: 0,
  };
  for (const d of declarations) {
    state.attacks[d.id] = {
      id: d.id, mobUuid: d.mobUuid, mobName: d.mobName, mobImg: d.mobImg, attackName: d.attackName,
      damage: d.damage, damageType: d.damageType, damageIsMagic: d.damageIsMagic, isArea: d.isArea,
      floor: d.floor, mobBase: d.mobBase, mobOwnRows: d.mobOwnRows ?? [], effect: d.effect, range: d.range,
    };
    for (const row of Object.values(d.targetRows ?? {}).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))) {
      const id = `${d.id}-${row.id}`;
      state.hits[id] = {
        id, attackId: d.id, rowId: row.id, order: state.nextOrder++, row, isArea: !!d.isArea,
        targetUuid: row.uuid, targetName: row.name, originalUuid: row.uuid, originalName: row.name,
        caughtBy: null, tauntedBy: null, free: null, evade: null,
      };
      if (row.isCharacter) state.crawlers[crawlerKey(row.uuid)] ??= { uuid: row.uuid, name: row.name, evaded: false };
    }
  }
  return state;
}
