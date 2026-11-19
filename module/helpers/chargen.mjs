/**
 * Character creation for a First Floor crawler ("Crawlers & Customization",
 * Starter Set pp.4-19; core rulebook Chapter 3, pp.102-115). The wizard
 * (module/apps/crawler-creation.mjs) collects a `state`; this file holds the
 * rules - the background tables and their Ranks, the combat choices, the
 * Stat methods, what still blocks finishing - and applies a finished state
 * to a Character (applyChargen).
 *
 * The world settings choose which methods are offered: chargenStatMethods
 * (Standard Array, rolling, or both), chargenBackgroundMethods (choosing,
 * rolling, or both) and allowAnimalCrawlers.
 */
import { slugifySkillName } from "./modifiers.mjs";
import { bareSkillLikeData, cleanSkillLikeCopy, findOwnedSkillLike, findSkillLikeItem } from "./race-class-grants.mjs";
import { assignItemToSlot, slotHolds } from "./equip-slots.mjs";
import { isInHotlist, toggleHotlist } from "./hotlist.mjs";
import { headedSectionsToHtml, STORY_SECTIONS } from "./rich-text.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";
import { copyData, PACKS } from "./packs.mjs";
import { esc } from "./html.mjs";

const SCOPE = "carl-rpg";

/**
 * Step 1's four backgrounds, by kind of crawler: the table each is chosen
 * or rolled from, and the Rank its two Skills start at ("The starting Rank
 * depends on the stage of life in which you gained that Skill").
 */
export const CHARGEN_STAGES = {
  human: [
    { key: "childhood", table: "Childhood Background Skills", rank: 1 },
    { key: "adolescence", table: "Adolescence Background Skills", rank: 1 },
    { key: "career", table: "Career Skills", rank: 3 },
    { key: "hobby", table: "Hobby Skills", rank: 2 },
  ],
  animal: [
    { key: "youth", table: "Animal Youth Skills", rank: 1 },
    { key: "training", table: "Animal Training Skills", rank: 1 },
    { key: "adult", table: "Animal Adult Skills", rank: 3 },
    { key: "quirk", table: "Animal Quirk Skills", rank: 2 },
  ],
};

/** Skills picked from each background ("pick two of its three Skills"). */
export const SKILLS_PER_BACKGROUND = 2;

/** Every combat Skill starts at Rank 3 (Step 2). */
export const COMBAT_RANK = 3;

/** The Skill every crawler of a kind starts with (Step 2). */
export const BASE_COMBAT_SKILL = { human: "Unarmed Combat", animal: "Slice Attack" };

/**
 * Step 2's second combat Skill: a weapon (by group, as the book lists them),
 * an attack Spell ("Be sure to set your Intelligence Stat to a 4 or higher"),
 * a hand-to-hand Skill with its Damage Effect, or - an animal crawler's -
 * another strike Skill ("Animal crawler & pet strike skills", p.177).
 */
export const COMBAT_OPTIONS = {
  weapons: {
    bashing: ["Club", "Improvised Weapons", "Warhammer"],
    edged: ["Axe", "Dagger", "Longsword"],
    ranged: ["Bow", "Crossbow", "Handgun", "Shotgun", "Javelin", "Shuriken", "Slingshot"],
    reach: ["Polearm", "Quarterstaff"],
  },
  spells: ["Dirt Clod", "Fire Fingers", "Frost Scar", "Shock Treatment", "Soul Collector"],
  handToHand: {
    "Pugilism": "Iron Punch",
    "Foot Soldier": "Smush",
    "Noggin Nocker": "Skullcracker",
    "Wrasslin'": "Toss",
  },
  animalStrikes: ["Back Claw", "Bite"],
};

/** An attack Spell needs this much Intelligence to cast (Step 2). */
export const SPELL_MIN_INT = 4;

/** "You also gain 5 Standard Mana Potions" with an attack Spell (Step 2). */
export const SPELL_MANA_POTIONS = 5;

/** Standard Array: "Assign a score of 2, 3, 4, 5, and 6 to your Stats" (Step 3). */
export const STANDARD_ARRAY = [2, 3, 4, 5, 6];

/** "Starting with Strength, and going down the line of Stats" (Step 3). */
export const STAT_ORDER = ["str", "int", "con", "dex", "cha"];

/** Each rolled Stat: "roll 1d6, rerolling any 1s". */
export const STAT_ROLL = "1d6rr1";

/** Animals "range anywhere from size 2 to 4" (Step 8); humans are Medium (4). */
export const ANIMAL_SIZES = [2, 3, 4];

/** "You can choose a number between 500,000 and 12,900,000" (Crawler Number). */
export const CRAWLER_NUMBER_RANGE = [500000, 12900000];

/** Step 9's three tables. */
export const PAST_TABLES = {
  pastTrauma: "Past Traumas",
  looseEnds: "Loose Ends",
  regrets: "Regrets",
};

/** Step 10's example starting equipment sets. */
export const STARTING_SETS = {
  athlete: { clothing: "Jogging attire", weapon: "Barbell", weaponSkill: "Club", item: "Headphones, music player", weird: "A 3-pack of condoms" },
  gamingGeek: { clothing: "T-shirt, hoodie, and jeans", weapon: "Boffer sword", weaponSkill: "Longsword", item: "Game book or novel", weird: "A pack of 12 googly eyes and a single Lego minifig" },
  militant: { clothing: "Military fatigues", weapon: "Handgun", weaponSkill: "Handgun", item: "2 snack bars", weird: "A morale patch that reads, \"No Plan Survives First Contact\"" },
  outdoorsy: { clothing: "Apparel appropriate for your location's climate and an orange safety jacket", weapon: "Bow and arrow", weaponSkill: "Bow", item: "Lighter", weird: "A duck call on a leather cord" },
};

/* -------------------------------------------------- */
/*  Settings                                          */
/* -------------------------------------------------- */

/** Register the character-creation world settings (init). */
export function registerChargenSettings() {
  game.settings.register(SCOPE, "chargenStatMethods", {
    name: "CARLRPG.Chargen.Settings.StatMethods",
    hint: "CARLRPG.Chargen.Settings.StatMethodsHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      both: "CARLRPG.Chargen.Settings.Both",
      array: "CARLRPG.Chargen.Settings.ArrayOnly",
      roll: "CARLRPG.Chargen.Settings.RollOnly",
    },
    default: "both",
  });
  game.settings.register(SCOPE, "chargenBackgroundMethods", {
    name: "CARLRPG.Chargen.Settings.BackgroundMethods",
    hint: "CARLRPG.Chargen.Settings.BackgroundMethodsHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      both: "CARLRPG.Chargen.Settings.Both",
      choose: "CARLRPG.Chargen.Settings.ChooseOnly",
      roll: "CARLRPG.Chargen.Settings.RollOnly",
    },
    default: "both",
  });
  game.settings.register(SCOPE, "allowAnimalCrawlers", {
    name: "CARLRPG.Chargen.Settings.AllowAnimals",
    hint: "CARLRPG.Chargen.Settings.AllowAnimalsHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
}

/**
 * Which methods the settings allow.
 * @returns {{statArray: boolean, statRoll: boolean, chooseBackground: boolean, rollBackground: boolean, animals: boolean}}
 */
export function chargenMethods() {
  const stats = game.settings.get(SCOPE, "chargenStatMethods");
  const backgrounds = game.settings.get(SCOPE, "chargenBackgroundMethods");
  return {
    statArray: stats !== "roll",
    statRoll: stats !== "array",
    chooseBackground: backgrounds !== "roll",
    rollBackground: backgrounds !== "choose",
    animals: !!game.settings.get(SCOPE, "allowAnimalCrawlers"),
  };
}

/* -------------------------------------------------- */
/*  Tables                                            */
/* -------------------------------------------------- */

/**
 * A background table result as a background and its Skills:
 * "Latchkey Kid: Streetwise (CHA), Perception (INT), or Stealth (DEX)".
 * @param {string} text
 * @returns {{name: string, skills: {name: string, stat: string}[]}|null}  null if it isn't one.
 */
export function parseBackgroundResult(text) {
  const plain = String(text ?? "").replace(/<[^>]*>/g, "").trim();
  const colon = plain.indexOf(":");
  if (colon < 0) return null;
  const name = plain.slice(0, colon).trim();
  const skills = plain.slice(colon + 1)
    .split(/,|\bor\b/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      return match ? { name: match[1].trim(), stat: match[2].trim().toLowerCase() } : { name: part, stat: "" };
    })
    .filter((s) => s.name);
  return name && skills.length ? { name, skills } : null;
}

/** A result's text, whatever the core version keeps it in. */
function resultText(result) {
  return result?.name || result?.description || result?.text || "";
}

/**
 * A roll table by name: the world's first (so a GM can homebrew one), else
 * the system's Roll Tables pack.
 * @param {string} name
 * @returns {Promise<RollTable|null>}
 */
export async function chargenTable(name) {
  const world = game.tables?.getName?.(name);
  if (world) return world;
  const pack = game.packs.get(PACKS.rollTables);
  const entry = (await pack?.getIndex())?.find((e) => e.name === name);
  return entry ? pack.getDocument(entry._id) : null;
}

/**
 * A background table's choices, in table order.
 * @param {RollTable} table
 * @returns {{name: string, skills: {name: string, stat: string}[]}[]}
 */
export function backgroundOptions(table) {
  return [...(table?.results ?? [])]
    .sort((a, b) => a.range[0] - b.range[0])
    .map((r) => parseBackgroundResult(resultText(r)))
    .filter(Boolean);
}

/**
 * A plain table's choices (Past Traumas...), in table order.
 * @param {RollTable} table
 * @returns {string[]}
 */
export function tableTexts(table) {
  return [...(table?.results ?? [])]
    .sort((a, b) => a.range[0] - b.range[0])
    .map((r) => resultText(r).replace(/<[^>]*>/g, "").trim())
    .filter(Boolean);
}

/**
 * Roll on a table, shown in chat.
 * @param {RollTable} table
 * @returns {Promise<string>}  The result's text ("" if none).
 */
export async function drawText(table) {
  const { results } = await table.draw({ displayChat: true });
  return resultText(results?.[0]).replace(/<[^>]*>/g, "").trim();
}

/* -------------------------------------------------- */
/*  Stats                                             */
/* -------------------------------------------------- */

/**
 * "Leaving it to Chance": 1d6 rerolling 1s for each Stat, in order, posted
 * to chat. No takesie-backsies.
 * @param {Actor} [actor]  The speaker.
 * @returns {Promise<Record<string, number>>}
 */
export async function rollStats(actor = null) {
  const rolls = [];
  const stats = {};
  for (const key of STAT_ORDER) {
    const roll = await new Roll(STAT_ROLL).evaluate();
    rolls.push(roll);
    stats[key] = roll.total;
  }
  const lines = STAT_ORDER.map((key) => `<li>${esc(game.i18n.localize(CONFIG.CARLRPG.stats[key]))}: <strong>${stats[key]}</strong></li>`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p>${esc(game.i18n.localize("CARLRPG.Chargen.RolledStats"))}</p><ul>${lines.join("")}</ul>`,
    rolls,
  });
  return stats;
}

/**
 * The Stats a state has settled on, or null while incomplete.
 * @param {object} state
 * @returns {Record<string, number>|null}
 */
export function chosenStats(state) {
  const source = state.statMethod === "roll" ? state.rolledStats : state.arrayStats;
  if (!source) return null;
  const stats = {};
  for (const key of STAT_ORDER) {
    const value = Number(source[key]);
    if (!value) return null;
    stats[key] = value;
  }
  return stats;
}

/* -------------------------------------------------- */
/*  State                                             */
/* -------------------------------------------------- */

/**
 * A fresh wizard state.
 * @param {Actor} actor
 * @returns {object}
 */
export function newChargenState(actor) {
  const methods = chargenMethods();
  return {
    kind: "human",
    name: actor?.name ?? "",
    pronouns: actor?.system?.details?.pronouns ?? "",
    crawlerNumber: actor?.system?.details?.crawlerNumber ?? "",
    size: 4,
    // Per stage key: {background: name, rolled: boolean, skills: [names]}.
    stages: {},
    combat: {
      type: "weapon", weapon: "Club", weaponName: "", spell: COMBAT_OPTIONS.spells[0], handToHand: "Pugilism",
      strike: COMBAT_OPTIONS.animalStrikes[0],
    },
    statMethod: methods.statArray ? "array" : "roll",
    arrayStats: Object.fromEntries(STAT_ORDER.map((k) => [k, ""])),
    rolledStats: null,
    past: { pastTrauma: "", looseEnds: "", regrets: "" },
    stuff: { clothing: "", weapon: "", item: "", weird: "" },
  };
}

/** The stages for this state's kind of crawler. */
export function stagesFor(state) {
  return CHARGEN_STAGES[state.kind === "animal" ? "animal" : "human"];
}

/**
 * The second combat Skill(s) a state chose: the Attack Skill, and a
 * hand-to-hand Damage Effect.
 * @param {object} state
 * @returns {{skill: string, damageEffect: string|null, spell: boolean}}
 */
export function combatChoice(state) {
  const c = state.combat ?? {};
  if (c.type === "spell") return { skill: c.spell, damageEffect: null, spell: true };
  if (c.type === "handToHand") return { skill: c.handToHand, damageEffect: COMBAT_OPTIONS.handToHand[c.handToHand] ?? null, spell: false };
  if (c.type === "strike") return { skill: state.kind === "animal" ? c.strike : "", damageEffect: null, spell: false };
  return { skill: c.weapon, damageEffect: null, spell: false };
}

/**
 * Every Skill the state gives, with its Rank: the eight background Skills,
 * the two combat Skills (and a Damage Effect), and Heal.
 * @param {object} state
 * @returns {{name: string, rank: number, source: string}[]}
 */
export function chargenSkills(state) {
  const out = [];
  for (const stage of stagesFor(state)) {
    for (const name of state.stages?.[stage.key]?.skills ?? []) out.push({ name, rank: stage.rank, source: stage.key });
  }
  out.push({ name: BASE_COMBAT_SKILL[state.kind === "animal" ? "animal" : "human"], rank: COMBAT_RANK, source: "combat" });
  const choice = combatChoice(state);
  if (choice.skill) out.push({ name: choice.skill, rank: COMBAT_RANK, source: "combat" });
  if (choice.damageEffect) out.push({ name: choice.damageEffect, rank: COMBAT_RANK, source: "combat" });
  // "All crawlers start with the Heal Spell" - Rank 1 (max).
  out.push({ name: "Heal", rank: 1, source: "heal" });
  return out;
}

/**
 * The Skills already taken outside one stage (so it can't take them too:
 * "Don't pick the same Skill from more than one background").
 * @param {object} state
 * @param {string} stageKey
 * @returns {Set<string>}  Slugs.
 */
export function skillsTakenElsewhere(state, stageKey) {
  return new Set(chargenSkills(state).filter((s) => s.source !== stageKey).map((s) => slugifySkillName(s.name)));
}

/**
 * Whether a stage's background may be rolled (again). Choosing is the
 * fix for an unwanted roll when choosing is allowed; when only rolling is,
 * a roll stands - unless it left fewer than two Skills not taken elsewhere,
 * so nothing valid can be picked from it.
 * @param {object} state
 * @param {string} stageKey
 * @param {{name: string, skills: {name: string}[]}|null} option  The stage's current background.
 * @returns {boolean}
 */
export function canRollBackground(state, stageKey, option) {
  const methods = chargenMethods();
  if (!methods.rollBackground) return false;
  const picked = state.stages?.[stageKey];
  if (!picked?.rolled || methods.chooseBackground) return true;
  const taken = skillsTakenElsewhere(state, stageKey);
  const free = (option?.skills ?? []).filter((s) => !taken.has(slugifySkillName(s.name)));
  return free.length < SKILLS_PER_BACKGROUND;
}

/**
 * What still blocks a step, as localized messages.
 * @param {object} state
 * @param {"crawler"|"backgrounds"|"combat"|"stats"|"past"|"stuff"} step
 * @returns {string[]}
 */
export function chargenProblems(state, step) {
  const t = (key, data) => game.i18n.format(`CARLRPG.Chargen.Problem.${key}`, data ?? {});
  const methods = chargenMethods();
  const out = [];
  if (step === "crawler") {
    if (!String(state.name ?? "").trim()) out.push(t("Name"));
    if (state.kind === "animal" && !methods.animals) out.push(t("NoAnimals"));
    if (state.kind === "animal" && !ANIMAL_SIZES.includes(Number(state.size))) out.push(t("AnimalSize"));
  } else if (step === "backgrounds") {
    for (const stage of stagesFor(state)) {
      const picked = state.stages?.[stage.key];
      const label = game.i18n.localize(`CARLRPG.Chargen.Stage.${stage.key}`);
      if (!picked?.background) out.push(t("NoBackground", { stage: label }));
      else if ((picked.skills ?? []).length !== SKILLS_PER_BACKGROUND) out.push(t("PickTwo", { stage: label }));
      if (picked?.background && !picked.rolled && !methods.chooseBackground) out.push(t("MustRoll", { stage: label }));
    }
    out.push(...duplicateProblems(state, t));
  } else if (step === "combat") {
    const choice = combatChoice(state);
    if (!choice.skill) out.push(t("NoCombat"));
    // A combat Skill a background already gave (Problem Child's Pugilism).
    out.push(...duplicateProblems(state, t));
    const stats = chosenStats(state);
    if (choice.spell && stats && stats.int < SPELL_MIN_INT) out.push(t("SpellInt", { min: SPELL_MIN_INT }));
  } else if (step === "stats") {
    if (state.statMethod === "array" && !methods.statArray) out.push(t("MethodOff"));
    if (state.statMethod === "roll" && !methods.statRoll) out.push(t("MethodOff"));
    if (state.statMethod === "roll" && !state.rolledStats) out.push(t("NotRolled"));
    if (state.statMethod === "array") {
      const values = STAT_ORDER.map((k) => Number(state.arrayStats?.[k]));
      const sorted = [...values].sort((a, b) => a - b);
      if (values.some((v) => !v)) out.push(t("ArrayIncomplete"));
      else if (sorted.join() !== STANDARD_ARRAY.join()) out.push(t("ArrayOnce"));
    }
    const choice = combatChoice(state);
    const stats = chosenStats(state);
    if (choice.spell && stats && stats.int < SPELL_MIN_INT) out.push(t("SpellInt", { min: SPELL_MIN_INT }));
  }
  return out;
}

/** "No double-dipping": a message for each Skill the state takes twice. */
function duplicateProblems(state, t) {
  const out = [];
  const seen = new Set();
  for (const { name } of chargenSkills(state)) {
    const slug = slugifySkillName(name);
    if (seen.has(slug)) out.push(t("Duplicate", { skill: name }));
    seen.add(slug);
  }
  return out;
}

/** Every step's problems, for the Review page and applyChargen. */
export function allChargenProblems(state) {
  return [...new Set(["crawler", "backgrounds", "combat", "stats"].flatMap((step) => chargenProblems(state, step)))];
}

/* -------------------------------------------------- */
/*  Applying                                          */
/* -------------------------------------------------- */

/** The Mana Potion from the Consumables pack, as item data. */
async function manaPotionData() {
  const pack = game.packs.get(PACKS.consumables);
  const entry = (await pack?.getIndex())?.find((e) => e.name === "Mana Potion");
  const doc = entry ? await pack.getDocument(entry._id) : null;
  return doc ? copyData(doc) : null;
}

/**
 * The starting weapon, from the Gear compendium when it has one for the
 * Weapon Skill (ruled 2026-11-18): the item named like the chosen weapon,
 * else the Skill's basic one (named after the Skill). It keeps the name the
 * player gave ("Boffer sword") and takes the item's icon, Held slot and
 * Two-Handed. A plain item when the compendium has none (or isn't built).
 * @param {string} name   The weapon's name as chosen.
 * @param {string} skill  Its Weapon Skill.
 * @returns {Promise<object>}
 */
export async function weaponData(name, skill) {
  const pack = game.packs.get(PACKS.gear);
  const index = (await pack?.getIndex({ fields: ["system.weaponSkill"] })) ?? [];
  const lower = (s) => String(s ?? "").trim().toLowerCase();
  const forSkill = index.filter((e) => lower(e.system?.weaponSkill) === lower(skill));
  const entry = forSkill.find((e) => lower(e.name) === lower(name)) ?? forSkill.find((e) => lower(e.name) === lower(skill));
  const doc = entry ? await pack.getDocument(entry._id) : null;
  if (!doc) return gearData(name, { weaponSkill: skill });
  const data = copyData(doc);
  data.name = name || data.name;
  data.system.weaponSkill = skill;
  return data;
}

/** A plain gear item's data. */
function gearData(name, system = {}) {
  return { name, type: "item", system };
}

/**
 * The Skills a state gives that the actor still needs: new ones as item data
 * (copied from the compendium, all in one write), and owned ones below the
 * wizard's Rank as rank updates. An owned Skill at or above it is left be.
 * @param {Actor} actor
 * @param {object} state
 * @returns {Promise<{create: object[], raise: {_id: string, "system.rank": number}[]}>}
 */
async function skillWrites(actor, state) {
  const create = [];
  const raise = [];
  const wanted = chargenSkills(state);
  const sources = await Promise.all(wanted.map(({ name }) => (findOwnedSkillLike(actor, name) ? null : findSkillLikeItem(name))));
  const { damageEffect } = combatChoice(state);
  wanted.forEach(({ name, rank, source }, i) => {
    const owned = findOwnedSkillLike(actor, name);
    if (owned) {
      if ((owned.system.rank ?? 0) < rank) raise.push({ _id: owned.id, "system.rank": rank });
      return;
    }
    // Missing from every compendium: a bare item of what it is - the Heal
    // Spell a Spell, the chosen Damage Effect a Damage Effect.
    const type = source === "heal" ? "spell" : (source === "combat" && name === damageEffect ? "damageEffect" : "skill");
    create.push(sources[i] ? cleanSkillLikeCopy(sources[i], rank) : bareSkillLikeData(name, rank, { type }));
  });
  return { create, raise };
}

/**
 * The Starting Stuff a state gives, as item data keyed by what it is. Each
 * carries a flag naming that, so a second run finds it rather than making it
 * again (applyChargen).
 * @param {object} state
 * @returns {Promise<Record<string, object>>}
 */
async function gearWrites(state) {
  const choice = combatChoice(state);
  const stuff = state.stuff ?? {};
  const gear = {};
  // The starting outfit is worn (a Torso piece; docs/gear-slots.md) -
  // equipped when applyChargen puts it in the slot.
  if (stuff.clothing) gear.clothing = gearData(stuff.clothing, { slots: ["torso"] });
  if (state.combat.type === "weapon") {
    gear.weapon = await weaponData(stuff.weapon || state.combat.weaponName || choice.skill, choice.skill);
  }
  if (stuff.item) gear.item = gearData(stuff.item);
  if (stuff.weird) gear.weird = gearData(stuff.weird);
  if (choice.spell) {
    const potion = await manaPotionData();
    if (potion) gear.potions = { ...potion, system: { ...potion.system, quantity: SPELL_MANA_POTIONS } };
  }
  for (const [key, data] of Object.entries(gear)) {
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [SCOPE]: { chargenGear: key } });
  }
  return gear;
}

/**
 * Build the crawler: Stats, details, story, Skills at their Ranks, Starting
 * Stuff, the Hotlist, then a full Health Bar and Mana, and a chat summary.
 *
 * Safe to run again on a crawler it failed part way through (its Create
 * Crawler button stays until it finishes): the Stats/details/story write is
 * recorded (flags.carl-rpg.chargen.applied) and not repeated, so the story
 * isn't added twice; Skills already owned are kept (raised to the wizard's
 * Rank if lower); Starting Stuff already made (flagged chargenGear) is
 * reused; the Hotlist only gets what isn't in it. A crawler already done is
 * refused - say, the GM and the player both pressing Create.
 * @param {Actor} actor  A Character.
 * @param {object} state  A finished wizard state (allChargenProblems empty).
 * @returns {Promise<Actor>}
 */
export async function applyChargen(actor, state) {
  if (actor.getFlag(SCOPE, "chargen")?.done) {
    throw new Error(game.i18n.format("CARLRPG.Chargen.Problem.AlreadyDone", { name: actor.name }));
  }
  const problems = allChargenProblems(state);
  if (problems.length) throw new Error(problems.join(" "));
  const animal = state.kind === "animal";
  const stats = chosenStats(state);
  const stages = stagesFor(state);

  // Stats, details, story - once.
  if (!actor.getFlag(SCOPE, "chargen")?.applied?.basics) {
    const backgroundLines = stages.map((stage) => {
      const picked = state.stages[stage.key];
      return `${game.i18n.localize(`CARLRPG.Chargen.Stage.${stage.key}`)}: ${picked.background} (${picked.skills.join(", ")})`;
    });
    // The backgrounds first, under "Background", then Past Trauma, Loose
    // Ends and Regrets (the Story box's own headings).
    const story = headedSectionsToHtml([
      { key: "CARLRPG.Chargen.Background", fallback: "Background", text: backgroundLines },
      ...STORY_SECTIONS.filter((s) => s.field !== "notes").map((s) => ({ ...s, text: state.past?.[s.field] ?? "" })),
    ]);
    const update = {
      name: String(state.name).trim(),
      "system.details.pronouns": state.pronouns ?? "",
      "system.details.crawlerNumber": String(state.crawlerNumber ?? ""),
      // "If you're playing a human crawler, write 1"; an animal spent it.
      "system.details.aiFavor": animal ? 0 : 1,
      "system.details.size": animal ? Number(state.size) : 4,
      "system.details.move": 20,
      "system.details.step": 10,
      "system.story": (actor.system.story ? actor.system.story : "") + story,
      [`flags.${SCOPE}.chargen.applied.basics`]: true,
    };
    for (const key of STAT_ORDER) update[`system.stats.${key}.value`] = stats[key];
    await actor.update(update);
  }

  // Skills: the new ones in one write, owned ones raised.
  const { create, raise } = await skillWrites(actor, state);
  const learned = create.length ? await actor.createEmbeddedDocuments("Item", create) : [];
  if (raise.length) await actor.updateEmbeddedDocuments("Item", raise);

  // Starting Stuff: what isn't there yet, in one write.
  const gear = await gearWrites(state);
  const made = {};
  for (const key of Object.keys(gear)) {
    made[key] = actor.items.find((i) => i.getFlag(SCOPE, "chargenGear") === key) ?? null;
  }
  const missing = Object.keys(gear).filter((key) => !made[key]);
  if (missing.length) {
    const created = await actor.createEmbeddedDocuments("Item", missing.map((key) => gear[key]));
    // Matched by their chargenGear flag, not by position: the documents
    // don't always come back in the order asked for (by id, it seems), and
    // a position match put the clothes in the Main Hand.
    for (const key of missing) made[key] = created.find((i) => i.getFlag(SCOPE, "chargenGear") === key) ?? null;
  }
  if (made.weapon && actor.system.gearSlots.mainHand !== made.weapon.id) {
    await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, made.weapon);
  }
  // The outfit is worn on the Torso (docs/gear-slots.md), in the doll - if
  // it's free (a deleted item's id counts as free).
  if (made.clothing && !slotHolds(actor, actor.system.gearSlots.torso)) {
    await assignItemToSlot(actor, { slotType: "gear", slotKey: "torso" }, made.clothing);
  }

  // Hotlist: Heal, the attack Spell and its potions, each in the first free
  // slot (one whose item is gone counts) - never past the last.
  const choice = combatChoice(state);
  const hotlist = [findOwnedSkillLike(actor, "Heal", ["spell"])];
  if (choice.spell) hotlist.push(findOwnedSkillLike(actor, choice.skill, ["spell"]), made.potions);
  for (const item of hotlist.filter(Boolean)) {
    if (!isInHotlist(actor, item) && !(await toggleHotlist(actor, item))) break;
  }

  // A full Health Bar and Mana - and done, last, so a crawler left half
  // made by an error keeps its Create Crawler button.
  await actor.update({
    "system.hb.value": actor.system.hb.effectiveMax ?? actor.system.hb.max,
    "system.mana.value": actor.system.mana.max,
    [`flags.${SCOPE}.chargen`]: {
      done: true,
      kind: animal ? "animal" : "human",
      statMethod: state.statMethod,
      backgrounds: Object.fromEntries(stages.map((s) => [s.key, state.stages[s.key].background])),
    },
  });

  await postChargenSummary(actor, state, learned);
  return actor;
}

/** The chat card summing up a new crawler. */
async function postChargenSummary(actor, state, learned) {
  const t = (key, data) => game.i18n.format(`CARLRPG.Chargen.Summary.${key}`, data ?? {});
  const lines = stagesFor(state).map((stage) => {
    const picked = state.stages[stage.key];
    return `<li><strong>${esc(game.i18n.localize(`CARLRPG.Chargen.Stage.${stage.key}`))}:</strong> ${esc(picked.background)} - ${esc(picked.skills.join(", "))}</li>`;
  });
  const skills = learned.map((i) => `${esc(i.name)} ${i.system.rank ?? ""}`.trim()).join(", ");
  let body = `<ul>${lines.join("")}</ul><p>${t("Skills", { skills })}</p>`;
  if (state.combat.type === "handToHand") body += `<p>${esc(t("WeaponBox"))}</p>`;
  await createCardMessage({
    title: t("Title", { name: actor.name }),
    img: actor.img,
    body,
    actor,
  });
}
