/**
 * Gear entries: an all-caps heading, an optional "Gear Slot:" line, prose,
 * and a bullet list of benefits (Core Rulebook Appendix 1: Iconic Gear, and
 * the loot lists in other books). Simple bullets ("+1 Dexterity", "+3 Double
 * Tap Skill", "Resistance to Poison and Ice damage") become ChangeEntries,
 * and "On an Amazing Success ... the target gains the X Debuff" an On-hit
 * Debuff; everything stays readable in the description.
 */

import { itemTargetEffects } from "./debuff-text.mjs";
import { bodySize, escapeHtml, isHeading, joinText, titleCase } from "./page-text.mjs";
import { changeEntry, toBlocks } from "./shared.mjs";
import { normalizeDamageType } from "../helpers/damage-types.mjs";
import { parseGearSlotLine, slotsFromName } from "../helpers/gear-text.mjs";

const SLOT_RE = /^Gear Slot:\s*(.*)$/;
// Section headings on the gear pages that aren't items: the loot box
// tiers ("GOLD BOXES"), and tables and lists of many items.
const NOT_GEAR_RE = /^(?:\w+ Boxes|Randomized Magic Items\b.*|Memorial and Soul Crystals|Faction Wars Items)$/i;
const STAT_WORDS = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  charisma: "cha",
};
/**
 * @param {object[]} pages  From scan.mjs readPages.
 * @returns {{name: string, page: number, data: object}[]}
 */
export function parseGear(pages) {
  const gearPages = pages.filter((p) => p.lines.some((l) => SLOT_RE.test(l.text)));
  const entries = [];
  for (const page of gearPages) {
    const body = bodySize(page.lines);
    let current = null;
    let prevHeading = false;
    for (const line of page.lines) {
      if (isHeading(line, body) && line.size < body * 2.5) {
        // A heading that wraps onto a second line, before any body text.
        if (current && prevHeading) current.name = joinText([current.name, line.text]);
        else entries.push((current = { name: line.text, page: page.page, lines: [] }));
        prevHeading = true;
        continue;
      }
      if (isHeading(line, body)) {
        // A page or chapter title ends the current entry.
        current = null;
      } else if (current) {
        current.lines.push(line);
      }
      prevHeading = false;
    }
  }
  return entries.filter((e) => e.lines.length && !NOT_GEAR_RE.test(e.name)).map(toGearItem);
}

/** Map one benefit bullet onto ChangeEntries, or none when it is prose. */
export function bulletToChanges(text, label) {
  const value = (sign, n) => (sign === "+" ? n : `-${n}`);
  let m = text.match(/^([+−-])(\d+) (Strength|Dexterity|Constitution|Intelligence|Charisma)$/i);
  if (m)
    return [
      changeEntry({
        label,
        targetType: "stat",
        target: STAT_WORDS[m[3].toLowerCase()],
        value: value(m[1], m[2]),
      }),
    ];
  // "+3 Double Tap Skill", "+5 to the Skullcracker Skill". "+1 to all Skill
  // or Stat Checks" names no one Skill: it stays prose.
  m = text.match(/^([+−-])(\d+) (?!(?:to )?(?:all|any)\b)(?:to (?:the |your )?)?(.+?) Skill\b/);
  if (m)
    return [
      changeEntry({
        label,
        targetType: "skillRank",
        target: m[3].trim(),
        value: value(m[1], m[2]),
      }),
    ];
  m = text.match(/^(Resistance|Immunity|Vulnerability) to (.+?) damage$/i);
  if (m) {
    const state = { resistance: "resist", immunity: "immune", vulnerability: "vulnerable" }[
      m[1].toLowerCase()
    ];
    return m[2]
      .split(/,|\band\b/)
      .map((t) => normalizeDamageType(t))
      .filter(Boolean)
      .map((t) =>
        changeEntry({ label, targetType: "resistance", target: t, mode: "override", value: state }),
      );
  }
  return [];
}

/**
 * Where an entry is worn (docs/gear-slots.md): its "Gear Slot:" line, else
 * its name (gear.mjs); a Belt or Cape by name.
 * @param {string} slot  The "Gear Slot:" value, or "".
 * @param {string} name
 * @returns {object}  `slots`, and `twoHanded` / `accessoryKind` when set.
 */
function gearSlotData(slot, name) {
  const fromLine = parseGearSlotLine(slot);
  const fromName = slotsFromName(name);
  const slots = fromLine?.slots ?? fromName?.slots ?? [];
  const out = { slots };
  if (fromLine?.twoHanded) out.twoHanded = true;
  if (fromName?.accessoryKind && slots.includes("accessory")) out.accessoryKind = fromName.accessoryKind;
  return out;
}

function toGearItem(entry) {
  const name = titleCase(entry.name);
  let slot = "";
  const lines = entry.lines.filter((line) => {
    const m = line.text.match(SLOT_RE);
    if (m && !slot) slot = m[1];
    return !m;
  });

  const html = [];
  if (slot) html.push(`<p><strong>Gear Slot:</strong> ${escapeHtml(slot)}</p>`);
  const changes = [];
  const targetEffects = [];
  let list = [];
  const flushList = () => {
    if (list.length)
      html.push(`<ul>${list.map((li) => `<li>${escapeHtml(li)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const block of toBlocks(lines)) {
    const text = joinText(block.map((l) => l.text));
    if (text.startsWith("•")) {
      const bullet = text.replace(/^•\s*/, "");
      list.push(bullet);
      changes.push(...bulletToChanges(bullet, name));
      // "On an Amazing Success with any Hand-to-Hand Attack you make, the
      // target gains the Stunned Debuff" (debuff-text.mjs).
      targetEffects.push(...itemTargetEffects(bullet, "gear"));
    } else {
      flushList();
      html.push(`<p>${escapeHtml(text)}</p>`);
    }
  }
  flushList();

  return {
    name,
    page: entry.page,
    data: {
      name,
      type: "item",
      img: "icons/svg/item-bag.svg",
      system: { description: html.join(""), changes, targetEffects, ...gearSlotData(slot, name) },
    },
  };
}
