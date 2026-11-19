/**
 * A row's Evade on an Attack card, kept on the row itself
 * (docs/reaction-card-redesign.md, phase 3): no card of its own. The crawler
 * a Mob Attack (or another crawler's, p.87) is aimed at rolls it - Mobs never
 * roll (p.267). The row keeps its Checks in the Reaction card's shape
 * (module/helpers/reaction-state.mjs makeCheck/gradeCheck):
 *  - `checks.free`: a Disadvantaged Attack's free Evade (p.61, p.96);
 *  - `checks.evade`: the paid one;
 *  - `checks.block`: a Shield Block (helpers/shield-block.mjs) - its own
 *    Check, never the row's Evade: a block halves the damage, but the hit
 *    "still counts as ... a crawler who failed to Evade" (p.198). Once it's
 *    rolled the row's Evades are closed.
 * Each carries its Intervene d6s, its AI Reroll history, who rolled it and
 * the fight and round it was rolled in. From the deciding Check (the paid
 * one, or a free one that succeeded) the row's summary is written:
 *  - `evade` ({degree, success}) - read by damage (rowOutcome), a ram's
 *    recoil and the card's lock;
 *  - `freeUsed`, and the hit moved to the vehicle on an occupant's Near Miss
 *    (p.72);
 *  - and the Advantage a Natural 20 or Amazing Success gives against the
 *    attacker (p.79) is set or taken back.
 * An Intervene or AI Reroll on a row is applied by the GM, one at a time per
 * Attack card (module/chat/check-revision.mjs), and can go backwards (an
 * undone d6, a worse reroll).
 */
import { applyAiReroll, gradeCheck, makeCheck } from "../helpers/reaction-state.mjs";
import { aiRerollAllowed, fightStamp } from "../helpers/ai-favor.mjs";
import { isCrawler } from "../helpers/actor-kinds.mjs";
import { addConditionToActor } from "../helpers/conditions.mjs";
import { actorFromUuid, resolveCombatantFor } from "../helpers/token-resolution.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";
import { vehicleSeatOf } from "../helpers/vehicle-state.mjs";
import { cardFight, fightHelpers } from "./check-revision.mjs";

const SCOPE = "carl-rpg";
const GREAT_EVADE = ["criticalHit", "amazingSuccess"];
const WHICH = ["free", "evade", "block"];

/** Resolve a row's token/actor uuid to {actor, token}. */
export async function resolveRowTarget(row) {
  const doc = row?.uuid ? await fromUuid(row.uuid) : null;
  if (!doc) return null;
  if (doc instanceof Actor) return { actor: doc, token: null };
  return doc.actor ? { actor: doc.actor, token: doc } : null;
}


/** A row of an Attack card, by id. */
export function rowAt(message, rowId) {
  return message?.flags?.[SCOPE]?.targetRows?.[rowId] ?? null;
}

/** One of a row's Checks ("free" or "evade"), or null. */
export function rowCheck(row, which) {
  return WHICH.includes(which) ? (row?.checks?.[which] ?? null) : null;
}

/**
 * The Check that decides a row: the paid Evade, else a free one that
 * succeeded. A failed free Evade decides nothing (p.96).
 * @param {object} row
 * @returns {object|null}
 */
export function decidingRowCheck(row) {
  const checks = row?.checks ?? {};
  return checks.evade ?? (checks.free?.success ? checks.free : null);
}

/** The Check a row shows: a Shield Block, else the paid Evade, else the free one; and which. */
export function shownRowCheck(row) {
  if (row?.checks?.block) return { check: row.checks.block, which: "block" };
  if (row?.checks?.evade) return { check: row.checks.evade, which: "evade" };
  if (row?.checks?.free) return { check: row.checks.free, which: "free" };
  return { check: null, which: null };
}

/**
 * The injury a row's deciding Evade calls for (p.79-80): a Major Fail a
 * Minor Injury, a Critical Fail a Major Injury - or null.
 * @param {object} row
 * @returns {"minorInjury"|"majorInjury"|null}
 */
export function rowInjury(row) {
  const degree = decidingRowCheck(row)?.degree;
  if (degree === "majorFail") return "minorInjury";
  if (degree === "criticalFail") return "majorInjury";
  return null;
}

/**
 * A row's summary fields from its Checks.
 * @param {object} row
 * @param {{free?: object|null, evade?: object|null}} checks
 * @param {{isArea: boolean, target: {actor: Actor}|null}} context
 * @returns {object}
 */
function rowSummary(row, checks, { isArea, target }) {
  const deciding = checks.evade ?? (checks.free?.success ? checks.free : null);
  // Not an Area Attack: the vehicle is caught in it on its own row.
  const seat = deciding && !deciding.success && deciding.degree === "nearMissFail" && !isArea && target
    ? vehicleSeatOf(target.actor) : null;
  const summary = {
    evade: deciding ? { degree: deciding.degree, success: deciding.success } : null,
    freeUsed: !!checks.free || !!row.freeUsed,
    redirectUuid: seat?.vehicle.uuid ?? null,
    redirectName: seat?.vehicle.name ?? null,
  };
  // A Shield Block's outcome (attack-targets-card.mjs) - only on a row that
  // has had one, so an Evade's write leaves other rows as they were.
  if (checks.block || "block" in row) {
    summary.block = checks.block ? { degree: checks.block.degree, success: checks.block.success } : null;
  }
  return summary;
}

/** Set, or take back, the Advantage a great Evade gives against the attacker. */
async function moveAdvantage(attack, target, before, after) {
  const attackerUuid = attack.flags[SCOPE]?.attackerUuid;
  if (!attackerUuid || !target) return;
  const combatant = resolveCombatantFor(target);
  if (!combatant?.canUserModify(game.user, "update")) return;
  const held = combatant.getFlag(SCOPE, "advantageVsUuid") === attackerUuid;
  if (GREAT_EVADE.includes(after)) {
    if (!held) await combatant.setFlag(SCOPE, "advantageVsUuid", attackerUuid);
  } else if (GREAT_EVADE.includes(before) && held) {
    await combatant.unsetFlag(SCOPE, "advantageVsUuid");
  }
}

/**
 * Record a row's Evade (its Evade icon): the Check on the row, and the
 * row's summary from it. The roller's own client writes it (through the GM
 * when the card isn't theirs).
 * @param {ChatMessage} attack  The Attack card.
 * @param {object} row
 * @param {{actor: Actor, token: TokenDocument|null}} target
 * @param {object} result  rollEvadeCheck's post:false result.
 * @param {{free: boolean}} options
 * @returns {Promise<object>}  The Check recorded.
 */
export async function recordRowEvade(attack, row, target, result, { free }) {
  const which = free ? "free" : "evade";
  const check = {
    ...makeCheck(which, result),
    id: foundry.utils.randomID(),
    actorUuid: target.actor.uuid,
    // An Intervene is open while the fight is on this round (check-revision.mjs cardFight).
    fight: fightStamp(target.actor),
  };
  const checks = { ...(row.checks ?? {}), [which]: check };
  const summary = rowSummary(row, checks, { isArea: !!attack.flags[SCOPE].isArea, target });
  await moveAdvantage(attack, target, decidingRowCheck(row)?.degree ?? null, summary.evade?.degree ?? null);
  await updateCardMessage(attack, { flags: { [SCOPE]: { targetRows: { [row.id]: { checks: { [which]: check }, ...summary } } } } });
  return check;
}

/**
 * Record a row's Shield Block (its shield icon): the Check on the row with
 * the Shield and Rank it was made with, and the row's summary. Written like
 * an Evade (recordRowEvade).
 * @param {ChatMessage} attack  The Attack card.
 * @param {object} row
 * @param {{actor: Actor, token: TokenDocument|null}} target
 * @param {object} result  rollOpposedSkillCheck's post:false result.
 * @param {{shield: Item, rank: number}} options
 * @returns {Promise<object>}  The Check recorded.
 */
export async function recordRowBlock(attack, row, target, result, { shield, rank }) {
  const check = {
    ...makeCheck("block", result),
    id: foundry.utils.randomID(),
    actorUuid: target.actor.uuid,
    fight: fightStamp(target.actor),
    shieldId: shield.id,
    shieldName: shield.name,
    rank,
  };
  const checks = { ...(row.checks ?? {}), block: check };
  const summary = rowSummary(row, checks, { isArea: !!attack.flags[SCOPE].isArea, target });
  await updateCardMessage(attack, { flags: { [SCOPE]: { targetRows: { [row.id]: { checks: { block: check }, ...summary } } } } });
  return check;
}

/**
 * Whether a ram's recoil (module/helpers/vehicle-ram.mjs), decided by this
 * row's Evade, has already been applied: the Evade can't change after it.
 * @param {ChatMessage} attack
 * @param {string} rowId
 * @returns {boolean}
 */
export function recoilSettledBy(attack, rowId) {
  const flags = attack?.flags?.[SCOPE] ?? {};
  if (flags.ram?.primaryRowId !== rowId) return false;
  return Object.values(flags.targetRows ?? {}).some((r) => r?.role === "recoil" && r.applied);
}

/**
 * Whether a row's Check can still change (an AI Reroll, an Intervene's
 * undo): the row isn't applied or Taunted away, its injury hasn't been
 * added, a ram's recoil it decided hasn't been applied; a free Evade only
 * while no paid Evade has replaced it, and an Evade only while no Shield
 * Block has followed it.
 * @param {ChatMessage} attack
 * @param {string} rowId
 * @param {"free"|"evade"} which
 * @returns {boolean}
 */
export function rowCheckOpen(attack, rowId, which) {
  const row = rowAt(attack, rowId);
  if (!rowCheck(row, which) || row.applied || row.replaced || row.injuryAdded) return false;
  if (recoilSettledBy(attack, rowId)) return false;
  if (which === "block") return true;
  if (row.checks?.block) return false;
  return which === "evade" || !row.checks?.evade;
}

/**
 * Whether an Intervene can still change a row's Check: a crawler's (it
 * helps "another crawler", p.82 - not a Pet's), open, and rolled in a fight
 * that's still on that round. Its natural d20 doesn't matter (ruled
 * 2026-11-19).
 * @param {ChatMessage} attack
 * @param {string} rowId
 * @param {"free"|"evade"} which
 * @returns {boolean}
 */
export function rowInterveneOpen(attack, rowId, which) {
  const check = rowCheck(rowAt(attack, rowId), which);
  if (!check) return false;
  if (!isCrawler(actorFromUuid(check.actorUuid))) return false;
  return rowCheckOpen(attack, rowId, which) && !!cardFight(check);
}

/**
 * The crawlers this user could Intervene with on a row's Check: their own
 * (any, for the GM) in its fight, other than whoever rolled it.
 * @returns {Actor[]}
 */
export function rowInterveners(attack, rowId, which, user = game.user) {
  const check = rowCheck(rowAt(attack, rowId), which);
  return fightHelpers(check ? cardFight(check) : null, check?.actorUuid, user);
}

/**
 * The rerolls this user could make on a row's Check: AI Favor (p.61) - the
 * roller's owner (or the GM), with AI Favor left, once per Check, never a
 * Natural 1.
 * @returns {Array<{key: "favor", actor: Actor, favor: number}>}
 */
export function rowRerollSources(attack, rowId, which, user = game.user) {
  if (!rowCheckOpen(attack, rowId, which)) return [];
  const check = rowCheck(rowAt(attack, rowId), which);
  const actor = actorFromUuid(check.actorUuid);
  if (!aiRerollAllowed(check, actor, user)) return [];
  return [{ key: "favor", actor, favor: actor.system.details?.aiFavor ?? 0 }];
}

/**
 * A row's Check revised (GM, module/chat/check-revision.mjs): its d6s, or a
 * new d20 from an AI Reroll, re-graded; `write` puts it and the row's
 * summary on the card, and moves the Advantage.
 * @param {ChatMessage} attack
 * @param {string} rowId
 * @param {"free"|"evade"} which
 * @param {{interventions: object[], reroll: {natural: number, total: number, roll: object, breakdown: string}|null}} change
 * @returns {Promise<{write: () => Promise<void>}|null>}  null if the row or its target is gone.
 */
export async function reviseRow(attack, rowId, which, { interventions = [], reroll = null }) {
  const row = foundry.utils.deepClone(rowAt(attack, rowId));
  const check = rowCheck(row, which);
  const target = row ? await resolveRowTarget(row) : null;
  if (!check || !target) return null;
  const before = decidingRowCheck(row)?.degree ?? null;
  if (reroll) applyAiReroll(check, reroll);
  check.interventions = interventions;
  gradeCheck(check);
  const checks = { ...row.checks, [which]: check };
  const summary = rowSummary(row, checks, { isArea: !!attack.flags[SCOPE].isArea, target });
  return {
    write: async () => {
      await moveAdvantage(attack, target, before, summary.evade?.degree ?? null);
      const { ForcedReplacement } = foundry.data.operators;
      await attack.update({ flags: { [SCOPE]: { targetRows: { [rowId]: { checks: { [which]: ForcedReplacement.create(check) }, ...summary } } } } });
    },
  };
}

/**
 * Take a row's paid Evade or Shield Block back (undoing its Action,
 * module/helpers/action-undo.mjs): the row as it was before it - a free
 * Evade's result still stands. GM.
 * @param {ChatMessage} attack
 * @param {string} rowId
 * @param {string} checkId  The Check's id; a different one (a later Evade)
 *   is left alone.
 * @param {"evade"|"block"} [which]
 * @returns {Promise<void>}
 */
export async function clearRowEvade(attack, rowId, checkId, which = "evade") {
  const row = rowAt(attack, rowId);
  if (!row || !["evade", "block"].includes(which) || row.checks?.[which]?.id !== checkId) return;
  const target = await resolveRowTarget(row);
  const checks = { ...row.checks, [which]: null };
  const summary = rowSummary(which === "evade" ? { ...row, freeUsed: false } : row, checks, { isArea: !!attack.flags[SCOPE].isArea, target });
  const { ForcedDeletion } = foundry.data.operators;
  await attack.update({
    flags: { [SCOPE]: { targetRows: { [rowId]: { checks: { [which]: new ForcedDeletion() }, ...summary } } } },
  }, { carlUndo: true });
}

/**
 * Add the injury a row's Evade called for (its band-aid icon) - never
 * automatic. The row is marked, so its Evade can't change after.
 * @param {ChatMessage} attack
 * @param {string} rowId
 * @returns {Promise<boolean>}
 */
export async function addRowInjury(attack, rowId) {
  const row = rowAt(attack, rowId);
  const key = rowInjury(row);
  if (!key || row.injuryAdded) return false;
  const target = await resolveRowTarget(row);
  if (!target) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Evade.NoActor"));
    return false;
  }
  await updateCardMessage(attack, { flags: { [SCOPE]: { targetRows: { [rowId]: { injuryAdded: true } } } } });
  await addConditionToActor(target.actor, key, { source: game.i18n.localize("CARLRPG.Roll.Evade") });
  ui.notifications.info(game.i18n.format("CARLRPG.Evade.DebuffAddedNotice", { name: target.actor.name }));
  return true;
}
