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
 *  - `crawlers.<key>` Who has used their Evade: its dialog's choices
 *    (`evadePreset`, for Attacks that land on them later) and the Action it
 *    spent (`evadeSpent`, given back if it ends up covering nothing).
 *  - `taunts.<id>`   Each Taunt Check and the Attacks it pulled.
 *  - `locked`        once Lock Results runs.
 * There are no stages (docs/reaction-card-redesign.md): Taunt, Catch, Evade,
 * Intervene and AI Reroll are all open until Lock Results, and the card
 * ends where "Taunts first, then Evades" would have, whatever the order.
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
 * single-target Attacks aimed at someone else that are still landing - not
 * missed, not Caught, and not already Evaded (an Attack already dodged
 * isn't "headed" anywhere, p.200).
 * @param {object} state
 * @param {string} mobUuid
 * @param {string} taunterUuid
 * @returns {object[]}
 */
export function pullableHits(state, mobUuid, taunterUuid) {
  return hitList(state).filter((hit) => {
    const attack = state.attacks?.[hit.attackId];
    return attack?.mobUuid === mobUuid && !attack.isArea && hit.targetUuid !== taunterUuid
      && !hit.caughtBy && !hitMissed(hit) && !hit.evade?.success && !!hit.row?.isCharacter;
  });
}

/**
 * A Mob's Area Attacks that a Taunt against it could re-aim at the taunter,
 * if the GM allows it (the card's "Pull Area Attacks too"): ones landing on
 * anyone else that haven't been Caught or locked in.
 * @param {object} state
 * @param {string} mobUuid
 * @param {string} taunterUuid
 * @returns {string[]}  Their attack ids.
 */
export function pullableAreaAttacks(state, mobUuid, taunterUuid) {
  return Object.entries(state?.attacks ?? {})
    .filter(([id, attack]) => attack.isArea && attack.mobUuid === mobUuid
      && hitList(state).some((hit) => hit.attackId === id && hit.targetUuid !== taunterUuid))
    .map(([id]) => id);
}

/**
 * The Mobs a crawler could Taunt: those with Attacks a Taunt would pull -
 * single-target ones, or Area Attacks the GM may let it re-aim.
 * @param {object} state
 * @param {string} taunterUuid
 * @returns {{mobUuid: string, mobName: string}[]}
 */
export function tauntableMobs(state, taunterUuid) {
  const seen = new Map();
  for (const attack of Object.values(state?.attacks ?? {})) {
    if (seen.has(attack.mobUuid)) continue;
    if (pullableHits(state, attack.mobUuid, taunterUuid).length
      || pullableAreaAttacks(state, attack.mobUuid, taunterUuid).length) seen.set(attack.mobUuid, attack.mobName);
  }
  return [...seen].map(([mobUuid, mobName]) => ({ mobUuid, mobName }));
}

/**
 * The hits a Catcher could take for an ally: single-target, aimed at
 * someone else who rolls their own Evade, not already Caught, a miss or
 * Evaded. One the ally failed to Evade can still be Caught (their failed
 * Evade drops off).
 * @param {object} state
 * @param {string} catcherUuid
 * @returns {object[]}
 */
export function catchableHits(state, catcherUuid) {
  return hitList(state).filter((hit) => {
    const attack = state.attacks?.[hit.attackId];
    return attack && !attack.isArea && hit.targetUuid !== catcherUuid && !!hit.row?.isCharacter
      && !hit.caughtBy && !hitMissed(hit) && !hit.evade?.success;
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
 * Whether a Check can still change: anything until Lock Results, but a free
 * Evade only while no paid Evade has replaced it, and nothing on a Caught
 * hit (it can't be Evaded).
 * @param {object} state
 * @param {object} ref
 * @returns {boolean}
 */
export function checkOpen(state, ref) {
  if (!state || state.locked) return false;
  if (ref.type === "taunt") return !!state.taunts?.[ref.tauntId];
  const hit = state.hits?.[ref.hitId];
  if (!hit || hit.caughtBy) return false;
  if (ref.which === "free") return !!hit.free && !hit.evade;
  return !!hit.evade;
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
 * The sections of the card: one per creature with an Attack on it, a Taunt
 * of its own, or an Attack that has moved off it, in the order first seen.
 * `moved` are the hits that were aimed at it first and now aren't (drawn
 * struck through, saying where they went).
 * @param {object} state
 * @returns {{uuid: string, name: string, hits: object[], taunts: object[], moved: object[]}[]}
 */
export function sectionsOf(state) {
  const sections = new Map();
  const section = (uuid, name) => {
    if (!sections.has(uuid)) sections.set(uuid, { uuid, name, hits: [], taunts: [], moved: [] });
    return sections.get(uuid);
  };
  for (const hit of hitList(state)) {
    if (hit.originalUuid && hit.originalUuid !== hit.targetUuid) section(hit.originalUuid, hit.originalName).moved.push(hit);
    section(hit.targetUuid, hit.targetName).hits.push(hit);
  }
  for (const taunt of tauntList(state)) section(taunt.byUuid, taunt.byName).taunts.push(taunt);
  return [...sections.values()];
}

/**
 * Where one hit stands, as its row shows it (the status chips,
 * docs/reaction-card-redesign.md), with the Check that shows it.
 *  - missed: the to-hit didn't reach it, or a free Evade made it miss;
 *  - caught: taken by a Catcher, who can't Evade it;
 *  - evaded / half / quarter: Evaded - an Area Attack halved, or quartered
 *    in its Splash (p.83);
 *  - hit: lands (after a failed Evade, on a creature that doesn't Evade, or
 *    once locked without one);
 *  - incoming: still to be Evaded.
 * @param {object} state
 * @param {object} hit
 * @returns {{status: string, check: object|null, which: "free"|"evade"|null}}
 */
export function hitStatus(state, hit) {
  if (!hit.row?.hit) return { status: "missed", check: null, which: null };
  if (hit.caughtBy) return { status: "caught", check: null, which: null };
  const deciding = decidingEvade(hit);
  const which = deciding ? (deciding === hit.evade ? "evade" : "free") : null;
  if (deciding?.success) {
    if (!hit.isArea) return { status: which === "free" ? "missed" : "evaded", check: deciding, which };
    return { status: hit.row.zone === "splash" ? "quarter" : "half", check: deciding, which };
  }
  if (hit.evade) return { status: "hit", check: hit.evade, which: "evade" };
  // Not Evaded yet: a failed free Evade shows, but decides nothing.
  const free = hit.free ? { check: hit.free, which: "free" } : { check: null, which: null };
  if (!hit.row.isCharacter || state?.locked) return { status: "hit", ...free };
  return { status: "incoming", ...free };
}

/** How far the card has got: the hits no longer incoming, of all of them. */
export function cardProgress(state) {
  const hits = hitList(state);
  return { settled: hits.filter((hit) => hitStatus(state, hit).status !== "incoming").length, total: hits.length };
}

/**
 * A section's headline counts: what's still bad or pending for this
 * creature (hits, incoming, caught, halved). None of those is "all clear".
 * @param {object} state
 * @param {{hits: object[]}} section
 * @returns {Record<"hit"|"incoming"|"caught"|"half", number>}
 */
export function sectionCounts(state, section) {
  const counts = { hit: 0, incoming: 0, caught: 0, half: 0 };
  for (const hit of section.hits) {
    const { status } = hitStatus(state, hit);
    if (status === "quarter" || status === "half") counts.half++;
    else if (status in counts) counts[status]++;
  }
  return counts;
}

/**
 * The crawlers whose Evade no longer covers any Attack (every Attack it
 * rolled against has moved away): their Action comes back.
 * @param {object} state
 * @returns {object[]}  Their `crawlers` entries.
 */
export function idleEvaders(state) {
  return Object.values(state?.crawlers ?? {}).filter((crawler) => crawler.evaded
    && !hitList(state).some((hit) => hit.targetUuid === crawler.uuid && hit.evade));
}

/**
 * The initial state from this round's declarations.
 * @param {Combat} combat
 * @param {object[]} declarations  module/helpers/declarations.mjs
 * @returns {object}
 */
export function buildReactionState(combat, declarations) {
  const state = {
    combatId: combat.id, round: combat.round, locked: false,
    attacks: {}, hits: {}, crawlers: {}, taunts: {}, nextOrder: 0,
    // Actions the card's ops spent (helpers/actions.mjs), refunded if it's discarded.
    spentActions: [],
  };
  for (const d of declarations) {
    state.attacks[d.id] = {
      id: d.id, mobUuid: d.mobUuid, mobName: d.mobName, mobImg: d.mobImg, attackName: d.attackName,
      damage: d.damage, damageType: d.damageType, damageIsMagic: d.damageIsMagic, armorPiercing: !!d.armorPiercing, isArea: d.isArea,
      floor: d.floor, mobBase: d.mobBase, mobOwnRows: d.mobOwnRows ?? [], effect: d.effect, range: d.range,
      // Its Debuffs, each with its trigger - landed at Resolution
      // (reaction-resolve.mjs; docs/mob-sheet.md).
      targetEffects: d.targetEffects ?? [],
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
