/**
 * Mob stat blocks, in every book's shared layout:
 *
 *   Goblin                                   <- name
 *   Mob; Petite (3), Humanoid                <- class line (the anchor)
 *   1 1 / 50% 100%                           <- Health Bar: slot value, one % per slot
 *   Level Surprise Evade Move DR / 2 11+F 13+F 20+S 1
 *   Str Int Con Dex Cha / 1 (+1) 2 (+1) 1 (+1) 6 (+3) 1 (+1)
 *   Club: 11+F to hit, 1d6+1 Bludgeoning, 5ft range
 *   Notes: Pineapple Club—...
 *
 * The class line is "<kind>; <Size> (<n>), <type>", where kind is Mob,
 * Crawler, or a Boss tier. Prose between a section heading and the name is
 * the creature's flavor text.
 */

import { bodySize, escapeHtml, isHeading, joinText } from "./page-text.mjs";

const CLASS_RE = /^([A-Z][A-Za-z ]{1,30});\s*([A-Za-z]+)\s*\((\d+)\),\s*(.+)$/;
// One % per slot; a % is sometimes missing or mistyped in print ("50 60%", "80&").
const HB_PERCENT_RE = /^\d+[%&]?( \d+[%&]?)*$/;
// The closing paren is sometimes missing in print: "10 (+4 8 (+3)".
const STAT_PAIR_RE = /(\d+)\s*\(\s*[+−-]?\d+\s*\)?/g;
// "2d8+3 Piercing", "−1d6", "No damage"; the comma after it is sometimes
// missing in print ("1d6+3 60ft range").
const DAMAGE_RE = /^(No damage|[+−-]?\d*d\d+(?:\s*[+−-]\s*\d+)?(?:\s*[A-Z][a-z]+)?)\s*,?\s*(.*)$/;
const ATTACK_RE = /^([^:]{1,60}):\s*(\d+(?:\+F)* to hit|None|Auto)\b,?\s*(.*)$/i;
const NOTES_RE = /^Notes:\s*(.*)$/;
const NOTE_TITLE_RE = /^([A-Z][\w’'!?,()&. -]{1,40})—/;
const EFFECT_START_RE = /^(On an?y? |Any |Make a |If |Each |\(Secret!?\))/;
const TIERS = ["neighborhood", "borough", "city", "province", "country", "floor"];
const STAT_KEYS = { str: "str", int: "int", con: "con", dex: "dex", cha: "cha" };
const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "electric",
  "fire",
  "force",
  "holy",
  "ice",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "slashing",
  "sonic",
];

/**
 * @param {object[]} pages  From scan.mjs readPages.
 * @returns {{name: string, page: number, data: object}[]}
 */
export function parseMobs(pages) {
  // A block can run onto the next page, which has no class line of its own.
  const lines = [];
  let prevHadBlock = false;
  for (const page of pages) {
    const hasBlock = page.lines.some((l) => CLASS_RE.test(l.text));
    const keep = hasBlock || prevHadBlock;
    prevHadBlock = hasBlock;
    if (!keep) continue;
    const body = bodySize(page.lines);
    for (const line of page.lines) lines.push({ ...line, heading: isHeading(line, body) });
  }

  const anchors = [];
  lines.forEach((line, i) => {
    if (i > 0 && CLASS_RE.test(line.text) && !lines[i - 1].heading) anchors.push(i);
  });

  // The name sits right above the class line and may wrap ("Spat—Goblin
  // Who Just Can't Seem to Let" / "Go of the Past"): lines just above, set
  // in the same type size (bigger than body text), are part of it.
  const nameStarts = anchors.map((at, n) => {
    const floor = n > 0 ? anchors[n - 1] + 1 : 0;
    let nameAt = at - 1;
    while (
      nameAt - 1 >= floor &&
      !lines[nameAt - 1].heading &&
      lines[nameAt - 1].size === lines[nameAt].size &&
      lines[nameAt].size > lines[at].size &&
      lines[nameAt].gap !== null &&
      lines[nameAt].gap <= lines[nameAt].size * 1.4
    )
      nameAt--;
    return nameAt;
  });

  return anchors.map((at, n) => {
    const nameAt = nameStarts[n];
    // Flavor: prose between the nearest heading above and the name.
    // Reaching the previous block first means there is none.
    const floor = n > 0 ? anchors[n - 1] + 1 : 0;
    let start = nameAt;
    while (start - 1 >= floor && !lines[start - 1].heading) start--;
    const flavor = lines[start - 1]?.heading ? lines.slice(start, nameAt) : [];

    // Body: up to the next block's name, or a heading.
    let end = n + 1 < anchors.length ? nameStarts[n + 1] : lines.length;
    for (let i = at + 1; i < end; i++) {
      if (lines[i].heading) {
        end = i;
        break;
      }
    }
    const name = joinText(lines.slice(nameAt, at).map((l) => l.text));
    return toMob(name, lines[at], lines.slice(at + 1, end), flavor);
  });
}

function toMob(rawName, classLine, body, flavor) {
  const [, kind, size, sizeN, type] = classLine.text.match(CLASS_RE);
  const name = rawName.trim();
  const tierWord = kind.match(/^(\w+) Boss$/)?.[1]?.toLowerCase();
  const system = {
    mobTier: TIERS.includes(tierWord) ? tierWord : "",
    size: `${size} (${sizeN})`,
    creatureType: /^(Mob|Boss)$/i.test(kind) || tierWord ? type : `${type} ${kind}`,
    attacks: [],
    biography: "",
  };

  const notes = [];
  const extra = [];
  let hbCount = 0;
  let attack = null;
  let note = null;
  // Attacks and notes are set a touch smaller than page prose; prose after
  // the block (before the next heading) is not part of it.
  let blockSize = null;
  for (let i = 0; i < body.length; i++) {
    const text = body[i].text;
    let m;
    if (blockSize !== null && Math.abs(body[i].size - blockSize) > 0.3) break;
    if (HB_PERCENT_RE.test(text)) {
      if (/[%&]/.test(text)) hbCount += text.split(" ").length;
      continue;
    }
    if (/^Level\b.*\bDR$/.test(text)) {
      const values = body[++i]?.text.split(" ") ?? [];
      const headers = text.split(/\s+/);
      const at = (h) => values[headers.indexOf(h)];
      system.level = Number.parseInt(at("Level"), 10) || 1;
      system.move = at("Move") ?? "";
      system.dr = Number.parseInt(at("DR"), 10) || 0;
      continue;
    }
    if (/^Str\b.*\bCha$/.test(text)) {
      const headers = text.toLowerCase().split(/\s+/);
      const values = [...(body[++i]?.text ?? "").matchAll(STAT_PAIR_RE)].map((v) => Number(v[1]));
      system.stats = {};
      headers.forEach((h, k) => {
        if (STAT_KEYS[h] && values[k]) system.stats[STAT_KEYS[h]] = { value: values[k] };
      });
      continue;
    }
    if ((m = text.match(NOTES_RE))) {
      attack = null;
      notes.push((note = [m[1]]));
      continue;
    }
    if ((m = text.match(ATTACK_RE))) {
      blockSize ??= body[i].size;
      note = null;
      system.attacks.push((attack = { name: m[1].trim(), toHit: m[2], main: [m[3]], effect: [] }));
      continue;
    }
    if (note) {
      if (NOTE_TITLE_RE.test(text) && body[i].gap !== null) notes.push((note = [text]));
      else note.push(text);
    } else if (attack) {
      // The attack's own clause runs until it names a range or area; later
      // lines are its on-hit effect.
      const done =
        attack.effect.length || EFFECT_START_RE.test(text) || mainClauseDone(joinText(attack.main));
      (done ? attack.effect : attack.main).push(text);
    } else {
      extra.push(text);
    }
  }

  system.attacks = system.attacks.map(finishAttack);
  if (hbCount) {
    system.hbSlotsOverride = hbCount;
    system.hb = { value: hbCount, max: hbCount };
  }

  const html = [];
  if (flavor.length)
    html.push(`<p><em>${escapeHtml(joinText(flavor.map((l) => l.text)))}</em></p>`);
  if (extra.length) html.push(`<p>${escapeHtml(joinText(extra))}</p>`);
  for (const parts of notes) {
    const text = joinText(parts);
    const titled = text.match(/^([^—]{1,40})—(.*)$/);
    html.push(
      titled
        ? `<p><strong>${escapeHtml(titled[1])}:</strong> ${escapeHtml(titled[2])}</p>`
        : `<p>${escapeHtml(text)}</p>`,
    );
  }
  system.biography = html.join("");

  return {
    name,
    page: classLine.page,
    data: { name, type: "mob", img: "icons/svg/mystery-man.svg", system },
  };
}

// "…, 5ft range", "…, 15ft Cone", "…; 5ft Blast radius (see Bombs)",
// "…, Auto-hits a Held foe". "…, Line of" is not done: "Sight range" follows.
function mainClauseDone(text) {
  return /(range|Cone|Line|radius|Splash|foe|self|Aura|\))$/i.test(text);
}

function finishAttack({ name, toHit, main, effect }) {
  const text = joinText(main);
  const split = text.match(DAMAGE_RE);
  const [damagePart = "", ...rest] = split ? [split[1], split[2]] : text.split(/,\s*/);
  let rangeText = rest.join(", ");
  const extraEffect = [];
  const semi = rangeText.indexOf(";");
  if (semi >= 0) {
    extraEffect.push(rangeText.slice(semi + 1).trim());
    rangeText = rangeText.slice(0, semi);
  }
  const dice = damagePart.match(/\d*d\d+(?:\s*[+−-]\s*\d+)?/)?.[0]?.replace(/\s+/g, "") ?? "";
  const damageType = DAMAGE_TYPES.find((t) => new RegExp(`\\b${t}\\b`, "i").test(damagePart)) ?? "";
  return {
    name,
    toHit: /to hit/i.test(toHit) ? toHit.replace(/\s*to hit/i, "") : "",
    damage: dice,
    damageType,
    range: rangeText.replace(/\s+range\b/i, "").trim(),
    effect: joinText([...extraEffect, ...effect]),
  };
}
