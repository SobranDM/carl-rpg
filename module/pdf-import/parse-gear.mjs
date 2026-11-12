/**
 * Gear entries: an all-caps heading, an optional "Gear Slot:" line, prose,
 * and a bullet list of benefits (Core Rulebook Appendix 1: Iconic Gear, and
 * the loot lists in other books). Simple bullets ("+1 Dexterity", "+3 Double
 * Tap Skill", "Resistance to Poison and Ice damage") become ChangeEntries;
 * everything else stays readable in the description.
 */

import { bodySize, escapeHtml, isHeading, joinText, titleCase } from "./page-text.mjs";
import { changeEntry, toBlocks } from "./shared.mjs";
import { normalizeDamageType } from "../helpers/damage-types.mjs";

const SLOT_RE = /^Gear Slot:\s*(.*)$/;
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
  return entries.filter((e) => e.lines.length).map(toGearItem);
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
  m = text.match(/^([+−-])(\d+) (.+?) Skill\b/);
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
      system: { description: html.join(""), changes },
    },
  };
}
