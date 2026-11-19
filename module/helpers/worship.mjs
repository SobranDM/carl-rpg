import { createCardMessage } from "../chat/chat-card.mjs";
import { PACKS } from "./packs.mjs";
import { esc } from "./html.mjs";
import { changeConditions } from "./conditions.mjs";

/**
 * Worship (Character Creation, pp.163-168; Gods, pp.312-313): the
 * Character's Deity block on the Benefits tab (benefits.hbs). Everything
 * here reads system.deity (module/data/character.mjs).
 */

/** "Every five consecutive days of worship ... you will receive a Boon" (p.164). */
export const BOON_DAYS = 5;

/** "Advantage on all Stat or Skill Checks for one stat for 30 hours" - a Boon's usual span (Table 63, p.313). */
export const BOON_HOURS = 30;

const BOONS_TABLE_NAME = "Boons";

/**
 * The required tithe, in percent of looted gold: the Tier's (5/10/20%,
 * CONFIG.CARLRPG.titheByTier), doubled by a first offense's penance and
 * quadrupled by a second (p.312). 0 without a Tier.
 * @param {{tier: string, penitence: number}} deity
 * @returns {number}
 */
export function deityTithe(deity) {
  const base = CONFIG.CARLRPG.titheByTier[deity?.tier] ?? 0;
  return base * 2 ** Math.max(0, deity?.penitence ?? 0);
}

/**
 * Whether the deity's benefits are lost right now: a missed offering (until
 * it's made the next day, p.163), Shunned until penance is paid (p.312), or
 * Fallen from Grace.
 * @param {object} deity
 * @returns {boolean}
 */
export function worshipSuspended(deity) {
  return !!(deity?.shunned || deity?.fallen || (deity?.missedOfferings ?? 0) > 0);
}

/**
 * Tier rank for comparisons: 0 for none, then Acolyte, Devotee, Zealot.
 * @param {string} tier
 * @returns {number}
 */
export function tierRank(tier) {
  return Object.keys(CONFIG.CARLRPG.featureTiers).indexOf(tier) + 1;
}

/**
 * Whether an owned item's benefits apply, given the crawler's worship. A
 * Boon (feature) with a Tier is one of the deity's church benefits: it
 * applies only at or below the crawler's Tier, and not while worship is
 * suspended. Every other item is unaffected. Read by the modifier engine
 * (aggregateActorBonuses) and the Benefits tab, which dims what doesn't.
 * @param {Item|object} item
 * @param {object} deity  system.deity
 * @returns {boolean}
 */
export function deityBenefitApplies(item, deity) {
  const tier = item?.type === "feature" ? item.system?.tier : "";
  if (!tier) return true;
  return !worshipSuspended(deity) && tierRank(tier) <= tierRank(deity?.tier);
}

/**
 * Whether a Boon can be received now: five consecutive days of worship
 * (p.164), a church Tier, and worship not suspended. The GM can still grant
 * one at any time.
 * @param {object} deity  system.deity
 * @returns {boolean}
 */
export function boonAvailable(deity) {
  return (deity?.worshipDays ?? 0) >= BOON_DAYS && !!deity?.tier && !worshipSuspended(deity);
}

/**
 * The sheet's Deity block (benefits.hbs).
 * @param {object} deity  system.deity
 * @returns {object}
 */
export function describeDeity(deity) {
  const days = deity.worshipDays ?? 0;
  const missed = deity.missedOfferings ?? 0;
  return {
    tithe: deityTithe(deity),
    tierLabel: deity.tier ? CONFIG.CARLRPG.featureTiers[deity.tier] : "",
    // Due from the fifth day until it's received - days past five carry
    // over toward the next one (receiveBoon).
    boonDue: days >= BOON_DAYS,
    daysToNextBoon: Math.max(0, BOON_DAYS - days),
    canReceive: boonAvailable(deity),
    suspended: worshipSuspended(deity),
    missedPips: [1, 2, 3].map((n) => ({
      value: n,
      filled: n <= missed,
      hint: `CARLRPG.Deity.Missed${n}`,
    })),
    tierChoices: { "": "CARLRPG.Deity.NoTier", ...CONFIG.CARLRPG.featureTiers },
    penitenceChoices: {
      0: "CARLRPG.Deity.Penitence0",
      1: "CARLRPG.Deity.Penitence1",
      2: "CARLRPG.Deity.Penitence2",
    },
  };
}

/**
 * Roll a Boon (Table 63, the roll-tables pack's "Boons") for this crawler:
 * it lands on the Conditions tab as a 30-hour custom Buff from the deity,
 * the five days it used come off the worship day count (any extra carry
 * over), and the result is posted to chat. The sheet offers it only when
 * boonAvailable() - except to the GM, who can grant one at any time.
 * The GM can adjust or remove the Buff - some Boons (a Rank-Up Check) are
 * immediate rather than timed.
 * @param {Actor} actor
 * @returns {Promise<TableResult|null>}
 */
export async function receiveBoon(actor) {
  const pack = game.packs.get(PACKS.rollTables);
  const index = await pack?.getIndex();
  const entry = index?.find((e) => e.name === BOONS_TABLE_NAME);
  const table = entry ? await pack.getDocument(entry._id) : null;
  if (!table) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Deity.NoBoonsTable"));
    return null;
  }
  const { results } = await table.roll({ recursive: false });
  const result = results[0];
  if (!result) return null;

  const deityName = actor.system.deity.name || game.i18n.localize("CARLRPG.Actor.Deity");
  const boon = {
    id: foundry.utils.randomID(),
    key: "custom",
    label: result.name,
    stacks: 1,
    source: deityName,
    durationType: null,
    remaining: null,
    expiresAt: game.time.worldTime + BOON_HOURS * 3600,
    changes: [],
  };
  const worshipDays = Math.max(0, (actor.system.deity.worshipDays ?? 0) - BOON_DAYS);
  await changeConditions(actor, [{ op: "push", entry: boon }], { updates: { "system.deity.worshipDays": worshipDays } });

  const description = result.description
    ? await foundry.applications.ux.TextEditor.implementation.enrichHTML(result.description, { relativeTo: actor })
    : "";
  await createCardMessage({
    title: game.i18n.localize("CARLRPG.Deity.BoonCardTitle"),
    subtitle: game.i18n.format("CARLRPG.Deity.BoonCardSubtitle", { deity: deityName }),
    img: actor.img,
    body: `<p><strong>${esc(result.name)}</strong></p>${description}`,
    actor,
  });
  return result;
}
