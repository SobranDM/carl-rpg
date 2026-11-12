/**
 * Spell cards (Core Rulebook "List of Spells", and the spell lists in other
 * books). Moved here from the old pdftotext prototype
 * (tools/pdf-import/extract-rulebook.mjs) so the in-Foundry importer and the
 * Node preview share one parser. An entry only counts as a spell if it has a
 * "Mana Cost:" line; section intros on the same pages are dropped.
 */

import { joinText, titleCase } from "./page-text.mjs";
import { findDamageType } from "../helpers/damage-types.mjs";

const STATS = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  charisma: "cha",
};
const STAT_ABBR = new Set(Object.values(STATS));

const FIELD_RE = /^(Mana Cost|Range|Duration|Limitations|Cooldown|AI Favor):\s*(.*)$/;
const RANK_RE = /^Rank (\d+):\s*(.*)$/;
// The tag line under the flavor text, e.g. "Attack, Necrotic, Charisma, Favored: Cleric".
const TYPE_RE =
  /^(Attack|Passive|Interrupt|Heal|Mind Control|Area of Effect|Strength|Dexterity|Constitution|Intelligence|Charisma|Favored)\b[^.]*$/;

function isSpellHeading(text) {
  return (
    /^[A-Z][A-Z0-9 '’,()\-!.&]+$/.test(text) &&
    /[A-Z]{3}/.test(text) &&
    !["UPGRADES", "LIST OF SPELLS"].includes(text)
  );
}

/**
 * @param {object[]} pages  From scan.mjs readPages.
 * @returns {{name: string, page: number, data: object}[]}
 */
export function parseSpells(pages) {
  const entries = [];
  let cur = null;
  for (const page of pages) {
    if (!page.lines.some((l) => /^Mana Cost:/.test(l.text))) {
      cur = null;
      continue;
    }
    for (const { text } of page.lines) {
      const line = text.replace(/‑$/, "-");
      if (isSpellHeading(line)) {
        // A heading that wraps onto a second all-caps line, before any body.
        if (cur && cur.body.length === 0) cur.name += ` ${line}`;
        else entries.push((cur = { name: line, page: page.page, body: [] }));
      } else if (cur) {
        cur.body.push(line);
      }
    }
  }
  return entries.map(parseSpell).filter(Boolean);
}

function parseSpell({ name, page, body }) {
  const spell = {
    flavor: [],
    typeLine: [],
    fields: {},
    description: [],
    baseDamage: [],
    upgrades: [],
  };
  let mode = "flavor";
  let field = null;
  for (const line of body) {
    let m;
    if (mode === "flavor" && line.startsWith("“")) {
      spell.flavor.push(line);
      if (!line.endsWith("”")) mode = "flavorMore";
      continue;
    }
    if (mode === "flavorMore") {
      spell.flavor.push(line);
      if (line.endsWith("”")) mode = "flavor";
      continue;
    }
    const typeWraps = mode === "type" && /(,|:)$/.test(spell.typeLine.at(-1));
    if (
      (!spell.typeLine.length && ["flavor", "field"].includes(mode) && TYPE_RE.test(line)) ||
      typeWraps
    ) {
      spell.typeLine.push(line);
      mode = "type";
      continue;
    }
    if ((m = line.match(FIELD_RE))) {
      field = m[1];
      spell.fields[field] = [m[2]];
      mode = "field";
      continue;
    }
    if (mode === "field" && field) {
      // Continuation of a wrapped field value: starts lowercase, or the
      // previous line ends mid-phrase.
      const prev = spell.fields[field].at(-1);
      if (/^[a-z0-9(]/.test(line) || /(,|\b(per|your|or|and|of|to|the|a|an|with)|’s)$/.test(prev)) {
        spell.fields[field].push(line);
        continue;
      }
    }
    if (line.startsWith("Base Damage:")) {
      spell.baseDamage.push(line.slice("Base Damage:".length).trim());
      mode = "damage";
      continue;
    }
    if (line === "UPGRADES") {
      mode = "upgrades";
      continue;
    }
    if (mode === "upgrades") {
      if ((m = line.match(RANK_RE))) spell.upgrades.push({ rank: Number(m[1]), text: [m[2]] });
      else if (spell.upgrades.length) spell.upgrades.at(-1).text.push(line);
      continue;
    }
    if (
      mode === "damage" &&
      !/[.!?]$/.test(spell.baseDamage.join(" ")) &&
      spell.baseDamage.length < 4 &&
      !/^[A-Z][a-z]+ [a-z]/.test(line)
    ) {
      spell.baseDamage.push(line);
      continue;
    }
    mode = "description";
    field = null;
    spell.description.push(line);
  }
  if (!spell.fields["Mana Cost"]) return null;
  return toItem(name, page, spell);
}

function toItem(rawName, page, s) {
  const name = titleCase(rawName.trim());
  const typeText = joinText(s.typeLine);
  const keywords = [];
  if (/\bAttack\b/.test(typeText)) keywords.push("attack");
  if (/\bPassive\b/.test(typeText)) keywords.push("passive");
  if (/\bInterrupt\b/.test(typeText)) keywords.push("interrupt");
  if (/\bHeal\b/.test(typeText)) keywords.push("heal");
  if (/\bMind Control\b/.test(typeText)) keywords.push("mindControl");
  if (/\bArea of Effect\b/.test(typeText)) keywords.push("areaOfEffect");

  const lowerType = typeText.toLowerCase();
  const statWord = Object.keys(STATS).find((w) => lowerType.includes(w));
  const favored = typeText.match(/Favored:\s*(.+)$/);
  const favoredClasses = favored
    ? favored[1]
        .split(/,|&|\band\b/)
        .map((c) => c.trim())
        .filter(Boolean)
    : [];

  const f = Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, joinText(v)]));
  const manaCost = Number.parseInt(f["Mana Cost"] ?? "", 10);

  const dmgText = joinText(s.baseDamage);
  const dice = dmgText.match(/\d+d\d+/)?.[0] ?? "";
  const dmgStat = dmgText.match(/\+\s*(Str|Dex|Con|Int|Cha)\b/i)?.[1]?.toLowerCase();
  // Other spellings ("Cold", "Radiant") map onto the book's types.
  const dmgType = findDamageType(dmgText) || findDamageType(lowerType);
  const governingStat = STATS[statWord] ?? (STAT_ABBR.has(dmgStat) ? dmgStat : "int");

  const paras = [];
  if (s.flavor.length) paras.push(`<p><em>${joinText(s.flavor)}</em></p>`);
  for (const key of ["Limitations", "AI Favor"])
    if (f[key]) paras.push(`<p><strong>${key}:</strong> ${f[key]}</p>`);
  if (s.description.length) paras.push(`<p>${joinText(s.description)}</p>`);

  return {
    name,
    page,
    data: {
      name,
      type: "spell",
      img: "icons/svg/lightning.svg",
      system: {
        description: paras.join(""),
        governingStat,
        rank: 0,
        isPassive: !keywords.includes("attack"),
        advancementGate: keywords.includes("attack") ? "normal" : "magic-only",
        baseDamage: { dice, stat: dice ? (dmgStat ?? governingStat) : "", damageType: dmgType },
        upgrades: s.upgrades.map((u) => ({
          rankThreshold: u.rank,
          description: joinText(u.text),
          changes: [],
        })),
        manaCost: Number.isFinite(manaCost) ? manaCost : 0,
        range: f.Range ?? "",
        duration: f.Duration ?? "",
        cooldown: f.Cooldown ?? "",
        castingKeywords: keywords,
        favoredClasses,
      },
    },
  };
}
