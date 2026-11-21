/**
 * Reading a Skill's, Spell's or Damage Effect's free-text `duration` and
 * `cooldown` (docs/rules-fixes.md B). Foundry-free, so the PDF import can
 * reuse it and it can be tested on its own.
 *
 * parseTimerText turns the text into data; resolveTimerSeconds works out
 * the seconds once the Rank and Intelligence are known (when it's cast).
 * Time follows the book: "Each round lasts for 10 seconds" (p.62).
 *
 * What it reads:
 *  - "N rounds/seconds/minutes/hours" (a number or a word: "two"), summed
 *    ("5 minutes + 1 minute per Rank");
 *  - "... per Rank" (`perRank`, seconds per Rank);
 *  - "A number of seconds equal to your/the caster's Intelligence (xN)"
 *    (`perInt`, seconds per point of the Intelligence score - "the full
 *    name, such as Intelligence, ... refers to the score", p.57);
 *  - "Until the end of (the) combat or N minutes" (`untilCombatEnd` plus
 *    the time - whichever comes first);
 *  - "Until the end of two full rounds of combat or 20 seconds" (`rounds`
 *    and `seconds` - the same span, in and out of a fight);
 *  - ", or until the caster chooses to end the effect" (`casterMayEnd`:
 *    the time is still the upper bound);
 *  - "Once per round", "Once per scene" (cooldowns).
 * Anything else with no time in it is `manual`. Text with a time and words
 * it can't read ("1 hour, once per 50ft-square area") keeps the time and
 * is marked `partial`.
 */

/** Seconds in one round (p.62). */
export const ROUND_SECONDS = 10;

const NUMBER_WORDS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};

const UNIT_SECONDS = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600 };

/** Phrases read whole, before the time segments. Each removes its own text. */
const PHRASES = [
  { re: /^once per round$/, set: { perRound: true } },
  { re: /^once per scene$/, set: { perScene: true } },
  {
    re: /,?\s*or until the caster chooses to end (?:the|this) effect/,
    set: { casterMayEnd: true },
  },
  { re: /until the end of (?:the )?combat/, set: { untilCombatEnd: true } },
];

/**
 * @typedef {object} TimerText
 * @property {string} text  The text as given.
 * @property {number|null} seconds  The fixed part, in seconds.
 * @property {number|null} rounds  A count of rounds.
 * @property {number|null} perRank  Seconds added per Rank.
 * @property {number|null} perInt  Seconds per point of the Intelligence score.
 * @property {boolean} untilCombatEnd  Also ends when the combat does.
 * @property {boolean} perScene  "Once per scene".
 * @property {boolean} perRound  "Once per round".
 * @property {boolean} casterMayEnd  The caster can end it sooner.
 * @property {boolean} partial  Some of the text wasn't read (the time was).
 * @property {boolean} manual  No time could be read: left to the table.
 */

/**
 * Read a duration or cooldown text.
 * @param {string|null|undefined} text
 * @returns {TimerText|null}  null for blank text.
 */
export function parseTimerText(text) {
  const original = String(text ?? "");
  let rest = original
    .trim()
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/\s+/g, " ")
    .replace(/[.;]+$/, "")
    .trim();
  if (!rest) return null;

  const result = {
    text: original,
    seconds: null,
    rounds: null,
    perRank: null,
    perInt: null,
    untilCombatEnd: false,
    perScene: false,
    perRound: false,
    casterMayEnd: false,
    partial: false,
    manual: false,
  };

  // Number words to digits ("two full rounds").
  rest = rest.replace(/\b([a-z]+)\b/g, (word) =>
    word in NUMBER_WORDS && word !== "a" && word !== "an" ? String(NUMBER_WORDS[word]) : word,
  );

  for (const phrase of PHRASES) {
    if (phrase.re.test(rest)) {
      Object.assign(result, phrase.set);
      rest = rest.replace(phrase.re, " ");
    }
  }

  // "A number of seconds equal to your Intelligence (x3)".
  rest = rest.replace(
    /a number of seconds equal to (?:your|the caster'?s|their) intelligence(?:\s*x\s*(\d+(?:\.\d+)?))?/,
    (_, times) => {
      result.perInt = times ? Number(times) : 1;
      return " ";
    },
  );

  // "Until the end of 2 (full) rounds (of combat)" and "N rounds".
  rest = rest.replace(/(?:until the end of )?(\d+) (?:full )?rounds?(?: of combat)?/g, (_, n) => {
    result.rounds = (result.rounds ?? 0) + Number(n);
    return " ";
  });

  // Time segments, each maybe "per Rank": "5 minutes + 1 minute per Rank".
  rest = rest.replace(
    /(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr)s?\b(\s+per\s+rank)?/g,
    (_, n, unit, perRank) => {
      const seconds = Number(n) * UNIT_SECONDS[unit];
      if (perRank) result.perRank = (result.perRank ?? 0) + seconds;
      else result.seconds = (result.seconds ?? 0) + seconds;
      return " ";
    },
  );

  const timed =
    result.seconds !== null ||
    result.rounds !== null ||
    result.perRank !== null ||
    result.perInt !== null;
  // "Until the end of the combat" alone is still read: it ends with the fight.
  const marker = result.perRound || result.perScene || result.untilCombatEnd;
  // What's left once the read parts are gone: joiners only, or words the
  // parser doesn't know.
  const leftover = rest
    .replace(/\b(?:until|the|end|of|or|and|plus|for|duration)\b/g, " ")
    .replace(/[\s,+&()-]+/g, "");
  if (!timed && !marker) {
    result.manual = true;
  } else if (leftover) {
    result.partial = true;
  }
  return result;
}

/**
 * The seconds a parsed duration or cooldown lasts, given what it depends
 * on. Alternatives ("2 rounds or 20 seconds") take the shorter.
 * @param {TimerText|null} parsed
 * @param {{rank?: number, intelligence?: number, roundSeconds?: number}} [context]
 * @returns {number|null}  null when there's no time to count.
 */
export function resolveTimerSeconds(
  parsed,
  { rank = 0, intelligence = 0, roundSeconds = ROUND_SECONDS } = {},
) {
  if (!parsed || parsed.manual) return null;
  const options = [];
  if (parsed.seconds !== null || parsed.perRank !== null || parsed.perInt !== null) {
    options.push(
      (parsed.seconds ?? 0) +
        (parsed.perRank ?? 0) * Math.max(0, Number(rank) || 0) +
        (parsed.perInt ?? 0) * Math.max(0, Number(intelligence) || 0),
    );
  }
  if (parsed.rounds !== null) options.push(parsed.rounds * roundSeconds);
  if (!options.length) return null;
  return Math.max(0, Math.min(...options));
}
