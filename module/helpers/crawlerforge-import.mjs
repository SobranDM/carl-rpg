/**
 * Importer for CrawlerForge (crawlerforge.com) crawler Export files.
 *
 * An export is an event log, not a snapshot: `{schemaVersion: 1, kind:
 * "crawler", events: [...]}`, where `crawler.created` carries the full
 * starting sheet and later events (`item.added`, `gold.changed`,
 * `hotlist.set`, ...) amend it. `event.retracted` undoes an earlier event by
 * id. foldCrawlerForgeEvents replays that log into one state object;
 * buildCrawlerForgeActorData maps the state onto carl-rpg's schema and
 * decides everything else (what's copied from a compendium, what's
 * CrawlerForge's own, where gear goes) from the sources it's handed; both
 * are pure, so the Quench suite and a Node script can check them without
 * touching the world. importCrawlerForgeCrawler gathers the sources, writes,
 * places the gear and whispers the GM a report.
 *
 * Skills and Spells (ruled 2026-11-18, docs/imports.md phase 3): CrawlerForge
 * invents Skills the book doesn't have, and marks every entry, real or not,
 * `crawlerforge: true`. So an entry is matched by name to our compendiums
 * (compendium-match.mjs's priority: system packs, rulebook imports, world
 * Items, other packs) and copied at the exported Rank; anything else is
 * built from the export's own definition - a Spell as a Spell - and flagged
 * `flags.carl-rpg.crawlerforge.notInRulebook` for the GM to decide on.
 *
 * Stats: CrawlerForge's `unenhanced` layer is the book's Unenhanced Stat -
 * starting Stats PLUS Race/Class boosts (Playing the Game, Stats). That is
 * exactly what carl-rpg stores in the baked base `stats.*.value` (see
 * module/helpers/race-class-grants.mjs), and the exported Skill ranks are
 * likewise taken as final. So the imported Race/Class items carry their
 * stat/skillRank grants for display, but are created with every grant that
 * applies at the crawler's Level already in their `bakedGrantIds` flag -
 * otherwise item._onCreate would bake them a second time on top of a base
 * that already includes them. They're created with `carlPreBaked`, so
 * item._preCreate keeps that flag rather than emptying it as it does for
 * a Race/Class copied onto an actor. A level-gated grant not reached yet is left
 * to bake on the Level-up. A Skill a Race/Class grants that the export
 * doesn't list is made at the granted Rank.
 *
 * A Race or Class is our compendium's (carl-rpg.classes-and-races) when one
 * has exactly its name (Q7b) - case aside, parentheticals counting
 * ("Human" is not "Human (Primal)"). CrawlerForge's `species` is the kind of
 * crawler (a human or an animal one, chargen's `kind`), not a Race: Race
 * selection is a Third Floor choice (Race & Class Selection, p.128), and our
 * Race "Human" is that choice (+2 to all Stats). SPECIES_IS_RACE switches
 * that reading.
 */

import { CARLRPG } from "./config.mjs";
import {
  bareSkillLikeData,
  cappedGrantRank,
  cleanSkillLikeCopy,
  isEligibleNow,
  SKILL_LIKE_TYPES,
} from "./race-class-grants.mjs";
import { slugifySkillName } from "./modifiers.mjs";
import { changeEntry } from "../pdf-import/shared.mjs";
import { escapeHtml } from "../pdf-import/page-text.mjs";
import { buildMatcher, normalizeName } from "../pdf-import/compendium-match.mjs";
import { matchCandidates } from "../pdf-import/importer.mjs";
import { storyToHtml } from "./rich-text.mjs";
import { HANDS, WEAR_SLOT_OF_GEAR_SLOT, canWear, isTwoHanded } from "./gear.mjs";
import {
  freeSlotFor,
  isItemWorn,
  placeInFreeSlot,
  slotHolds,
  slotRefusal,
} from "./equip-slots.mjs";
import { canHotlist } from "./hotlist.mjs";
import { PAST_TABLES, tableTexts, weaponData } from "./chargen.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";
import { copyData, PACKS, stripCopyFields, systemTable } from "./packs.mjs";
import { gmUserIds } from "./ownership.mjs";
import { esc } from "./html.mjs";

const SCOPE = "carl-rpg";
const FLAG = "crawlerforge";
const SUPPORTED_SCHEMA_VERSION = 1;

/** Read `species` as a Race name (Q7b) rather than the kind of crawler. */
const SPECIES_IS_RACE = false;

/**
 * The Race or Class name an export asks for: its definition's, or for a
 * Race the species when that's read as one (Q7b).
 * @param {object} crawler
 * @param {"race"|"class"} type
 * @returns {string|null}
 */
function raceClassName(crawler, type) {
  return (
    crawler[type]?.definition?.name ?? (type === "race" && SPECIES_IS_RACE ? crawler.species : null)
  );
}

/** A Race/Class name as matched: exact but for case and surrounding spaces (Q7b). */
function raceClassKey(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

/** A CrawlerForge slot -> the Equipment Doll slot it means. */
const GEAR_SLOT_MAP = {
  head: "head",
  torso: "torso",
  arms: "arms",
  hand: "mainHand",
  hands: "mainHand",
  offhand: "offHand",
  gloves: "gloves",
  legs: "legs",
  feet: "feet",
};
const RESISTANCE_MAP = { resistance: "resist", vulnerability: "vulnerable", immunity: "immune" };
const UPGRADE_RANKS = [5, 10, 15];
/** Effect types the importer knows and handles elsewhere (a Race's Size). */
const HANDLED_ELSEWHERE = new Set(["size"]);
/** checkTypes our Skills/Spells already roll as (an Attack vs Evade, else a plain Check). */
const KNOWN_CHECK_TYPES = new Set(["none", "unopposed", "evade"]);
const SPELL_KEYWORDS = ["attack", "passive", "interrupt", "areaOfEffect", "mindControl", "heal"];
const HEALS = ["self", "others", "pets", "anyone"];
/**
 * "Standard Mana Potion" is the book's name for our "Mana Potion" (Table 46
 * lists Standard, Good... Potions; chargen's starting Spell gives five Mana
 * Potions). Tried only when the full name matches nothing.
 */
const STANDARD_PREFIX = /^standard\s+/i;

/**
 * A CrawlerForge slot as where-worn keys (CONFIG.CARLRPG.wearSlots): a
 * hand is Held; none for an item with no slot.
 * @param {string} slot
 * @returns {string[]}
 */
export function crawlerforgeSlots(slot) {
  if (slot === "accessory") return ["accessory"];
  const gearSlot = GEAR_SLOT_MAP[slot];
  if (!gearSlot) return [];
  return [WEAR_SLOT_OF_GEAR_SLOT[gearSlot] ?? gearSlot];
}

/**
 * Replay a CrawlerForge export's event log into a single crawler state.
 * @param {object} exportJson  Parsed export file.
 * @returns {{crawler: object, items: object[], gold: number|null, hotlist: string[]|null, warnings: string[]}}
 */
export function foldCrawlerForgeEvents(exportJson) {
  if (exportJson?.kind !== "crawler" || !Array.isArray(exportJson.events)) {
    throw new Error(
      'Not a CrawlerForge crawler export (expected kind "crawler" with an events list).',
    );
  }
  if (exportJson.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported CrawlerForge export schemaVersion ${exportJson.schemaVersion} (expected ${SUPPORTED_SCHEMA_VERSION}).`,
    );
  }

  const retracted = new Set(
    exportJson.events.filter((e) => e.type === "event.retracted").map((e) => e.payload?.eventId),
  );
  const events = exportJson.events
    .filter((e) => !retracted.has(e.id))
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));

  const state = { crawler: null, items: [], gold: null, hotlist: null, warnings: [] };
  const unknownTypes = new Set();
  for (const event of events) {
    const payload = event.payload ?? {};
    switch (event.type) {
      case "crawler.created":
        state.crawler = payload;
        break;
      case "item.added":
        state.items.push(payload);
        break;
      case "gold.changed":
        state.gold = payload.gold;
        break;
      case "hotlist.set":
        state.hotlist = payload.entries ?? [];
        break;
      case "crawler.kept":
      case "event.retracted":
        break;
      default:
        unknownTypes.add(event.type);
    }
  }
  if (!state.crawler) throw new Error("CrawlerForge export has no crawler.created event.");
  for (const type of unknownTypes) state.warnings.push(`Skipped unsupported event type "${type}".`);
  return state;
}

/** An effect in a few words, for the report. */
function effectText(effect) {
  const what =
    effect.skill?.label ??
    effect.skill?.name ??
    effect.club ??
    effect.stat ??
    effect.damageType ??
    "";
  return what ? `${effect.type}: ${what}` : String(effect.type ?? "?");
}

/**
 * Map CrawlerForge effects (Race/Class build entries, item effects) onto
 * carl-rpg ChangeEntries. What has no carl-rpg equivalent (a Skill of your
 * choice, a group of Skills, rank caps, club memberships) is returned as
 * `unmapped` for the report - its text still lands in the owning item's
 * description where the export has some.
 * @param {object[]} effects
 * @param {string} label
 * @returns {{changes: object[], unmapped: string[]}}
 */
export function effectsToChanges(effects = [], label = "") {
  const changes = [];
  const unmapped = [];
  for (const effect of effects ?? []) {
    if (effect.type === "stat" && CARLRPG.statAbbreviations[effect.stat]) {
      changes.push(
        changeEntry({
          label,
          targetType: "stat",
          target: effect.stat,
          value: String(effect.amount),
        }),
      );
    } else if (effect.type === "skill" && effect.skill?.kind === "named") {
      changes.push(
        changeEntry({
          label,
          targetType: "skillRank",
          target: effect.skill.name,
          value: String(effect.ranks),
        }),
      );
    } else if (effect.type === "advancementBonus" && effect.skill?.kind === "named") {
      changes.push(
        changeEntry({
          label,
          targetType: "advancementBonus",
          target: effect.skill.name,
          value: String(effect.bonus),
        }),
      );
    } else if (effect.type === "dr") {
      changes.push(
        changeEntry({ label, targetType: "resource", target: "dr", value: String(effect.amount) }),
      );
    } else if (
      effect.type === "damageResponse" &&
      CARLRPG.damageTypes[effect.damageType] &&
      RESISTANCE_MAP[effect.response]
    ) {
      changes.push(
        changeEntry({
          label,
          targetType: "resistance",
          target: effect.damageType,
          mode: "override",
          value: RESISTANCE_MAP[effect.response],
        }),
      );
    } else if (!HANDLED_ELSEWHERE.has(effect.type)) {
      unmapped.push(effectText(effect));
    }
  }
  return { changes, unmapped };
}

/** Definition blurb plus the build's benefit/detriment lines as HTML. */
function buildDescription(definition) {
  const parts = [`<p>${escapeHtml(definition.description ?? "")}</p>`];
  const list = (title, entries = []) => {
    if (!entries.length) return;
    const lines = entries.map((e) => {
      const name =
        e.name && !String(e.text).startsWith(e.name)
          ? `<strong>${escapeHtml(e.name)}:</strong> `
          : "";
      return `<li>${name}${escapeHtml(e.text ?? "")}</li>`;
    });
    parts.push(`<p><strong>${title}</strong></p><ul>${lines.join("")}</ul>`);
  };
  list("Benefits", definition.build?.benefits);
  list("Detriments", definition.build?.detriments);
  return parts.join("");
}

/** Race/Class item data from CrawlerForge's own definition. */
function buildRaceClassItem(type, definition, report) {
  const entries = [...(definition.build?.benefits ?? []), ...(definition.build?.detriments ?? [])];
  const changes = [];
  for (const entry of entries) {
    const mapped = effectsToChanges(entry.effects, entry.text ?? "");
    changes.push(...mapped.changes);
    if (mapped.unmapped.length)
      report.unmappedEffects.push({
        owner: definition.name,
        text: entry.text || mapped.unmapped.join(", "),
      });
  }
  const system = { description: buildDescription(definition), changes };
  if (type === "race") {
    if (definition.size) system.size = `${definition.size.name} (${definition.size.value})`;
    system.isEarthBased = definition.origin === "earth";
    system.isAlien = definition.origin === "alien";
  } else {
    system.classTypes = (definition.classTypes ?? []).map(
      (t) => t.charAt(0).toUpperCase() + t.slice(1),
    );
  }
  return { name: definition.name, type, system, flags: { [SCOPE]: {} } };
}

/**
 * Does a Race/Class grant apply now (and so is already in the exported
 * Stats and Ranks)? The grant engine's own rule (race-class-grants.mjs
 * isEligibleNow), so the two can't drift apart.
 */
function grantAppliesAt(change, level) {
  return isEligibleNow(change, level);
}

/**
 * A Race/Class ready to create: every change given an id (compendium ones
 * ship blank) and those that apply at this Level marked baked.
 * @param {object} data  Item data.
 * @param {number} level
 * @param {string} key
 * @returns {object}
 */
function preBaked(data, level, key) {
  const copy = stripCopyFields(foundry.utils.deepClone(data));
  copy.system ??= {};
  copy.system.changes = (copy.system.changes ?? []).map((c) =>
    c.id ? c : { ...c, id: foundry.utils.randomID() },
  );
  copy.flags = foundry.utils.mergeObject(copy.flags ?? {}, {
    [SCOPE]: {
      bakedGrantIds: copy.system.changes.filter((c) => grantAppliesAt(c, level)).map((c) => c.id),
      [FLAG]: { key },
    },
  });
  return copy;
}

/** A debuff rider's `when`, as a target effect's flags - or null if ours has no such trigger. */
function riderTrigger(when) {
  if (!when) return { critOnly: false, amazingSuccessOnly: false };
  if (when.kind === "crit") return { critOnly: true, amazingSuccessOnly: false };
  if (when.kind === "degree" && when.atLeast === "amazingSuccess")
    return { critOnly: false, amazingSuccessOnly: true };
  return null;
}

/**
 * Rank 5/10/15 Upgrade tiers from a CrawlerForge skill definition. Riders
 * with no carl-rpg equivalent stay as the tier's text and are reported.
 */
export function buildUpgrades(skillName, definition, report = null) {
  const upgrades = [];
  for (const rank of UPGRADE_RANKS) {
    const text = definition.upgrades?.[`rank${rank}`];
    const riders = definition.upgradeRiders?.[`rank${rank}`] ?? [];
    if (!text && !riders.length) continue;
    const changes = [];
    const targetEffects = [];
    for (const rider of riders) {
      const trigger = rider.type === "debuff" ? riderTrigger(rider.when) : null;
      if (rider.type === "baseDice" && rider.dice) {
        changes.push(
          changeEntry({
            targetType: "skillDamage",
            target: skillName,
            value: rider.dice,
            damageDiceKind: "base",
          }),
        );
      } else if (rider.type === "rankDamageDie" && (rider.rankOf ?? "attack") === "attack") {
        changes.push(
          changeEntry({
            targetType: "skillDamage",
            target: skillName,
            value: "",
            damageDiceKind: "rankDie",
          }),
        );
      } else if (rider.type === "debuff" && CARLRPG.debuffs[rider.debuffId] && trigger) {
        targetEffects.push({
          id: foundry.utils.randomID(),
          debuffKey: rider.debuffId,
          stacks: Math.max(1, Number(rider.stacks) || 1),
          ...trigger,
          label: "",
        });
      } else {
        report?.unmappedRiders.push({
          owner: skillName,
          rank,
          text: rider.debuffId ? `${rider.type}: ${rider.debuffId}` : String(rider.type),
        });
      }
    }
    upgrades.push({
      id: foundry.utils.randomID(),
      rankThreshold: rank,
      description: text ?? "",
      changes,
      targetEffects,
    });
  }
  return upgrades;
}

/** The definition's description, plus any limitations, as HTML. */
function skillDescription(definition, limitations = "") {
  const parts = [];
  if (definition.description) parts.push(`<p>${escapeHtml(definition.description)}</p>`);
  if (limitations) parts.push(`<p><strong>Limitations:</strong> ${escapeHtml(limitations)}</p>`);
  return parts.join("");
}

/** Base damage from an `attack` sub-object, if it gives one our schema takes. */
function baseDamageOf(attack, stat) {
  const dice = String(attack?.baseDamage?.dice ?? "").trim();
  if (!dice) return null;
  const damageType = attack.baseDamage.damageType;
  return { dice, stat, damageType: CARLRPG.damageTypes[damageType] ? damageType : "" };
}

/** The Advancement gate a definition asks for. */
function advancementGateOf(definition) {
  return definition.advancement?.untilRank === 5 ? "passive-until-5" : "normal";
}

/**
 * Skill item data built straight from the export's own definition.
 * @param {{name: string, rank?: number, definition?: object}} skill
 * @param {object} [report]
 * @returns {object}
 */
export function buildSkillItem(skill, report = null) {
  const definition = skill.definition ?? {};
  const stat = CARLRPG.statAbbreviations[definition.stat] ? definition.stat : "";
  const attack = definition.attack;
  const system = {
    description: skillDescription(
      definition,
      typeof definition.limitations === "string" ? definition.limitations : "",
    ),
    rank: skill.rank ?? 0,
    category: definition.category === "attack" ? "attack" : "utility",
    isPassive: !!definition.passive,
    governingStat: stat,
    advancementGate: advancementGateOf(definition),
    upgrades: buildUpgrades(skill.name, definition, report),
  };
  if (attack) {
    system.attackType = ["melee", "ranged"].includes(attack.type) ? attack.type : "";
    system.isHandToHand = attack.weaponCategory === "handToHand";
    if (attack.range) system.range = String(attack.range);
    // "All ranged weapons use your Dex to hit, and some add your Str to the
    // damage" (Ranged Weapon Skills): the to-hit Stat isn't the damage one.
    const damage = baseDamageOf(attack, system.attackType === "ranged" ? "" : stat);
    if (damage) system.baseDamage = damage;
  }
  return { name: skill.name, type: "skill", system, flags: { [SCOPE]: {} } };
}

/**
 * Spell item data from a definition of category "spell": Mana cost, Range,
 * Duration and Cooldown from its `spell` sub-object, damage from its
 * `attack`, a heal from `spell.heal`.
 * @param {{name: string, rank?: number, definition?: object}} skill
 * @param {object} [report]
 * @returns {object}
 */
export function buildSpellItem(skill, report = null) {
  const definition = skill.definition ?? {};
  const spell = definition.spell ?? {};
  const stat = CARLRPG.statAbbreviations[definition.stat] ? definition.stat : "";
  const keywords = new Set();
  if (SPELL_KEYWORDS.includes(spell.type)) keywords.add(spell.type);
  if (definition.attack?.baseDamage) keywords.add("attack");
  if (definition.passive) keywords.add("passive");
  if (definition.interrupt) keywords.add("interrupt");
  if (spell.heal) keywords.add("heal");
  const mana = Number.parseInt(spell.manaCost, 10);
  if (spell.manaCost !== undefined && !Number.isFinite(mana)) {
    report?.unmappedFields.push({
      owner: skill.name,
      key: "ManaCost",
      data: { value: String(spell.manaCost) },
    });
  }
  const system = {
    description: skillDescription(definition, spell.limitations ?? ""),
    rank: skill.rank ?? 0,
    isPassive: !!definition.passive,
    governingStat: stat,
    advancementGate: advancementGateOf(definition),
    manaCost: Number.isFinite(mana) ? Math.max(0, mana) : 1,
    range: String(spell.range ?? definition.attack?.range ?? ""),
    duration: String(spell.duration ?? ""),
    cooldown: String(spell.cooldown ?? ""),
    castingKeywords: SPELL_KEYWORDS.filter((k) => keywords.has(k)),
    upgrades: buildUpgrades(skill.name, definition, report),
  };
  const damage = baseDamageOf(definition.attack, stat);
  if (damage) system.baseDamage = damage;
  if (spell.heal) {
    const amount = String(spell.heal.amount ?? "").trim();
    if (/^\d+(d\d+)?([+-]\d+)?$/i.test(amount)) system.healDice = amount;
    if (HEALS.includes(spell.heal.target)) system.heals = spell.heal.target;
  }
  return { name: skill.name, type: "spell", system, flags: { [SCOPE]: {} } };
}

/**
 * Text that should be one of a table's entries: the same, or containing
 * it (a player may add to a rolled line).
 */
function inTable(text, entries) {
  // Punctuation aside: "...someone I trusted" is the book's "...trusted.".
  const bare = (s) =>
    normalizeName(s)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const want = bare(text);
  return entries.some((entry) => {
    const have = bare(entry);
    return have && (want === have || want.includes(have));
  });
}

/**
 * Background text (Past Trauma, Loose Ends, Regrets) that isn't any entry of
 * the book's table for it (Tables 22-24) - CrawlerForge may write its own.
 * @param {object} crawler
 * @param {Record<string, string[]>|null} tables  Each field's table entries; a field without one isn't checked.
 * @returns {{field: string, text: string}[]}
 */
export function backgroundTableMisses(crawler, tables) {
  const misses = [];
  for (const field of Object.keys(PAST_TABLES)) {
    const entries = tables?.[field];
    if (!entries?.length) continue;
    for (const line of String(crawler?.[field] ?? "").split(/\r?\n/)) {
      if (line.trim() && !inTable(line, entries)) misses.push({ field, text: line.trim() });
    }
  }
  return misses;
}

/** Words of a normalised name. */
const words = (name) =>
  normalizeName(name)
    .split(/[^a-z0-9']+/)
    .filter(Boolean);

/**
 * Gear names that nearly match - every word of one is in the other ("Clothes"
 * and "Plain Clothes") - for the report, never imported as a match.
 */
function nearMissesFor(name, candidates) {
  const mine = words(name);
  if (!mine.length) return [];
  const found = new Set();
  for (const c of candidates) {
    if (c.type !== "item") continue;
    const theirs = words(c.name);
    if (!theirs.length) continue;
    const contains = (a, b) => a.every((w) => b.includes(w));
    if (contains(mine, theirs) || contains(theirs, mine)) found.add(c.name);
  }
  return [...found];
}

/** An empty import report. */
function newReport() {
  return {
    copied: [],
    invented: [],
    granted: [],
    weaponsWithoutItem: [],
    gearMatched: [],
    gearUnmatched: [],
    nearMisses: [],
    weapons: [],
    unplaced: [],
    hotlistDropped: [],
    unmappedEffects: [],
    unmappedRiders: [],
    unmappedFields: [],
    background: [],
    notes: [],
  };
}

/**
 * Map a folded CrawlerForge state onto carl-rpg Actor/Item creation data,
 * with every decision made: what each Skill/Spell is (a compendium copy at
 * the export's Rank, or CrawlerForge's own and flagged), which Race/Class,
 * what each piece of gear is, where it's to be worn, and what to report.
 *
 * Every item carries `flags.carl-rpg.crawlerforge.key` so it can be found
 * again after creation (created documents don't come back in order).
 *
 * @param {ReturnType<typeof foldCrawlerForgeEvents>} state
 * @param {object} [sources]
 * @param {import("../pdf-import/compendium-match.mjs").MatchCandidate[]} [sources.candidates]
 *   Skill/Spell/gear candidates (importer.mjs matchCandidates); none: nothing is matched.
 * @param {object[]} [sources.raceClass]  Our Race/Class item data to swap in by exact name.
 * @param {Record<string, string[]>} [sources.tables]  Background table entries, by story field.
 * @returns {{actor: object, skills: object[], race: object|null, class: object|null, items: object[],
 *   placements: object[], hotlist: string[], report: object, warnings: string[]}}
 *   A skill/item entry with `copy` ({ref, rank|name, ...}) is to be fetched and copied; else `data` is it.
 */
export function buildCrawlerForgeActorData(
  state,
  { candidates = [], raceClass = [], tables = null } = {},
) {
  const c = state.crawler;
  const warnings = [...state.warnings];
  const report = newReport();
  // Skills and Spells also by the system's Skill slug, as play-time checks
  // match them ("Hand to Hand" is the pack's "Hand-to-Hand").
  const match = buildMatcher(candidates, { slug: slugifySkillName });
  const level = Number(c.level) || 1;

  const stats = {};
  for (const key of Object.keys(CARLRPG.statAbbreviations)) {
    if (c.unenhanced?.[key] !== undefined) stats[key] = { value: Math.max(1, c.unenhanced[key]) };
  }

  const size = Number(c.size?.value);
  const system = {
    attributes: { level: { value: level } },
    bankedStatPoints: c.unassignedStatPoints ?? 0,
    stats,
    details: {
      pronouns: c.pronouns ?? "",
      crawlerNumber: c.crawlerNumber != null ? String(c.crawlerNumber) : "",
      aiFavor: c.aiFavor ?? 0,
      // Gold is one number on the sheet header, not an Item.
      gold: Math.max(0, Number(state.gold) || 0),
      ...(CARLRPG.sizes[size] ? { size } : {}),
    },
    // Placed after creation, by item (importCrawlerForgeCrawler).
    gearSlots: {},
    accessories: [],
    hotlist: [],
    story: storyToHtml({ pastTrauma: c.pastTrauma, looseEnds: c.looseEnds, regrets: c.regrets }),
  };
  if (c.floor) {
    warnings.push(
      `Crawler was on Floor ${c.floor}; Floor is world-wide in carl-rpg, set it in the GM Toolbox.`,
    );
  }
  if (c.campaign) report.notes.push({ key: "Campaign", data: { campaign: String(c.campaign) } });

  // Race and Class: ours by exact name (Q7b), else CrawlerForge's own.
  const ours = (type, name) => {
    const want = raceClassKey(name);
    return want
      ? (raceClass.find((d) => d.type === type && raceClassKey(d.name) === want) ?? null)
      : null;
  };
  const kind = String(c.species ?? "")
    .trim()
    .toLowerCase();
  const raceOrClass = (type) => {
    const definition = c[type]?.definition;
    const name = raceClassName(c, type);
    const found = ours(type, name);
    if (found) {
      report.copied.push({ name: found.name, type, source: PACKS.classesAndRaces });
      return { ...preBaked(found, level, type), name: found.name };
    }
    if (!definition) {
      if (name)
        report.notes.push({
          key: type === "race" ? "RaceNotFound" : "ClassNotFound",
          data: { name: String(name) },
        });
      return null;
    }
    const built = buildRaceClassItem(type, definition, report);
    report.invented.push({ name: definition.name, type });
    const data = preBaked(built, level, type);
    data.flags[SCOPE][FLAG] = { key: type, id: definition.id, notInRulebook: true };
    return data;
  };
  const race = raceOrClass("race");
  const cls = raceOrClass("class");
  const chargenKind = SPECIES_IS_RACE
    ? null
    : kind === "human"
      ? "human"
      : kind === "animal"
        ? "animal"
        : null;
  if (kind && !SPECIES_IS_RACE && !chargenKind)
    report.notes.push({ key: "Species", data: { species: String(c.species) } });

  // Skills and Spells. Their names are keyed by the system's Skill slug
  // (modifiers.mjs slugifySkillName), as play-time checks match them, so
  // "Hand to Hand" here and a weapon's "Hand-to-Hand" are one Skill.
  const skills = [];
  const skillNames = new Map();
  (c.skills ?? []).forEach((skill, index) => {
    const definition = skill.definition ?? {};
    const isSpell = definition.category === "spell";
    const key = `skill:${index}`;
    const rank = Math.max(0, Number(skill.rank) || 0);
    const found =
      match(skill.name, [isSpell ? "spell" : "skill"]) ?? match(skill.name, SKILL_LIKE_TYPES);
    if (!KNOWN_CHECK_TYPES.has(definition.checkType ?? "none")) {
      report.unmappedFields.push({
        owner: skill.name,
        key: "CheckType",
        data: { value: String(definition.checkType) },
      });
    }
    if (found) {
      report.copied.push({ name: found.name, type: found.type, source: found.source ?? "" });
      // If the copy can't be fetched at write time (deleted, unreadable),
      // the export's own definition stands in, flagged (skillData).
      const fallback = isSpell ? buildSpellItem(skill) : buildSkillItem(skill);
      fallback.flags[SCOPE][FLAG] = { key, id: definition.id, notInRulebook: true };
      skills.push({
        key,
        name: found.name,
        type: found.type,
        copy: { ref: found.ref, rank },
        fallback,
      });
      skillNames.set(slugifySkillName(skill.name), {
        name: found.name,
        type: found.type,
        category: found.category || null,
        handToHand: !!found.handToHand,
        noWeapon: !!found.noWeapon,
        definition,
      });
      return;
    }
    const data = isSpell ? buildSpellItem(skill, report) : buildSkillItem(skill, report);
    data.flags[SCOPE][FLAG] = { key, id: definition.id, notInRulebook: true };
    if (definition.interrupt && !isSpell)
      report.unmappedFields.push({ owner: skill.name, key: "Interrupt", data: {} });
    report.invented.push({ name: skill.name, type: data.type });
    skills.push({ key, name: skill.name, type: data.type, data });
    skillNames.set(slugifySkillName(skill.name), {
      name: skill.name,
      type: data.type,
      category: data.system.category,
      definition,
    });
  });

  // A Skill the Race/Class grants that the export doesn't list: made at the
  // granted Rank (the book's "you gain it at that Rank listed").
  // Keyed by the system's Skill slug (modifiers.mjs slugifySkillName, as
  // the grant engine and the live bonuses match Skills), so "Hand to Hand
  // Combat" listed and "Hand-to-Hand Combat" granted are one Skill.
  const listed = new Set([
    ...(c.skills ?? []).map((s) => slugifySkillName(s.name)),
    ...skills.map((s) => slugifySkillName(s.name)),
  ]);
  const grants = new Map();
  for (const item of [race, cls].filter(Boolean)) {
    for (const change of item.system.changes ?? []) {
      if (
        change.targetType !== "skillRank" ||
        !grantAppliesAt(change, level) ||
        change.mode !== "add"
      )
        continue;
      if (!String(change.target ?? "").trim()) continue;
      const slug = slugifySkillName(change.target);
      if (listed.has(slug)) continue;
      const entry = grants.get(slug) ?? { name: change.target, rank: 0, from: new Set() };
      // As baking does (race-class-grants.mjs bakeSkillRankGrant): the
      // first grant makes it at its Rank; a further one adds, up to 10
      // ("If you have that Skill, add the bonus, up to 10", p.127), never
      // lowering a Rank already above 10 (cappedGrantRank).
      entry.rank = cappedGrantRank(entry.rank, entry.rank + (Number(change.value) || 0));
      entry.from.add(item.name);
      grants.set(slug, entry);
    }
  }
  for (const [slug, grant] of grants) {
    const key = `granted:${slug}`;
    const rank = Math.max(0, grant.rank);
    const found = match(grant.name, SKILL_LIKE_TYPES);
    report.granted.push({
      name: found?.name ?? grant.name,
      rank,
      from: [...grant.from].join(", "),
      inRulebook: !!found,
    });
    if (found) {
      skills.push({ key, name: found.name, type: found.type, copy: { ref: found.ref, rank } });
    } else {
      skills.push({
        key,
        name: grant.name,
        type: "skill",
        data: bareSkillLikeData(grant.name, rank, {
          flags: { [SCOPE]: { [FLAG]: { key, notInRulebook: true } } },
        }),
      });
    }
    skillNames.set(slug, {
      name: found?.name ?? grant.name,
      type: found?.type ?? "skill",
      category: found?.category || null,
      handToHand: !!found?.handToHand,
      noWeapon: !!found?.noWeapon,
      definition: {},
    });
  }

  // Gear.
  const attackSkill = (name) => {
    const s = skillNames.get(slugifySkillName(name));
    if (!s || s.type !== "skill") return null;
    const attack = s.category === "attack" || s.definition?.category === "attack";
    return attack ? s : null;
  };
  const armed = new Set();
  const items = [];
  const placements = [];
  state.items.forEach((item, index) => {
    const key = `item:${item.id ?? index}`;
    const mapped = effectsToChanges(item.effects, item.name);
    if (mapped.unmapped.length)
      report.unmappedEffects.push({ owner: item.name, text: mapped.unmapped.join(", ") });
    const quantity = Math.max(0, Number(item.quantity ?? 1) || 0);
    const notes = item.notes ? `<p>${escapeHtml(item.notes)}</p>` : "";
    const flags = { [SCOPE]: { [FLAG]: { key, id: item.id ?? null, name: item.name } } };
    const skill = attackSkill(item.name);
    let entry;
    if (skill) {
      // A weapon: its Weapon Skill, and the Gear compendium's item for it
      // if there is one (chargen.mjs weaponData), keeping this name.
      armed.add(slugifySkillName(skill.name));
      report.weapons.push({ name: item.name, skill: skill.name });
      entry = {
        key,
        name: item.name,
        weapon: { skill: skill.name, twoHanded: item.slot === "hands" },
        quantity,
        notes,
        changes: mapped.changes,
        flags,
        exportSlot: item.slot ?? null,
      };
    } else {
      const alias = STANDARD_PREFIX.test(item.name)
        ? match(item.name.replace(STANDARD_PREFIX, ""), ["item"])
        : null;
      const found = match(item.name, ["item"]) ?? (alias?.consumable ? alias : null);
      if (found) {
        report.gearMatched.push({
          name: item.name,
          as: found.name,
          source: found.source ?? "",
          consumable: !!found.consumable,
        });
        if (found.weaponSkill && !skillNames.has(slugifySkillName(found.weaponSkill))) {
          report.notes.push({
            key: "NoWeaponSkill",
            data: { name: item.name, skill: found.weaponSkill },
          });
        }
        if (found.weaponSkill) armed.add(slugifySkillName(found.weaponSkill));
        entry = {
          key,
          name: item.name,
          copy: { ref: found.ref, name: item.name },
          quantity,
          notes,
          changes: mapped.changes,
          flags,
          exportSlot: item.slot ?? null,
        };
      } else {
        report.gearUnmatched.push(item.name);
        const near = nearMissesFor(item.name, candidates);
        if (near.length) report.nearMisses.push({ name: item.name, candidates: near });
        entry = {
          key,
          name: item.name,
          exportSlot: item.slot ?? null,
          data: {
            name: item.name,
            type: "item",
            system: {
              description: notes,
              quantity,
              // Where it's worn (docs/gear-slots.md): the export's slot.
              slots: crawlerforgeSlots(item.slot),
              twoHanded: item.slot === "hands",
              changes: mapped.changes,
            },
            flags,
          },
        };
      }
    }
    items.push(entry);
    if (item.equipped) {
      if (!item.slot) {
        report.unplaced.push({ name: item.name, slot: "", reason: "noExportSlot" });
      } else if (item.slot === "accessory") {
        placements.push({ key, name: item.name, exportSlot: item.slot, slotType: "accessory" });
      } else if (GEAR_SLOT_MAP[item.slot]) {
        placements.push({
          key,
          name: item.name,
          exportSlot: item.slot,
          slotType: "gear",
          slotKey: GEAR_SLOT_MAP[item.slot],
        });
      } else {
        report.unplaced.push({ name: item.name, slot: item.slot, reason: "unknownSlot" });
      }
    }
  });

  // An Attack Skill that needs a weapon (weapons.mjs needsWeapon: not
  // hand-to-hand, no Needs no weapon box) the export has none for.
  for (const entry of skills) {
    const s = skillNames.get(slugifySkillName(entry.name));
    const def = s?.definition ?? {};
    const attack = entry.data
      ? entry.data.system.category === "attack"
      : (s?.category ?? def.category) === "attack";
    const handToHand = entry.data
      ? entry.data.system.isHandToHand
      : s?.handToHand || def.attack?.weaponCategory === "handToHand";
    const noWeapon = entry.data ? entry.data.system.noWeapon : s?.noWeapon;
    if (entry.type !== "skill" || !attack || handToHand || noWeapon) continue;
    if (!armed.has(slugifySkillName(entry.name))) report.weaponsWithoutItem.push(entry.name);
  }

  report.background = backgroundTableMisses(c, tables);
  for (const [field, table] of Object.entries(PAST_TABLES)) {
    if (tables && String(c[field] ?? "").trim() && !tables[field]?.length)
      report.notes.push({ key: "TableUnread", data: { table } });
  }

  return {
    actor: { name: c.name ?? "CrawlerForge Crawler", type: "character", system },
    chargenKind,
    skills,
    race,
    class: cls,
    items,
    placements,
    // Hotlist slots are numbered: keep blanks so later entries stay put.
    hotlist: (state.hotlist ?? []).map((e) => (e && String(e).trim() ? String(e) : "")),
    report,
    warnings,
  };
}

/* -------------------------------------------------- */
/*  Writing (Foundry)                                 */
/* -------------------------------------------------- */

/** Our Race/Class documents named exactly like the export's (Q7b). */
async function raceClassSources(crawler) {
  const pack = game.packs.get(PACKS.classesAndRaces);
  const names = ["race", "class"]
    .map((type) => raceClassName(crawler, type))
    .filter(Boolean)
    .map(raceClassKey);
  if (!pack || !names.length) return [];
  const index = await pack.getIndex({ fields: ["type"] });
  const hits = index.filter(
    (e) => ["race", "class"].includes(e.type) && names.includes(raceClassKey(e.name)),
  );
  const docs = await Promise.all(hits.map((e) => pack.getDocument(e._id)));
  return docs
    .filter(Boolean)
    .map((d) => ({ ...d.toObject(), _stats: { compendiumSource: d.uuid } }));
}

/**
 * The book's Past Traumas, Loose Ends and Regrets entries - the system's
 * own tables, never a GM's homebrew copy (packs.mjs systemTable).
 */
async function backgroundTables() {
  const tables = {};
  for (const [field, name] of Object.entries(PAST_TABLES)) {
    tables[field] = tableTexts(await systemTable(name));
  }
  return tables;
}

/** A compendium document's data as a new owned item, from its uuid. */
async function copyOf(ref) {
  const source = ref ? await fromUuid(ref) : null;
  return source ? copyData(source) : null;
}

/** A planned Skill/Spell as creation data. */
async function skillData(entry, report) {
  if (!entry.copy) return entry.data;
  const source = await copyOf(entry.copy.ref);
  if (!source) {
    // Matched, but gone or unreadable now: the export's own definition
    // (flagged), else a bare item of the matched type - and say so.
    report?.notes.push({ key: "CopyFailed", data: { name: entry.name } });
    if (entry.fallback)
      return { ...entry.fallback, system: { ...entry.fallback.system, rank: entry.copy.rank } };
    return bareSkillLikeData(entry.name, entry.copy.rank, {
      type: entry.type ?? "skill",
      flags: { [SCOPE]: { [FLAG]: { key: entry.key, notInRulebook: true } } },
    });
  }
  // Its compendium source comes along (copyOf, kept by cleanSkillLikeCopy).
  const data = cleanSkillLikeCopy(source, entry.copy.rank);
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, {
    [SCOPE]: { [FLAG]: { key: entry.key } },
  });
  return data;
}

/** A planned piece of gear as creation data: the export's name, quantity, notes and effects on our item. */
async function gearItemData(entry, report) {
  if (entry.data) return entry.data;
  const base = entry.weapon
    ? await weaponData(entry.name, entry.weapon.skill)
    : await copyOf(entry.copy.ref);
  const data = base ?? { name: entry.name, type: "item", system: {} };
  data.name = entry.name;
  data.system ??= {};
  data.system.quantity = entry.quantity;
  if (entry.notes)
    data.system.description = data.system.description
      ? `${entry.notes}${data.system.description}`
      : entry.notes;
  // Our item's own bonuses win (they're authored); the export's effects
  // only on an item that has none, so nothing counts twice. A weapon with
  // no Gear compendium item is Held by its Weapon Skill alone.
  if (!data.system.changes?.length) data.system.changes = entry.changes;
  else if (entry.changes.length)
    report.notes.push({ key: "OurBonuses", data: { name: entry.name } });
  // A weapon of CrawlerForge's own takes its hands from the export.
  if (entry.weapon && !data._stats?.compendiumSource)
    data.system.twoHanded = entry.weapon.twoHanded;
  data.system.equipped = false;
  data.flags = foundry.utils.mergeObject(data.flags ?? {}, entry.flags);
  return data;
}

/**
 * The doll slot to wear an item in: the export's own if it fits and is
 * free, else the item's first free one (equip-slots.mjs freeSlotFor).
 * @returns {{slot: object|null, reason: string|null}}
 */
function slotFor(actor, plan, item) {
  if (!canWear(item) && !(plan.slotType === "gear" && HANDS.includes(plan.slotKey))) {
    return { slot: null, reason: "noSlot" };
  }
  if (plan.slotType === "gear") {
    const gearSlots = actor.system.gearSlots ?? {};
    const keys = HANDS.includes(plan.slotKey) && isTwoHanded(item) ? HANDS : [plan.slotKey];
    const preferred = { slotType: "gear", slotKey: plan.slotKey };
    if (
      keys.every((k) => !slotHolds(actor, gearSlots[k])) &&
      !slotRefusal(actor, preferred, item)
    ) {
      return { slot: preferred, reason: null };
    }
  }
  const free = freeSlotFor(actor, item);
  return free ? { slot: free, reason: null } : { slot: null, reason: "full" };
}

/**
 * Create a Character actor from a parsed CrawlerForge export, place its
 * gear, and whisper the GM what wasn't matched, isn't in the rulebook or
 * couldn't be placed.
 * @param {object} exportJson
 * @returns {Promise<Actor>}
 */
export async function importCrawlerForgeCrawler(exportJson) {
  const state = foldCrawlerForgeEvents(exportJson);
  const [candidates, raceClass, tables] = await Promise.all([
    // Never "undefined": that would skip every pack without an import flag.
    matchCandidates(null),
    raceClassSources(state.crawler),
    backgroundTables(),
  ]);
  const data = buildCrawlerForgeActorData(state, { candidates, raceClass, tables });
  const { report } = data;

  const skills = [];
  for (const entry of data.skills) skills.push(await skillData(entry, report));
  const gear = [];
  for (const entry of data.items) gear.push(await gearItemData(entry, report));

  const chargen = {
    done: true,
    imported: true,
    ...(data.chargenKind ? { kind: data.chargenKind } : {}),
  };
  const actor = await Actor.create(
    foundry.utils.mergeObject(
      data.actor,
      {
        flags: { [SCOPE]: { chargen } },
      },
      { inplace: false },
    ),
  );
  // An export with its own Size keeps it: the Race mustn't reset it
  // (helpers/size.mjs). Without one, the Race's Size applies. The Race and
  // Class keep their pre-baked grants (carlPreBaked, item._preCreate).
  const created = await actor.createEmbeddedDocuments(
    "Item",
    [...skills, ...(data.race ? [data.race] : []), ...(data.class ? [data.class] : []), ...gear],
    { carlKeepSize: data.actor.system.details?.size !== undefined, carlPreBaked: true },
  );
  // Matched back by key: created documents don't come back in order.
  const byKey = new Map(created.map((i) => [i.getFlag(SCOPE, FLAG)?.key, i]));

  await actor.update({
    "system.race": byKey.get("race")?.id ?? "",
    "system.class": byKey.get("class")?.id ?? "",
  });

  // Gear worn by the doll's rules, one at a time so each sees the last.
  for (const plan of data.placements) {
    const item = byKey.get(plan.key);
    if (!item) continue;
    const { slot, reason } = slotFor(actor, plan, item);
    if (!slot) {
      report.unplaced.push({ name: plan.name, slot: plan.exportSlot, reason });
      continue;
    }
    const sameHands = HANDS.includes(slot.slotKey) && HANDS.includes(plan.slotKey);
    const movedGear = plan.slotType === "gear" && slot.slotKey !== plan.slotKey && !sameHands;
    const movedAccessory = plan.slotType === "accessory" && slot.slotType !== "accessory";
    if (movedGear || movedAccessory) {
      const where =
        slot.slotType === "accessory"
          ? CONFIG.CARLRPG.wearSlots.accessory
          : CONFIG.CARLRPG.gearSlots[slot.slotKey]?.label;
      report.notes.push({
        key: "Moved",
        data: {
          name: plan.name,
          slot: plan.exportSlot,
          to: game.i18n.localize(where ?? slot.slotKey),
        },
      });
    }
    await placeInFreeSlot(actor, slot, item);
    // Placed already: not the Equipped box's own placing, and no Action.
    await item.update({ "system.equipped": true }, { carlInAction: true });
  }

  // The Hotlist, by name: gear first (each item once), then Skills/Spells.
  // Worn gear stays out (p.98); what can't be hotlisted is reported.
  const gearLeft = created.filter((i) => i.type === "item");
  const max = CONFIG.CARLRPG.characterListSlots.hotlist;
  for (const name of data.hotlist.slice(max))
    if (name) report.hotlistDropped.push({ name, reason: "full" });
  const hotlist = data.hotlist.slice(0, max).map((name) => {
    if (!name) return "";
    const id = normalizeName(name);
    const named = (i) => normalizeName(i.getFlag(SCOPE, FLAG)?.name ?? i.name) === id;
    // Two same-named items: the unworn one (a worn one stays out, p.98).
    let item = gearLeft.find((i) => named(i) && !isItemWorn(actor, i.id)) ?? gearLeft.find(named);
    if (item) gearLeft.splice(gearLeft.indexOf(item), 1);
    else {
      // The same gear named twice: one slot for it.
      const listed = created.find((i) => i.type === "item" && named(i));
      if (listed) {
        if (!isItemWorn(actor, listed.id))
          report.hotlistDropped.push({ name, reason: "duplicate" });
        return "";
      }
      item = created.find((i) => i.type !== "item" && named(i));
    }
    // No item by that name: kept as text, as the slot shows it (equip-slots.mjs).
    if (!item) return name;
    if (isItemWorn(actor, item.id)) return "";
    if (!canHotlist(actor, item)) {
      report.hotlistDropped.push({ name, reason: "refused" });
      return "";
    }
    return item.id;
  });
  await actor.update({ "system.hotlist": hotlist });

  for (const warning of data.warnings) ui.notifications?.warn(warning);
  await postImportReport(actor, report);
  return actor;
}

/** The GM's whispered report of an import (chat-card.mjs). */
async function postImportReport(actor, report) {
  const t = (key, data) => game.i18n.format(`CARLRPG.CrawlerForge.Report.${key}`, data ?? {});
  const typeName = (type) => game.i18n.localize(`TYPES.Item.${type}`);
  const sections = [];
  const section = (key, lines) => {
    if (lines.length)
      sections.push(
        `<p><strong>${esc(t(key))}</strong></p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
      );
  };
  section(
    "NotInRulebook",
    report.invented.map((e) => `${esc(e.name)} (${esc(typeName(e.type))})`),
  );
  section(
    "Granted",
    report.granted.map(
      (g) =>
        esc(t("GrantedLine", { name: g.name, rank: g.rank, from: g.from })) +
        (g.inRulebook ? "" : ` - ${esc(t("NotInRulebookShort"))}`),
    ),
  );
  // A match outside this system's packs (the world's, a module's) is named.
  section(
    "Copied",
    report.copied.map(
      (e) =>
        `${esc(e.name)} (${esc(typeName(e.type))}` +
        `${e.source && !e.source.startsWith(`${SCOPE}.`) ? `; ${esc(e.source)}` : ""})`,
    ),
  );
  section(
    "GearMatched",
    report.gearMatched.map((g) =>
      esc(g.name === g.as ? g.name : t("AsLine", { name: g.name, as: g.as })),
    ),
  );
  section(
    "Weapons",
    report.weapons.map((w) => esc(t("WeaponLine", { name: w.name, skill: w.skill }))),
  );
  section(
    "NoWeapon",
    report.weaponsWithoutItem.map((n) => esc(n)),
  );
  section(
    "GearUnmatched",
    report.gearUnmatched.map((n) => {
      const near = report.nearMisses.find((m) => m.name === n);
      return (
        esc(n) + (near ? ` - ${esc(t("NearMiss", { names: near.candidates.join(", ") }))}` : "")
      );
    }),
  );
  section(
    "Unplaced",
    report.unplaced.map((u) =>
      esc(t(`UnplacedReason.${u.reason}`, { name: u.name, slot: u.slot ?? "" })),
    ),
  );
  section(
    "HotlistDropped",
    report.hotlistDropped.map((h) => esc(t(`HotlistReason.${h.reason}`, { name: h.name }))),
  );
  section("Unmapped", [
    ...report.unmappedEffects.map((e) => `${esc(e.owner)}: ${esc(e.text)}`),
    ...report.unmappedRiders.map(
      (r) => `${esc(r.owner)} ${esc(t("RankN", { rank: r.rank }))}: ${esc(r.text)}`,
    ),
    ...report.unmappedFields.map((f) => `${esc(f.owner)}: ${esc(t(`Field.${f.key}`, f.data))}`),
  ]);
  section(
    "Background",
    report.background.map(
      (b) =>
        `${esc(game.i18n.localize(`CARLRPG.Actor.${b.field.charAt(0).toUpperCase()}${b.field.slice(1)}`))}: ${esc(b.text)}`,
    ),
  );
  section(
    "Notes",
    report.notes.map((n) => esc(t(`Note.${n.key}`, n.data))),
  );
  await createCardMessage({
    title: t("Title", { name: actor.name }),
    img: actor.img,
    body: sections.join("") || `<p>${esc(t("AllMatched"))}</p>`,
    actor,
    whisper: gmUserIds(),
    flags: { kind: "crawlerforgeReport" },
  });
}
