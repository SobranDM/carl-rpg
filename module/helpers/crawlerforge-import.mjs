/**
 * Importer for CrawlerForge (crawlerforge.com) crawler Export files.
 *
 * An export is an event log, not a snapshot: `{schemaVersion: 1, kind:
 * "crawler", events: [...]}`, where `crawler.created` carries the full
 * starting sheet and later events (`item.added`, `gold.changed`,
 * `hotlist.set`, ...) amend it. `event.retracted` undoes an earlier event by
 * id. foldCrawlerForgeEvents replays that log into one state object;
 * buildCrawlerForgeActorData maps the state onto carl-rpg's schema; both are
 * pure so the Quench suite can check them without touching the world.
 *
 * Stats: CrawlerForge's `unenhanced` layer is the book's Unenhanced Stat -
 * starting Stats PLUS Race/Class boosts (Playing the Game, Stats). That is
 * exactly what carl-rpg stores in the baked base `stats.*.value` (see
 * module/helpers/race-class-grants.mjs), and the exported Skill ranks are
 * likewise final. So the imported Race/Class items carry their stat/
 * skillRank grants for display, but are created with every grant id already
 * in their `bakedGrantIds` flag - otherwise item._onCreate would bake them a
 * second time on top of a base that already includes them.
 */

import { CARLRPG } from "./config.mjs";
import { cleanSkillLikeCopy, findSkillLikeItem } from "./race-class-grants.mjs";
import { changeEntry } from "../pdf-import/shared.mjs";
import { escapeHtml } from "../pdf-import/page-text.mjs";

const SUPPORTED_SCHEMA_VERSION = 1;
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

/**
 * Map CrawlerForge effects (Race/Class build entries, item effects) onto
 * carl-rpg ChangeEntries. Effects with no carl-rpg equivalent (rank caps,
 * club memberships, "skill of your choice", group grants) are skipped - their
 * text still lands in the owning item's description.
 * @param {object[]} effects
 * @param {string} label
 * @returns {object[]}
 */
function effectsToChanges(effects = [], label = "") {
  const changes = [];
  for (const effect of effects) {
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
    }
  }
  return changes;
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

/** Race/Class item data, with every grant pre-marked as baked (see file docstring). */
function buildRaceClassItem(type, definition) {
  const entries = [...(definition.build?.benefits ?? []), ...(definition.build?.detriments ?? [])];
  const changes = entries.flatMap((e) => effectsToChanges(e.effects, e.text ?? ""));
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
  return {
    name: definition.name,
    type,
    system,
    flags: {
      "carl-rpg": { bakedGrantIds: changes.map((c) => c.id), crawlerforgeId: definition.id },
    },
  };
}

/** Rank 5/10/15 Upgrade tiers from a CrawlerForge skill definition. */
function buildUpgrades(skillName, definition) {
  const upgrades = [];
  for (const rank of UPGRADE_RANKS) {
    const text = definition.upgrades?.[`rank${rank}`];
    const riders = definition.upgradeRiders?.[`rank${rank}`] ?? [];
    if (!text && !riders.length) continue;
    const changes = [];
    const targetEffects = [];
    for (const rider of riders) {
      if (rider.type === "baseDice") {
        changes.push(
          changeEntry({
            targetType: "skillDamage",
            target: skillName,
            value: rider.dice,
            damageDiceKind: "base",
          }),
        );
      } else if (rider.type === "debuff" && CARLRPG.debuffs[rider.debuffId]) {
        targetEffects.push({
          id: foundry.utils.randomID(),
          debuffKey: rider.debuffId,
          stacks: 1,
          critOnly: rider.when?.kind === "crit",
          amazingSuccessOnly:
            rider.when?.kind === "degree" && rider.when?.atLeast === "amazingSuccess",
          label: "",
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

/** Skill item data built straight from the export's own definition. */
function buildSkillItem(skill) {
  const definition = skill.definition ?? {};
  const stat = CARLRPG.statAbbreviations[definition.stat] ? definition.stat : "";
  const attack = definition.attack;
  const system = {
    description: definition.description ? `<p>${escapeHtml(definition.description)}</p>` : "",
    rank: skill.rank ?? 0,
    category: definition.category === "attack" ? "attack" : "utility",
    isPassive: !!definition.passive,
    governingStat: stat,
    advancementGate: definition.advancement?.untilRank === 5 ? "passive-until-5" : "normal",
    upgrades: buildUpgrades(skill.name, definition),
  };
  if (attack) {
    system.attackType = ["melee", "ranged"].includes(attack.type) ? attack.type : "";
    system.baseDamage = {
      dice: attack.baseDamage?.dice ?? "",
      stat,
      damageType: CARLRPG.damageTypes[attack.baseDamage?.damageType]
        ? attack.baseDamage.damageType
        : "",
    };
  }
  return {
    name: skill.name,
    type: "skill",
    system,
    flags: { "carl-rpg": { crawlerforgeId: definition.id } },
  };
}

/**
 * Map a folded CrawlerForge state onto carl-rpg Actor/Item creation data.
 * @param {ReturnType<typeof foldCrawlerForgeEvents>} state
 * @returns {{actor: object, skills: object[], race: object|null, class: object|null, items: object[], warnings: string[]}}
 */
export function buildCrawlerForgeActorData(state) {
  const c = state.crawler;
  const warnings = [...state.warnings];

  const stats = {};
  for (const key of Object.keys(CARLRPG.statAbbreviations)) {
    if (c.unenhanced?.[key] !== undefined) stats[key] = { value: Math.max(1, c.unenhanced[key]) };
  }

  const gearSlots = {};
  const accessories = [];
  for (const item of state.items) {
    if (!item.equipped || !item.slot) continue;
    if (item.slot === "accessory") accessories.push(item.name);
    else if (GEAR_SLOT_MAP[item.slot]) gearSlots[GEAR_SLOT_MAP[item.slot]] = item.name;
  }

  const size = Number(c.size?.value);
  const system = {
    attributes: { level: { value: c.level ?? 1 } },
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
    // Hotlist slots are numbered: keep blanks so later entries stay put.
    hotlist: (state.hotlist ?? []).map((e) => (e && e.trim() ? e : "")),
    gearSlots,
    accessories,
    story: {
      pastTrauma: c.pastTrauma ?? "",
      looseEnds: c.looseEnds ?? "",
      regrets: c.regrets ?? "",
    },
  };
  if (c.floor)
    warnings.push(
      `Crawler was on Floor ${c.floor}; Floor is world-wide in carl-rpg, set it in the GM Toolbox.`,
    );

  const items = state.items.map((item) => ({
    name: item.name,
    type: "item",
    system: {
      description: item.notes ? `<p>${escapeHtml(item.notes)}</p>` : "",
      quantity: item.quantity ?? 1,
      equipped: !!item.equipped,
      changes: effectsToChanges(item.effects, item.name),
    },
  }));

  return {
    actor: { name: c.name ?? "CrawlerForge Crawler", type: "character", system },
    skills: (c.skills ?? []).map(buildSkillItem),
    race: c.race?.definition ? buildRaceClassItem("race", c.race.definition) : null,
    class: c.class?.definition ? buildRaceClassItem("class", c.class.definition) : null,
    items,
    warnings,
  };
}

/**
 * Create a Character actor from a parsed CrawlerForge export. A Skill that
 * already exists by name in a compendium or the world Items directory is
 * copied from there (richer authored mechanics) at the exported Rank;
 * anything else is built from the export's own definition.
 * @param {object} exportJson
 * @returns {Promise<Actor>}
 */
export async function importCrawlerForgeCrawler(exportJson) {
  const data = buildCrawlerForgeActorData(foldCrawlerForgeEvents(exportJson));

  const skills = [];
  for (const skill of data.skills) {
    const existing = await findSkillLikeItem(skill.name);
    if (existing) {
      skills.push(cleanSkillLikeCopy(existing, skill.system.rank));
    } else {
      skills.push(skill);
    }
  }

  const actor = await Actor.create(data.actor);
  const [race, cls] = [data.race, data.class];
  const created = await actor.createEmbeddedDocuments("Item", [
    ...skills,
    ...(race ? [race] : []),
    ...(cls ? [cls] : []),
    ...data.items,
  ]);
  const raceItem = race ? created.find((i) => i.type === "race") : null;
  const classItem = cls ? created.find((i) => i.type === "class") : null;

  // Slots were built from item names; point them at the created items' ids
  // (helpers/equip-slots.mjs). A name with no matching item stays as text.
  const gearIds = new Map(created.filter((i) => i.type === "item").map((i) => [i.name, i.id]));
  const toId = (name) => gearIds.get(name) ?? name;
  const { gearSlots, accessories, hotlist } = data.actor.system;
  await actor.update({
    "system.race": raceItem?.id ?? "",
    "system.class": classItem?.id ?? "",
    "system.gearSlots": Object.fromEntries(
      Object.entries(gearSlots).map(([key, name]) => [key, toId(name)]),
    ),
    "system.accessories": accessories.map(toId),
    "system.hotlist": hotlist.map(toId),
  });

  for (const warning of data.warnings) ui.notifications?.warn(warning);
  return actor;
}
