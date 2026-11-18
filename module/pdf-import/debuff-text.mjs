/**
 * Debuffs named in printed effect text, read into structured entries: a Mob
 * Attack's (`targetEffects` with a `trigger`, module/data/mob-attack.mjs),
 * a gear item's (Amazing-Success-only / crit-only, "Only with" Skills,
 * module/data/shared/upgrade-tier.mjs defineGearTargetEffectsField) and a
 * Spell Upgrade tier's. Pure (no Foundry globals), so the Node preview tool
 * runs it too. The printed text always stays in the description.
 *
 * Read sentence by sentence: a trigger ("On an Evade Major Fail or worse",
 * "Any hit crawler", "On an Amazing Success with any Hand-to-Hand Attack you
 * make", "on a Critical Hit"), then "gain(s) the X [and Y] Debuff(s)".
 * Only Table 11's Debuffs (p.97) become entries (ruled 2026-11-18, Q3/Q4).
 * Everything else stays text, never applied: a Debuff Table 11 doesn't
 * list ("Swallowed", "Stank Rot"), a Table 11 name the stat block redefines
 * ("the Blinded Debuff: Roll with..."), anything inside a custom Debuff's
 * definition, a Debuff behind a Stat or Skill Check ("must make a Str Stat
 * Check. On a Fail..."), an HB-loss or "If ..." condition, a choice
 * ("X or Y", "one of the following"), and a Mob Attack sentence with no
 * trigger this system knows.
 */

import { randomId } from "./shared.mjs";

/**
 * Table 11: Debuffs (p.97), by name, to CONFIG.CARLRPG.debuffs keys
 * (module/helpers/config.mjs). Names are compared lower-case, with
 * hyphens as spaces and no leading article.
 */
const TABLE_11 = {
  blinded: "blinded",
  "blood trail": "bloodTrail",
  burned: "burned",
  drowning: "drowning",
  dying: "dying",
  enraged: "enraged",
  fatigued: "fatigued",
  held: "held",
  "long term major injury": "longTermMajorInjury",
  "long term minor injury": "longTermMinorInjury",
  "major injury": "majorInjury",
  "minor injury": "minorInjury",
  muted: "muted",
  poisoned: "poisoned",
  paralyzed: "paralyzed",
  queasy: "queasy",
  sepsis: "sepsis",
  "shit faced": "shitFaced",
  shocked: "shocked",
  "sore as shit": "soreAsShit",
  staggered: "staggered",
  "stiff legs": "stiffLegs",
  stunned: "stunned",
  "take down": "takeDown",
  terrified: "terrified",
  // "The Taint" - its article is part of the name, and is stripped below.
  taint: "theTaint",
  woozy: "woozy",
};

/**
 * Other spellings in print. "Burning" is only ever the Bad Llama's Lava
 * Spit (a Fire Attack; the book's own example on p.267), never defined
 * anywhere: read as Burned.
 */
const VARIANTS = {
  poison: "poisoned",
  burning: "burned",
  takedown: "takeDown",
  shitfaced: "shitFaced",
  paralysed: "paralyzed",
};

/** Every Debuff key the table above can produce (a Quench test checks them against CONFIG). */
export const DEBUFF_KEYS = [...new Set([...Object.values(TABLE_11), ...Object.values(VARIANTS)])];

/**
 * The hand-to-hand Combat Skills (p.179), for "with any Hand-to-Hand
 * Attack": the gear entry's "Only with" list (matched by name,
 * modifiers.mjs collectItemTargetEffects). A homebrew one isn't listed.
 */
export const HAND_TO_HAND_SKILLS = [
  "Foot Soldier",
  "Noggin Nocker",
  "Pugilism",
  "Unarmed Combat",
  "Wrasslin'",
];

/**
 * A Debuff's key from its printed name, or null when Table 11 has no such
 * Debuff.
 * @param {string} name  "Poison", "the Blood Trail", "The Taint", "Long-Term Minor Injury"...
 * @returns {string|null}
 */
export function debuffKeyFor(name) {
  const norm = String(name ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-‐‑‒–]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:the|a|an) /, "");
  return TABLE_11[norm] ?? VARIANTS[norm] ?? VARIANTS[norm.replace(/ /g, "")] ?? null;
}

/**
 * Split an Attack's printed range at ", Armor-Piercing" (p.95): "5ft,
 * Armor-Piercing" -> "5ft", armor-piercing.
 * @param {string} range
 * @returns {{range: string, armorPiercing: boolean}}
 */
export function splitArmorPiercing(range) {
  const re = /\s*,?\s*\bArmor[\s‑-]?Piercing\b\s*,?/i;
  const text = String(range ?? "");
  if (!re.test(text)) return { range: text, armorPiercing: false };
  return {
    range: text
      .replace(re, ", ")
      .replace(/\s+/g, " ")
      .replace(/^[\s,]+|[\s,]+$/g, ""),
    armorPiercing: true,
  };
}

// A second Attack's line run into this one's effect ("... Debuff. Bite
// 14+F to hit, ..."): what follows is not this Attack's.
const RUN_ON_ATTACK_RE = /\b\d+\s*\+\s*(?:F|\d+)\s+to hit\b/;

// Mob Attack triggers (CONFIG.CARLRPG.mobAttackTriggers), read before "gains".
const MAJOR_FAIL_RE = /\bMajor Fail(?:ure)? or worse\b/i;
const CRITICAL_FAIL_RE = /(?<!not a )\bCritical Fail(?:ure)?\b/i;
const HIT_RE =
  /^(?:Any hit crawlers?\b|Any crawlers? hit\b|On (?:a )?hit\b|On an? (?:Evade )?Fail(?:ure)? or worse\b)|\bwho fails? to Evade\b|^If a crawler does not successfully Evade\b/i;

// What makes a Debuff text only (see the module comment).
const CHECK_RE = /\bChecks?\b|^On (?:a )?Fail(?:ure)?\b/i;
const HB_GATE_RE = /\b(?:loses?|lost|losing)\b[^.]*\b(?:HB|Health Bar)\b|\bHB slots? lost\b/i;
const IF_RE = /^If\b/i;
// A name list joined to the one before ("the Held Debuff, and the Skewered Debuff").
const NEXT_NAME_RE =
  /^\s*(?:,\s*)?(?:and\s+)?(?:also\s+)?(?:the|a|an)\s+(?=\S)|^\s*(?:,\s*and|,|and)\s+(?=[A-Z])/i;
const NAME_LIST_RE = /^(.{1,80}?)\s+Debuffs?\b(\s*:)?/;

/**
 * @typedef {object} ParsedDebuff
 * @property {string} debuffKey
 * @property {string} name         As printed.
 * @property {"hit"|"majorFail"|"criticalFail"} [trigger]  Mob Attacks.
 * @property {boolean} [critOnly]  Gear and Spells: a Critical Hit only.
 * @property {boolean} [amazingSuccessOnly]  Gear and Spells: an Amazing Success only.
 * @property {string[]} [skills]   Gear: the Attack Skills it comes with (blank: any).
 */

/**
 * @typedef {object} TextDebuff  A Debuff named but left as text.
 * @property {string} name
 * @property {"custom"|"redefined"|"check"|"hb"|"if"|"choice"|"trigger"} reason
 */

/**
 * Read the Debuffs a piece of effect text gives.
 * @param {string} text
 * @param {{context?: "mob"|"gear"|"spell"}} [options]  mob: a Mob Attack's
 *   effect (Evade triggers); gear: a benefit bullet; spell: an Upgrade tier.
 * @returns {{effects: ParsedDebuff[], textOnly: TextDebuff[]}}
 */
export function parseDebuffText(text, { context = "mob" } = {}) {
  const effects = [];
  const textOnly = [];
  let body = String(text ?? "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const runOn = body.search(RUN_ON_ATTACK_RE);
  if (runOn >= 0) {
    // Back to the start of the sentence the run-on Attack begins.
    const before = body.slice(0, runOn);
    const end = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "));
    body = end >= 0 ? body.slice(0, end + 1) : "";
  }

  // Not before "Debuff": "the You Stanky! Debuff" is one name.
  for (const raw of body.split(/(?<=[.!?])\s+(?=[A-Z(“"])(?!Debuffs?\b)/)) {
    const sentence = raw.replace(/^(?:\([^)]*\)\s*)+/, "");
    const stop = readSentence(sentence, context, effects, textOnly);
    // A custom Debuff's definition runs on: nothing after it is a trigger.
    if (stop) break;
  }

  // One entry per Debuff and moment.
  const seen = new Set();
  return {
    effects: effects.filter((e) => {
      const key = [e.debuffKey, e.trigger, e.critOnly, e.amazingSuccessOnly].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    textOnly,
  };
}

/** Read one sentence into `effects` / `textOnly`. Returns true to stop reading (a definition began). */
function readSentence(sentence, context, effects, textOnly) {
  // "AS: Target gains Burned" (p.116's shorthand for weapon notes).
  const shorthand =
    context !== "mob" && sentence.match(/^AS:\s*Target gains (?:the )?(.+?)(?: Debuffs?)?\.?$/i);
  const verb = shorthand ? null : sentence.match(/\bgain(?:s|ed)?\b/i);
  if (!shorthand && (!verb || !/\bDebuffs?\b/i.test(sentence.slice(verb.index)))) return false;
  const lead = shorthand ? "" : sentence.slice(0, verb.index);

  // Why the whole sentence stays text, if it does.
  let gate = null;
  if (CHECK_RE.test(sentence.slice(0, shorthand ? 0 : verb.index + verb[0].length))) gate = "check";
  else if (HB_GATE_RE.test(lead) || /^For every\b/i.test(lead)) gate = "hb";
  else if (IF_RE.test(lead) && !HIT_RE.test(lead)) gate = "if";
  // "a crawler with the Ovulated Debuff gains..."
  else if (/\bDebuffs?\b/i.test(lead)) gate = "if";

  const moment = {};
  if (context === "mob") {
    if (MAJOR_FAIL_RE.test(lead)) moment.trigger = "majorFail";
    else if (CRITICAL_FAIL_RE.test(lead)) moment.trigger = "criticalFail";
    else if (HIT_RE.test(lead)) moment.trigger = "hit";
    else gate ??= "trigger";
  } else {
    moment.critOnly = /\bCritical Hit\b|\bnatural 20\b/i.test(lead);
    moment.amazingSuccessOnly = !!shorthand || /\bAmazing Success\b/i.test(lead);
    if (context === "gear") {
      const only = lead.match(/\bwith any (?:(.+?) )?Attacks?\b/i);
      moment.skills = !only?.[1]
        ? []
        : /^hand[\s‑-]to[\s‑-]hand$/i.test(only[1].trim())
          ? [...HAND_TO_HAND_SKILLS]
          : [only[1].trim()];
    }
  }

  const add = (name, reason) => {
    const key = reason ? null : debuffKeyFor(name);
    if (key) effects.push({ debuffKey: key, name, ...moment });
    else textOnly.push({ name, reason: reason ?? "custom" });
  };

  if (shorthand) {
    for (const name of splitNames(shorthand[1])) add(name, gate);
    return false;
  }

  let tail = sentence.slice(verb.index + verb[0].length);
  if (/^\s*one of the following\b/i.test(tail)) {
    textOnly.push({
      name: tail.replace(/^.*?Debuffs?:?\s*/i, "").replace(/\.$/, ""),
      reason: "choice",
    });
    return true;
  }
  // The first name follows the verb; later ones must be joined to it.
  let first = true;
  for (;;) {
    const lead2 = first
      ? tail.match(/^\s*(?:one stack of\s+)?(?:(?:the|a|an)\s+)?/i)
      : tail.match(NEXT_NAME_RE);
    if (!lead2) break;
    const rest = tail.slice(lead2[0].length);
    const m = rest.match(NAME_LIST_RE);
    if (!m || /[;.]/.test(m[1])) break;
    first = false;
    const names = splitNames(m[1]);
    const after = rest.slice(m[0].length);
    const choice = /\bor\b/i.test(m[1]) || /^\s*or\b/i.test(after);
    const definition = !!m[2];
    if (definition) {
      // "the Blinded Debuff: Roll with..." - Table 11's name, its own rules.
      const known = names.filter((n) => debuffKeyFor(n));
      if (!known.length) add(m[1], gate);
      else for (const name of names) add(name, gate ?? (debuffKeyFor(name) ? "redefined" : null));
      return true;
    }
    if (choice) {
      textOnly.push({ name: m[1], reason: "choice" });
    } else {
      // A name list that's no Debuff at all is one custom Debuff ("You'll
      // Listen to Us and Like It, ..."), not several.
      const known = names.filter((n) => debuffKeyFor(n));
      if (!known.length) add(m[1], gate);
      else for (const name of names) add(name, gate);
    }
    tail = after;
  }
  return false;
}

/** "Stunned, Staggered, and Sore as Shit" -> three names. */
function splitNames(list) {
  return String(list)
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((n) => n.trim().replace(/^(?:the|a|an)\s+(?!Taint\b)/i, ""))
    .filter(Boolean);
}

/**
 * A Mob Attack's `targetEffects` (module/data/mob-attack.mjs) from its
 * printed effect.
 * @param {string} effect
 * @returns {object[]}
 */
export function mobAttackTargetEffects(effect) {
  return parseDebuffText(effect, { context: "mob" }).effects.map((e) => ({
    id: randomId(),
    debuffKey: e.debuffKey,
    stacks: 1,
    trigger: e.trigger,
    label: "",
  }));
}

/**
 * Gear's or a Spell Upgrade tier's `targetEffects` from printed text.
 * @param {string} text
 * @param {"gear"|"spell"} context
 * @returns {object[]}
 */
export function itemTargetEffects(text, context) {
  return parseDebuffText(text, { context }).effects.map((e) => ({
    id: randomId(),
    debuffKey: e.debuffKey,
    stacks: 1,
    critOnly: !!e.critOnly,
    amazingSuccessOnly: !!e.amazingSuccessOnly,
    label: "",
    ...(context === "gear" ? { skills: e.skills ?? [] } : {}),
  }));
}
